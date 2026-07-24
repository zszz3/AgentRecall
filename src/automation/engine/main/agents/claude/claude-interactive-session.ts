import type { ChatRuntimeSessionState, RuntimeConversation } from "../../../shared/types";
import type { InteractiveSession, InteractiveSessionContext, InteractiveSessionSnapshot } from "../runtime/runtime-driver";
import { ClaudeAgentSdkInteractive } from "./claude-agent-sdk-interactive";
import { ProcessLease } from "../shared/process-lease";
import { claudeRuntimeStateCodec } from "./claude-runtime-state-codec";
import { planSessionReconfigure } from "../runtime/session-reconfigure";
import type { RuntimeApprovalRequester } from "../../approvals/runtime-approval-broker";
import { workflowMcpScopeForContext } from "../../../shared/workflow-mcp-policy";

type ClaudeInteractiveSdkBinding = Pick<
  ClaudeAgentSdkInteractive,
  "isAttached" | "attach" | "sendUserMessage" | "interrupt" | "detach"
>;

interface ClaudeInteractiveSessionOptions {
  sdkInteractive: ClaudeInteractiveSdkBinding;
  capabilities: ChatRuntimeSessionState["capabilities"];
  resolveModelId?: (context: InteractiveSessionContext) => string | undefined;
  resolveEnvironment?: (context: InteractiveSessionContext) => NodeJS.ProcessEnv;
  resolveMcpServers?: (context: InteractiveSessionContext) => Parameters<ClaudeAgentSdkInteractive["attach"]>[0]["mcpServers"];
  now?: () => number;
  requestApproval?: RuntimeApprovalRequester;
}

function modelFromContext(context: InteractiveSessionContext): string {
  return context.runtimeConfig.model;
}

function claudeSessionIdFromRuntimeConversation(conversation: RuntimeConversation | undefined): string | undefined {
  return claudeRuntimeStateCodec.decodeConversation(conversation)?.native.sessionId;
}

export class ClaudeInteractiveSession implements InteractiveSession {
  private readonly lease = new ProcessLease();
  private readonly now: () => number;
  private readonly sdkInteractive: ClaudeInteractiveSdkBinding;
  private runtimeConversation: RuntimeConversation | undefined;
  private attachmentState: ChatRuntimeSessionState["attachmentState"] = "detached";
  private attachmentGeneration = 0;
  private activeTurnId: string | undefined;
  private lastMeaningfulActivityAt: number | undefined;
  private pendingContext: InteractiveSessionContext | undefined;

  constructor(
    private context: InteractiveSessionContext,
    private readonly options: ClaudeInteractiveSessionOptions,
  ) {
    this.sdkInteractive = options.sdkInteractive;
    this.now = options.now ?? (() => Date.now());
    this.runtimeConversation = context.runtimeConversation
      ? claudeRuntimeStateCodec.cloneConversation(context.runtimeConversation)
      : undefined;
  }

