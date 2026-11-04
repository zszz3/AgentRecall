import { dshRuntimeStateCodec } from "../../../../agents/dsh/dsh-runtime-state-codec";
import type { AgentRuntime, RuntimeConversation, AgentOneShotResponse } from "../../../../../shared/types";
import { DshRunner } from "../../../../agents/dsh/dsh-runner";
import type {
  RuntimeChannelTestContext,
  RuntimeOneShotRequest,
} from "../../../../agents/runtime/runtime-driver";
import {
  RUNTIME_CHANNEL_TEST_PROMPT,
  RUNTIME_CHANNEL_TEST_TIMEOUT_MS,
} from "../runtime-test-constants";
import { combineDeveloperInstructions, promptWithDeveloperInstructions } from "../runtime-instructions";
import {
  modelFromRuntimeConfig,
  type RuntimeOneShotExecutionOptions,
} from "../oneshot-shared";
import { assertDshDefaultModel, dshEnvironment } from "./dsh-config";
import type { DshRunnerFactory } from "./dsh-runtime-lifecycle";

function oneShotAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Agent request interrupted.");
}

function oneShotStopError(error: unknown): Error {
  return new Error(
    `Failed to stop DSH after agent interruption: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
}

export async function runDshOneShot(
  input: RuntimeOneShotRequest,
  options: RuntimeOneShotExecutionOptions,
  createRunner: DshRunnerFactory =
    (runnerOptions) => new DshRunner(runnerOptions),
): Promise<AgentOneShotResponse> {
  assertDshDefaultModel(modelFromRuntimeConfig(input.runtimeConfig));
  if (input.signal?.aborted) throw oneShotAbortError(input.signal);

  let content = "";
  let runtimeConversation: RuntimeConversation | undefined;
  let sessionId: string | undefined;
  let runnerError: string | undefined;
  const runner = createRunner({
    executable: input.runtime.command || options.executables.dsh,
    cwd: input.workDir,
    env: dshEnvironment(options.channelById(input.channelId)),
    useStoredCredentials: options.channelById(input.channelId)?.dshUseStoredCredentials === true,
    sessionId: input.continuationPolicy === "fresh" ? undefined
      : dshRuntimeStateCodec.decodeConversation(input.runtimeConversation)?.native.sessionId,
    prompt: promptWithDeveloperInstructions(
      input.prompt,
      combineDeveloperInstructions(input.developerInstructions),
    ),
    onEvent: (event) => {
      if (event.type === "runtime_conversation") {
        runtimeConversation = structuredClone(event.runtimeConversation);
        sessionId = dshRuntimeStateCodec.decodeConversation(runtimeConversation)?.native.sessionId;
        if (sessionId) input.reportExecutionReference?.({ sessionId });
        return;
      }
      if (event.type === "delta" || event.type === "meta" || event.type === "system" || event.type === "tool_call" || event.type === "tool_result") {
        input.onEvent?.({ requestId: input.requestId, ...event });
        return;
      }
      if (event.type === "completed") {
        content = event.content?.trim() ?? "";
        input.onEvent?.({
          requestId: input.requestId,
          type: "completed",
          content,
        });
        return;
      }
      if (event.type === "error") {
        runnerError = event.error;
        input.onEvent?.({
          requestId: input.requestId,
          type: "error",
          error: event.error,
        });
      }
    },
    onExit: () => undefined,
  });

  const startPromise = runner.start();
  let stopPromise: Promise<void> | undefined;
  let rejectAborted: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = (): void => {
    if (!input.signal || stopPromise) return;
    stopPromise = runner.stop();
    void stopPromise.then(
      () => rejectAborted?.(oneShotAbortError(input.signal!)),
      (error) => rejectAborted?.(oneShotStopError(error)),
    );
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    if (input.signal) {
      await Promise.race([startPromise, aborted]);
    } else {
      await startPromise;
    }
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }

  if (input.signal?.aborted) throw oneShotAbortError(input.signal);
  if (runnerError) throw new Error(runnerError);
  if (!content) throw new Error("DSH completed without assistant text.");
  return {
    content,
    ...(runtimeConversation ? { runtimeConversation } : {}),
    ...(sessionId ? { executionReference: { sessionId } } : {}),
  };
}

export async function runDshChannelTest(
  input: RuntimeChannelTestContext,
  options: RuntimeOneShotExecutionOptions,
  createRunner?: DshRunnerFactory,
): Promise<string> {
  input.emit({
    type: "phase",
    content: "Launching DSH with the model configured in DSH settings.",
  });
  input.emit({ type: "user", content: RUNTIME_CHANNEL_TEST_PROMPT });

  const response = await runDshOneShot(
    {
      requestId: "agent-test",
      prompt: RUNTIME_CHANNEL_TEST_PROMPT,
      runtimeId: input.runtime.id,
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: input.modelId },
      invocation: { surface: "system", role: "channel_test", ownerReference: { channelId: input.channelId } },
      runtime: input.runtime as AgentRuntime,
      channelId: input.channelId,
      workDir: input.workDir,
      signal: AbortSignal.timeout(RUNTIME_CHANNEL_TEST_TIMEOUT_MS),
      reportExecutionReference: input.reportExecutionReference,
      onEvent: (event) => {
        if (event.type === "error") {
          input.emit({ type: "error", content: event.error });
        }
      },
    },
    options,
    createRunner,
  );

  input.emit({ type: "assistant", content: response.content });
  return response.content;
}
