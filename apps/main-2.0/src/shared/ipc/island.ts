import { z } from "zod";
import type { SessionSource } from "../../core/types";
import { defineIpcRequest } from "./contract";

export const ISLAND_TASK_STATUSES = ["running", "waiting_input", "completed", "error"] as const;
export type IslandTaskStatus = (typeof ISLAND_TASK_STATUSES)[number];

export const ISLAND_SIGNAL_SOURCES = ["log", "hook", "gateway"] as const;
export type IslandSignalSource = (typeof ISLAND_SIGNAL_SOURCES)[number];

export const ISLAND_APP_KINDS = ["desktop", "terminal"] as const;
export type IslandAppKind = (typeof ISLAND_APP_KINDS)[number];

export interface IslandTaskTokens {
  input: number;
  output: number;
  cached: number;
}

export interface IslandTask {
  id: string;
  source: SessionSource;
  agentLabel: string;
  appKind: IslandAppKind;
  sessionId: string;
  sessionKey: string | null;
  projectPath: string | null;
  projectName: string;
  title: string;
  status: IslandTaskStatus;
  summary: string;
  activeTool: string | null;
  model: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  tokens: IslandTaskTokens | null;
  pid: number | null;
  signalSource: IslandSignalSource;
  unread: boolean;
}

export interface IslandSnapshot {
  enabled: boolean;
  muted: boolean;
  soundEnabled: boolean;
  suppressWhenFocused: boolean;
  autoCollapseSeconds: number;
  tasks: IslandTask[];
  /** Task currently featured in the expanded toast banner, if any. */
  highlightedTaskId: string | null;
  /** Monotonic counter incremented when a fresh alert triggers expansion. */
  highlightVersion: number;
}

export interface IslandFocusResult {
  focused: boolean;
  targetLabel?: string;
  error?: string;
}

export const ISLAND_SNAPSHOT_CHANNEL = "island:snapshot";
export const SHARE_SESSION_TO_TEAM_CHANNEL = "share-session-to-team";

const taskIdInput = z.string().min(1).max(512);

export const ISLAND_IPC = {
  getSnapshot: defineIpcRequest("island:get-snapshot", z.tuple([])),
  focusTask: defineIpcRequest("island:focus-task", z.tuple([taskIdInput])),
  openTrajectory: defineIpcRequest("island:open-trajectory", z.tuple([taskIdInput])),
  shareToTeam: defineIpcRequest("island:share-to-team", z.tuple([taskIdInput])),
  dismissTask: defineIpcRequest("island:dismiss-task", z.tuple([taskIdInput])),
  clearCompleted: defineIpcRequest("island:clear-completed", z.tuple([])),
  setMuted: defineIpcRequest("island:set-muted", z.tuple([z.boolean()])),
  setInteractive: defineIpcRequest("island:set-interactive", z.tuple([z.boolean()])),
  close: defineIpcRequest("island:close", z.tuple([])),
} as const;
