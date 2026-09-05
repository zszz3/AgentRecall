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
  InteractiveSessionInterruption,
  RuntimeChannelTestContext,
  RuntimeDriver,
  RuntimeSessionCleanupContext,
  RuntimeSurface,
  RuntimeWorkflowRequestContext,
} from "./runtime-driver";
import type { RuntimeCapabilities } from "./runtime-capabilities";
import type { RuntimeStateCodec } from "./runtime-state-codec";
import {
  MISSING_RUNTIME_INVOCATION_RECORDER,
  runtimeInvocationErrorMessage,
  type RuntimeInvocationRecorder,
  type RuntimeInvocationStatus,
  type RuntimeSessionRelation,
} from "./runtime-invocation-recorder";

const MAX_RUNTIME_REFERENCE_CHARACTERS = 1_000;

type RuntimeRequestLike = {
  runtimeId: AgentId;
  executionMode: RuntimeExecutionMode;
  continuationPolicy: RuntimeContinuationPolicy;
  runtimeConversation?: RuntimeConversation;
  invocationId?: string;
  environmentId?: string;
};

export class RuntimeRouter {
  constructor(
    private readonly registry: RuntimeDriverRegistry,
    private readonly invocationRecorder: RuntimeInvocationRecorder = MISSING_RUNTIME_INVOCATION_RECORDER,
    private readonly now: () => number = () => Date.now(),
    private readonly createInvocationId: () => string = () => randomUUID(),
  ) {}

  capabilitiesFor(runtime: AgentRuntime): RuntimeCapabilities {
    return this.registry.driverFor(runtime.id).getCapabilities(runtime);
  }

