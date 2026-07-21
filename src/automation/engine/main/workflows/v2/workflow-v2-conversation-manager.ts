import type { AgentEvent, ChatEvent, RuntimeConversation } from "../../../shared/types";
import type {
  WorkflowNodeCompletionProposal,
  WorkflowNodeConversation,
  WorkflowNodeMessage,
} from "../../../shared/workflow-v2/conversation";
import { workflowNodeConversationId } from "../../../shared/workflow-v2/conversation";

export interface WorkflowNodeInteractiveSession {
  sendPrompt(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  runtimeConversation(): RuntimeConversation | undefined;
}

export interface CreateWorkflowNodeConversationInput {
  workflowId: string;
  runId: string;
  nodeId: string;
  configuredAgentId: string;
  modelId: string;
  workDir: string;
  initialPrompt: string;
  developerInstructions?: string;
  contextDocument?: string;
}

export class WorkflowV2ConversationManager {
  private readonly conversations = new Map<string, WorkflowNodeConversation>();
  private readonly sessions = new Map<string, WorkflowNodeInteractiveSession>();
  private readonly restoredInputs = new Map<string, CreateWorkflowNodeConversationInput>();
  private readonly completing = new Set<string>();

  constructor(private readonly deps: {
    now: () => number;
    createSession: (input: CreateWorkflowNodeConversationInput & { emit: (event: AgentEvent) => void }) => WorkflowNodeInteractiveSession;
    onChanged?: (conversation: WorkflowNodeConversation) => void;
    onCompleted?: (conversation: WorkflowNodeConversation, content: string) => void;
  }) {}

  async start(input: CreateWorkflowNodeConversationInput): Promise<WorkflowNodeConversation> {
    const conversationId = workflowNodeConversationId(input.workflowId, input.runId, input.nodeId);
    const existing = this.conversations.get(conversationId);
    if (existing) return structuredClone(existing);
    const now = this.deps.now();
    const conversation: WorkflowNodeConversation = {
      conversationId,
      workflowId: input.workflowId,
      runId: input.runId,
      nodeId: input.nodeId,
      configuredAgentId: input.configuredAgentId,
      modelId: input.modelId,
      workDir: input.workDir,
      status: "starting",
      messages: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };
    const session = this.deps.createSession({ ...input, emit: (event) => this.recordEvent(conversationId, event) });
    this.conversations.set(conversationId, conversation);
    this.sessions.set(conversationId, session);
    this.appendMessage(conversation, "system", input.initialPrompt, now);
    conversation.status = "active";
    this.changed(conversation);
    void session.sendPrompt(input.initialPrompt)
      .then(() => this.syncRuntimeConversation(conversationId))
      .catch(async (error) => {
        const mutable = this.conversations.get(conversationId);
        if (!mutable || mutable.status === "closed") return;
        this.sessions.delete(conversationId);
        await session.close().catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        this.appendMessage(mutable, "system", message, this.deps.now(), "error");
        mutable.status = "failed";
        this.changed(mutable);
      });
    return this.getRequired(conversationId);
  }

  async sendUserMessage(conversationId: string, content: string): Promise<WorkflowNodeConversation> {
    const conversation = this.mutableRequired(conversationId);
    if (this.completing.has(conversationId)) throw new Error("Workflow node completion is being confirmed.");
    const session = this.sessionForConversation(conversationId);
    const message = content.trim();
    if (!message) throw new Error("Workflow node conversation message is required.");
    if (conversation.status === "closed" || conversation.status === "failed") throw new Error("Workflow node conversation is not active.");
    const now = this.deps.now();
    this.appendMessage(conversation, "user", message, now);
    delete conversation.completionProposal;
    conversation.status = "active";
    this.changed(conversation);
    await session.sendPrompt(message);
    this.syncRuntimeConversation(conversationId);
    return this.getRequired(conversationId);
  }

  markWaitingForUser(conversationId: string, question: string): WorkflowNodeConversation {
    const conversation = this.mutableRequired(conversationId);
    const normalizedQuestion = question.trim();
    const lastMessage = conversation.messages.at(-1);
    if (!lastMessage || lastMessage.role !== "assistant" || lastMessage.content.trim() !== normalizedQuestion) {
      this.appendMessage(conversation, "assistant", normalizedQuestion, this.deps.now());
    }
    conversation.status = "waiting_for_user";
    this.changed(conversation);
    return this.getRequired(conversationId);
  }

