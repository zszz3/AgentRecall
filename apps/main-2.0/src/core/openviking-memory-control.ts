export type OpenVikingMemoryAuthority = "model" | "user";

export type OpenVikingMemoryLifecycle =
  | "active"
  | "disputed"
  | "superseded"
  | "invalidated"
  | "deleted";

export type OpenVikingMemoryEvidenceStatus = "verified" | "legacy" | "invalid";

export type OpenVikingMemoryFeedbackKind = "helpful" | "wrong" | "outdated";

export interface OpenVikingMemoryControl {
  workspaceId: string;
  uri: string;
  memoryType: string;
  authority: OpenVikingMemoryAuthority;
  lifecycle: OpenVikingMemoryLifecycle;
  locked: boolean;
  evidenceStatus: OpenVikingMemoryEvidenceStatus;
  source: "openviking" | "manual" | "user-edit" | "legacy";
  title?: string;
  lockedContent?: string;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpenVikingMemoryEvidence {
  id: string;
  workspaceId: string;
  memoryUri: string;
  sourceSessionId?: string;
  sourceAgent?: string;
  sourceTurnIds: string[];
  archiveUri?: string;
  memoryDiffUri?: string;
  remoteTaskId?: string;
  modelSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
  state: "active" | "invalidated";
  createdAt: string;
  updatedAt: string;
}

export interface OpenVikingMemoryFeedback {
  id: string;
  workspaceId: string;
  memoryUri: string;
  feedback: OpenVikingMemoryFeedbackKind;
  actor: string;
  note?: string;
  createdAt: string;
}

export interface OpenVikingMemoryDetails {
  control: OpenVikingMemoryControl;
  evidence: OpenVikingMemoryEvidence[];
  feedback: OpenVikingMemoryFeedback[];
}

export interface OpenVikingOperationEvent {
  id: string;
  workspaceId: string;
  phase: string;
  status: "started" | "completed" | "failed" | "degraded" | "skipped";
  sessionId?: string;
  taskId?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export interface OpenVikingRecallCandidateTrace {
  uri: string;
  score?: number;
  scoreThreshold?: number;
  decision: "injected" | "filtered" | "budget";
  reason: string;
  memoryType: string;
  authority: OpenVikingMemoryAuthority;
  lifecycle: OpenVikingMemoryLifecycle;
  evidenceStatus: OpenVikingMemoryEvidenceStatus;
  locked: boolean;
}

export interface OpenVikingRecallTrace {
  id: string;
  workspaceId: string;
  agent: string;
  query: string;
  contextualQuery: string;
  searchedScopes: string[];
  searchedTypes: string[];
  scoreThresholds?: Record<string, number>;
  candidates: OpenVikingRecallCandidateTrace[];
  injectedUris: string[];
  injectedTokenCount: number;
  durationMs: number;
  degradedReason?: string;
  createdAt: string;
}

export interface OpenVikingCommitRun {
  taskId: string;
  workspaceId: string;
  sessionId: string;
  sourceSessionId?: string;
  agent?: string;
  trigger: string;
  state: "running" | "completed" | "failed";
  sourceTurnIds: string[];
  tokenEstimate: number;
  archiveUri?: string;
  memoryDiffUri?: string;
  memoriesExtracted?: Record<string, number>;
  tokenUsage?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
}

export interface OpenVikingMemoryChange {
  kind: "add" | "update" | "delete";
  uri: string;
  memoryType: string;
  before?: string;
  after?: string;
}

export interface OpenVikingApplyCommitInput {
  run: OpenVikingCommitRun;
  changes: OpenVikingMemoryChange[];
  archiveUri?: string;
  memoryDiffUri?: string;
  modelSnapshot?: Record<string, unknown>;
  policySnapshot?: Record<string, unknown>;
}

export interface OpenVikingLockedMemoryConflict {
  uri: string;
  content: string;
  title?: string;
  change: OpenVikingMemoryChange;
}

export interface OpenVikingControlDiagnostics {
  recentEvents: OpenVikingOperationEvent[];
  recentRecallTraces: OpenVikingRecallTrace[];
  recentCommits: OpenVikingCommitRun[];
}

export function inferOpenVikingMemoryType(uri: string): string {
  const normalized = (tryCanonicalOpenVikingMemoryUri(uri) ?? uri).toLowerCase();
  const segment = normalized
    .replace(/^viking:\/\/user\/memories\//u, "")
    .split("/")[0]
    ?.replace(/\.md$/u, "");
  if (segment === "identity" || segment === "soul") return "profile";
  if (segment === "manual") return "notes";
  if (segment === "context") return "context";
  return segment || "other";
}

export function defaultOpenVikingMemoryControl(
  workspaceId: string,
  uri: string,
): Pick<
  OpenVikingMemoryControl,
  "workspaceId" | "uri" | "memoryType" | "authority" | "lifecycle" | "locked" | "evidenceStatus" | "source" | "evidenceCount"
> {
  return {
    workspaceId,
    uri,
    memoryType: inferOpenVikingMemoryType(uri),
    authority: "model",
    lifecycle: "active",
    locked: false,
    evidenceStatus: "legacy",
    source: "legacy",
    evidenceCount: 0,
  };
}
import { tryCanonicalOpenVikingMemoryUri } from "./openviking-memory";
