import type { AgentRuntime } from "../../../../../shared/types";
import type { RuntimeCapabilities } from "../../../../agents/runtime/runtime-capabilities";
import type { RuntimeSurfaceSupport } from "../../../../agents/runtime/runtime-driver";
import { support } from "../agent-executor-capabilities";

export const apiSurfaceSupport: RuntimeSurfaceSupport[] = [
  support("chat", ["oneshot"], ["fresh"]),
  support("oneshot", ["oneshot"], ["fresh"]),
  support("channel-test", ["oneshot"], ["fresh"]),
];

export function getApiCapabilities(runtime: AgentRuntime): RuntimeCapabilities {
  return {
    runtimeId: runtime.id,
    chatStyle: "oneshot",
    oneShotStyle: "oneshot",
    testStyle: "oneshot",
    supportsInterrupt: false,
    supportsContinue: false,
    supportsApprovalRequests: false,
    supportsUserInputRequests: false,
    resume: {
      supportsInProcessConversationResume: false,
      supportsResumeAfterDetach: false,
      supportsResumeAfterAppRestart: false,
      supportsTurnResume: false,
    },
  };
}
