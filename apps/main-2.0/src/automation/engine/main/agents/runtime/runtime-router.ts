import { randomUUID } from "node:crypto";
import type { AgentExecutionContext, AgentExecutor } from "../../hub/runtime/executor/agent-executor";
import type {
  AgentEvent,
  AgentId,
  AgentRuntime,
  RuntimeContinuationPolicy,
  RuntimeConversation,
  RuntimeExecutionMode,
  RuntimeExecutionReference,
  RuntimeInvocationRequest,
} from "../../../shared/types";
import {
  RuntimeDriverRegistry,
} from "./runtime-driver";
import type {
  InteractiveSession,
  InteractiveSessionContext,
  RuntimeChannelTestContext,
  RuntimeDriver,
  RuntimeSessionCleanupContext,
  RuntimeSurface,
  RuntimeWorkflowRequestContext,
} from "./runtime-driver";
import type { RuntimeCapabilities } from "./runtime-capabilities";
import type { RuntimeStateCodec } from "./runtime-state-codec";
import {
  NOOP_RUNTIME_INVOCATION_RECORDER,
  type RuntimeInvocationRecorder,
  type RuntimeInvocationStatus,
  type RuntimeSessionRelation,
} from "./runtime-invocation-recorder";

type RuntimeRequestLike = {
  runtimeId: AgentId;
  executionMode: RuntimeExecutionMode;
  continuationPolicy: RuntimeContinuationPolicy;
  runtimeConversation?: RuntimeConversation;
};

export class RuntimeRouter {
  constructor(
    private readonly registry: RuntimeDriverRegistry,
    private readonly invocationRecorder: RuntimeInvocationRecorder = NOOP_RUNTIME_INVOCATION_RECORDER,
    private readonly now: () => number = () => Date.now(),
    private readonly createInvocationId: () => string = () => randomUUID(),
  ) {}

  capabilitiesFor(runtime: AgentRuntime): RuntimeCapabilities {
    return this.registry.driverFor(runtime.id).getCapabilities(runtime);
  }

  supportsSurface(runtimeId: AgentId, surface: RuntimeSurface): boolean {
    return this.registry
      .maybeDriverFor(runtimeId)
      ?.surfaceSupport.some((item) => item.surface === surface) ?? false;
  }

  createOneShotExecutor(context: AgentExecutionContext): AgentExecutor {
    const surface: RuntimeSurface = context.runKind === "chat" ? "chat" : "task";
    const { driver, input } = this.validateRequest(surface, context);
    if (!driver.createOneShotExecutor) {
      throw new Error(`${context.runtimeId} runtime does not provide one-shot execution for ${surface}.`);
    }
    let lifecycle: RuntimeInvocationLifecycle | undefined;
    let cancelling = false;
    const emit = input.emit;
    const onExit = input.onExit;
    const wrappedInput: AgentExecutionContext = {
      ...input,
      emit: (event) => {
        if (lifecycle) this.observeAgentEvent(lifecycle, event, cancelling);
        emit(event);
      },
      onExit: (code) => {
        if (lifecycle && !lifecycle.isFinished()) {
          void lifecycle.finish(code && code !== 0 ? "failed" : "completed");
        }
        onExit(code);
      },
    };
    const executor = driver.createOneShotExecutor(wrappedInput);
    return {
      start: async () => {
        lifecycle = this.createLifecycle(input, input.channelId);
        await lifecycle.begin(input.runtimeConversation);
        try {
          await executor.start();
        } catch (error) {
          await lifecycle.finish(this.statusForError(error), error);
          throw error;
        }
      },
      stop: async () => {
        cancelling = true;
        try {
          await executor.stop();
        } finally {
          await lifecycle?.finish("cancelled");
        }
      },
    };
  }

