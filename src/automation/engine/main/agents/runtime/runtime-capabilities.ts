import type { AgentId, ExecutionStyle, RuntimeInteractionCapabilities, RuntimeResumeCapabilities } from "../../../shared/types";

export interface RuntimeCapabilities extends RuntimeInteractionCapabilities {
  runtimeId: AgentId;
  chatStyle: ExecutionStyle;
  taskStyle: ExecutionStyle;
  workflowStyle: ExecutionStyle;
  testStyle: ExecutionStyle;
  resume: RuntimeResumeCapabilities;
}
