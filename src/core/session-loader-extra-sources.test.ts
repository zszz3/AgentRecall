import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadCursorAgentSessions,
  loadCodeWizSessions,
  loadHermesSessions,
  loadOpenClawSessions,
  loadOpenCodeSessions,
  loadDefaultSessions,
  loadTraeSessions,
  loadQoderSessions,
} from "./session-loader";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync };

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `session-search-${name}-`));
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"));
}

describe("extra session sources", () => {
  it("loads OpenClaw JSONL sessions and skips trajectory traces", () => {
    const root = tmpDir("openclaw");
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    writeJsonl(path.join(sessionsDir, "openclaw-1.jsonl"), [
      { type: "session", version: 1, id: "openclaw-1", timestamp: "2026-06-10T08:00:00Z", cwd: "/work/openclaw-app" },
      {
        type: "message",
        id: "msg-1",
        timestamp: "2026-06-10T08:01:00Z",
        message: { role: "user", content: [{ type: "text", text: "Fix OpenClaw login flow" }] },
      },
      {
        type: "message",
        id: "msg-2",
        timestamp: "2026-06-10T08:02:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "I will inspect the auth files." }] },
      },
      {
        type: "custom",
        customType: "tool_call",
        timestamp: "2026-06-10T08:03:00Z",
        data: { name: "shell", command: "npm test" },
      },
    ]);
    writeJsonl(path.join(sessionsDir, "debug.trajectory.jsonl"), [
      { type: "session", id: "trajectory", timestamp: "2026-06-10T08:00:00Z", cwd: "/work/noise" },
    ]);

    const loaded = loadOpenClawSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "openclaw:openclaw-1",
      rawId: "openclaw-1",
      source: "openclaw",
      projectPath: "/work/openclaw-app",
      firstQuestion: "Fix OpenClaw login flow",
      originalTitle: "Fix OpenClaw login flow",
    });
    expect(loaded[0].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Fix OpenClaw login flow",
      "assistant:I will inspect the auth files.",
    ]);
    expect(loaded[0].traceEvents?.[0]).toMatchObject({
      kind: "tool_call",
      source: "openclaw",
      title: "tool_call · npm test",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads Trae memory JSONL as searchable summary sessions", () => {
    const root = tmpDir("trae");
    const siblingRoot = tmpDir("trae-sibling");
    const filePath = path.join(root, "memory", "projects", "-tmp-demo-project", "20260610", "session_memory_abc.jsonl");
    const siblingFilePath = path.join(siblingRoot, "memory", "projects", "-tmp-demo-project", "20260610", "session_memory_sibling.jsonl");
    writeJsonl(filePath, [
      {
        intent: "Investigate slow checkout",
        actions: ["read checkout.ts", "run npm test"],
        outcome: "Found redundant API polling",
        learned: ["Checkout poller runs every render"],
        message_summary_time: "2026-06-10T09:00:00Z",
        message_id: "m1",
      },
    ]);
    writeJsonl(siblingFilePath, [{ intent: "Must not be loaded from an unselected Trae root" }]);

    const loaded = loadTraeSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "trae:session_memory_abc",
      rawId: "session_memory_abc",
      source: "trae",
      projectPath: "/tmp/demo/project",
      firstQuestion: "Investigate slow checkout",
      originalTitle: "Investigate slow checkout",
    });
    expect(loaded[0].messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(loaded[0].messages[1].content).toContain("Found redundant API polling");

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(siblingRoot, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("resolves legacy Trae project directories containing underscores", () => {
    const root = tmpDir("trae-underscore-data");
    const projectRoot = fs.mkdtempSync("/tmp/agentrecall");
    const projectPath = path.join(projectRoot, "trae_projects");
    const projectSegment = projectPath.replace(/[/_]/g, "-");
    const filePath = path.join(root, "memory", "projects", projectSegment, "20260610", "session_memory_underscore.jsonl");

    try {
      fs.mkdirSync(projectPath, { recursive: true });
      writeJsonl(filePath, [
        {
          intent: "Resolve a Trae project path",
          outcome: "Resolved from the filesystem",
          message_summary_time: "2026-06-10T09:00:00Z",
        },
      ]);

      const loaded = loadTraeSessions(root);

      expect(loaded).toHaveLength(1);
      expect(loaded[0].session.projectPath).toBe(projectPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([".trae", ".trae-cn"] as const)("discovers Trae sessions from the default %s home directory", (directory) => {
    const homeDir = tmpDir("trae-default-single");
    try {
      const filePath = path.join(homeDir, directory, "memory", "projects", "-tmp-demo-project", "20260721", "session_memory_single.jsonl");
      writeJsonl(filePath, [{ intent: `Inspect ${directory}`, projectPath: "/tmp/demo/project" }]);

      const loaded = loadDefaultSessions({ homeDir, includeTrae: true });

      expect(loaded.filter((item) => item.session.source === "trae").map((item) => item.session.rawId)).toEqual(["session_memory_single"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("discovers Trae sessions from both official and CN home directories", () => {
    const homeDir = tmpDir("trae-default");
    try {
      for (const [directory, id] of [[".trae", "international"], [".trae-cn", "china"]] as const) {
        const filePath = path.join(homeDir, directory, "memory", "projects", "-tmp-demo-project", "20260721", `session_memory_${id}.jsonl`);
        writeJsonl(filePath, [
          {
            intent: `Investigate ${id} checkout`,
            projectPath: "/tmp/demo/project",
            message_summary_time: "2026-07-21T09:00:00Z",
          },
        ]);
      }

      const loaded = loadDefaultSessions({ homeDir, includeTrae: true });

      expect(loaded.filter((item) => item.session.source === "trae").map((item) => item.session.rawId)).toEqual([
        "session_memory_international",
        "session_memory_china",
      ]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("loads Qoder conversation history JSONL as searchable sessions", () => {
    const root = tmpDir("qoder");
    const filePath = path.join(root, "cache", "projects", "demo-app-1a2b3c4d", "conversation-history", "task-fe3", "task-fe3.jsonl");
    writeJsonl(filePath, [
      { role: "user", message: { content: [{ type: "text", text: "Fix the login bug" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "I will check the auth module." }] } },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "qoder:demo-app-1a2b3c4d/task-fe3",
      rawId: "demo-app-1a2b3c4d/task-fe3",
      source: "qoder",
      projectPath: "demo-app",
      firstQuestion: "Fix the login bug",
      originalTitle: "Fix the login bug",
    });
    expect(loaded[0].messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(loaded[0].messages[0].content).toBe("Fix the login bug");
    expect(loaded[0].messages[1].content).toBe("I will check the auth module.");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips empty Qoder conversation files and concatenates multi-element content", () => {
    const root = tmpDir("qoder-edge");
    const emptyPath = path.join(root, "cache", "projects", "proj-aabbccdd", "conversation-history", "task-empty", "task-empty.jsonl");
    writeJsonl(emptyPath, []);
    const multiPath = path.join(root, "cache", "projects", "proj-aabbccdd", "conversation-history", "task-multi", "task-multi.jsonl");
    writeJsonl(multiPath, [
      { role: "user", message: { content: [{ type: "text", text: "First part" }, { type: "text", text: "Second part" }] } },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.rawId).toBe("proj-aabbccdd/task-multi");
    expect(loaded[0].messages[0].content).toBe("First part\nSecond part");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads Hermes sessions from state.db without writing to the source database", () => {
    const root = tmpDir("hermes");
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        model TEXT,
        model_config TEXT,
        started_at REAL NOT NULL,
        title TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO sessions (id, source, model, model_config, started_at, title, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "hermes-1",
      "cli",
      "claude-sonnet",
      JSON.stringify({ cwd: "/work/hermes-app" }),
      Date.parse("2026-06-10T10:00:00Z") / 1000,
      "Hermes checkout fix",
      100,
      40,
      10,
      5,
    );
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run(
      "hermes-1",
      "user",
      "Fix Hermes checkout",
      Date.parse("2026-06-10T10:01:00Z") / 1000,
    );
    db.prepare("INSERT INTO messages (session_id, role, content, tool_name, tool_calls, timestamp) VALUES (?, ?, ?, ?, ?, ?)").run(
      "hermes-1",
      "assistant",
      "I will inspect the route.",
      "terminal",
      JSON.stringify([{ function: { name: "terminal", arguments: "{\"command\":\"npm test\"}" } }]),
      Date.parse("2026-06-10T10:02:00Z") / 1000,
    );
    db.close();

    const loaded = loadHermesSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "hermes:hermes-1",
      rawId: "hermes-1",
      source: "hermes",
      projectPath: "/work/hermes-app",
      originalTitle: "Hermes checkout fix",
      firstQuestion: "Fix Hermes checkout",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 40,
        cachedInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 155,
      },
    });
    expect(loaded[0].traceEvents?.[0]).toMatchObject({
      kind: "tool_call",
      source: "hermes",
      title: "terminal",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips unsupported Hermes database schemas without failing the index", () => {
    const root = tmpDir("hermes-schema");
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT);
    `);
    db.close();

    expect(() => loadHermesSessions(root)).not.toThrow();
    expect(loadHermesSessions(root)).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads OpenCode sessions from opencode.db message parts", () => {
    const root = tmpDir("opencode");
    const shareDir = path.join(root, ".local", "share", "opencode");
    fs.mkdirSync(shareDir, { recursive: true });
    const dbPath = path.join(shareDir, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER,
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        tokens_reasoning INTEGER DEFAULT 0,
        tokens_cache_read INTEGER DEFAULT 0
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO session (id, directory, title, time_created, time_updated, tokens_input, tokens_output) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "opencode-1",
      "/work/opencode-app",
      "OpenCode route fix",
      Date.parse("2026-06-10T11:00:00Z"),
      Date.parse("2026-06-10T11:10:00Z"),
      30,
      20,
    );
    db.prepare("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "msg-user",
      "opencode-1",
      "user",
      Date.parse("2026-06-10T11:01:00Z"),
      JSON.stringify({ role: "user" }),
    );
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "part-user",
      "msg-user",
      "opencode-1",
      Date.parse("2026-06-10T11:01:00Z"),
      JSON.stringify({ type: "text", text: "Fix OpenCode route" }),
    );
    db.prepare("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "msg-assistant",
      "opencode-1",
      "assistant",
      Date.parse("2026-06-10T11:02:00Z"),
      JSON.stringify({ role: "assistant" }),
    );
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "part-assistant",
      "msg-assistant",
      "opencode-1",
      Date.parse("2026-06-10T11:02:00Z"),
      JSON.stringify({ type: "text", text: "I will inspect router.ts" }),
    );
    db.close();

    const loaded = loadOpenCodeSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "opencode:opencode-1",
      rawId: "opencode-1",
      source: "opencode-cli",
      projectPath: "/work/opencode-app",
      originalTitle: "OpenCode route fix",
      firstQuestion: "Fix OpenCode route",
    });
    expect(loaded[0].messages.map((message) => message.content)).toEqual(["Fix OpenCode route", "I will inspect router.ts"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads CodeWiz token usage from message and part JSON", () => {
    const root = tmpDir("codewiz-tokens");
    const dbPath = path.join(root, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)").run(
      "codewiz-1",
      "/work/codewiz-app",
      "CodeWiz token fix",
      Date.parse("2026-06-10T12:00:00Z"),
      Date.parse("2026-06-10T12:10:00Z"),
    );
    db.prepare("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "msg-user",
      "codewiz-1",
      "user",
      Date.parse("2026-06-10T12:01:00Z"),
      JSON.stringify({ role: "user" }),
    );
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "part-user",
      "msg-user",
      "codewiz-1",
      Date.parse("2026-06-10T12:01:00Z"),
      JSON.stringify({ type: "text", text: "Fix CodeWiz token stats" }),
    );
    db.prepare("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "msg-assistant",
      "codewiz-1",
      "assistant",
      Date.parse("2026-06-10T12:02:00Z"),
      JSON.stringify({ role: "assistant", tokens: { input: 242, output: 142, reasoning: 13, cache: { read: 18816, write: 4 } } }),
    );
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)").run(
      "part-assistant",
      "msg-assistant",
      "codewiz-1",
      Date.parse("2026-06-10T12:02:00Z"),
      JSON.stringify({ type: "text", text: "I will inspect token rows", tokens: { input: 242, output: 142, reasoning: 13, cache: { read: 18816, write: 4 } } }),
    );
    db.close();

    const loaded = loadCodeWizSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.tokenUsage).toEqual({
      inputTokens: 242,
      outputTokens: 142,
      cachedInputTokens: 18820,
      reasoningOutputTokens: 13,
      totalTokens: 19217,
    });
    expect(loaded[0].tokenEvents).toEqual([
      {
        timestamp: Date.parse("2026-06-10T12:02:00Z"),
        dedupeKey: "codewiz:msg-assistant",
        inputTokens: 242,
        outputTokens: 142,
        cachedInputTokens: 18820,
        reasoningOutputTokens: 13,
        totalTokens: 19217,
      },
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips unsupported OpenCode database schemas without failing the index", () => {
    const root = tmpDir("opencode-schema");
    const shareDir = path.join(root, ".local", "share", "opencode");
    fs.mkdirSync(shareDir, { recursive: true });
    const dbPath = path.join(shareDir, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT);
    `);
    db.close();

    expect(() => loadOpenCodeSessions(root)).not.toThrow();
    expect(loadOpenCodeSessions(root)).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads Cursor Agent transcript JSONL sessions with real format", () => {
    const root = tmpDir("cursor");
    const workspaceSlug = "Users-mac-work-cursor-app";
    const transcript = path.join(root, "projects", workspaceSlug, "agent-transcripts", "cursor-1", "cursor-1.jsonl");
    writeJsonl(transcript, [
      {
        role: "user",
        message: {
          content: [{ type: "text", text: "<timestamp>Sunday, Jun 10, 2026, 8:00 PM (UTC+8)</timestamp>\n<user_query>\nFix Cursor sidebar\n</user_query>" }],
        },
      },
      {
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "I will inspect the layout." },
            { type: "tool_use", name: "Read", input: { path: "src/App.tsx" } },
          ],
        },
      },
    ]);

    const loaded = loadCursorAgentSessions(root, {
      cursorWorkspacePathMap: new Map([[workspaceSlug, "/Users/mac/work/cursor-app"]]),
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: `cursor:${workspaceSlug}:cursor-1`,
      rawId: "cursor-1",
      source: "cursor-agent",
      projectPath: "/Users/mac/work/cursor-app",
      firstQuestion: "Fix Cursor sidebar",
      originalTitle: "Fix Cursor sidebar",
      isSubagent: false,
      parentSessionId: null,
    });
    expect(loaded[0].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Fix Cursor sidebar",
      "assistant:I will inspect the layout.",
    ]);
    expect(loaded[0].traceEvents?.[0]).toMatchObject({
      kind: "tool_call",
      source: "cursor",
      title: "Read · src/App.tsx",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads Cursor subagent transcripts with parent session metadata", () => {
    const root = tmpDir("cursor-subagent");
    const workspaceSlug = "Users-mac-work-cursor-app";
    const transcript = path.join(
      root,
      "projects",
      workspaceSlug,
      "agent-transcripts",
      "parent-1",
      "subagents",
      "agent-1.jsonl",
    );
    writeJsonl(transcript, [
      {
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>\nInvestigate auth bug\n</user_query>" }],
        },
      },
      {
        role: "assistant",
        message: {
          content: [{ type: "text", text: "Checking auth middleware." }],
        },
      },
    ]);

    const loaded = loadCursorAgentSessions(root, {
      cursorWorkspacePathMap: new Map([[workspaceSlug, "/Users/mac/work/cursor-app"]]),
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: `cursor:${workspaceSlug}:agent-1`,
      rawId: "agent-1",
      isSubagent: true,
      parentSessionId: "parent-1",
      firstQuestion: "Investigate auth bug",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });
});
