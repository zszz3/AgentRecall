import type { AgentRuntime, ChatRuntimeSessionState } from "../../../../../shared/types";
import type { RuntimeCapabilities } from "../../../../agents/runtime/runtime-capabilities";
import type { RuntimeSurfaceSupport } from "../../../../agents/runtime/runtime-driver";
import { support } from "../agent-executor-capabilities";

export const openCodeSurfaceSupport: RuntimeSurfaceSupport[] = [
  support("chat", ["interactive"], ["fresh", "resume-preferred"]),
  support("task", ["oneshot"], ["fresh"]),
  support("workflow", ["oneshot"], ["fresh"]),
  support("channel-test", ["oneshot"], ["fresh"]),
  support("cleanup", ["oneshot"], ["fresh", "resume-preferred"]),
];

export const openCodeInteractiveSessionCapabilities: ChatRuntimeSessionState["capabilities"] = {
  supportsInProcessConversationResume: true,
  supportsResumeAfterDetach: true,
  supportsResumeAfterAppRestart: true,
  supportsTurnResume: false,
  supportsInterrupt: true,
  supportsContinue: true,
  supportsApprovalRequests: true,
  supportsUserInputRequests: false,
};

export function getOpenCodeCapabilities(runtime: AgentRuntime): RuntimeCapabilities {
  return {
    runtimeId: runtime.id,
    chatStyle: "interactive",
    taskStyle: "oneshot",
    workflowStyle: "oneshot",
    testStyle: "oneshot",
    supportsInterrupt: true,
    supportsContinue: true,
    supportsApprovalRequests: true,
    supportsUserInputRequests: false,
    resume: {
      supportsInProcessConversationResume: true,
      supportsResumeAfterDetach: true,
      supportsResumeAfterAppRestart: true,
      supportsTurnResume: false,
    },
  };
}
