export const AGENT_RECALL_INVOCATION_SURFACES = [
  "workflow",
  "evaluation",
  // Retained for historical Session attribution after multi-agent Chat removal.
  "team_chat",
  "agent",
  "skill",
  "system",
] as const;

export type AgentRecallInvocationSurface = typeof AGENT_RECALL_INVOCATION_SURFACES[number];
export type SessionInvocationSurfaceFilter = AgentRecallInvocationSurface | "all";