  proposeCompletion(conversationId: string, proposal: Omit<WorkflowNodeCompletionProposal, "proposedAt">): WorkflowNodeConversation {
    const conversation = this.mutableRequired(conversationId);
    conversation.completionProposal = { ...structuredClone(proposal), proposedAt: this.deps.now() };
    conversation.status = "completion_proposed";
    this.changed(conversation);
    return this.getRequired(conversationId);
  }

  completionProposal(conversationId: string): WorkflowNodeCompletionProposal {
    const conversation = this.mutableRequired(conversationId);
    if (conversation.status !== "completion_proposed" || !conversation.completionProposal) {
      throw new Error("Workflow node conversation has no completion proposal to confirm.");
    }
    return structuredClone(conversation.completionProposal);
  }

  beginCompletion(conversationId: string): WorkflowNodeCompletionProposal {
    if (this.completing.has(conversationId)) throw new Error("Workflow node completion is already being confirmed.");
    const proposal = this.completionProposal(conversationId);
    this.completing.add(conversationId);
    return proposal;
  }

  async closeCompleted(conversationId: string): Promise<WorkflowNodeConversation> {
    const conversation = this.mutableRequired(conversationId);
    if (!conversation.completionProposal) throw new Error("Workflow node conversation has no completed output.");
    conversation.status = "closed";
    this.completing.delete(conversationId);
    const session = this.sessions.get(conversationId);
    this.sessions.delete(conversationId);
    await session?.close().catch(() => undefined);
    this.changed(conversation);
    return this.getRequired(conversationId);
  }

  releaseCompletion(conversationId: string): void {
    this.completing.delete(conversationId);
  }

  async rejectCompletion(conversationId: string, instruction: string): Promise<WorkflowNodeConversation> {
    return this.sendUserMessage(conversationId, instruction);
  }

  async interrupt(conversationId: string): Promise<void> {
    const conversation = this.mutableRequired(conversationId);
    if (conversation.status === "closed" || conversation.status === "failed") return;
    const session = this.sessions.get(conversationId);
    if (!session) return;
    await session.interrupt();
  }

  async stopRun(workflowId: string, runId: string): Promise<void> {
    const conversations = this.listForRun(workflowId, runId).filter((conversation) => conversation.status !== "closed" && conversation.status !== "failed");
    await Promise.allSettled(conversations.map(async (conversation) => {
      const session = this.sessions.get(conversation.conversationId);
      if (session) {
        await Promise.allSettled([session.interrupt(), session.close()]);
        this.sessions.delete(conversation.conversationId);
      }
      const mutable = this.mutableRequired(conversation.conversationId);
      mutable.status = "closed";
      this.appendMessage(mutable, "system", "Workflow run stopped by user.", this.deps.now());
      this.changed(mutable);
    }));
  }

  async shutdown(): Promise<void> {
    const active = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.allSettled(active.map(async ([conversationId, session]) => {
      await Promise.allSettled([session.interrupt(), session.close()]);
      const conversation = this.conversations.get(conversationId);
      if (!conversation || conversation.status === "closed" || conversation.status === "failed") return;
      conversation.status = "closed";
      this.appendMessage(conversation, "system", "AgentRecall closed this conversation when the app stopped.", this.deps.now());
      this.changed(conversation);
    }));
  }

  get(conversationId: string): WorkflowNodeConversation | undefined {
    const conversation = this.conversations.get(conversationId);
    return conversation ? structuredClone(conversation) : undefined;
  }

  listForRun(workflowId: string, runId: string): WorkflowNodeConversation[] {
    return [...this.conversations.values()]
      .filter((conversation) => conversation.workflowId === workflowId && conversation.runId === runId)
      .map((conversation) => structuredClone(conversation));
  }

  restore(conversations: WorkflowNodeConversation[]): void {
    for (const conversation of conversations) {
      const restored = structuredClone(conversation);
      for (const message of restored.messages) {
        if ((message.event?.type === "approval_request" || message.event?.type === "user_input_request") && message.event.requestState === "live") message.event.requestState = "expired";
      }
      this.conversations.set(conversation.conversationId, restored);
      this.restoredInputs.set(conversation.conversationId, {
        workflowId: conversation.workflowId, runId: conversation.runId, nodeId: conversation.nodeId,
        configuredAgentId: conversation.configuredAgentId, modelId: conversation.modelId, workDir: conversation.workDir,
        initialPrompt: conversation.messages.find((message) => message.role === "system")?.content ?? "Continue this workflow node.",
      });
    }
  }

  list(): WorkflowNodeConversation[] {
    return [...this.conversations.values()].map((conversation) => structuredClone(conversation));
  }