  /** Returns whether a registered Runtime can serve the requested application surface. */
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
    const invocationId = this.createInvocationId();
    let lifecycle: RuntimeInvocationLifecycle | undefined;
    let cancelling = false;
    let exitDelivered = false;
    let persistenceFailureReported = false;
    let callbackQueue = Promise.resolve();
    const emit = input.emit;
    const onExit = input.onExit;
    const reportPersistenceFailure = (error: unknown): void => {
      if (persistenceFailureReported) return;
      persistenceFailureReported = true;
      const message = error instanceof Error ? error.message : String(error);
      emit({
        type: "error",
        error: `Runtime invocation tracking failed: ${message}`,
        invocationId,
      });
      if (!exitDelivered) {
        exitDelivered = true;
        onExit(1);
      }
    };
    const enqueue = (operation: () => Promise<void>): void => {
      callbackQueue = callbackQueue.then(operation).catch((error) => {
        reportPersistenceFailure(error);
      });
    };
    const wrappedInput: AgentExecutionContext = {
      ...input,
      invocationId,
      emit: (event) => {
        enqueue(async () => {
          if (lifecycle) {
            await this.observeAgentEvent(
              lifecycle,
              event,
              cancelling ? { status: "cancelled" } : undefined,
            );
          }
          emit({ ...event, invocationId });
        });
      },
      onExit: (code) => {
        enqueue(async () => {
          if (lifecycle) {
            const status: Exclude<RuntimeInvocationStatus, "pending"> =
              code === null || cancelling ? "cancelled" : code !== 0 ? "failed" : "completed";
            await lifecycle.finish(status);
          }
          if (exitDelivered) return;
          exitDelivered = true;
          onExit(code);
        });
      },
    };
    const executor = driver.createOneShotExecutor(wrappedInput);
    return {
      start: async () => {
        lifecycle = this.createLifecycle({ ...input, invocationId }, input.channelId);
        await lifecycle.begin();
        try {
          await executor.start();
          await callbackQueue;
        } catch (error) {
          try {
            await callbackQueue;
          } finally {
            await lifecycle.finish(this.statusForError(error), error);
          }
          throw error;
        }
      },
      stop: async () => {
        cancelling = true;
        try {
          await executor.stop();
          await callbackQueue;
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
    let interruption: InteractiveSessionInterruption | undefined;
    let callbackQueue = Promise.resolve();
    const wrap = (next: InteractiveSessionContext): InteractiveSessionContext => ({
      ...next,
      emit: (event) => {
        callbackQueue = callbackQueue.then(async () => {
          if (lifecycle) await this.observeAgentEvent(lifecycle, event, interruption);
          next.emit({ ...event, ...(lifecycle ? { invocationId: lifecycle.id } : {}) });
        });
        void callbackQueue.catch(() => undefined);
      },
    });
    const session = driver.createInteractiveSession(wrap(input));
    const ensureInvocation = async (): Promise<RuntimeInvocationLifecycle> => {
      if (lifecycle && !lifecycle.isFinished()) return lifecycle;
      interruption = undefined;
      lifecycle = this.createLifecycle(currentInput, currentInput.channelId);
      await lifecycle.begin();
      currentInput = { ...currentInput, invocationId: lifecycle.id };
      session.reconfigure(wrap(currentInput));
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
          await callbackQueue;
        } catch (error) {
          try {
            await callbackQueue;
          } finally {
            await active.finish(
              interruption?.status ?? this.statusForError(error),
              interruption?.error ?? error,
            );
          }
          throw error;
        }
      },
      sendPrompt: async (prompt) => {
        const active = await ensureInvocation();
        try {
          await session.sendPrompt(prompt);
          await callbackQueue;
          await active.finish(interruption?.status ?? "completed", interruption?.error);
        } catch (error) {
          try {
            await callbackQueue;
          } finally {
            await active.finish(
              interruption?.status ?? this.statusForError(error),
              interruption?.error ?? error,
            );
          }
          throw error;
        }
      },
      interrupt: async (requestedInterruption) => {
        interruption ??= requestedInterruption ?? { status: "cancelled" };
        try {
          await session.interrupt();
          await callbackQueue;
        } finally {
          await lifecycle?.finish(interruption.status, interruption.error);
        }
      },
      detach: async (reason) => {
        try {
          await session.detach(reason);
          await callbackQueue;
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
    await lifecycle.begin();
    const reportExecutionReference = normalizedInput.reportExecutionReference;
    let callbackQueue = Promise.resolve();
    const enqueue = (operation: () => Promise<void>): void => {
      callbackQueue = callbackQueue.then(operation);
      void callbackQueue.catch(() => undefined);
    };
    try {
      const response = await driver.askWorkflow({
        ...normalizedInput,
        invocationId: lifecycle.id,
        reportExecutionReference: (reference) => {
          const invocationReference = { ...reference, invocationId: lifecycle.id };
          enqueue(async () => {
            await lifecycle.bindReference(invocationReference);
            reportExecutionReference?.(invocationReference);
          });
        },
        onEvent: (event) => {
          enqueue(async () => {
            if (event.type === "completed" && event.runtimeConversation) {
              await lifecycle.bindConversation(event.runtimeConversation);
            }
            normalizedInput.onEvent?.({ ...event, invocationId: lifecycle.id });
          });
        },
      });
      await callbackQueue;
      if (response.runtimeConversation) await lifecycle.bindConversation(response.runtimeConversation);
      if (response.executionReference) await lifecycle.bindReference(response.executionReference);
      await lifecycle.finish("completed");
      return normalizedInput.invocationId
        ? {
            ...response,
            executionReference: {
              ...response.executionReference,
              invocationId: lifecycle.id,
            },
          }
        : response;
    } catch (error) {
      try {
        await callbackQueue;
      } finally {
        await lifecycle.finish(this.statusForError(error, normalizedInput.signal), error);
      }
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
      environmentId: input.environmentId,
      invocation: {
        surface: "system",
        role: "channel_test",
        ownerReference: { channelId: input.channelId },
      },
    }, input.channelId);
    await lifecycle.begin();
    let callbackQueue = Promise.resolve();
    try {
      const result = await driver.testChannel({
        ...input,
        invocationId: lifecycle.id,
        emit: (event) => input.emit({ ...event, invocationId: lifecycle.id }),
        reportExecutionReference: (reference) => {
          callbackQueue = callbackQueue.then(() => lifecycle.bindReference(reference));
          void callbackQueue.catch(() => undefined);
        },
      });
      await callbackQueue;
      await lifecycle.finish("completed");
      return result;
    } catch (error) {
      try {
        await callbackQueue;
      } finally {
        await lifecycle.finish(this.statusForError(error), error);
      }
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
      invocationId?: string;
      environmentId?: string;
      invocation: RuntimeInvocationRequest;
    },
    channelId?: string,
  ): RuntimeInvocationLifecycle {
    return new RuntimeInvocationLifecycle({
      recorder: this.invocationRecorder,
      invocationId: input.invocationId ?? this.createInvocationId(),
      invocation: input.invocation,
      runtimeId: input.runtimeId,
      channelId,
      environmentId: input.environmentId,
      continuedSessionId: input.runtimeConversation
        ? this.sessionIdFromConversation(input.runtimeConversation)
        : undefined,
      now: this.now,
      sessionIdFromConversation: (conversation) => this.sessionIdFromConversation(conversation),
    });
  }

  private async observeAgentEvent(
    lifecycle: RuntimeInvocationLifecycle,
    event: AgentEvent,
    interruption?: InteractiveSessionInterruption,
  ): Promise<void> {
    if (event.type === "runtime_conversation") await lifecycle.bindConversation(event.runtimeConversation);
    else if (event.type === "completed") {
      await lifecycle.finish(interruption?.status ?? "completed", interruption?.error);
    }
    else if (event.type === "error") {
      await lifecycle.finish(
        interruption?.status ?? this.statusForError(event.error),
        interruption?.error ?? event.error,
      );
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
    const code = error instanceof Error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "TimeoutError" || code === "ETIMEDOUT" || /\btimed out\b/iu.test(message)) return "timed_out";
    if (signal?.aborted || name === "AbortError" || /\binterrupted\b|\bcancelled\b|\bcanceled\b/iu.test(message)) {
      return "cancelled";
    }
    return "failed";
  }
}

class RuntimeInvocationLifecycle {
  private writeQueue: Promise<void> = Promise.resolve();
  private finished = false;
  /**
   * Runtime dispatch only spawns CLI subprocesses on the indexing machine, so
   * invocations and bindings default to the reserved `local` environment; the
   * ssh/wsl environments in the sessions index are sync-only sources and never
   * dispatch targets. A caller that starts dispatching on a synced environment
   * must pass its environment id explicitly — the binding-match SQL keys on
   * environment equality, so a wrong default silently drops attribution
   * instead of misattributing the Session.
   */
  private readonly environmentId: string;

  constructor(private readonly options: {
    recorder: RuntimeInvocationRecorder;
    invocationId: string;
    invocation: RuntimeInvocationRequest;
    runtimeId: AgentId;
    channelId?: string;
    environmentId?: string;
    continuedSessionId?: string;
    now: () => number;
    sessionIdFromConversation: (conversation: RuntimeConversation) => string | undefined;
  }) {
    this.environmentId = options.environmentId ?? "local";
  }

  get id(): string {
    return this.options.invocationId;
  }

  async begin(): Promise<void> {
    await this.options.recorder.begin({
      id: this.options.invocationId,
      initiator: "agentrecall",
      invocation: this.options.invocation,
      runtimeId: this.options.runtimeId,
      ...(this.options.channelId ? { channelId: this.options.channelId } : {}),
      environmentId: this.environmentId,
      startedAt: this.options.now(),
    });
  }

  async bindConversation(conversation: RuntimeConversation): Promise<void> {
    if (conversation.runtimeId !== this.options.runtimeId) {
      throw new Error(
        `${this.options.runtimeId} Runtime reported a Session owned by ${conversation.runtimeId}.`,
      );
    }
    const sessionId = this.options.sessionIdFromConversation(conversation);
    if (sessionId) await this.bindReference({ sessionId });
  }

  async bindReference(reference: RuntimeExecutionReference): Promise<void> {
    if (!reference.sessionId) return;
    if (reference.sessionId.length > MAX_RUNTIME_REFERENCE_CHARACTERS) {
      throw new Error("Runtime reported a Session identifier that exceeds the supported limit.");
    }
    if (reference.turnId && reference.turnId.length > MAX_RUNTIME_REFERENCE_CHARACTERS) {
      throw new Error("Runtime reported a Turn identifier that exceeds the supported limit.");
    }
    this.enqueueBinding(
      {
        sessionId: reference.sessionId,
        ...(reference.turnId ? { turnId: reference.turnId } : {}),
      },
      this.options.continuedSessionId === reference.sessionId ? "continued" : "created",
    );
    await this.writeQueue;
  }

  private enqueueBinding(
    reference: { sessionId: string; turnId?: string },
    relation: RuntimeSessionRelation,
  ): void {
    const binding = {
      runtimeId: this.options.runtimeId,
      ...(this.options.channelId ? { channelId: this.options.channelId } : {}),
      environmentId: this.environmentId,
      sessionId: reference.sessionId,
      ...(reference.turnId ? { turnId: reference.turnId } : {}),
      relation,
      boundAt: this.options.now(),
    } as const;
    this.writeQueue = this.writeQueue.then(() =>
      this.options.recorder.bind(this.options.invocationId, binding));
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
    const message = error === undefined ? undefined : runtimeInvocationErrorMessage(error);
    const pendingWrites = this.writeQueue;
    this.writeQueue = pendingWrites.catch(() => undefined).then(() => this.options.recorder.finish(
      this.options.invocationId,
      status,
      this.options.now(),
      message,
    ));
    try {
      await pendingWrites;
    } catch (writeError) {
      await this.writeQueue;
      throw writeError;
    }
    await this.writeQueue;
  }
}