  createInteractiveSession(context: InteractiveSessionContext): InteractiveSession {
    const { driver, input } = this.validateRequest("chat", context);
    if (!driver.createInteractiveSession) {
      throw new Error(`${context.runtimeId} runtime does not provide interactive chat sessions.`);
    }
    let currentInput = input;
    let lifecycle: RuntimeInvocationLifecycle | undefined;
    let cancelling = false;
    const wrap = (next: InteractiveSessionContext): InteractiveSessionContext => ({
      ...next,
      emit: (event) => {
        if (lifecycle) this.observeAgentEvent(lifecycle, event, cancelling);
        next.emit(event);
      },
    });
    const session = driver.createInteractiveSession(wrap(input));
    const ensureInvocation = async (): Promise<RuntimeInvocationLifecycle> => {
      if (lifecycle && !lifecycle.isFinished()) return lifecycle;
      cancelling = false;
      lifecycle = this.createLifecycle(currentInput, currentInput.channelId);
      await lifecycle.begin(currentInput.runtimeConversation);
      return lifecycle;
    };
    return {
      reconfigure: (next) => {
        currentInput = next;
        session.reconfigure(wrap(next));
      },
      ensureAttached: async () => {
        const active = await ensureInvocation();
        try {
          await session.ensureAttached();
        } catch (error) {
          await active.finish(this.statusForError(error), error);
          throw error;
        }
      },
      sendPrompt: async (prompt) => {
        const active = await ensureInvocation();
        try {
          await session.sendPrompt(prompt);
          await active.finish("completed");
        } catch (error) {
          await active.finish(this.statusForError(error), error);
          throw error;
        }
      },
      interrupt: async () => {
        cancelling = true;
        try {
          await session.interrupt();
        } finally {
          await lifecycle?.finish("cancelled");
        }
      },
      detach: async (reason) => {
        try {
          await session.detach(reason);
        } finally {
          if (lifecycle && !lifecycle.isFinished()) {
            await lifecycle.finish(reason === "error" ? "failed" : "cancelled");
          }
        }
      },
      detachIfStillExpired: (detachInput) => session.detachIfStillExpired(detachInput),
      snapshot: () => session.snapshot(),
    };
  }

  async askWorkflow(input: RuntimeWorkflowRequestContext) {
    const { driver, input: normalizedInput } = this.validateRequest("workflow", input);
    if (!driver.askWorkflow) {
      throw new Error(`${input.runtimeId} runtime does not provide workflow execution.`);
    }
    const lifecycle = this.createLifecycle(normalizedInput, normalizedInput.channelId);
    await lifecycle.begin(normalizedInput.runtimeConversation);
    const reportExecutionReference = normalizedInput.reportExecutionReference;
    try {
      const response = await driver.askWorkflow({
        ...normalizedInput,
        reportExecutionReference: (reference) => {
          lifecycle.bindReference(reference);
          reportExecutionReference?.(reference);
        },
        onEvent: (event) => {
          if (event.type === "completed" && event.runtimeConversation) {
            lifecycle.bindConversation(event.runtimeConversation);
          }
          normalizedInput.onEvent?.(event);
        },
      });
      if (response.runtimeConversation) lifecycle.bindConversation(response.runtimeConversation);
      if (response.executionReference) lifecycle.bindReference(response.executionReference);
      await lifecycle.finish("completed");
      return response;
    } catch (error) {
      await lifecycle.finish(this.statusForError(error, normalizedInput.signal), error);
      throw error;
    }
  }

  async testChannel(runtimeId: AgentId, input: RuntimeChannelTestContext): Promise<string> {
    const driver = this.validateSurface(runtimeId, "channel-test");
    if (!driver.testChannel) {
      throw new Error(`${runtimeId} runtime testing is not configured.`);
    }
    const lifecycle = this.createLifecycle({
      runtimeId,
      continuationPolicy: "fresh",
      invocation: {
        surface: "system",
        role: "channel_test",
        ownerReference: { channelId: input.channelId },
      },
    }, input.channelId);
    await lifecycle.begin();
    try {
      const result = await driver.testChannel(input);
      await lifecycle.finish("completed");
      return result;
    } catch (error) {
      await lifecycle.finish(this.statusForError(error), error);
      throw error;
    }
  }

  async deleteSessionArtifacts(runtimeId: AgentId, input: RuntimeSessionCleanupContext): Promise<void> {
    const driver = this.validateSurface(runtimeId, "cleanup");
    if (!driver.deleteSessionArtifacts) {
      throw new Error(`${runtimeId} runtime cleanup is not configured.`);
    }
    const runtimeConversation = input.runtimeConversation
      ? this.cloneOwnedConversation(runtimeId, input.runtimeConversation)
      : undefined;
    await driver.deleteSessionArtifacts({
      workDir: input.workDir,
      ...(runtimeConversation ? { runtimeConversation } : {}),
    });
  }

