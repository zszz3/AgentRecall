export interface WorkflowV2IdleProbePolicy {
  quietPeriodMs: number;
  probeCooldownMs: number;
  maxConsecutiveProbes: number;
  hardTimeoutMs?: number;
}

export interface WorkflowV2IdleProbeState {
  lastActivityAt: number;
  lastProbeAt?: number;
  consecutiveProbes: number;
  startedAt: number;
}

export function shouldProbeWorkflowV2Node(now: number, state: WorkflowV2IdleProbeState, policy: WorkflowV2IdleProbePolicy): boolean {
  if (policy.hardTimeoutMs !== undefined && now - state.startedAt >= policy.hardTimeoutMs) return false;
  if (state.consecutiveProbes >= policy.maxConsecutiveProbes) return false;
  if (now - state.lastActivityAt < policy.quietPeriodMs) return false;
  return state.lastProbeAt === undefined || now - state.lastProbeAt >= policy.probeCooldownMs;
}
