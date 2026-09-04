import type { AgentRuntime, RuntimeConversation, WorkflowAgentResponse } from "../../../../../shared/types";
import { DshRunner } from "../../../../agents/dsh/dsh-runner";
import type {
  RuntimeChannelTestContext,
  RuntimeWorkflowRequestContext,
} from "../../../../agents/runtime/runtime-driver";
import {
  RUNTIME_CHANNEL_TEST_PROMPT,
  RUNTIME_CHANNEL_TEST_TIMEOUT_MS,
} from "../runtime-test-constants";
import { promptWithDeveloperInstructions } from "../runtime-instructions";
import {
  developerInstructionsForWorkflowRequest,
  modelFromRuntimeConfig,
  type RuntimeWorkflowExecutionOptions,
} from "../workflow/agent-executor-workflow-shared";
import { assertDshDefaultModel, dshEnvironment } from "./dsh-config";
import type { DshRunnerFactory } from "./dsh-runtime-lifecycle";

function workflowAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow agent interrupted.");
}

function workflowStopError(error: unknown): Error {
  return new Error(
    `Failed to stop DSH after workflow interruption: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
}

export async function runDshWorkflow(
  input: RuntimeWorkflowRequestContext,
  options: RuntimeWorkflowExecutionOptions,
  createRunner: DshRunnerFactory =
    (runnerOptions) => new DshRunner(runnerOptions),
): Promise<WorkflowAgentResponse> {
  assertDshDefaultModel(modelFromRuntimeConfig(input.runtimeConfig));
  if (input.signal?.aborted) throw workflowAbortError(input.signal);

  let content = "";
  let runtimeConversation: RuntimeConversation | undefined;
  let sessionId: string | undefined;
  let runnerError: string | undefined;
  const runner = createRunner({
    executable: input.runtime.command || options.executables.dsh,
    cwd: input.workDir,
    env: dshEnvironment(options.channelById(input.channelId)),
    prompt: promptWithDeveloperInstructions(
      input.prompt,
      developerInstructionsForWorkflowRequest(input),
    ),
    onEvent: (event) => {
      if (event.type === "runtime_conversation") {
        runtimeConversation = structuredClone(event.runtimeConversation);
        const payload = runtimeConversation.payload;
        const native = payload && typeof payload === "object"
          ? (payload as Record<string, unknown>).native
          : undefined;
        const nativeRecord = native && typeof native === "object"
          ? native as Record<string, unknown>
          : undefined;
        sessionId = typeof nativeRecord?.sessionId === "string"
          ? nativeRecord.sessionId
          : undefined;
        if (sessionId) input.reportExecutionReference?.({ sessionId });
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
      () => rejectAborted?.(workflowAbortError(input.signal!)),
      (error) => rejectAborted?.(workflowStopError(error)),
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

  if (input.signal?.aborted) throw workflowAbortError(input.signal);
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
  options: RuntimeWorkflowExecutionOptions,
  createRunner?: DshRunnerFactory,
): Promise<string> {
  input.emit({
    type: "phase",
    content: "Launching DSH with the model configured in DSH settings.",
  });
  input.emit({ type: "user", content: RUNTIME_CHANNEL_TEST_PROMPT });

  const response = await runDshWorkflow(
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
      instructionScope: "agent",
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
