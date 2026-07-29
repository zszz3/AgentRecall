import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkillUsage, readSkillUsageSourceEvents, usageForSkill } from "./skill-usage";

function writeUsageLog(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-usage-"));
  const usagePath = path.join(dir, "skill-usage.jsonl");
  fs.writeFileSync(usagePath, lines.join("\n"), "utf8");
  return usagePath;
}

function writeCodexSession(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-usage-"));
  const sessionDir = path.join(dir, "sessions", "2026", "06", "01");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout.jsonl"), lines.join("\n"), "utf8");
  return path.join(dir, "sessions");
}

describe("skill usage", () => {
  it("aggregates counts and last-used time per skill", () => {
    const usagePath = writeUsageLog([
      JSON.stringify({ skill: "brainstorming", ts: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ skill: "brainstorming", ts: "2026-06-02T10:00:00.000Z" }),
      JSON.stringify({ skill: "tdd", ts: "2026-06-03T10:00:00.000Z" }),
    ]);

    const snapshot = loadSkillUsage({ usagePath, codexSessionsDir: null });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.totalEvents).toBe(3);
    expect(snapshot.stats).toEqual([
      { skill: "brainstorming", count: 2, lastUsedAt: Date.parse("2026-06-02T10:00:00.000Z") },
      { skill: "tdd", count: 1, lastUsedAt: Date.parse("2026-06-03T10:00:00.000Z") },
    ]);
    expect(usageForSkill(snapshot, "Brainstorming")?.count).toBe(2);

    fs.rmSync(path.dirname(usagePath), { recursive: true, force: true });
  });

  it("skips malformed lines and records without a skill name", () => {
    const usagePath = writeUsageLog([
      "not json",
      JSON.stringify({ ts: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ skill: "  ", ts: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ skill: "review-code", ts: "2026-06-01T10:00:00.000Z" }),
      "",
    ]);

    const snapshot = loadSkillUsage({ usagePath, codexSessionsDir: null });

    expect(snapshot.totalEvents).toBe(1);
    expect(snapshot.stats.map((stat) => stat.skill)).toEqual(["review-code"]);

    fs.rmSync(path.dirname(usagePath), { recursive: true, force: true });
  });

  it("carries session linkage fields from newer hook records and tolerates old ones", () => {
    const usagePath = writeUsageLog([
      JSON.stringify({ skill: "review", ts: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ skill: "review", ts: "2026-06-02T10:00:00.000Z", session_id: "abc-123", cwd: "/repo" }),
      JSON.stringify({ skill: "review", ts: "2026-06-03T10:00:00.000Z", session_id: "   ", cwd: 42 }),
    ]);

    const events = readSkillUsageSourceEvents({
      agent: "claude",
      kind: "claude-hook",
      path: usagePath,
      mtimeMs: 1,
      fileSize: 1,
    });

    expect(events).toHaveLength(3);
    expect(events[0]?.sessionId).toBeUndefined();
    expect(events[0]?.cwd).toBeUndefined();
    expect(events[1]).toMatchObject({ sessionId: "abc-123", cwd: "/repo" });
    expect(events[2]?.sessionId).toBeUndefined();
    expect(events[2]?.cwd).toBeUndefined();

    fs.rmSync(path.dirname(usagePath), { recursive: true, force: true });
  });

  it("returns an empty snapshot when the log is missing", () => {
    const snapshot = loadSkillUsage({ usagePath: path.join(os.tmpdir(), "session-search-missing-usage.jsonl"), codexSessionsDir: null });
    expect(snapshot.exists).toBe(false);
    expect(snapshot.totalEvents).toBe(0);
    expect(snapshot.stats).toEqual([]);
    expect(usageForSkill(snapshot, "anything")).toBeNull();
  });

  it("counts Codex skill reads from function call arguments", () => {
    const codexSessionsDir = writeCodexSession([
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T10:00:00.000Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: "sed -n '1,200p' /tmp/session-search-fixtures/codex/skills/brainstorming/SKILL.md" }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-02T10:00:00.000Z",
        payload: {
          type: "function_call",
          name: "read_file",
          arguments: { path: "/tmp/session-search-fixtures/agents/skills/tdd/SKILL.md" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-02T10:30:00.000Z",
        payload: {
          type: "function_call",
          name: "apply_patch",
          arguments: JSON.stringify({ patch: "*** Update File: /tmp/session-search-fixtures/codex/skills/patch-helper/SKILL.md" }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-03T10:00:00.000Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: "cat /tmp/session-search-fixtures/codex/skills/brainstorming/SKILL.md" }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-04T10:00:00.000Z",
        payload: {
          type: "function_call_output",
          output: "/tmp/session-search-fixtures/.codex/skills/ignored/SKILL.md",
        },
      }),
    ]);

    const snapshot = loadSkillUsage({
      usagePath: path.join(os.tmpdir(), "session-search-missing-usage.jsonl"),
      codexSessionsDir,
    });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.totalEvents).toBe(2);
    expect(snapshot.stats).toEqual([
      { skill: "brainstorming", count: 2, lastUsedAt: Date.parse("2026-06-03T10:00:00.000Z") },
    ]);
    expect(usageForSkill(snapshot, "TDD")).toBeNull();
    expect(usageForSkill(snapshot, "patch-helper")).toBeNull();
    expect(usageForSkill(snapshot, "TDD", "claude")).toBeNull();

    fs.rmSync(path.dirname(codexSessionsDir), { recursive: true, force: true });
  });

  it("keeps same-name Codex and Claude usage separate for per-agent lookups", () => {
    const usagePath = writeUsageLog([
      JSON.stringify({ skill: "brainstorming", ts: "2026-06-01T10:00:00.000Z" }),
    ]);
    const codexSessionsDir = writeCodexSession([
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-02T10:00:00.000Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: "cat /tmp/session-search-fixtures/.codex/skills/brainstorming/SKILL.md" }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-03T10:00:00.000Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: "cat /tmp/session-search-fixtures/.codex/skills/brainstorming/SKILL.md" }),
        },
      }),
    ]);

    const snapshot = loadSkillUsage({ usagePath, codexSessionsDir });

    expect(usageForSkill(snapshot, "brainstorming")?.count).toBe(3);
    expect(usageForSkill(snapshot, "brainstorming", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "brainstorming", "codex")?.count).toBe(2);

    fs.rmSync(path.dirname(usagePath), { recursive: true, force: true });
    fs.rmSync(path.dirname(codexSessionsDir), { recursive: true, force: true });
  });
});
