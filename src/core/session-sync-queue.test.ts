import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  coalesceSessionSyncQueueEvents,
  readSessionSyncQueue,
  removeSessionSyncQueueFiles,
} from "./session-sync-queue";

function freshQueue(): { homeDir: string; queueDir: string } {
  const homeDir = path.join(tmpdir(), `session-sync-queue-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const queueDir = path.join(homeDir, ".agent-recall", "session-sync-queue");
  mkdirSync(queueDir, { recursive: true });
  return { homeDir, queueDir };
}

function event(agent: "claude" | "codex", sessionId: string, queuedAt: string) {
  return { version: 1 as const, agent, sessionId, transcriptPath: null, cwd: null, queuedAt };
}

describe("session sync queue", () => {
  it("reads valid event files and reports malformed files for cleanup", () => {
    const fixture = freshQueue();
    try {
      writeFileSync(path.join(fixture.queueDir, "valid.json"), JSON.stringify(event("codex", "abc", "2026-07-16T00:00:00.000Z")));
      writeFileSync(path.join(fixture.queueDir, "invalid.json"), "not json");
      writeFileSync(path.join(fixture.queueDir, "wrong-shape.json"), JSON.stringify({ version: 1, agent: "other", sessionId: "x" }));

      const result = readSessionSyncQueue(fixture.homeDir);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({ agent: "codex", sessionId: "abc", filePath: path.join(fixture.queueDir, "valid.json") });
      expect(result.invalidFiles.sort()).toEqual([
        path.join(fixture.queueDir, "invalid.json"),
        path.join(fixture.queueDir, "wrong-shape.json"),
      ].sort());
    } finally {
      rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });

  it("keeps only the newest event for each agent and session", () => {
    const events = [
      { ...event("codex", "same", "2026-07-16T00:00:00.000Z"), filePath: "/old" },
      { ...event("codex", "same", "2026-07-16T00:01:00.000Z"), filePath: "/new" },
      { ...event("claude", "same", "2026-07-16T00:02:00.000Z"), filePath: "/claude" },
    ];
    const result = coalesceSessionSyncQueueEvents(events);
    expect(result.events.map((item) => item.filePath).sort()).toEqual(["/claude", "/new"]);
    expect(result.supersededFiles).toEqual(["/old"]);
  });

  it("removes only named queue files", () => {
    const fixture = freshQueue();
    try {
      const removePath = path.join(fixture.queueDir, "remove.json");
      const keepPath = path.join(fixture.queueDir, "keep.json");
      writeFileSync(removePath, "{}");
      writeFileSync(keepPath, "{}");
      removeSessionSyncQueueFiles([removePath]);
      const result = readSessionSyncQueue(fixture.homeDir);
      expect(result.invalidFiles).toEqual([keepPath]);
    } finally {
      rmSync(fixture.homeDir, { recursive: true, force: true });
    }
  });
});
