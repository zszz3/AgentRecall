import type { AgentRuntime } from "../../../../../shared/types";
import type { RuntimeCapabilities } from "../../../../agents/runtime/runtime-capabilities";
import type { RuntimeSurfaceSupport } from "../../../../agents/runtime/runtime-driver";
import { support } from "../agent-executor-capabilities";

export const dshSurfaceSupport: RuntimeSurfaceSupport[] = [
  support("chat", ["oneshot"], ["fresh", "resume-preferred", "resume-required"]),
  support("oneshot", ["oneshot"], ["fresh", "resume-preferred", "resume-required"]),
  support("channel-test", ["oneshot"], ["fresh"]),
];

export function getDshCapabilities(runtime: AgentRuntime): RuntimeCapabilities {
  return {
    runtimeId: runtime.id,
    chatStyle: "oneshot",
    oneShotStyle: "oneshot",
    testStyle: "oneshot",
    supportsInterrupt: true,
    supportsContinue: true,
    supportsApprovalRequests: false,
    supportsUserInputRequests: false,
    resume: {
      supportsInProcessConversationResume: true,
      supportsResumeAfterDetach: true,
      supportsResumeAfterAppRestart: true,
      supportsTurnResume: false,
    },
  };
}
