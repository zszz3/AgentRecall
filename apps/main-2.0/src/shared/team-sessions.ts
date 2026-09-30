import { z } from "zod";
import type { SessionTurnDetail, SessionTurnSummary, SessionMessage } from "../core/types";

export const MAX_SHARED_TURNS = 500;
export const teamTurnSelectionSchema = z.array(z.string().min(1).max(1024)).min(1).max(MAX_SHARED_TURNS)
  .refine((ids) => new Set(ids).size === ids.length, "轮次不能重复");

export interface TeamSessionDetail {
  schemaVersion: 2;
  exportedAt: number;
  session: { sessionKey: string; originalTitle: string; displayTitle: string; source: string; [key: string]: unknown };
  messages: SessionMessage[];
  traceEvents: Array<Record<string, unknown>>;
}

export interface TeamSharedSession {
  id: number;
  title: string;
  author: string;
  source?: string;
  createdAt: string;
  bytes: number;
  /** Block shares list manifest bytes; detail includes referenced content. */
  storage?: "blocks";
  digest: string;
  canWithdraw: boolean;
  match?: { record: number; turnId: string; turnIndex: number; offset: number; snippet: string };
}
export interface TeamSessionPage { items: TeamSharedSession[]; page: number; hasMore: boolean; }
export interface TeamSessionContent {
  root: TeamSessionDetail;
  selectedTurns?: SessionTurnDetail[];
  children: TeamSessionDetail[];
  files: Array<{ name: string; bytes: number; kind: string; attachmentId?: string }>;
  bytes: number;
  missingAttachments: string[];
}
export interface TeamSessionPreview extends TeamSessionContent {
  token: string;
  repository: string;
  projectIdentity: string;
  expiresAt: number;
}

/** Downloaded shares are read-only snapshots, separate from resumable local sessions. */
export interface TeamSessionSnapshot {
  partial: boolean;
  records: Array<{ sessionKey: string; title: string; turnCount: number; source?: string }>;
  bytes: number;
  files: TeamSessionContent["files"];
  missingAttachments: string[];
}
export interface TeamSessionTurnsPage {
  turns: SessionTurnSummary[];
  offset: number;
  hasMore: boolean;
}

export type TeamSessionFetchPhase = "queued" | "downloading" | "indexing" | "ready" | "failed" | "cancelled";
export interface TeamSessionFetchState {
  id: number;
  digest: string;
  phase: TeamSessionFetchPhase;
  source?: string;
  error?: string;
}
