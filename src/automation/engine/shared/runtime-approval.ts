import type { ApprovalDecision } from "./types";

export interface ResolveRuntimeApprovalRequest {
  ownerId: string;
  requestId: string;
  decision: ApprovalDecision;
}
