import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SessionSyncQueueEvent {
  version: 1;
  agent: "claude" | "codex";
  sessionId: string;
  transcriptPath: string | null;
  cwd: string | null;
  queuedAt: string;
  filePath: string;
}

export interface SessionSyncHookStatus {
  installed: boolean;
  claude: boolean;
  codex: boolean;
  pending: number;
  lastProcessedAt: number | null;
  lastError: string | null;
}

export function sessionSyncQueueDirectory(homeDir = process.env.AGENT_RECALL_TEST_HOME || os.homedir()): string {
  return process.env.AGENT_RECALL_SYNC_QUEUE || path.join(homeDir, ".agent-recall", "session-sync-queue");
}

export function readSessionSyncQueue(homeDir?: string): { events: SessionSyncQueueEvent[]; invalidFiles: string[] } {
  const queueDir = sessionSyncQueueDirectory(homeDir);
  if (!fs.existsSync(queueDir)) return { events: [], invalidFiles: [] };
  const events: SessionSyncQueueEvent[] = [];
  const invalidFiles: string[] = [];
  for (const name of fs.readdirSync(queueDir).filter((value) => value.endsWith(".json")).sort()) {
    const filePath = path.join(queueDir, name);
    try {
      const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SessionSyncQueueEvent>;
      if (
        value.version !== 1 ||
        (value.agent !== "claude" && value.agent !== "codex") ||
        typeof value.sessionId !== "string" || !value.sessionId.trim() ||
        typeof value.queuedAt !== "string" || !Number.isFinite(Date.parse(value.queuedAt))
      ) {
        invalidFiles.push(filePath);
        continue;
      }
      events.push({
        version: 1,
        agent: value.agent,
        sessionId: value.sessionId.trim(),
        transcriptPath: typeof value.transcriptPath === "string" ? value.transcriptPath : null,
        cwd: typeof value.cwd === "string" ? value.cwd : null,
        queuedAt: value.queuedAt,
        filePath,
      });
    } catch {
      invalidFiles.push(filePath);
    }
  }
  return { events, invalidFiles };
}

export function coalesceSessionSyncQueueEvents(events: SessionSyncQueueEvent[]): {
  events: SessionSyncQueueEvent[];
  supersededFiles: string[];
} {
  const latest = new Map<string, SessionSyncQueueEvent>();
  const supersededFiles: string[] = [];
  for (const event of events) {
    const key = `${event.agent}:${event.sessionId}`;
    const previous = latest.get(key);
    if (!previous) {
      latest.set(key, event);
      continue;
    }
    if (Date.parse(event.queuedAt) >= Date.parse(previous.queuedAt)) {
      supersededFiles.push(previous.filePath);
      latest.set(key, event);
    } else {
      supersededFiles.push(event.filePath);
    }
  }
  return { events: [...latest.values()], supersededFiles };
}

export function removeSessionSyncQueueFiles(filePaths: string[]): void {
  for (const filePath of filePaths) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // A later drain can retry cleanup without blocking other sessions.
    }
  }
}

export function clearSessionSyncQueue(homeDir?: string): void {
  fs.rmSync(sessionSyncQueueDirectory(homeDir), { recursive: true, force: true });
}
