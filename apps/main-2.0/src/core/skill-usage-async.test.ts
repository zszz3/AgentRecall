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
      const failedPath = "/tmp/.codex/skills/paged-failed/SKILL.md";
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
        {
          type: "event_msg",
          timestamp: "2026-08-04T00:00:04.000Z",
          payload: {
            type: "item_completed",
            turn_id: "turn-1",
            item: {
              type: "CommandExecution",
              id: "cmd-3",
              command: ["cat", failedPath],
              cwd: "/repo",
              status: "failed",
              exit_code: 1,
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
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ skill: "paged-failed" }),
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

  it("counts Codex Desktop wrapped exec commands through the structured tool-call layer", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-wrapped-codex-skill-usage-"));
    try {
      const sessionPath = path.join(homeDir, ".codex", "sessions", "2026", "08", "rollout.jsonl");
      const skillPath = "/tmp/.codex/skills/wrapped-review/SKILL.md";
      writeJsonl(sessionPath, [{
        type: "response_item",
        timestamp: "2026-08-04T00:00:00.000Z",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "exec-1",
          input: `const r = await tools.exec_command({"cmd":"cat ${skillPath}"}); text(r.output)`,
        },
      }]);

      const sources = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: path.dirname(sessionPath) });
      const source = sources.find((item) => item.path === sessionPath);
      await expect(readSkillUsageSourceEventsAsync(source!)).resolves.toEqual([
        expect.objectContaining({ agent: "codex", skill: "wrapped-review" }),
      ]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("resolves paginated Code Mode catalogs and excludes unexecuted Skill scripts", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-structured-skill-"));
    try {
      const sessionPath = path.join(homeDir, ".codex", "sessions", "2026", "08", "rollout.jsonl");
      writeJsonl(sessionPath, [
        {
          type: "session_meta",
          timestamp: "2026-08-19T10:00:00.000Z",
          payload: { id: "session-structured", cwd: "/repo", history_mode: "paginated" },
        },
        {
          type: "response_item",
          timestamp: "2026-08-19T10:00:00.100Z",
          payload: {
            type: "message",
            role: "developer",
            content: [{
              type: "input_text",
              text: "<skills_instructions>\n- search: Search sources. (executor package: e0/search)\n</skills_instructions>",
            }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-08-19T10:00:01.000Z",
          payload: {
            type: "custom_tool_call",
            call_id: "exec-container",
            name: "exec",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-exec" },
            input: [
              "await tools.skills__read({ package: 'e0/search' });",
              "await tools.exec_command({ cmd: \"sed -n '1,20p' /tmp/.codex/skills/review/SKILL.md\" });",
              "await tools.exec_command({ cmd: \"rg TODO /tmp/.codex/skills/not-run/scripts/run.py\" });",
              "await tools.exec_command({ cmd: 'powershell -File C:\\\\Users\\\\me\\\\.codex\\\\skills\\\\win\\\\scripts\\\\run.ps1' });",
            ].join("\n"),
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-08-19T10:00:02.000Z",
          payload: {
            type: "item_completed",
            turn_id: "turn-exec",
            item: { type: "DynamicToolCall", id: "search-runtime", namespace: "skills", tool: "read", arguments: { package: "e0/search" }, status: "completed", success: true },
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-08-19T10:00:03.000Z",
          payload: {
            type: "item_completed",
            turn_id: "turn-exec",
            item: { type: "CommandExecution", id: "review-runtime", command: "sed -n '1,20p' /tmp/.codex/skills/review/SKILL.md", status: "completed", exit_code: 0 },
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-08-19T10:00:04.000Z",
          payload: {
            type: "item_completed",
            turn_id: "turn-exec",
            item: { type: "CommandExecution", id: "win-runtime", command: "powershell -File C:\\Users\\me\\.codex\\skills\\win\\scripts\\run.ps1", status: "completed", exit_code: 0 },
          },
        },
        {
          type: "event_msg",
          timestamp: "2026-08-19T10:00:05.000Z",
          payload: {
            type: "item_completed",
            turn_id: "turn-exec",
            item: {
              type: "CommandExecution",
              id: "trusted-runtime",
              command: "custom-runner /tmp/.codex/skills/trusted/scripts/run.py",
              plugin_id: "trusted@marketplace",
              script_path: "scripts/run.py",
              status: "completed",
              exit_code: 0,
            },
          },
        },
      ]);
      const staticOnlyPath = path.join(path.dirname(sessionPath), "static-only.jsonl");
      writeJsonl(staticOnlyPath, [
        { type: "session_meta", payload: { id: "session-static", history_mode: "paginated" } },
        {
          type: "response_item",
          timestamp: "2026-08-19T10:00:06.000Z",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "static-container",
            input: "await tools.exec_command({ cmd: 'cat /tmp/.codex/skills/static/SKILL.md' });",
          },
        },
      ]);

      const sources = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: path.dirname(sessionPath) });
      const source = sources.find((item) => item.path === sessionPath);
      const events = await readSkillUsageSourceEventsAsync(source!);
      expect(events.map((event) => event.skill).sort()).toEqual(["review", "search", "trusted", "win"]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ skill: "search", sessionId: "session-structured", cwd: "/repo" }),
        expect.objectContaining({ skill: "win", sessionId: "session-structured" }),
      ]));
      expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ skill: "not-run" })]));
      const staticOnlySource = sources.find((item) => item.path === staticOnlyPath);
      await expect(readSkillUsageSourceEventsAsync(staticOnlySource!)).resolves.toEqual([]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("discovers StepCode usage and honors each record's agent and outcome", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-stepcode-skill-usage-"));
    try {
      const sessionPath = path.join(homeDir, ".stepcode", "sessions", "usage.jsonl");
      writeJsonl(sessionPath, [
        {
          type: "tool.call",
          agent: "claude",
          ts: "2026-08-04T00:00:01.000Z",
          toolName: "Read",
          data: { input: { path: "/tmp/.claude/skills/stepcode-claude/SKILL.md" } },
        },
        {
          type: "tool.call",
          agent: "codex",
          ts: "2026-08-04T00:00:02.000Z",
          toolName: "read_file",
          data: { input: { path: "/tmp/.codex/skills/stepcode-codex/SKILL.md" } },
        },
        {
          type: "tool.call",
          agent: "codex",
          ts: "2026-08-04T00:00:03.000Z",
          toolName: "read_file",
          data: { isError: true, input: { path: "/tmp/.codex/skills/ignored/SKILL.md" } },
        },
      ]);

      const disabled = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: null, includeStepcode: false });
      expect(disabled).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: sessionPath })]));

      const sources = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: null, includeStepcode: true });
      const source = sources.find((item) => item.path === sessionPath);
      const events = await readSkillUsageSourceEventsAsync(source!);
      expect(events).toEqual([
        expect.objectContaining({
          agent: "claude",
          skill: "stepcode-claude",
          timestamp: Date.parse("2026-08-04T00:00:01.000Z"),
        }),
        expect.objectContaining({
          agent: "codex",
          skill: "stepcode-codex",
          timestamp: Date.parse("2026-08-04T00:00:02.000Z"),
        }),
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
