import type { AgentId, AgentTestEvent, AgentTestResult } from "../../../../shared/types";
import { formatElapsed, sanitizeTestError } from "./agent-hub-cli";

type AgentTestEmit = (event: Omit<AgentTestEvent, "agentId" | "timestamp">) => void;

export async function runRuntimeChannelTest(input: {
  agentId: string;
  runtimeAgentId: AgentId;
  channelId: string;
  modelId: string;
  phaseMessage: string;
  successLabel: string;
  testPrompt: string;
  onEvent: ((event: AgentTestEvent) => void) | undefined;
  runTest: (emit: AgentTestEmit) => Promise<string>;
}): Promise<AgentTestResult> {
  const startedAt = Date.now();
  const emit: AgentTestEmit = (event) => {
    input.onEvent?.({ agentId: input.agentId, timestamp: Date.now(), ...event } as AgentTestEvent);
  };
  const base = {
    agentId: input.agentId,
    runtimeAgentId: input.runtimeAgentId,
    channelId: input.channelId,
    modelId: input.modelId,
  };

  try {
    emit({ type: "phase", content: input.phaseMessage });
    emit({ type: "user", content: input.testPrompt });
    const output = await input.runTest(emit);
    const elapsedMs = Date.now() - startedAt;
    return {
      ...base,
      ok: true,
      status: "passed",
      message: `${input.successLabel} test passed in ${formatElapsed(elapsedMs)}.`,
      output: output.trim().slice(0, 2000),
      elapsedMs,
      testedAt: Date.now(),
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    emit({ type: "error", content: sanitizeTestError(error) });
    return {
      ...base,
      ok: false,
      status: "failed",
      message: sanitizeTestError(error),
      elapsedMs,
      testedAt: Date.now(),
    };
  }
}