  private recordEvent(conversationId: string, event: AgentEvent): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.status === "closed") return;
    const content = "content" in event && typeof event.content === "string" ? event.content : "";
    if (content && event.type !== "delta" && event.type !== "completed") {
      const at = this.deps.now();
      if (event.type === "approval_response" || event.type === "user_input_response") {
        const requestType = event.type === "approval_response" ? "approval_request" : "user_input_request";
        const pending = [...conversation.messages].reverse().find((message) => message.event?.type === requestType && message.event.requestId === event.requestId && message.event.requestState === "live");
        if (pending?.event) pending.event.requestState = "resolved";
      }
      this.appendMessage(conversation, event.type === "tool_call" || event.type === "tool_result" ? "tool" : "assistant", content, at, event.type, "name" in event && typeof event.name === "string" ? event.name : undefined, workflowNodeChatEvent(event, `${conversation.conversationId}:event:${conversation.messages.length + 1}`, at));
    }
    if (event.type === "delta") {
      const last = conversation.messages.at(-1);
      if (last?.role === "assistant" && last.eventType === "delta") {
        last.content += event.content;
        last.at = this.deps.now();
        conversation.lastActivityAt = last.at;
      } else {
        this.appendMessage(conversation, "assistant", event.content, this.deps.now(), event.type);
      }
    }
    if (event.type === "completed") {
      const finalContent = (event.content || (conversation.messages.at(-1)?.eventType === "delta" ? conversation.messages.at(-1)?.content : "") || "").trim();
      this.deps.onCompleted?.(structuredClone(conversation), finalContent);
    }
    if (event.type === "error") conversation.status = "failed";
    this.syncRuntimeConversation(conversationId);
    this.changed(conversation);
  }

  private syncRuntimeConversation(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    const session = this.sessions.get(conversationId);
    if (!conversation || !session || conversation.status === "closed") return;
    const runtimeConversation = session.runtimeConversation();
    if (runtimeConversation) conversation.runtimeConversation = structuredClone(runtimeConversation);
  }

  private appendMessage(conversation: WorkflowNodeConversation, role: WorkflowNodeMessage["role"], content: string, at: number, eventType?: AgentEvent["type"], name?: string, event?: ChatEvent): void {
    conversation.messages.push({ id: `${conversation.conversationId}:${conversation.messages.length + 1}`, role, content, at, ...(eventType ? { eventType } : {}), ...(name ? { name } : {}), ...(event ? { event } : {}) });
    conversation.updatedAt = at;
    conversation.lastActivityAt = at;
  }

  private changed(conversation: WorkflowNodeConversation): void {
    conversation.updatedAt = this.deps.now();
    this.deps.onChanged?.(structuredClone(conversation));
  }

  private mutableRequired(conversationId: string): WorkflowNodeConversation {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`Workflow node conversation ${conversationId} was not found.`);
    return conversation;
  }

  private getRequired(conversationId: string): WorkflowNodeConversation {
    return structuredClone(this.mutableRequired(conversationId));
  }

  private sessionForConversation(conversationId: string): WorkflowNodeInteractiveSession {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const input = this.restoredInputs.get(conversationId);
    if (input) {
      const session = this.deps.createSession({ ...input, emit: (event) => this.recordEvent(conversationId, event) });
      this.sessions.set(conversationId, session);
      this.restoredInputs.delete(conversationId);
      return session;
    }
    return this.sessionRequired(conversationId);
  }

  private sessionRequired(conversationId: string): WorkflowNodeInteractiveSession {
    const session = this.sessions.get(conversationId);
    if (!session) throw new Error(`Workflow node conversation session ${conversationId} was not found.`);
    return session;
  }
}

function workflowNodeChatEvent(event: AgentEvent, id: string, timestamp: number): ChatEvent | undefined {
  if (event.type === "runtime_conversation" || event.type === "delta" || event.type === "completed") return undefined;
  if (event.type === "error") return { id, type: "error", content: event.error, timestamp };
  return {
    id,
    type: event.type,
    content: event.content ?? "",
    timestamp,
    ...("name" in event && event.name ? { name: event.name } : {}),
    ...("fromAgentId" in event && event.fromAgentId ? { fromAgentId: event.fromAgentId } : {}),
    ...("toAgentId" in event && event.toAgentId ? { toAgentId: event.toAgentId } : {}),
    ...("requestId" in event ? { requestId: event.requestId } : {}),
    ...(event.type === "approval_request" || event.type === "user_input_request" ? { requestState: "live" as const } : {}),
    ...(event.type === "approval_response" ? { decision: event.decision } : {}),
    ...("metadata" in event && event.metadata ? { metadata: structuredClone(event.metadata) } : {}),
  };
}
