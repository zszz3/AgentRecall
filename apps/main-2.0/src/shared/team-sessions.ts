import { z } from "zod";
import type { SessionTurnDetail, SessionMessage } from "../core/types";

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
  createdAt: string;
  bytes: number;
  digest: string;
  canWithdraw: boolean;
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
