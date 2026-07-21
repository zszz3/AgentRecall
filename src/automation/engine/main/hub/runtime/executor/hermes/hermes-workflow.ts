import type {
  AgentRuntime,
  WorkflowAgentResponse,
} from "../../../../../shared/types";
import { runtimeModelId } from "../../../../../shared/models";
import { HermesRunner } from "../../../../agents/hermes/hermes-runner";
import type {
  RuntimeChannelTestContext,
  RuntimeWorkflowRequestContext,
} from "../../../../agents/runtime/runtime-driver";
import {
  modelFromRuntimeConfig,
  type RuntimeWorkflowExecutionOptions,
} from "../workflow/agent-executor-workflow-shared";

const HERMES_AGENT_TEST_PROMPT = "Reply with OK only.";

export async function runHermesWorkflow(
  input: RuntimeWorkflowRequestContext,
  options: RuntimeWorkflowExecutionOptions,
): Promise<WorkflowAgentResponse> {
  let content = "";
  let exitCode: number | null = 0;
  let stderr = "";
  let runnerError: string | undefined;

  const runner = new HermesRunner({
    executable: input.runtime.command || options.executables.hermes,
    cwd: input.workDir,
    prompt: input.prompt,
    modelId: modelFromRuntimeConfig(input.runtimeConfig),
    onEvent: (event) => {
      if (event.type === "completed") {
        content = typeof event.content === "string" ? event.content : content;
        input.onEvent?.({ requestId: input.requestId, type: "completed", content: content.trim() });
        return;
      }
      if (event.type === "error") {
        runnerError = event.error;
        input.onEvent?.({ requestId: input.requestId, type: "error", error: event.error });
      }
    },
    onStderr: (text) => {
      stderr += text;
    },
    onExit: (code) => {
      exitCode = code;
    },
  });

  const abort = () => { void runner.stop(); };
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });
  try { await runner.start(); } finally { input.signal?.removeEventListener("abort", abort); }
  if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Workflow agent interrupted.");

  const output = content.trim();
  if (runnerError) throw new Error(runnerError);
  if (exitCode !== 0) {
    throw new Error(`Hermes exited with ${exitCode ?? "unknown"}: ${(stderr.trim() || output || "no output").slice(0, 800)}`);
  }
  if (!output) throw new Error("Hermes completed without assistant text.");
  return { content: output };
}

export async function runHermesChannelTest(
  input: RuntimeChannelTestContext,
  options: RuntimeWorkflowExecutionOptions,
): Promise<string> {
  input.emit({ type: "phase", content: `Launching Hermes with model ${runtimeModelId(input.modelId) ?? "default"}.` });
  input.emit({ type: "user", content: HERMES_AGENT_TEST_PROMPT });

  const response = await runHermesWorkflow(
    {
      requestId: "agent-test",
      prompt: HERMES_AGENT_TEST_PROMPT,
      runtimeId: input.runtime.id,
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: input.modelId },
      runtime: input.runtime as AgentRuntime,
      channelId: input.channelId,
      workDir: input.workDir,
      onEvent: (event) => {
        if (event.type === "error") input.emit({ type: "error", content: event.error });
      },
    },
    options,
  );

  input.emit({ type: "assistant", content: response.content });
  return response.content;
}
