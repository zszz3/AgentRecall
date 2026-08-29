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
  loadQoderIdeSessions,
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

function writeCursorStateDb(
  dbPath: string,
  headers: Array<{
    composerId: string;
    name: string;
    projectPath: string;
    createdAt?: number;
    isSubagent?: boolean;
    parentComposerId?: string;
    uriScheme?: string;
    uriAuthority?: string;
    visibleBubbleIds?: string[];
  }>,
  bubbles: Array<{
    composerId: string;
    bubbleId: string;
    type: 1 | 2;
    text?: string;
    richText?: unknown;
    createdAt: string;
  }> = [],
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY,
      workspaceId TEXT,
      createdAt INTEGER,
      lastUpdatedAt INTEGER,
      isArchived INTEGER,
      isSubagent INTEGER,
      recency INTEGER,
      checkpointAt INTEGER,
      value TEXT
    );
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);

  const insertHeader = db.prepare(`
    INSERT INTO composerHeaders (
      composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value
    ) VALUES (?, ?, ?, ?, 0, ?, 0, 0, ?)
  `);
  for (const header of headers) {
    const createdAt = header.createdAt ?? Date.parse("2026-07-22T10:00:00Z");
    insertHeader.run(
      header.composerId,
      `workspace-${header.composerId}`,
      createdAt,
      createdAt,
      header.isSubagent ? 1 : 0,
      JSON.stringify({
        composerId: header.composerId,
        name: header.name,
        createdAt,
        isDraft: false,
        workspaceIdentifier: {
          id: `workspace-${header.composerId}`,
          uri: {
            scheme: header.uriScheme ?? "file",
            authority: header.uriAuthority ?? "",
            fsPath: header.projectPath,
          },
        },
        ...(header.parentComposerId
          ? { subagentInfo: { parentComposerId: header.parentComposerId } }
          : {}),
      }),
    );
  }

  const insertBubble = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const bubble of bubbles) {
    insertBubble.run(
      `bubbleId:${bubble.composerId}:${bubble.bubbleId}`,
      JSON.stringify({
        bubbleId: bubble.bubbleId,
        type: bubble.type,
        text: bubble.text ?? "",
        ...(bubble.richText === undefined ? {} : { richText: JSON.stringify(bubble.richText) }),
        createdAt: bubble.createdAt,
      }),
    );
  }
  for (const header of headers) {
    if (!header.visibleBubbleIds) continue;
    insertBubble.run(
      `composerData:${header.composerId}`,
      JSON.stringify({
        composerId: header.composerId,
        fullConversationHeadersOnly: header.visibleBubbleIds.map((bubbleId) => ({ bubbleId })),
      }),
    );
  }
  db.close();
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

  it("loads legacy Qoder IDE conversation history as qoder-ide sessions", () => {
    const root = tmpDir("qoder");
    const filePath = path.join(root, "cache", "projects", "demo-app-1a2b3c4d", "conversation-history", "task-fe3", "task-fe3.jsonl");
    writeJsonl(filePath, [
      { role: "user", message: { content: [{ type: "text", text: "Fix the login bug" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "I will check the auth module." }] } },
    ]);

    const loaded = loadQoderIdeSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "qoder-ide:demo-app-1a2b3c4d/task-fe3",
      rawId: "demo-app-1a2b3c4d/task-fe3",
      source: "qoder-ide",
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

    const loaded = loadQoderIdeSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.rawId).toBe("proj-aabbccdd/task-multi");
    expect(loaded[0].messages[0].content).toBe("First part\nSecond part");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("strips Qoder wrapper tags and uses user_query as title", () => {
    const root = tmpDir("qoder-wrapped");
    const filePath = path.join(root, "cache", "projects", "demo-app-1a2b3c4d", "conversation-history", "task-wrap", "task-wrap.jsonl");
    writeJsonl(filePath, [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<system-reminder>\n[IMPORTANT] You must always respond in 中文.\n</system-reminder>\n\n<user_query>\n我的目标在：D:\\oss-contrib\\giki\\IMPROVEMENT-LOOP.md\n</user_query>",
            },
          ],
        },
      },
      { role: "assistant", message: { content: [{ type: "text", text: "明白，开始执行。" }] } },
    ]);

    const loaded = loadQoderIdeSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.originalTitle).toBe("我的目标在：D:\\oss-contrib\\giki\\IMPROVEMENT-LOOP.md");
    expect(loaded[0].session.firstQuestion).toBe("我的目标在：D:\\oss-contrib\\giki\\IMPROVEMENT-LOOP.md");
    expect(loaded[0].messages[0].content).toBe("我的目标在：D:\\oss-contrib\\giki\\IMPROVEMENT-LOOP.md");
    // system-reminder content should not appear in searchable message text
    expect(loaded[0].messages[0].content).not.toContain("system-reminder");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("strips attached_files wrapper from Qoder messages without user_query", () => {
    const root = tmpDir("qoder-attached");
    const filePath = path.join(root, "cache", "projects", "proj-aabbccdd", "conversation-history", "task-att", "task-att.jsonl");
    writeJsonl(filePath, [
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<attached_files>\n#file:d:\\project\\architecture.zip\n#file:d:\\project\\ux-report.md\n</attached_files>\n\n直接帮我重构这个模块",
            },
          ],
        },
      },
      { role: "assistant", message: { content: [{ type: "text", text: "好的。" }] } },
    ]);

    const loaded = loadQoderIdeSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.originalTitle).toBe("直接帮我重构这个模块");
    expect(loaded[0].messages[0].content).toBe("直接帮我重构这个模块");
    expect(loaded[0].messages[0].content).not.toContain("attached_files");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads new Qoder transcripts stored directly under projects/<slug>", () => {
    const root = tmpDir("qoder-cli-flat");
    const filePath = path.join(root, "projects", "-Users-me-demo-app", "5a5f525e-99bc-4c95-9f03-de30ef8c9a32.jsonl");
    writeJsonl(filePath, [
      { type: "workspace-directories", sessionId: "5a5f525e", directories: ["/Users/me/demo-app"] },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        gitBranch: "main",
        timestamp: "2026-08-21T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Fix the login bug" }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-21T10:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "I will check the auth module." }] },
      },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "qoder:5a5f525e-99bc-4c95-9f03-de30ef8c9a32",
      source: "qoder",
      projectPath: "/Users/me/demo-app",
      gitBranch: "main",
      firstQuestion: "Fix the login bug",
    });
    expect(loaded[0].messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads new Qoder transcripts from the nested transcript directory and prefers ai-title", () => {
    const root = tmpDir("qoder-cli-nested");
    const filePath = path.join(root, "projects", "-Users-me-demo-app", "transcript", "428f5d29.jsonl");
    writeJsonl(filePath, [
      { type: "ai-title", sessionId: "428f5d29", aiTitle: "Refactor the auth module" },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        message: { role: "user", content: [{ type: "text", text: "Please refactor auth" }] },
      },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.rawId).toBe("428f5d29");
    expect(loaded[0].session.originalTitle).toBe("Refactor the auth module");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips new Qoder tool-execution traces that contain no readable messages", () => {
    const root = tmpDir("qoder-cli-trace");
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "transcript", "trace-only.jsonl"), [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      },
      { type: "progress", uuid: "p1", parentUuid: "u1" },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        cwd: "/Users/me/demo-app",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
      },
    ]);

    expect(loadQoderSessions(root)).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps legacy Qoder IDE sessions visible next to the new projects layout", () => {
    const root = tmpDir("qoder-prefer-projects");
    writeJsonl(path.join(root, "cache", "projects", "demo-app-1a2b3c4d", "conversation-history", "task-ide", "task-ide.jsonl"), [
      { role: "user", message: { content: [{ type: "text", text: "IDE question" }] } },
    ]);
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "cli-session.jsonl"), [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        message: { role: "user", content: [{ type: "text", text: "CLI question" }] },
      },
    ]);
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "compaction", "not-a-transcript.jsonl"), [
      { kind: "summary", tokens: 42 },
    ]);

    const current = loadQoderSessions(root);
    expect(current.map((entry) => entry.session.firstQuestion)).toEqual(["CLI question"]);
    expect(current.map((entry) => entry.session.source)).toEqual(["qoder"]);

    const legacy = loadQoderIdeSessions(root);
    expect(legacy).toHaveLength(1);
    expect(legacy[0].session).toMatchObject({
      source: "qoder-ide",
      sessionKey: "qoder-ide:demo-app-1a2b3c4d/task-ide",
      firstQuestion: "IDE question",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads the legacy conversation-history tree when the projects layout is absent", () => {
    const root = tmpDir("qoder-legacy-only");
    writeJsonl(path.join(root, "cache", "projects", "demo-app-1a2b3c4d", "conversation-history", "task-ide", "task-ide.jsonl"), [
      { role: "user", message: { content: [{ type: "text", text: "IDE question" }] } },
    ]);

    expect(loadQoderSessions(root)).toEqual([]);
    expect(loadQoderIdeSessions(root).map((entry) => entry.session.firstQuestion)).toEqual(["IDE question"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("drops execution transcripts that duplicate a canonical session but keeps unique runs", () => {
    const root = tmpDir("qoder-execution-dedupe");
    const slugDir = path.join(root, "projects", "-Users-me-demo-app");
    writeJsonl(path.join(slugDir, "9b1c2d3e.jsonl"), [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-09T03:57:54.457Z",
        message: { role: "user", content: [{ type: "text", text: "Run the long task" }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-09T03:57:56.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
      },
    ]);
    writeJsonl(path.join(slugDir, "transcript", "task-dup1.session.execution.jsonl"), [
      {
        type: "user",
        uuid: "x1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-09T03:57:54.457Z",
        message: { role: "user", content: [{ type: "text", text: "Run the long task" }] },
      },
      {
        type: "assistant",
        uuid: "x2",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-09T03:57:55.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Working..." }] },
      },
    ]);
    writeJsonl(path.join(slugDir, "transcript", "task-uniq2.session.execution.jsonl"), [
      {
        type: "user",
        uuid: "y1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-08T07:56:17.000Z",
        message: { role: "user", content: [{ type: "text", text: "Continue the review" }] },
      },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded.map((entry) => entry.session.firstQuestion).sort()).toEqual(["Continue the review", "Run the long task"]);
    expect(loaded.map((entry) => entry.session.rawId).sort()).toEqual(["9b1c2d3e", "task-uniq2.session.execution"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps every message of transcripts whose turns carry no parentUuid links", () => {
    const root = tmpDir("qoder-unchained");
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "transcript", "task-flat.session.execution.jsonl"), [
      { type: "session_meta", sessionId: "task-flat.session.execution", uuid: "m1" },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-07-27T07:17:17.000Z",
        message: { role: "user", content: "Install this tool" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-07-27T07:17:24.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Downloading it now." }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-07-27T07:18:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.firstQuestion).toBe("Install this tool");
    expect(loaded[0].messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);

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

  it("loads the project path from the current Hermes sessions.cwd column", () => {
    const root = tmpDir("hermes-current-schema");
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        model_config TEXT,
        started_at REAL NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp REAL NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO sessions (id, cwd, model_config, started_at) VALUES (?, ?, ?, ?)",
    ).run(
      "hermes-current-1",
      "/work/hermes-current",
      JSON.stringify({ cwd: "/work/hermes-legacy", max_iterations: 2 }),
      Date.parse("2026-07-31T03:32:15Z") / 1000,
    );
    db.close();

    const loaded = loadHermesSessions(root);
    fs.rmSync(root, { recursive: true, force: true });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.projectPath).toBe("/work/hermes-current");
  });

  it("maps Hermes delegates as related sessions without treating ordinary branches as subagents", () => {
    const root = tmpDir("hermes-relations");
    const db = new DatabaseSync(path.join(root, "state.db"));
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT,
        model_config TEXT,
        started_at REAL NOT NULL
      );
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, timestamp REAL NOT NULL);
    `);
    const insert = db.prepare(
      "INSERT INTO sessions (id, parent_session_id, model_config, started_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("root", null, "{}", 1);
    insert.run("branch", "root", "{}", 2);
    insert.run("delegate", "root", JSON.stringify({ _delegate_from: "root" }), 3);
    db.close();

    const loaded = loadHermesSessions(root);
    fs.rmSync(root, { recursive: true, force: true });

    expect(loaded.find((item) => item.session.rawId === "branch")?.session).toMatchObject({
      isSubagent: false,
      parentSessionId: null,
    });
    expect(loaded.find((item) => item.session.rawId === "delegate")?.session).toMatchObject({
      isSubagent: true,
      parentSessionId: "root",
    });
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

  it("marks OpenCode subagent sessions via session.parent_id", () => {
    const root = tmpDir("opencode-subagent");
    const shareDir = path.join(root, ".local", "share", "opencode");
    fs.mkdirSync(shareDir, { recursive: true });
    const dbPath = path.join(shareDir, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
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
    const insertSession = db.prepare("INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)");
    insertSession.run("opencode-root", null, "/work/opencode-app", "Root session", 1_000, 2_000);
    insertSession.run("opencode-child", "opencode-root", "/work/opencode-app", "Subagent session", 1_100, 1_900);
    const insertMessage = db.prepare("INSERT INTO message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)");
    insertMessage.run("msg-root-user", "opencode-root", "user", 1_100, JSON.stringify({ role: "user" }));
    insertPart.run("part-root-user", "msg-root-user", "opencode-root", 1_100, JSON.stringify({ type: "text", text: "Audit the auth flow" }));
    insertMessage.run("msg-child-user", "opencode-child", "user", 1_200, JSON.stringify({ role: "user" }));
    insertPart.run("part-child-user", "msg-child-user", "opencode-child", 1_200, JSON.stringify({ type: "text", text: "Inspect middleware" }));
    db.close();

    const loaded = loadOpenCodeSessions(root);

    expect(loaded).toHaveLength(2);
    const byKey = new Map(loaded.map((item) => [item.session.sessionKey, item.session]));
    expect(byKey.get("opencode:opencode-root")).toMatchObject({ isSubagent: false, parentSessionId: null });
    expect(byKey.get("opencode:opencode-child")).toMatchObject({
      sessionKey: "opencode:opencode-child",
      isSubagent: true,
      parentSessionId: "opencode-root",
    });

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

  it("uses the Cursor composer title instead of the opening prompt", () => {
    const root = tmpDir("cursor-title");
    const stateDbPath = path.join(root, "cursor-state.vscdb");
    const workspaceSlug = "Users-mac-work-cursor-app";
    const composerId = "cursor-title-1";
    const transcript = path.join(root, "projects", workspaceSlug, "agent-transcripts", composerId, `${composerId}.jsonl`);
    writeJsonl(transcript, [
      {
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>Fix Cursor sidebar</user_query>" }] },
      },
    ]);
    writeCursorStateDb(stateDbPath, [
      {
        composerId,
        name: "修复 Cursor 会话标题",
        projectPath: "/Users/mac/work/cursor-app",
      },
    ]);

    const loaded = loadCursorAgentSessions(root, {
      cursorStateDbPath: stateDbPath,
      cursorWorkspacePathMap: new Map([[workspaceSlug, "/Users/mac/work/cursor-app"]]),
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      originalTitle: "修复 Cursor 会话标题",
      firstQuestion: "Fix Cursor sidebar",
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads Cursor composer sessions that do not have transcript files", () => {
    const root = tmpDir("cursor-database-only");
    const stateDbPath = path.join(root, "cursor-state.vscdb");
    const composerId = "cursor-database-only-1";
    writeCursorStateDb(
      stateDbPath,
      [
        {
          composerId,
          name: "Repair Windows login flow",
          projectPath: "C:\\Users\\me\\cursor-app",
        },
      ],
      [
        {
          composerId,
          bubbleId: "bubble-user",
          type: 1,
          richText: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Investigate login failures" }] }],
          },
          createdAt: "2026-07-22T10:01:00Z",
        },
        {
          composerId,
          bubbleId: "bubble-assistant",
          type: 2,
          text: "I will inspect the authentication flow.",
          createdAt: "2026-07-22T10:02:00Z",
        },
      ],
    );

    const loaded = loadCursorAgentSessions(root, { cursorStateDbPath: stateDbPath });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: `cursor:C-Users-me-cursor-app:${composerId}`,
      rawId: composerId,
      projectPath: "C:\\Users\\me\\cursor-app",
      originalTitle: "Repair Windows login flow",
      firstQuestion: "Investigate login failures",
    });
    expect(loaded[0].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Investigate login failures",
      "assistant:I will inspect the authentication flow.",
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("shows only the current Cursor conversation branch in Cursor's visible order", () => {
    const root = tmpDir("cursor-visible-branch");
    const stateDbPath = path.join(root, "cursor-state.vscdb");
    const composerId = "cursor-visible-branch-1";
    writeCursorStateDb(
      stateDbPath,
      [
        {
          composerId,
          name: "Visible Cursor branch",
          projectPath: "/Users/me/cursor-app",
          visibleBubbleIds: ["current-user", "current-assistant"],
        },
      ],
      [
        {
          composerId,
          bubbleId: "current-assistant",
          type: 2,
          text: "This is the answer Cursor still shows.",
          createdAt: "2026-07-22T10:04:00Z",
        },
        {
          composerId,
          bubbleId: "discarded-user",
          type: 1,
          text: "This prompt was replaced after rewinding.",
          createdAt: "2026-07-22T10:02:00Z",
        },
        {
          composerId,
          bubbleId: "current-user",
          type: 1,
          text: "This is the replacement prompt.",
          createdAt: "2026-07-22T10:03:00Z",
        },
        {
          composerId,
          bubbleId: "discarded-assistant",
          type: 2,
          text: "This old branch must stay hidden.",
          createdAt: "2026-07-22T10:01:00Z",
        },
      ],
    );

    const loaded = loadCursorAgentSessions(root, { cursorStateDbPath: stateDbPath });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:This is the replacement prompt.",
      "assistant:This is the answer Cursor still shows.",
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("filters Cursor transcript messages and tools to the current database branch", () => {
    const root = tmpDir("cursor-transcript-visible-branch");
    const stateDbPath = path.join(root, "cursor-state.vscdb");
    const workspaceSlug = "Users-me-cursor-app";
    const composerId = "cursor-transcript-visible-branch-1";
    const transcript = path.join(root, "projects", workspaceSlug, "agent-transcripts", composerId, `${composerId}.jsonl`);
    writeJsonl(transcript, [
      {
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>Keep this shared prompt</user_query>" }] },
      },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "Shared answer" }] },
      },
      {
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>Discard this branch</user_query>" }] },
      },
      {
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "Discarded answer" },
            { type: "tool_use", name: "Read", input: { path: "old.ts" } },
          ],
        },
      },
      {
        role: "user",
        message: { content: [{ type: "text", text: "<user_query>Use this replacement prompt</user_query>" }] },
      },
      {
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "Replacement answer" },
            { type: "tool_use", name: "Read", input: { path: "current.ts" } },
          ],
        },
      },
    ]);
    writeCursorStateDb(
      stateDbPath,
      [
        {
          composerId,
          name: "Current transcript branch",
          projectPath: "/Users/me/cursor-app",
          visibleBubbleIds: ["shared-user", "shared-assistant", "current-user", "current-assistant"],
        },
      ],
      [
        {
          composerId,
          bubbleId: "shared-user",
          type: 1,
          text: "Keep this shared prompt",
          createdAt: "2026-07-22T10:01:00Z",
        },
        {
          composerId,
          bubbleId: "shared-assistant",
          type: 2,
          text: "Shared answer",
          createdAt: "2026-07-22T10:02:00Z",
        },
        {
          composerId,
          bubbleId: "discarded-user",
          type: 1,
          text: "Discard this branch",
          createdAt: "2026-07-22T10:03:00Z",
        },
        {
          composerId,
          bubbleId: "current-user",
          type: 1,
          text: "Use this replacement prompt",
          createdAt: "2026-07-22T10:05:00Z",
        },
        {
          composerId,
          bubbleId: "current-assistant",
          type: 2,
          text: "Replacement answer",
          createdAt: "2026-07-22T10:06:00Z",
        },
      ],
    );

    const loaded = loadCursorAgentSessions(root, {
      cursorStateDbPath: stateDbPath,
      cursorWorkspacePathMap: new Map([[workspaceSlug, "/Users/me/cursor-app"]]),
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:Keep this shared prompt",
      "assistant:Shared answer",
      "user:Use this replacement prompt",
      "assistant:Replacement answer",
    ]);
    expect(loaded[0].traceEvents?.map((event) => event.title)).toEqual(["Read · current.ts"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not revive discarded Cursor bubbles when the visible branch is empty", () => {
    const root = tmpDir("cursor-empty-visible-branch");
    const stateDbPath = path.join(root, "cursor-state.vscdb");
    const composerId = "cursor-empty-visible-branch-1";
    writeCursorStateDb(
      stateDbPath,
      [
        {
          composerId,
          name: "Discarded Cursor draft",
          projectPath: "/Users/me/cursor-app",
          visibleBubbleIds: [],
        },
      ],
      [
        {
          composerId,
          bubbleId: "discarded-user",
          type: 1,
          text: "This prompt is no longer visible in Cursor.",
          createdAt: "2026-07-22T10:01:00Z",
        },
      ],
    );

    expect(loadCursorAgentSessions(root, { cursorStateDbPath: stateDbPath })).toEqual([]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("omits Cursor composer headers that have no readable messages", () => {
    const root = tmpDir("cursor-empty-project-shell");
    const stateDbPath = path.join(root, "cursor-state.vscdb");
    writeCursorStateDb(stateDbPath, [
      {
        composerId: "2c975d5b-073b-4757-9901-0b85fceb58e9",
        name: "",
        projectPath: "/Users/mac/PycharmProjects/learn-claude-code",
        createdAt: Date.parse("2026-04-28T07:07:50Z"),
      },
      {
        composerId: "named-empty-draft",
        name: "Saved empty draft",
        projectPath: "/Users/mac/PycharmProjects/learn-claude-code",
      },
      {
        composerId: "with-messages",
        name: "",
        projectPath: "/Users/mac/IdeaProjects/sky-take-out",
      },
    ], [
      {
        composerId: "with-messages",
        bubbleId: "bubble-user",
        type: 1,
        text: "Explain the takeout order flow",
        createdAt: "2026-07-26T02:00:00Z",
      },
    ]);

    const loaded = loadCursorAgentSessions(root, { cursorStateDbPath: stateDbPath });

    expect(loaded.map((item) => item.session.rawId)).toEqual(["with-messages"]);
    expect(loaded.find((item) => item.session.rawId === "with-messages")?.session.firstQuestion).toBe("Explain the takeout order flow");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("describes Cursor Remote SSH execution separately from local storage", () => {
    const root = tmpDir("cursor-remote-ssh");
    const stateDbPath = path.join(root, "cursor-state.vscdb");
    writeCursorStateDb(
      stateDbPath,
      [
        {
          composerId: "cursor-remote-1",
          name: "Remote Cursor session",
          projectPath: "/home/me/project",
          uriScheme: "vscode-remote",
          uriAuthority: "ssh-remote+dev",
        },
        {
          composerId: "cursor-local-1",
          name: "Local Cursor session",
          projectPath: "/Users/me/project",
        },
      ],
      [
        {
          composerId: "cursor-remote-1",
          bubbleId: "remote-user",
          type: 1,
          text: "Inspect the remote project",
          createdAt: "2026-07-22T10:01:00Z",
        },
        {
          composerId: "cursor-local-1",
          bubbleId: "local-user",
          type: 1,
          text: "Inspect the local project",
          createdAt: "2026-07-22T10:02:00Z",
        },
      ],
    );

    const loaded = loadCursorAgentSessions(root, { cursorStateDbPath: stateDbPath });
    const remote = loaded.find((item) => item.session.rawId === "cursor-remote-1");
    const local = loaded.find((item) => item.session.rawId === "cursor-local-1");

    expect(remote).toMatchObject({
      session: { storageEnvironmentId: "local" },
      executionEnvironmentHint: { kind: "ssh", label: "dev", hostAlias: "dev" },
    });
    expect(local?.executionEnvironmentHint).toBeUndefined();

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
