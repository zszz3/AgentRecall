import type { AgentRuntime, ChatRuntimeSessionState } from "../../../../../shared/types";
import type { RuntimeCapabilities } from "../../../../agents/runtime/runtime-capabilities";
import type { RuntimeSurfaceSupport } from "../../../../agents/runtime/runtime-driver";
import { support } from "../agent-executor-capabilities";

export const claudeSurfaceSupport: RuntimeSurfaceSupport[] = [
  support("chat", ["interactive"], ["fresh", "resume-preferred"]),
  support("task", ["oneshot"], ["fresh", "resume-preferred"]),
  support("workflow", ["oneshot"], ["fresh", "resume-preferred"]),
  support("channel-test", ["oneshot"], ["fresh"]),
  support("cleanup", ["oneshot"], ["fresh", "resume-preferred"]),
];

export const claudeInteractiveSessionCapabilities: ChatRuntimeSessionState["capabilities"] = {
  supportsInProcessConversationResume: true,
  supportsResumeAfterDetach: true,
  supportsResumeAfterAppRestart: true,
  supportsTurnResume: false,
  supportsInterrupt: true,
  supportsContinue: true,
  supportsApprovalRequests: true,
  supportsUserInputRequests: true,
};

export function getClaudeCapabilities(runtime: AgentRuntime): RuntimeCapabilities {
  return {
    runtimeId: runtime.id,
    chatStyle: "interactive",
    taskStyle: "oneshot",
    workflowStyle: "oneshot",
    testStyle: "oneshot",
    supportsInterrupt: claudeInteractiveSessionCapabilities.supportsInterrupt,
    supportsContinue: claudeInteractiveSessionCapabilities.supportsContinue,
    supportsApprovalRequests: claudeInteractiveSessionCapabilities.supportsApprovalRequests,
    supportsUserInputRequests: claudeInteractiveSessionCapabilities.supportsUserInputRequests,
    resume: {
      supportsInProcessConversationResume: claudeInteractiveSessionCapabilities.supportsInProcessConversationResume,
      supportsResumeAfterDetach: claudeInteractiveSessionCapabilities.supportsResumeAfterDetach,
      supportsResumeAfterAppRestart: claudeInteractiveSessionCapabilities.supportsResumeAfterAppRestart,
      supportsTurnResume: claudeInteractiveSessionCapabilities.supportsTurnResume,
    },
  };
}