  shutdown(): Promise<void> {
    return this.registry.shutdown();
  }

  restorePersistedConversation(raw: unknown): RuntimeConversation | undefined {
    const envelope = this.asRuntimeConversationEnvelope(raw);
    if (!envelope) return undefined;
    const driver = this.registry.maybeDriverFor(envelope.runtimeId);
    if (!driver?.runtimeStateCodec) return undefined;
    return driver.runtimeStateCodec.restorePersistedConversation(raw);
  }

  cloneConversation(conversation: RuntimeConversation): RuntimeConversation {
    const driver = this.registry.maybeDriverFor(conversation.runtimeId);
    if (!driver) {
      throw new Error(`No runtime driver registered for ${conversation.runtimeId}`);
    }
    const codec = this.requireRuntimeStateCodec(driver, conversation.runtimeId);
    const cloned = codec.cloneConversation(conversation);
    if (!cloned) {
      throw new Error(`Invalid ${conversation.runtimeId} runtime conversation envelope.`);
    }
    return cloned;
  }

  private validateRequest<T extends RuntimeRequestLike>(
    surface: RuntimeSurface,
    input: T,
  ): { driver: RuntimeDriver; input: T } {
    const driver = this.validateSurface(input.runtimeId, surface);
    const support = driver.surfaceSupport.find((item) => item.surface === surface);
    const executionMode = input.executionMode;
    const continuationPolicy = input.continuationPolicy;
    const supported =
      support?.executionModes.includes(executionMode) &&
      support.continuationPolicies.includes(continuationPolicy);
    if (!supported) {
      throw new Error(`${input.runtimeId} does not support ${surface} ${executionMode} with continuation policy ${continuationPolicy}.`);
    }
    if (continuationPolicy === "resume-required" && !input.runtimeConversation) {
      throw new Error(`${input.runtimeId} ${surface} ${executionMode} requires runtimeConversation for continuation policy resume-required.`);
    }
    if (continuationPolicy !== "fresh" && !driver.runtimeStateCodec) {
      throw new Error(`${input.runtimeId} does not support ${surface} ${executionMode} with continuation policy ${continuationPolicy}.`);
    }
    if (!input.runtimeConversation) {
      return { driver, input };
    }
    this.assertConversationOwnership(input.runtimeId, input.runtimeConversation);
    if (continuationPolicy === "fresh") {
      const { runtimeConversation: _ignored, ...rest } = input;
      return { driver, input: rest as T };
    }
    const runtimeConversation = this.cloneConversation(input.runtimeConversation);
    return {
      driver,
      input: {
        ...input,
        runtimeConversation,
      } as T,
    };
  }

  private validateSurface(runtimeId: AgentId, surface: RuntimeSurface): RuntimeDriver {
    const driver = this.registry.driverFor(runtimeId);
    if (!driver.surfaceSupport.some((item) => item.surface === surface)) {
      throw new Error(`${runtimeId} runtime does not support ${surface}.`);
    }
    return driver;
  }

