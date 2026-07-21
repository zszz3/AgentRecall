import { runtimeModelId } from "../../../shared/models";
import type { AgentEvent, ChatRuntimeSessionState, RuntimeConversation } from "../../../shared/types";
import type { InteractiveSession, InteractiveSessionContext, InteractiveSessionSnapshot } from "../runtime/runtime-driver";
import { ProcessLease } from "../shared/process-lease";
import { CodexRpcClient } from "./codex-rpc";
import { codexRuntimeStateCodec } from "./codex-runtime-state-codec";
import { planSessionReconfigure } from "../runtime/session-reconfigure";

interface CodexInteractiveSessionOptions {
  createCodexClient: (input: {
    context: InteractiveSessionContext;
    onEvent: (event: AgentEvent) => void;
    onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
  }) => CodexRpcClient;
  capabilities: ChatRuntimeSessionState["capabilities"];
  now?: () => number;
}

function modelFromContext(context: InteractiveSessionContext): string {
  return context.runtimeConfig.model;
}

export class CodexInteractiveSession implements InteractiveSession {
  private readonly lease = new ProcessLease();
  private readonly now: () => number;
  private client: CodexRpcClient | undefined;
  private runtimeConversation: RuntimeConversation | undefined;
  private attachmentState: ChatRuntimeSessionState["attachmentState"] = "detached";
  private attachmentGeneration = 0;
  private activeTurnId: string | undefined;
  private lastMeaningfulActivityAt: number | undefined;
  private pendingContext: InteractiveSessionContext | undefined;

  constructor(
    private context: InteractiveSessionContext,
    private readonly options: CodexInteractiveSessionOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.runtimeConversation = context.runtimeConversation
      ? codexRuntimeStateCodec.cloneConversation(context.runtimeConversation)
      : undefined;
  }

  reconfigure(context: InteractiveSessionContext): void {
    const plan = planSessionReconfigure(this.context, context);
    this.context = { ...this.context, ...plan.applyNow };
    if (plan.invalidateResume) {
      this.runtimeConversation = undefined;
    } else if (!this.client && context.runtimeConversation !== undefined) {
      this.runtimeConversation = codexRuntimeStateCodec.cloneConversation(context.runtimeConversation);
    }

    const nextContext = { ...this.context, ...plan.applyOnNextAttach };
    if (this.attachmentState === "running" && Object.keys(plan.applyOnNextAttach).length > 0) {
      this.pendingContext = nextContext;
      this.context.syncState?.(this.snapshot());
      return;
    }

    this.context = nextContext;
    this.pendingContext = undefined;
    this.context.syncState?.(this.snapshot());
  }

  async ensureAttached(): Promise<void> {
    if (this.client) return;

    const generation = this.lease.nextAttachmentGeneration();
    this.attachmentGeneration = generation;
    const client = this.options.createCodexClient({
      context: this.context,
      onEvent: (event) => {
        if (!this.lease.matchesAttachment(generation)) return;
        this.handleEvent(event);
      },
      onExit: (_code, _signal, _stderr) => {
        if (!this.lease.matchesAttachment(generation)) return;
        this.client = undefined;
        this.attachmentState = "detached";
        this.activeTurnId = undefined;
        this.touch();
        this.context.syncState?.(this.snapshot());
      },
    });
    this.client = client;

    try {
      await client.start();
      const existingThreadId = codexRuntimeStateCodec.decodeConversation(this.runtimeConversation)?.native.threadId;
      const modelId = modelFromContext(this.context);
      const approvalPolicy = this.context.planningWorkflowId ? "on-request" : "never";
      const threadResult = existingThreadId
        ? await client.request("thread/resume", {
            threadId: existingThreadId,
            model: runtimeModelId(modelId),
            modelProvider: null,
            cwd: this.context.workDir,
            approvalPolicy,
            config: null,
            baseInstructions: null,
            developerInstructions: this.context.developerInstructions,
          })
        : await client.request("thread/start", {
            model: runtimeModelId(modelId),
            modelProvider: null,
            profile: null,
            cwd: this.context.workDir,
            approvalPolicy,
            config: null,
            baseInstructions: null,
            developerInstructions: this.context.developerInstructions,
            compactPrompt: null,
            includeApplyPatchTool: null,
            experimentalRawEvents: true,
            persistExtendedHistory: true,
          });

      const threadId = (threadResult as { thread?: { id?: string } }).thread?.id;
      if (!threadId) throw new Error("Codex thread attach completed without a thread id.");
      this.runtimeConversation = codexRuntimeStateCodec.encodeConversation({
        native: { threadId },
        appContext: {
          cwd: this.context.workDir,
          modelId,
          approvalPolicy,
        },
      });
      this.context.emit({
        type: "runtime_conversation",
        runtimeConversation: this.runtimeConversation,
      });

      this.attachmentState = "idle";
      this.activeTurnId = undefined;
      this.touch();
      this.context.syncState?.(this.snapshot());
    } catch (error) {
      try {
        await client.shutdown();
      } catch {
        // Best effort cleanup after partial attach failure.
      }
      this.client = undefined;
      this.attachmentState = "detached";
      this.activeTurnId = undefined;
      this.touch();
      this.context.syncState?.(this.snapshot());
      throw error;
    }
  }

