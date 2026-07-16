import { createRequire } from "node:module";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface SessionSyncRecorder {
  buildSessionSyncEvent(input: unknown, agent: string, now?: () => Date): {
    version: 1;
    agent: "claude" | "codex";
    sessionId: string;
    transcriptPath: string | null;
    cwd: string | null;
    queuedAt: string;
  } | null;
  writeSessionSyncEvent(event: object, options: { homeDir: string }): string;
}

const require = createRequire(import.meta.url);
const record = require(path.resolve("bin", "session-sync-record.cjs")) as SessionSyncRecorder;

describe("session sync hook recorder", () => {
  it("builds a minimal Stop event without copying unrelated hook input", () => {
    const event = record.buildSessionSyncEvent({
      hook_event_name: "Stop",
      session_id: "session-123",
      transcript_path: "/tmp/session-123.jsonl",
      cwd: "/repo",
      api_key: "must-not-be-copied",
      tool_input: { secret: "must-not-be-copied" },
    }, "codex", () => new Date("2026-07-16T00:00:00.000Z"));

    expect(event).toEqual({
      version: 1,
      agent: "codex",
      sessionId: "session-123",
      transcriptPath: "/tmp/session-123.jsonl",
      cwd: "/repo",
      queuedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(JSON.stringify(event)).not.toContain("must-not-be-copied");
  });

  it("rejects unsupported agents and payloads without a session id", () => {
    expect(record.buildSessionSyncEvent({ hook_event_name: "Stop", session_id: "x" }, "other")).toBeNull();
    expect(record.buildSessionSyncEvent({ hook_event_name: "Stop" }, "claude")).toBeNull();
    expect(record.buildSessionSyncEvent(null, "codex")).toBeNull();
  });

  it("writes one isolated queue file", () => {
    const homeDir = path.join(tmpdir(), `session-sync-record-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      const event = record.buildSessionSyncEvent({ hook_event_name: "Stop", session_id: "abc" }, "claude");
      expect(event).not.toBeNull();
      if (!event) throw new Error("Expected a queue event.");
      const filePath = record.writeSessionSyncEvent(event, { homeDir });
      const queueDir = path.join(homeDir, ".agent-recall", "session-sync-queue");
      expect(readdirSync(queueDir)).toEqual([path.basename(filePath)]);
      expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ agent: "claude", sessionId: "abc" });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