  private asRuntimeConversationEnvelope(raw: unknown): RuntimeConversation | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    if (typeof record.runtimeId !== "string") return undefined;
    if (typeof record.codecVersion !== "string") return undefined;
    if (!Object.prototype.hasOwnProperty.call(record, "payload")) return undefined;
    return {
      runtimeId: record.runtimeId as AgentId,
      codecVersion: record.codecVersion,
      payload: structuredClone(record.payload),
    };
  }

  private requireRuntimeStateCodec(driver: RuntimeDriver, runtimeId: AgentId): RuntimeStateCodec<unknown> {
    if (!driver.runtimeStateCodec) {
      throw new Error(`${runtimeId} runtime does not support persisted runtime conversations.`);
    }
    return driver.runtimeStateCodec;
  }

  private cloneOwnedConversation(runtimeId: AgentId, conversation: RuntimeConversation): RuntimeConversation {
    this.assertConversationOwnership(runtimeId, conversation);
    return this.cloneConversation(conversation);
  }

  private assertConversationOwnership(runtimeId: AgentId, conversation: RuntimeConversation): void {
    if (conversation.runtimeId !== runtimeId) {
      throw new Error(`${runtimeId} cannot use runtimeConversation owned by ${conversation.runtimeId}.`);
    }
  }

  private createLifecycle(
    input: {
      runtimeId: AgentId;
      continuationPolicy: RuntimeContinuationPolicy;
      runtimeConversation?: RuntimeConversation;
      invocation: RuntimeInvocationRequest;
    },
    channelId?: string,
  ): RuntimeInvocationLifecycle {
    return new RuntimeInvocationLifecycle({
      recorder: this.invocationRecorder,
      invocationId: this.createInvocationId(),
      invocation: input.invocation,
      runtimeId: input.runtimeId,
      channelId,
      relation: input.runtimeConversation ? "continued" : "created",
      now: this.now,
      sessionIdFromConversation: (conversation) => this.sessionIdFromConversation(conversation),
    });
  }

  private observeAgentEvent(
    lifecycle: RuntimeInvocationLifecycle,
    event: AgentEvent,
    cancelling: boolean,
  ): void {
    if (event.type === "runtime_conversation") lifecycle.bindConversation(event.runtimeConversation);
    else if (event.type === "completed") void lifecycle.finish("completed");
    else if (event.type === "error") {
      void lifecycle.finish(cancelling ? "cancelled" : this.statusForError(event.error), event.error);
    }
  }

  private sessionIdFromConversation(conversation: RuntimeConversation): string | undefined {
    const payload = conversation.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const native = (payload as Record<string, unknown>).native;
    if (!native || typeof native !== "object" || Array.isArray(native)) return undefined;
    const record = native as Record<string, unknown>;
    const value = conversation.runtimeId === "codex" ? record.threadId : record.sessionId;
    return typeof value === "string" && value ? value : undefined;
  }

  private statusForError(error: unknown, signal?: AbortSignal): Exclude<RuntimeInvocationStatus, "pending" | "completed"> {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "TimeoutError" || /timed out|timeout/iu.test(message)) return "timed_out";
    if (signal?.aborted || name === "AbortError" || /interrupt|cancel/iu.test(message)) return "cancelled";
    return "failed";
  }
}

class RuntimeInvocationLifecycle {
  private writeQueue: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(private readonly options: {
    recorder: RuntimeInvocationRecorder;
    invocationId: string;
    invocation: RuntimeInvocationRequest;
    runtimeId: AgentId;
    channelId?: string;
    relation: RuntimeSessionRelation;
    now: () => number;
    sessionIdFromConversation: (conversation: RuntimeConversation) => string | undefined;
  }) {}

  async begin(conversation?: RuntimeConversation): Promise<void> {
    await this.options.recorder.begin({
      id: this.options.invocationId,
      initiator: "agentrecall",
      invocation: this.options.invocation,
      runtimeId: this.options.runtimeId,
      ...(this.options.channelId ? { channelId: this.options.channelId } : {}),
      environmentId: "local",
      startedAt: this.options.now(),
    });
    if (conversation) {
      const sessionId = this.options.sessionIdFromConversation(conversation);
      if (sessionId) await this.bindReference({ sessionId });
    }
  }

  bindConversation(conversation: RuntimeConversation): void {
    const sessionId = this.options.sessionIdFromConversation(conversation);
    if (sessionId) void this.bindReference({ sessionId });
  }

  async bindReference(reference: RuntimeExecutionReference): Promise<void> {
    if (!reference.sessionId) return;
    const binding = {
      runtimeId: this.options.runtimeId,
      ...(this.options.channelId ? { channelId: this.options.channelId } : {}),
      environmentId: "local",
      sessionId: reference.sessionId,
      ...(reference.turnId ? { turnId: reference.turnId } : {}),
      relation: this.options.relation,
      boundAt: this.options.now(),
    } as const;
    this.writeQueue = this.writeQueue.then(() =>
      this.options.recorder.bind(this.options.invocationId, binding));
    await this.writeQueue;
  }

  isFinished(): boolean {
    return this.finished;
  }

  async finish(
    status: Exclude<RuntimeInvocationStatus, "pending">,
    error?: unknown,
  ): Promise<void> {
    if (this.finished) return this.writeQueue;
    this.finished = true;
    const message = error === undefined
      ? undefined
      : error instanceof Error
        ? error.message
        : String(error);
    this.writeQueue = this.writeQueue.then(() => this.options.recorder.finish(
      this.options.invocationId,
      status,
      this.options.now(),
      message,
    ));
    await this.writeQueue;
  }
}
