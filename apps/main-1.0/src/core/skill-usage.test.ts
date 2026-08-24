import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  listSkillUsageSources,
  listSkillUsageSourcesAsync,
  loadSkillUsage,
  readSkillUsageSourceEventsAsync,
  usageForSkill,
} from "./skill-usage";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

function withTempHome(run: (homeDir: string) => void): void {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-skill-usage-"));
  try {
    run(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

async function withTempHomeAsync(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-skill-usage-"));
  try {
    await run(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n"), "utf8");
}

function codexCall(
  name: string,
  input: unknown,
  timestamp = "2026-06-01T10:00:00.000Z",
  type: "function_call" | "custom_tool_call" = "function_call",
): unknown {
  return {
    type: "response_item",
    timestamp,
    payload: { type, name, [type === "custom_tool_call" ? "input" : "arguments"]: input },
  };
}

function assistantToolUse(name: string, input: unknown, timestamp = "2026-06-01T10:00:00.000Z"): unknown {
  return {
    type: "assistant",
    timestamp,
    message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
  };
}

describe("skill usage", () => {
  it("aggregates Claude hook records and skips malformed lines", () => withTempHome((homeDir) => {
    const usagePath = path.join(homeDir, ".claude", "skill-usage.jsonl");
    writeJsonl(usagePath, [
      { skill: "brainstorming", ts: "2026-06-01T10:00:00.000Z" },
      "not json",
      { ts: "2026-06-02T10:00:00.000Z" },
      { skill: "brainstorming", ts: "2026-06-03T10:00:00.000Z" },
      { skill: "tdd", ts: "2026-06-02T10:00:00.000Z" },
    ]);

    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: null });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.totalEvents).toBe(3);
    expect(snapshot.stats).toEqual([
      { skill: "brainstorming", count: 2, lastUsedAt: Date.parse("2026-06-03T10:00:00.000Z") },
      { skill: "tdd", count: 1, lastUsedAt: Date.parse("2026-06-02T10:00:00.000Z") },
    ]);
    expect(usageForSkill(snapshot, "Brainstorming", "claude")?.count).toBe(2);
  }));

  it("returns an empty snapshot when no synthetic source exists", () => withTempHome((homeDir) => {
    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: null });
    expect(snapshot.exists).toBe(false);
    expect(snapshot.totalEvents).toBe(0);
    expect(usageForSkill(snapshot, "anything")).toBeNull();
  }));

  it("counts Codex Read/read_file and structured custom tool calls", () => withTempHome((homeDir) => {
    const sessionsDir = path.join(homeDir, "codex-fixture", "sessions");
    writeJsonl(path.join(sessionsDir, "2026", "06", "rollout.jsonl"), [
      codexCall("shell_command", JSON.stringify({ command: "cat /tmp/.codex/skills/brainstorming/SKILL.md" })),
      codexCall("read_file", { path: "/tmp/.agents/skills/tdd/SKILL.md" }, "2026-06-02T10:00:00.000Z"),
      codexCall("Read", JSON.stringify({ file_path: "C:\\Users\\me\\.codex\\skills\\review-code\\SKILL.md" }), "2026-06-03T10:00:00.000Z"),
      codexCall("read_file", { path: "/tmp/.claude/skills/shared-review/SKILL.md" }, "2026-06-04T10:00:00.000Z"),
      codexCall("read_file", { path: "/tmp/.qoder/skills/qoder-review/SKILL.md" }, "2026-06-05T10:00:00.000Z"),
      codexCall("read_file", { path: "/tmp/.codex/skills/custom/SKILL.md" }, "2026-06-06T10:00:00.000Z", "custom_tool_call"),
    ]);

    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: sessionsDir });

    expect(snapshot.totalEvents).toBe(6);
    expect(usageForSkill(snapshot, "brainstorming", "codex")?.count).toBe(1);
    expect(usageForSkill(snapshot, "tdd", "codex")?.count).toBe(1);
    expect(usageForSkill(snapshot, "review-code", "codex")?.count).toBe(1);
    expect(usageForSkill(snapshot, "shared-review", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "qoder-review", "qoder")?.count).toBe(1);
    expect(usageForSkill(snapshot, "custom", "codex")?.count).toBe(1);
  }));

  it("excludes edit, write, patch, result, and output records", () => withTempHome((homeDir) => {
    const sessionsDir = path.join(homeDir, "codex-fixture", "sessions");
    const skillPath = "/tmp/.codex/skills/ignored/SKILL.md";
    writeJsonl(path.join(sessionsDir, "rollout.jsonl"), [
      codexCall("apply_patch", { patch: skillPath }),
      codexCall("write_file", { path: skillPath }),
      codexCall("edit", { file_path: skillPath }),
      { type: "response_item", timestamp: "2026-06-01T10:00:00.000Z", payload: { type: "function_call_output", output: skillPath } },
      { type: "response_item", timestamp: "2026-06-01T10:00:00.000Z", payload: { type: "custom_tool_call_output", output: skillPath } },
    ]);

    expect(loadSkillUsage({ homeDir, codexSessionsDir: sessionsDir }).totalEvents).toBe(0);
  }));

  it("counts native Claude tool_use and explicit Skill calls instead of the hook", () => withTempHome((homeDir) => {
    writeJsonl(path.join(homeDir, ".claude", "skill-usage.jsonl"), [
      { skill: "duplicate", ts: "2026-06-01T09:00:00.000Z" },
    ]);
    writeJsonl(path.join(homeDir, ".claude", "projects", "repo", "session.jsonl"), [
      assistantToolUse("Skill", { skill: "brainstorming" }),
      assistantToolUse("Read", { file_path: "/tmp/.claude/skills/review-code/SKILL.md" }, "2026-06-02T10:00:00.000Z"),
      { type: "user", timestamp: "2026-06-03T10:00:00.000Z", message: { role: "user", content: [{ type: "tool_result", content: "/tmp/.claude/skills/ignored/SKILL.md" }] } },
    ]);

    const sources = listSkillUsageSources({ homeDir, codexSessionsDir: null });
    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: null });

    expect(sources.map((source) => source.kind)).toEqual(["claude-session"]);
    expect(snapshot.totalEvents).toBe(2);
    expect(usageForSkill(snapshot, "brainstorming", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "review-code", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "duplicate")).toBeNull();
  }));

  it("discovers TClaude and TCodeX native sessions", () => withTempHome((homeDir) => {
    writeJsonl(path.join(homeDir, ".tclaude", "projects", "repo", "session.jsonl"), [
      assistantToolUse("Skill", { name: "claude-review" }),
    ]);
    writeJsonl(path.join(homeDir, ".tcodex", "sessions", "rollout.jsonl"), [
      codexCall("read_file", { path: "/tmp/project/skills/codex-review/SKILL.md" }),
    ]);

    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: null });
    expect(usageForSkill(snapshot, "claude-review", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "codex-review", "codex")?.count).toBe(1);
  }));

  it("uses informative paths to assign CodeBuddy calls without guessing pathless ownership", () => withTempHome((homeDir) => {
    const sessionPath = path.join(homeDir, ".codebuddy", "projects", "repo", "session.jsonl");
    writeJsonl(sessionPath, [
      { type: "function_call", name: "Read", timestamp: 1_780_000_001_100, arguments: { path: "/tmp/.claude/skills/claude-review/SKILL.md" } },
      { type: "function_call", name: "Read", timestamp: 1_780_000_001_200, input: { path: "C:\\Users\\me\\.qoder\\skills\\qoder-review\\SKILL.md" } },
      { type: "function_call", name: "Skill", timestamp: 1_780_000_001_300, arguments: { skill: "unknown-owner" } },
      { type: "function_call", name: "Read", timestamp: 1_780_000_001_400, arguments: { path: "/tmp/unowned/skills/unowned/SKILL.md" } },
    ]);

    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: null });
    expect(snapshot.totalEvents).toBe(2);
    expect(usageForSkill(snapshot, "claude-review", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "qoder-review", "qoder")?.count).toBe(1);
    expect(usageForSkill(snapshot, "unknown-owner")).toBeNull();
    expect(usageForSkill(snapshot, "unowned")).toBeNull();
  }));

  it("gates WorkBuddy skill usage and scans only supported session layouts", () => withTempHome((homeDir) => {
    const projectsDir = path.join(homeDir, ".workbuddy", "projects");
    writeJsonl(path.join(projectsDir, "repo", "session.jsonl"), [
      { type: "function_call", name: "Read", timestamp: 1_780_000_001_100, arguments: { path: "/tmp/.codex/skills/workbuddy-review/SKILL.md" } },
    ]);
    writeJsonl(path.join(projectsDir, "repo", "session", "subagents", "2025.01.01.jsonl"), [
      { type: "function_call", name: "Read", timestamp: 1_780_000_001_200, arguments: { path: "/tmp/.claude/skills/workbuddy-subagent/SKILL.md" } },
    ]);
    writeJsonl(path.join(projectsDir, "repo", "session", "tool-results", "ignored.jsonl"), [
      { type: "function_call", name: "Read", timestamp: 1_780_000_001_300, arguments: { path: "/tmp/.codex/skills/ignored/SKILL.md" } },
    ]);

    expect(listSkillUsageSources({ homeDir, codexSessionsDir: null, includeWorkBuddy: false }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "workbuddy-session" })]));
    const sources = listSkillUsageSources({ homeDir, codexSessionsDir: null, includeWorkBuddy: true });
    expect(sources.filter((source) => source.kind === "workbuddy-session")).toHaveLength(2);
    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: null, includeWorkBuddy: true });
    expect(usageForSkill(snapshot, "workbuddy-review", "codex")?.count).toBe(1);
    expect(usageForSkill(snapshot, "workbuddy-subagent", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "ignored")).toBeNull();
  }));

  it("discovers proven Cursor and OpenClaw structured tool calls", () => withTempHome((homeDir) => {
    writeJsonl(path.join(homeDir, ".cursor", "projects", "repo", "agent-transcripts", "session.jsonl"), [
      assistantToolUse("Read", { path: "/tmp/.codex/skills/cursor-review/SKILL.md" }),
    ]);
    writeJsonl(path.join(homeDir, ".openclaw", "agents", "main", "sessions", "session.jsonl"), [
      {
        type: "custom",
        customType: "tool_call",
        timestamp: "2026-06-01T10:00:00.000Z",
        data: { name: "shell", command: "cat /tmp/.claude/skills/openclaw-review/SKILL.md" },
      },
    ]);

    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: null });
    expect(usageForSkill(snapshot, "cursor-review", "codex")?.count).toBe(1);
    expect(usageForSkill(snapshot, "openclaw-review", "claude")?.count).toBe(1);
  }));

  it("validates shell commands, aliases, namespaces, and per-call deduplication", () => withTempHome((homeDir) => {
    const sessionsDir = path.join(homeDir, "codex-fixture", "sessions");
    const skillPath = "/tmp/.codex/skills/safe-read/SKILL.md";
    writeJsonl(path.join(sessionsDir, "rollout.jsonl"), [
      codexCall("mcp__filesystem__read_file", { path: `${skillPath} ${skillPath}` }),
      codexCall("shell_command", { command: `head -20 ${skillPath}` }),
      codexCall("shell_command", { command: `sed -n '1,20p' ${skillPath}` }),
      codexCall("shell_command", { command: `rm ${skillPath}` }),
      codexCall("shell_command", { command: `cat ${skillPath} > /tmp/copy` }),
      codexCall("shell_command", { command: `python inspect.py ${skillPath}` }),
      codexCall("shell_command", { command: `cat ${skillPath} && echo done` }),
      codexCall("functions.Skill", { skill_name: "explicit-alias" }),
    ]);

    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: sessionsDir });
    expect(snapshot.totalEvents).toBe(4);
    expect(usageForSkill(snapshot, "safe-read", "codex")?.count).toBe(3);
    expect(usageForSkill(snapshot, "explicit-alias", "codex")?.count).toBe(1);
  }));

  it("counts paginated Codex runtime records once alongside their requests", () => withTempHome((homeDir) => {
    const sessionsDir = path.join(homeDir, "codex-fixture", "sessions");
    const skillPath = "/tmp/.codex/skills/paged-read/SKILL.md";
    const completionOnlyPath = "/tmp/.codex/skills/paged-only/SKILL.md";
    const failedPath = "/tmp/.codex/skills/paged-failed/SKILL.md";
    writeJsonl(path.join(sessionsDir, "rollout.jsonl"), [
      {
        type: "session_meta",
        timestamp: "2026-06-01T09:00:00.000Z",
        payload: { id: "s-1", cwd: "/repo", history_mode: "paginated" },
      },
      {
        type: "response_item",
        timestamp: "2026-06-01T10:00:00.000Z",
        payload: {
          type: "function_call",
          name: "shell_command",
          call_id: "cmd-1",
          arguments: JSON.stringify({ command: `cat ${skillPath}` }),
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-06-01T10:00:05.000Z",
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
        timestamp: "2026-06-01T10:01:00.000Z",
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
        timestamp: "2026-06-01T10:02:00.000Z",
        payload: {
          type: "item_completed",
          turn_id: "turn-1",
          item: {
            type: "DynamicToolCall",
            id: "dyn-1",
            namespace: "skills",
            tool: "read",
            arguments: { package: "e0/search" },
            status: "completed",
            success: true,
          },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-06-01T10:03:00.000Z",
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

    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: sessionsDir });
    expect(snapshot.totalEvents).toBe(2);
    expect(usageForSkill(snapshot, "paged-read", "codex")?.count).toBe(1);
    expect(usageForSkill(snapshot, "paged-only", "codex")?.count).toBe(1);
    expect(usageForSkill(snapshot, "paged-failed", "codex")).toBeNull();
  }));

  it("resolves Code Mode Skill catalogs and counts only executed Skill scripts", () => withTempHome((homeDir) => {
    const sessionsDir = path.join(homeDir, "codex-fixture", "sessions");
    const catalog = {
      type: "response_item",
      timestamp: "2026-08-19T10:00:00.000Z",
      payload: {
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: [
            "<skills_instructions>",
            "- search: Search trusted sources. (executor package: e0/search)",
            "- plugin:deploy: Deploy safely. (orchestrator package: o0/deploy)",
            "</skills_instructions>",
          ].join("\n"),
        }],
      },
    };
    writeJsonl(path.join(sessionsDir, "legacy.jsonl"), [
      { type: "session_meta", payload: { history_mode: "legacy", cwd: "/tmp" } },
      catalog,
      {
        type: "response_item",
        timestamp: "2026-08-19T10:00:00.500Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<skills_instructions>\n- spoofed: no. (executor package: e0/spoofed)\n</skills_instructions>" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-19T10:00:00.750Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<skill><name>envelope-demo</name><path>/tmp/.codex/skills/envelope-demo/SKILL.md</path>\n# demo\n</skill>" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-19T10:00:01.000Z",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "legacy-exec",
          input: [
            "await tools.skills__read({ package: 'e0/search' });",
            "await tools.skills__read({ package: getPackage() });",
            "await tools.exec_command({ cmd: 'python /tmp/.codex/skills/build/scripts/run.py' });",
            "await tools.exec_command({ cmd: 'rg TODO /tmp/.codex/skills/not-run/scripts/run.py' });",
            "await tools.exec_command({ cmd: 'powershell -File C:\\\\Users\\\\me\\\\.codex\\\\skills\\\\win\\\\scripts\\\\run.ps1' });",
          ].join("\n"),
        },
      },
    ]);
    writeJsonl(path.join(sessionsDir, "paginated.jsonl"), [
      { type: "session_meta", payload: { history_mode: "paginated", cwd: "/tmp" } },
      catalog,
      {
        type: "response_item",
        timestamp: "2026-08-19T10:00:02.000Z",
        payload: { type: "custom_tool_call", call_id: "direct-read", namespace: "skills", name: "read", input: { package: "o0/deploy" } },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-19T10:00:02.500Z",
        payload: {
          type: "item_completed",
          item: { type: "DynamicToolCall", id: "direct-read", namespace: "skills", tool: "read", arguments: { package: "o0/deploy" }, status: "completed", success: true },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-19T10:00:03.000Z",
        payload: {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            id: "trusted-script",
            command: "custom-runner /tmp/.codex/skills/trusted/scripts/run.py",
            plugin_id: "trusted@marketplace",
            script_path: "scripts/run.py",
            status: "completed",
            exit_code: 0,
          },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-08-19T10:00:04.000Z",
        payload: {
          type: "item_completed",
          item: { type: "CommandExecution", id: "failed-read", command: "cat /tmp/.codex/skills/failed/SKILL.md", status: "failed", exit_code: 1 },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-19T10:00:05.000Z",
        payload: { type: "custom_tool_call", name: "exec", call_id: "static-only", input: "await tools.exec_command({ cmd: 'cat /tmp/.codex/skills/static/SKILL.md' });" },
      },
    ]);

    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: sessionsDir });
    expect(snapshot.totalEvents).toBe(6);
    for (const skill of ["envelope-demo", "search", "build", "win", "plugin:deploy", "trusted"]) {
      expect(usageForSkill(snapshot, skill, "codex")?.count).toBe(1);
    }
    for (const skill of ["spoofed", "not-run", "failed", "static"]) {
      expect(usageForSkill(snapshot, skill)).toBeNull();
    }
  }));

  it("honors optional source settings and parses Qoder structured calls", () => withTempHome((homeDir) => {
    const qoderPath = path.join(
      homeDir,
      ".qoder",
      "cache",
      "projects",
      "demo-aabbccdd",
      "conversation-history",
      "task-1",
      "task-1.jsonl",
    );
    writeJsonl(qoderPath, [assistantToolUse("Read", { path: "/tmp/.qoder/skills/qoder-review/SKILL.md" })]);

    expect(listSkillUsageSources({ homeDir, codexSessionsDir: null, includeQoder: false }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "qoder-session" })]));
    const snapshot = loadSkillUsage({ homeDir, codexSessionsDir: null, includeQoder: true });
    expect(usageForSkill(snapshot, "qoder-review", "qoder")?.count).toBe(1);
  }));

  it("discovers and reads session usage through the asynchronous refresh path", async () => withTempHomeAsync(async (homeDir) => {
    const sessionsDir = path.join(homeDir, "codex-fixture", "sessions");
    const filePath = path.join(sessionsDir, "2026", "08", "rollout.jsonl");
    writeJsonl(filePath, [
      codexCall("read_file", { path: "/tmp/.codex/skills/async-review/SKILL.md" }),
      "not json",
    ]);

    const sources = await listSkillUsageSourcesAsync({ homeDir, codexSessionsDir: sessionsDir });
    const source = sources.find((candidate) => candidate.path === filePath);
    expect(source).toBeDefined();
    await expect(readSkillUsageSourceEventsAsync(source!)).resolves.toEqual([
      expect.objectContaining({ agent: "codex", skill: "async-review" }),
    ]);
  }));

  it("parses trusted Hermes, OpenCode, CodeWiz, and ZCode database tool calls", () => withTempHome((homeDir) => {
    const hermesPath = path.join(homeDir, ".hermes", "state.db");
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
    const hermes = new DatabaseSync(hermesPath);
    hermes.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, tool_name TEXT, tool_calls TEXT, timestamp REAL)");
    hermes.prepare("INSERT INTO messages (tool_name, tool_calls, timestamp) VALUES (?, ?, ?)").run(
      "terminal",
      JSON.stringify([{ function: { name: "Read", arguments: JSON.stringify({ path: "/tmp/.claude/skills/hermes-review/SKILL.md" }) } }]),
      1_780_000_001,
    );
    hermes.close();

    const databases = [
      [path.join(homeDir, ".local", "share", "opencode", "opencode.db"), "/tmp/.codex/skills/opencode-review/SKILL.md"],
      [path.join(homeDir, ".local", "share", "codewiz", "opencode.db"), "/tmp/.qoder/skills/codewiz-review/SKILL.md"],
      [path.join(homeDir, ".zcode", "cli", "db", "db.sqlite"), "/tmp/.claude/skills/zcode-review/SKILL.md"],
    ] as const;
    for (const [dbPath, skillPath] of databases) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, time_created INTEGER, data TEXT)");
      db.prepare("INSERT INTO part (id, time_created, data) VALUES (?, ?, ?)").run(
        path.basename(skillPath),
        1_780_000_002_000,
        JSON.stringify({ type: "tool", tool: "Read", state: { input: { file_path: skillPath } } }),
      );
      db.close();
    }

    const snapshot = loadSkillUsage({
      homeDir,
      codexSessionsDir: null,
      includeHermes: true,
      includeOpenCode: true,
      includeCodeWizCli: true,
      includeZcode: true,
    });
    expect(usageForSkill(snapshot, "hermes-review", "claude")?.count).toBe(1);
    expect(usageForSkill(snapshot, "opencode-review", "codex")?.count).toBe(1);
    expect(usageForSkill(snapshot, "codewiz-review", "qoder")?.count).toBe(1);
    expect(usageForSkill(snapshot, "zcode-review", "claude")?.count).toBe(1);
  }));

  it("honors CODEX_HOME for default Codex discovery", () => withTempHome((homeDir) => {
    const codexHome = path.join(homeDir, "custom-codex");
    writeJsonl(path.join(codexHome, "sessions", "rollout.jsonl"), [
      codexCall("read_file", { path: "/tmp/.codex/skills/from-env/SKILL.md" }),
    ]);
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      expect(usageForSkill(loadSkillUsage({ homeDir }), "from-env", "codex")?.count).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  }));
});
