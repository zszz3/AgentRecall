import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listSkillUsageSources,
  listSkillUsageSourcesAsync,
  loadSkillUsage,
  readSkillUsageSourceEventsAsync,
} from "./skill-usage";

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
}

describe("asynchronous skill usage refresh", () => {
  it("discovers active and archived Codex sessions without synchronous directory walking", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-skill-usage-"));
    try {
      const codexHome = path.join(homeDir, ".codex");
      const activePath = path.join(codexHome, "sessions", "2026", "08", "active.jsonl");
      const archivedPath = path.join(codexHome, "archived_sessions", "archived.jsonl");
      for (const filePath of [activePath, archivedPath]) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify({
          type: "response_item",
          timestamp: "2026-08-04T00:00:00.000Z",
          payload: {
            type: "function_call",
            name: "read_file",
            arguments: JSON.stringify({ path: "/tmp/.codex/skills/async-review/SKILL.md" }),
          },
        })}\n`, "utf8");
      }

      const sources = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: path.join(codexHome, "sessions") });
      expect(sources.map((source) => source.path)).toEqual(expect.arrayContaining([activePath, archivedPath]));
      const activeSource = sources.find((source) => source.path === activePath);
      await expect(readSkillUsageSourceEventsAsync(activeSource!)).resolves.toEqual([
        expect.objectContaining({ agent: "codex", skill: "async-review" }),
      ]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("counts paginated Codex runtime calls once and keeps session linkage", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-paginated-skill-usage-"));
    try {
      const sessionPath = path.join(homeDir, ".codex", "sessions", "2026", "08", "rollout.jsonl");
      const skillPath = "/tmp/.codex/skills/paged-read/SKILL.md";
      const completionOnlyPath = "/tmp/.codex/skills/paged-only/SKILL.md";
      writeJsonl(sessionPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-04T00:00:00.000Z",
          payload: { id: "s-1", cwd: "/repo", history_mode: "paginated" },
        },
        {
          type: "response_item",
          timestamp: "2026-08-04T00:00:01.000Z",
          payload: {
            type: "function_call",
            name: "shell_command",
            call_id: "cmd-1",
            arguments: JSON.stringify({ command: `cat ${skillPath}` }),
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-08-04T00:00:02.000Z",
          payload: {
            type: "item_completed",
            turn_id: "turn-1",
            item: {
              type: "CommandExecution",
              id: "cmd-1",
              command: ["cat", skillPath],
              cwd: "/repo",
              status: "completed",
              exit_code: 0,
            },
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-08-04T00:00:03.000Z",
          payload: {
            type: "item_completed",
            turn_id: "turn-1",
            item: {
              type: "CommandExecution",
              id: "cmd-2",
              command: ["sed", "-n", "1,5p", completionOnlyPath],
              cwd: "/repo",
              status: "completed",
              exit_code: 0,
            },
          },
        },
      ]);

      const sources = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: path.dirname(sessionPath) });
      const source = sources.find((item) => item.path === sessionPath);
      const events = await readSkillUsageSourceEventsAsync(source!);
      expect(events).toHaveLength(2);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ agent: "codex", skill: "paged-read", sessionId: "s-1", cwd: "/repo" }),
        expect.objectContaining({ agent: "codex", skill: "paged-only", sessionId: "s-1", cwd: "/repo" }),
      ]));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps Codex skill envelopes alongside structured tool calls", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-envelope-skill-usage-"));
    try {
      const sessionPath = path.join(homeDir, ".codex", "sessions", "2026", "08", "rollout.jsonl");
      const skillPath = "/tmp/.codex/skills/envelope-demo/SKILL.md";
      writeJsonl(sessionPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-04T00:00:00.000Z",
          payload: { id: "s-2", cwd: "/repo" },
        },
        {
          type: "response_item",
          timestamp: "2026-08-04T00:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: `<skill><name>envelope-demo</name><path>${skillPath}</path>\n# demo\n</skill>`,
            }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-08-04T00:00:02.000Z",
          payload: {
            type: "function_call",
            name: "shell_command",
            call_id: "cmd-1",
            arguments: JSON.stringify({ command: `cat ${skillPath}` }),
          },
        },
      ]);

      const sources = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: path.dirname(sessionPath) });
      const source = sources.find((item) => item.path === sessionPath);
      const events = await readSkillUsageSourceEventsAsync(source!);
      expect(events).toHaveLength(2);
      expect(events.filter((event) => "skillHash" in event)).toEqual([
        expect.objectContaining({ agent: "codex", skill: "envelope-demo", sessionId: "s-2" }),
      ]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("gates WorkBuddy usage and scans only root and subagent session layouts", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-workbuddy-skill-usage-"));
    try {
      const projectsDir = path.join(homeDir, ".workbuddy", "projects");
      writeJsonl(path.join(projectsDir, "repo", "session.jsonl"), [
        { type: "function_call", name: "Read", timestamp: 1_780_000_001_100, arguments: { path: "/tmp/.codex/skills/workbuddy-review/SKILL.md" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Read", input: { path: "/tmp/.codex/skills/not-workbuddy-schema/SKILL.md" } }],
          },
          timestamp: 1_780_000_001_150,
        },
      ]);
      writeJsonl(path.join(projectsDir, "repo", "session", "subagents", "2025.01.01.jsonl"), [
        { type: "function_call", name: "Read", timestamp: 1_780_000_001_200, arguments: { path: "/tmp/.claude/skills/workbuddy-subagent/SKILL.md" } },
      ]);
      writeJsonl(path.join(projectsDir, "repo", "session", "tool-results", "ignored.jsonl"), [
        { type: "function_call", name: "Read", timestamp: 1_780_000_001_300, arguments: { path: "/tmp/.codex/skills/ignored/SKILL.md" } },
      ]);
      writeJsonl(path.join(projectsDir, "repo", "nested", "ignored.jsonl"), [
        { type: "function_call", name: "Read", timestamp: 1_780_000_001_400, arguments: { path: "/tmp/.codex/skills/ignored-nested/SKILL.md" } },
      ]);
      writeJsonl(path.join(projectsDir, "repo", "2025.01.01.jsonl"), [
        { type: "function_call", name: "Read", timestamp: 1_780_000_001_500, arguments: { path: "/tmp/.codex/skills/ignored-main-stem/SKILL.md" } },
      ]);
      writeJsonl(path.join(projectsDir, "repo", "session", "subagents", ".jsonl"), [
        { type: "function_call", name: "Read", timestamp: 1_780_000_001_600, arguments: { path: "/tmp/.codex/skills/ignored-empty-subagent-stem/SKILL.md" } },
      ]);

      expect(listSkillUsageSources({ homeDir, codexSessionsDir: null, includeWorkBuddy: false }))
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "workbuddy-session" })]));
      const syncSources = listSkillUsageSources({ homeDir, codexSessionsDir: null, includeWorkBuddy: true });
      expect(syncSources
        .filter((source) => source.kind === "workbuddy-session")
        .map(({ agent, provider, kind, path: sourcePath }) => ({
          agent,
          provider,
          kind,
          path: path.relative(projectsDir, sourcePath),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)))
        .toEqual([
          { agent: "codex", provider: "workbuddy", kind: "workbuddy-session", path: path.join("repo", "session.jsonl") },
          {
            agent: "codex",
            provider: "workbuddy",
            kind: "workbuddy-session",
            path: path.join("repo", "session", "subagents", "2025.01.01.jsonl"),
          },
        ]);
      const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: null, includeWorkBuddy: true });
      expect(snapshot.byAgentName["codex:workbuddy-review"]?.count).toBe(1);
      expect(snapshot.byAgentName["claude:workbuddy-subagent"]?.count).toBe(1);
      expect(snapshot.byName.ignored).toBeUndefined();
      expect(snapshot.byName["not-workbuddy-schema"]).toBeUndefined();
      expect(snapshot.byName["ignored-nested"]).toBeUndefined();
      expect(snapshot.byName["ignored-main-stem"]).toBeUndefined();
      expect(snapshot.byName["ignored-empty-subagent-stem"]).toBeUndefined();

      const asyncSources = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: null, includeWorkBuddy: true });
      const workBuddySources = asyncSources.filter((source) => source.kind === "workbuddy-session");
      expect(workBuddySources
        .map((source) => path.relative(projectsDir, source.path))
        .sort((left, right) => left.localeCompare(right)))
        .toEqual([
          path.join("repo", "session.jsonl"),
          path.join("repo", "session", "subagents", "2025.01.01.jsonl"),
        ]);
      const events = (await Promise.all(workBuddySources.map((source) => readSkillUsageSourceEventsAsync(source)))).flat();
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ agent: "codex", skill: "workbuddy-review" }),
        expect.objectContaining({ agent: "claude", skill: "workbuddy-subagent" }),
      ]));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
