import type { AgentEvent, ChatRuntimeSessionState, RuntimeConversation } from "../../../shared/types";
import type { AcpInteractiveClient } from "./acp-interactive-client";
import { ProcessLease } from "../shared/process-lease";
import type { InteractiveSession, InteractiveSessionContext, InteractiveSessionSnapshot } from "../runtime/runtime-driver";
import { planSessionReconfigure } from "../runtime/session-reconfigure";
import type { RuntimeStateCodec } from "../runtime/runtime-state-codec";
import type { AcpRuntimeConversationPayload } from "./acp-runtime-state-codec";

type AcpClientBinding = Pick<AcpInteractiveClient, "isAttached" | "attach" | "prompt" | "interrupt" | "detach">;

export interface AcpInteractiveSessionOptions {
  runtimeLabel: string;
  runtimeStateCodec: RuntimeStateCodec<AcpRuntimeConversationPayload>;
  capabilities: ChatRuntimeSessionState["capabilities"];
  createClient: (input: {
    context: InteractiveSessionContext;
    onEvent: (event: AgentEvent) => void;
    onExit: (error?: Error) => void;
  }) => AcpClientBinding;
  now?: () => number;
}

export class AcpInteractiveSession implements InteractiveSession {
  private readonly lease = new ProcessLease();
  private readonly now: () => number;
  private client: AcpClientBinding | undefined;
  private runtimeConversation: RuntimeConversation | undefined;
  private attachmentState: ChatRuntimeSessionState["attachmentState"] = "detached";
  private attachmentGeneration = 0;
  private activeTurnId: string | undefined;
  private lastMeaningfulActivityAt: number | undefined;
  private pendingContext: InteractiveSessionContext | undefined;
  private includeDeveloperInstructions = false;

  constructor(
    private context: InteractiveSessionContext,
    private readonly options: AcpInteractiveSessionOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.runtimeConversation = context.runtimeConversation
      ? options.runtimeStateCodec.cloneConversation(context.runtimeConversation)
      : undefined;
  }

  reconfigure(context: InteractiveSessionContext): void {
    const plan = planSessionReconfigure(this.context, context);
    this.context = { ...this.context, ...plan.applyNow };
    if (plan.invalidateResume) {
      this.runtimeConversation = undefined;
    } else if (!this.client && context.runtimeConversation !== undefined) {
      this.runtimeConversation = this.options.runtimeStateCodec.cloneConversation(context.runtimeConversation);
    }
    const nextContext = { ...this.context, ...plan.applyOnNextAttach };
    if (Object.keys(plan.applyOnNextAttach).length > 0 && this.attachmentState === "running") {
      this.pendingContext = nextContext;
      this.context.syncState?.(this.snapshot());
      return;
    }
    this.context = nextContext;
    this.pendingContext = undefined;
    this.context.syncState?.(this.snapshot());
  }

  async ensureAttached(): Promise<void> {
    if (this.pendingContext && this.attachmentState !== "running") {
      await this.client?.detach();
      this.client = undefined;
      this.attachmentState = "detached";
      this.applyPendingContext();
    }
    if (this.client?.isAttached()) return;

    const generation = this.lease.nextAttachmentGeneration();
    this.attachmentGeneration = generation;
    this.attachmentState = "idle";
    this.touch();
    this.context.syncState?.(this.snapshot());
    const client = this.options.createClient({
      context: this.context,
      onEvent: (event) => {
        if (this.lease.matchesAttachment(generation)) this.handleEvent(event);
      },
      onExit: () => {
        if (!this.lease.matchesAttachment(generation)) return;
        this.client = undefined;
        this.attachmentState = "detached";
        this.activeTurnId = undefined;
        this.touch();
        this.context.syncState?.(this.snapshot());
      },
    });
    this.client = client;

    const resumeSessionId = this.options.runtimeStateCodec.decodeConversation(this.runtimeConversation)?.native.sessionId;
    try {
      const sessionId = await client.attach(resumeSessionId);
      this.includeDeveloperInstructions = !resumeSessionId;
      this.runtimeConversation = this.options.runtimeStateCodec.encodeConversation({
        native: { sessionId },
        appContext: {
          cwd: this.context.workDir,
          modelId: this.context.runtimeConfig.model,
          transport: "acp",
        },
      });
      this.context.emit({ type: "runtime_conversation", runtimeConversation: this.runtimeConversation });
      this.attachmentState = "idle";
      this.touch();
      this.context.syncState?.(this.snapshot());
    } catch (error) {
      await client.detach();
      this.client = undefined;
      this.attachmentState = "detached";
      this.touch();
      this.context.syncState?.(this.snapshot());
      throw error;
    }
  }

  async sendPrompt(prompt: string): Promise<void> {
    await this.ensureAttached();
    const client = this.client;
    if (!client) throw new Error(`${this.options.runtimeLabel} interactive session is not attached.`);
    this.activeTurnId = this.lease.nextTurnId();
    this.attachmentState = "running";
    this.touch();
    this.context.syncState?.(this.snapshot());
    const instructions = this.context.developerInstructions.trim();
    const runtimePrompt = this.includeDeveloperInstructions && instructions
      ? `${instructions}\n\nUser request:\n${prompt}`
      : prompt;
    try {
      await client.prompt(runtimePrompt);
      this.includeDeveloperInstructions = false;
    } catch (error) {
      this.activeTurnId = undefined;
      this.attachmentState = this.client?.isAttached() ? "idle" : "detached";
      this.touch();
      this.context.syncState?.(this.snapshot());
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    this.attachmentState = "interrupted";
    this.activeTurnId = undefined;
    this.touch();
    this.context.syncState?.(this.snapshot());
    await this.client?.interrupt();
  }

  async detach(reason: "idle_timeout" | "app_shutdown" | "error"): Promise<void> {
    void reason;
    const client = this.client;
    this.client = undefined;
    try {
      await client?.detach();
    } finally {
      this.attachmentState = "detached";
      this.activeTurnId = undefined;
      this.applyPendingContext();
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
      this.applyPendingContext();
    } else if (event.type === "error") {
      this.attachmentState = "interrupted";
      this.activeTurnId = undefined;
      this.applyPendingContext();
    }
    this.touch();
    this.context.emit(event);
    this.context.syncState?.(this.snapshot());
  }

  private touch(): void {
    this.lastMeaningfulActivityAt = this.now();
  }

  private applyPendingContext(): void {
    if (!this.pendingContext || this.attachmentState === "running") return;
    this.context = this.pendingContext;
    this.pendingContext = undefined;
  }
}
