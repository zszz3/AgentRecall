import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  loadSkillUsage,
  readSkillUsageSourceEvents,
  readSkillUsageSourceEventsAsync,
  usageForSkill,
} from "./skill-usage";

function withTempHome(run: (homeDir: string) => void): void {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skill-usage-"));
  try {
    run(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function writeUsageLog(homeDir: string, lines: string[]): string {
  const usagePath = path.join(homeDir, ".claude", "skill-usage.jsonl");
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.writeFileSync(usagePath, lines.join("\n"), "utf8");
  return usagePath;
}

function writeCodexSession(homeDir: string, lines: string[]): string {
  const sessionsDir = path.join(homeDir, "codex-fixture", "sessions");
  const sessionDir = path.join(sessionsDir, "2026", "06", "01");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "rollout.jsonl"), lines.join("\n"), "utf8");
  return sessionsDir;
}

function writeClaudeSession(homeDir: string, lines: string[]): string {
  const projectDir = path.join(homeDir, ".claude", "projects", "repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  return filePath;
}

function claudeSkillUse(id: string, skill: string, timestamp: string, sessionId = "sess-1", cwd = "/repo"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId,
    cwd,
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] },
  });
}

describe("skill usage", () => {
  it("aggregates counts and last-used time per skill from Claude sessions", () => withTempHome((homeDir) => {
    writeClaudeSession(homeDir, [
      claudeSkillUse("call_1", "brainstorming", "2026-06-01T10:00:00.000Z"),
      claudeSkillUse("call_2", "brainstorming", "2026-06-02T10:00:00.000Z"),
      claudeSkillUse("call_3", "tdd", "2026-06-03T10:00:00.000Z"),
    ]);

    const snapshot = loadSkillUsage({ homeDir, usagePath: path.join(homeDir, "missing.jsonl"), codexSessionsDir: null });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.totalEvents).toBe(3);
    expect(snapshot.stats).toEqual([
      { skill: "brainstorming", count: 2, lastUsedAt: Date.parse("2026-06-02T10:00:00.000Z") },
      { skill: "tdd", count: 1, lastUsedAt: Date.parse("2026-06-03T10:00:00.000Z") },
    ]);
    expect(usageForSkill(snapshot, "Brainstorming", "claude")?.count).toBe(2);
  }));

  it("returns no events from the claude-hook source (data is merged into sessions)", () => withTempHome((homeDir) => {
    const usagePath = writeUsageLog(homeDir, [
      JSON.stringify({ skill: "review", ts: "2026-06-01T10:00:00.000Z", session_id: "abc-123", skill_hash: "a1b2c3" }),
    ]);

    const events = readSkillUsageSourceEvents({
      agent: "claude",
      kind: "claude-hook",
      path: usagePath,
      mtimeMs: 1,
      fileSize: 1,
    });

    expect(events).toEqual([]);
  }));

  it("enriches Claude session events with skill_hash from matching hook records", () => withTempHome((homeDir) => {
    const sessionPath = writeClaudeSession(homeDir, [
      claudeSkillUse("call_1", "review", "2026-06-01T10:00:00.000Z", "sess-abc"),
    ]);
    const hookLogPath = writeUsageLog(homeDir, [
      "not json",
      JSON.stringify({ ts: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ skill: "  ", ts: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ skill: "review", ts: "2026-06-01T10:00:01.000Z", session_id: "sess-abc", skill_hash: "a1b2c3" }),
      JSON.stringify({ skill: "review", ts: "2026-06-01T10:00:00.000Z", session_id: "other", skill_hash: "deadbeef" }),
    ]);
    const stat = fs.statSync(sessionPath);

    const events = readSkillUsageSourceEvents({
      agent: "claude",
      provider: "claude",
      kind: "claude-session",
      path: sessionPath,
      mtimeMs: stat.mtimeMs,
      fileSize: stat.size,
      hookLogPath,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ skill: "review", sessionId: "sess-abc", skillHash: "a1b2c3" });
  }));

  it("returns an empty snapshot when the log is missing", () => withTempHome((homeDir) => {
    const snapshot = loadSkillUsage({
      homeDir,
      usagePath: path.join(homeDir, ".claude", "missing-skill-usage.jsonl"),
      codexSessionsDir: null,
    });
    expect(snapshot.exists).toBe(false);
    expect(snapshot.totalEvents).toBe(0);
    expect(snapshot.stats).toEqual([]);
    expect(usageForSkill(snapshot, "anything")).toBeNull();
  }));

  it("counts Codex skill reads from function call arguments", () => withTempHome((homeDir) => {
    const codexSessionsDir = writeCodexSession(homeDir, [
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
      homeDir,
      usagePath: path.join(homeDir, ".claude", "missing-skill-usage.jsonl"),
      codexSessionsDir,
    });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.totalEvents).toBe(3);
    expect(snapshot.stats).toEqual([
      { skill: "brainstorming", count: 2, lastUsedAt: Date.parse("2026-06-03T10:00:00.000Z") },
      { skill: "tdd", count: 1, lastUsedAt: Date.parse("2026-06-02T10:00:00.000Z") },
    ]);
    expect(usageForSkill(snapshot, "TDD")?.count).toBe(1);
    expect(usageForSkill(snapshot, "patch-helper")).toBeNull();
    expect(usageForSkill(snapshot, "TDD", "claude")).toBeNull();
  }));

  it("keeps same-name Codex and Claude usage separate for per-agent lookups", () => withTempHome((homeDir) => {
    writeClaudeSession(homeDir, [
      claudeSkillUse("call_1", "brainstorming", "2026-06-01T10:00:00.000Z"),
    ]);
    const codexSessionsDir = writeCodexSession(homeDir, [
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

    const snapshot = loadSkillUsage({ homeDir, usagePath: path.join(homeDir, "missing.jsonl"), codexSessionsDir });

    expect(usageForSkill(snapshot, "brainstorming")?.count).toBe(3);
    expect(usageForSkill(snapshot, "brainstorming", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "brainstorming", "codex")?.count).toBe(2);
  }));

  it("streams Codex usage logs without parsing oversized image rows", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-skill-usage-"));
    try {
      const codexSessionsDir = writeCodexSession(homeDir, [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: `data:image/png;base64,${"x".repeat(2 * 1024 * 1024)}`,
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-05T10:00:00.000Z",
          payload: {
            type: "function_call",
            name: "shell_command",
            arguments: JSON.stringify({
              command: "cat /tmp/session-search-fixtures/.codex/skills/tdd/SKILL.md",
            }),
          },
        }),
      ]);
      const filePath = path.join(codexSessionsDir, "2026", "06", "01", "rollout.jsonl");
      const stat = fs.statSync(filePath);

      const events = await readSkillUsageSourceEventsAsync({
        agent: "codex",
        provider: "codex",
        kind: "codex-session",
        path: filePath,
        mtimeMs: stat.mtimeMs,
        fileSize: stat.size,
      });

      expect(events).toEqual([{
        agent: "codex",
        skill: "tdd",
        timestamp: Date.parse("2026-06-05T10:00:00.000Z"),
      }]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("records a Codex skill expansion with its session, cwd and trigger-time version", () => withTempHome((homeDir) => {
    const skillBody = "---\nname: control-in-app-browser\n---\n\n# Browser\nDrive the in-app browser.\n";
    const skillPath = "/home/dev/.codex/plugins/cache/openai-bundled/browser/26.7/skills/control-in-app-browser/SKILL.md";
    const codexSessionsDir = writeCodexSession(homeDir, [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: "019fb258-e7ba", cwd: "/home/dev/project" },
      }),
      // What the user typed. A mention alone must never count as a trigger.
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-05T09:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `[$browser:control-in-app-browser](${skillPath}) open github` }],
        },
      }),
      // What Codex injected when it expanded the skill.
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-05T09:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `<skill>\n<name>browser:control-in-app-browser</name>\n<path>${skillPath}</path>\n${skillBody}</skill>`,
          }],
        },
      }),
    ]);

    const snapshot = loadSkillUsage({ homeDir, usagePath: path.join(homeDir, "missing.jsonl"), codexSessionsDir });

    expect(snapshot.totalEvents).toBe(1);
    expect(usageForSkill(snapshot, "browser:control-in-app-browser", "codex")?.count).toBe(1);
  }));

  it("hashes the embedded skill text exactly as the on-disk SKILL.md", () => withTempHome((homeDir) => {
    const skillBody = "---\nname: tdd\n---\n\n# TDD\nWrite the test first.\n";
    const skillPath = path.join(homeDir, ".codex", "skills", "tdd", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, skillBody, "utf8");
    const codexSessionsDir = writeCodexSession(homeDir, [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: "sess-hash", cwd: homeDir },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-05T09:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          // Codex inlines the file plus one trailing newline.
          content: [{ type: "input_text", text: `<skill>\n<name>tdd</name>\n<path>${skillPath}</path>\n${skillBody}\n</skill>` }],
        },
      }),
    ]);
    const filePath = path.join(codexSessionsDir, "2026", "06", "01", "rollout.jsonl");
    const stat = fs.statSync(filePath);

    const events = readSkillUsageSourceEvents({
      agent: "codex",
      provider: "codex",
      kind: "codex-session",
      path: filePath,
      mtimeMs: stat.mtimeMs,
      fileSize: stat.size,
    });

    expect(events).toEqual([{
      agent: "codex",
      skill: "tdd",
      timestamp: Date.parse("2026-06-05T09:00:01.000Z"),
      sessionId: "sess-hash",
      cwd: homeDir,
      // Same invariant as skillMarkdownHash in bin/skill-usage-record.cjs.
      skillHash: createHash("sha256").update(fs.readFileSync(skillPath)).digest("hex"),
    }]);
  }));

  it("keeps reading Codex triggers after a thread is archived", () => withTempHome((homeDir) => {
    const codexHome = path.join(homeDir, "codex-fixture");
    const archivedDir = path.join(codexHome, "archived_sessions");
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(archivedDir, "rollout-archived.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { session_id: "archived-1", cwd: "/home/dev/p" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-06T09:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<skill>\n<name>visualize</name>\n<path>/home/dev/.codex/plugins/cache/o/visualize/1.0/skills/visualize/SKILL.md</path>\nbody\n</skill>" }],
        },
      }),
    ].join("\n"), "utf8");

    const snapshot = loadSkillUsage({
      homeDir,
      usagePath: path.join(homeDir, "missing.jsonl"),
      codexSessionsDir: path.join(codexHome, "sessions"),
    });

    expect(usageForSkill(snapshot, "visualize", "codex")?.count).toBe(1);
  }));

  it("ignores a Claude skill call whose result reports an error", () => withTempHome((homeDir) => {
    const projectDir = path.join(homeDir, ".claude", "projects", "repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "session.jsonl"), [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-07T09:00:00.000Z",
        sessionId: "claude-1",
        cwd: "/home/dev/repo",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_ok", name: "Skill", input: { skill: "repo-health" } }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-07T09:00:02.000Z",
        sessionId: "claude-1",
        cwd: "/home/dev/repo",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_bad", name: "Skill", input: { skill: "ghost" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-07T09:00:03.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_bad", is_error: true, content: "Unknown skill: ghost" }],
        },
      }),
    ].join("\n"), "utf8");

    const snapshot = loadSkillUsage({
      homeDir,
      usagePath: path.join(homeDir, "missing.jsonl"),
      codexSessionsDir: null,
    });

    expect(usageForSkill(snapshot, "repo-health", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "ghost", "claude")).toBeNull();
  }));
});