  reconfigure(context: InteractiveSessionContext): void {
    const plan = planSessionReconfigure(this.context, context);
    this.context = { ...this.context, ...plan.applyNow };
    if (plan.invalidateResume) {
      this.runtimeConversation = undefined;
    } else if (context.runtimeConversation !== undefined) {
      this.runtimeConversation = claudeRuntimeStateCodec.cloneConversation(context.runtimeConversation);
    }

    const nextContext = { ...this.context, ...plan.applyOnNextAttach };
    if (
      Object.keys(plan.applyOnNextAttach).length > 0 &&
      (this.attachmentState === "running" || this.sdkInteractive.isAttached())
    ) {
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
      if (this.sdkInteractive.isAttached()) {
        await this.sdkInteractive.detach();
      }
      this.attachmentState = "detached";
      this.applyPendingContextAfterDetach();
    }

    if (this.sdkInteractive.isAttached()) return;
    if (this.attachmentState !== "detached") return;

    const generation = this.lease.nextAttachmentGeneration();
    this.attachmentGeneration = generation;
    this.attachmentState = "idle";
    this.touch();
    this.context.syncState?.(this.snapshot());

    const modelId = this.options.resolveModelId?.(this.context) ?? modelFromContext(this.context);
    const resumeSessionId = claudeRuntimeStateCodec.decodeConversation(this.runtimeConversation)?.native.sessionId;
    const mcpServers = this.options.resolveMcpServers?.(this.context);

    await this.sdkInteractive.attach({
      cwd: this.context.workDir,
      modelId,
      developerInstructions: this.context.developerInstructions,
      ...(this.options.resolveEnvironment ? { env: this.options.resolveEnvironment(this.context) } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      approvalOwnerId: this.context.chatId,
      ...(workflowMcpScopeForContext(this.context) ? { workflowMcpScope: workflowMcpScopeForContext(this.context) } : {}),
      ...(this.options.requestApproval ? { requestApproval: this.options.requestApproval } : {}),
      onEvent: (event) => {
        if (!this.lease.matchesAttachment(generation)) return;
        if (event.type !== "runtime_conversation" && this.activeTurnId === undefined) return;
        this.handleEvent(event);
      },
    });
  }

  async sendPrompt(prompt: string): Promise<void> {
    await this.ensureAttached();
    this.activeTurnId = this.lease.nextTurnId();
    this.attachmentState = "running";
    this.touch();
    this.context.syncState?.(this.snapshot());

    try {
      await this.sdkInteractive.sendUserMessage(prompt);
    } catch (error) {
      this.activeTurnId = undefined;
      this.attachmentState = "idle";
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
    await this.sdkInteractive.interrupt();
  }

  async detach(reason: "idle_timeout" | "app_shutdown" | "error"): Promise<void> {
    void reason;
    await this.sdkInteractive.detach();
    this.attachmentState = "detached";
    this.activeTurnId = undefined;
    this.applyPendingContextAfterDetach();
    this.touch();
    this.context.syncState?.(this.snapshot());
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

  private handleEvent(event: { type: string } & Record<string, unknown>): void {
    if (event.type === "runtime_conversation") {
      const sessionId = claudeSessionIdFromRuntimeConversation(event.runtimeConversation as RuntimeConversation | undefined);
      if (!sessionId) return;
      this.refreshClaudeRuntimeConversation(sessionId);
      this.touch();
      this.context.emit({
        type: "runtime_conversation",
        runtimeConversation: this.runtimeConversation!,
      });
      this.context.syncState?.(this.snapshot());
      return;
    } else if (event.type === "completed") {
      this.attachmentState = "idle";
      this.activeTurnId = undefined;
      this.touch();
    } else if (event.type === "error") {
      this.attachmentState = "interrupted";
      this.activeTurnId = undefined;
      this.touch();
    } else {
      this.touch();
    }

    this.context.emit(event as never);
    this.context.syncState?.(this.snapshot());
  }

  private touch(): void {
    this.lastMeaningfulActivityAt = this.now();
  }

  private refreshClaudeRuntimeConversation(sessionId: string): void {
    const previousPayload = claudeRuntimeStateCodec.decodeConversation(this.runtimeConversation);
    const previousNative = previousPayload?.native;
    const previousAppContext = previousPayload?.appContext;
    const modelId = modelFromContext(this.context);

    this.runtimeConversation = claudeRuntimeStateCodec.encodeConversation({
      native: {
        sessionId,
        ...(previousNative?.projectKey !== undefined ? { projectKey: previousNative.projectKey } : {}),
        ...(previousNative?.subpaths !== undefined ? { subpaths: [...previousNative.subpaths] } : {}),
      },
      appContext: {
        cwd: this.context.workDir,
        modelId,
        ...(previousAppContext?.claudeConfigDir !== undefined ? { claudeConfigDir: previousAppContext.claudeConfigDir } : {}),
        ...(previousAppContext?.sessionStoreRef !== undefined ? { sessionStoreRef: previousAppContext.sessionStoreRef } : {}),
      },
      ...(previousPayload?.extensions ? { extensions: { ...previousPayload.extensions } } : {}),
    });
  }

  private applyPendingContextAfterDetach(): void {
    if (!this.pendingContext) return;
    this.context = this.pendingContext;
    this.pendingContext = undefined;
  }
}
