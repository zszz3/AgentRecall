import type { SessionMessage } from "../core/types";

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
  children: TeamSessionDetail[];
  files: Array<{ name: string; bytes: number; kind: string }>;
  bytes: number;
  missingAttachments: string[];
}
export interface TeamSessionPreview extends TeamSessionContent {
  token: string;
  repository: string;
  projectRepository: string;
  expiresAt: number;
}