  async sendPrompt(prompt: string): Promise<void> {
    await this.ensureAttached();
    const client = this.client;
    if (!client) throw new Error("Codex interactive session is not attached.");

    this.attachmentState = "running";
    this.touch();
    this.context.syncState?.(this.snapshot());

    try {
      const result = await client.request("turn/start", {
        threadId: this.codexThreadId(),
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      const turnId = (result as { turn?: { id?: string } }).turn?.id;
      if (this.attachmentState === "running") {
        this.activeTurnId = turnId;
        this.context.syncState?.(this.snapshot());
      }
    } catch (error) {
      this.activeTurnId = undefined;
      this.attachmentState = this.client ? "idle" : "detached";
      this.touch();
      this.context.syncState?.(this.snapshot());
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.client) return;
    const activeTurnId = this.activeTurnId;
    this.attachmentState = "interrupted";
    this.activeTurnId = undefined;
    this.touch();
    this.context.syncState?.(this.snapshot());
    await this.client.interruptTurn(this.codexThreadId(), activeTurnId);
  }

  async detach(reason: "idle_timeout" | "app_shutdown" | "error"): Promise<void> {
    void reason;
    const client = this.client;
    this.client = undefined;
    try {
      await client?.shutdown();
    } finally {
      this.attachmentState = "detached";
      this.activeTurnId = undefined;
      this.applyPendingContextIfIdle();
      this.touch();
      this.context.syncState?.(this.snapshot());
    }
  }

  async detachIfStillExpired(input: {
    expectedGeneration: number;
    expectedLastMeaningfulActivityAt: number;
    reason: "idle_timeout" | "app_shutdown" | "error";
  }): Promise<void> {
    if (!this.lease.matchesAttachment(input.expectedGeneration)) return;
    if (this.lastMeaningfulActivityAt !== input.expectedLastMeaningfulActivityAt) return;
    if (this.attachmentState !== "idle" && this.attachmentState !== "interrupted") return;
    await this.detach(input.reason);
  }

  snapshot(): InteractiveSessionSnapshot {
    return {
      runtimeState: {
        executionStyle: "interactive",
        attachmentState: this.attachmentState,
        attachmentGeneration: this.attachmentGeneration,
        ...(this.activeTurnId ? { activeTurnId: this.activeTurnId } : {}),
        ...(this.lastMeaningfulActivityAt !== undefined ? { lastMeaningfulActivityAt: this.lastMeaningfulActivityAt } : {}),
        capabilities: this.options.capabilities,
      },
      ...(this.runtimeConversation ? { runtimeConversation: this.runtimeConversation } : {}),
    };
  }

  private handleEvent(event: AgentEvent): void {
    if (event.type === "completed") {
      this.attachmentState = "idle";
      this.activeTurnId = undefined;
      this.applyPendingContextIfIdle();
      this.touch();
    } else if (event.type === "error") {
      this.attachmentState = "interrupted";
      this.activeTurnId = undefined;
      this.applyPendingContextIfIdle();
      this.touch();
    } else if (event.type === "delta" || event.type === "meta" || event.type === "system" || event.type === "tool_call" || event.type === "tool_result" || event.type === "handoff") {
      this.touch();
    }

    this.context.emit(event);
    this.context.syncState?.(this.snapshot());
  }

  private codexThreadId(): string {
    const threadId = codexRuntimeStateCodec.decodeConversation(this.runtimeConversation)?.native.threadId;
    if (!threadId) {
      throw new Error("Codex interactive session is missing a thread id.");
    }
    return threadId;
  }

  private touch(): void {
    this.lastMeaningfulActivityAt = this.now();
  }

  private applyPendingContextIfIdle(): void {
    if (!this.pendingContext) return;
    if (this.attachmentState === "running") return;
    this.context = this.pendingContext;
    this.pendingContext = undefined;
  }
}
