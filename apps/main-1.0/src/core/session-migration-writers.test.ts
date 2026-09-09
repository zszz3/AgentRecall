import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { extractCursorUserQuery } from "./format-adapters";
import {
  encodeCursorWorkspaceSlug,
  loadClaudeCliSessionRows,
  loadCodeBuddyCliSessionFile,
  loadCodexSessionRows,
  loadCursorTranscriptFile,
  loadZcodeSessions,
  parseCursorTranscriptPath,
  parseJsonlText,
} from "./session-loader";
import { targetFilePath, targetFilePathForRemoteEnvironment, writeMigratedSession } from "./session-migration-writers";
import type { LoadedSession, MigrationTarget, PortableSession, SessionSource } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const CHILD_SESSION_ID = "10000000-0000-4000-8000-000000000002";
const MESSAGE_IDS = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
];
const NOW = new Date("2026-06-23T06:07:08.901Z");
const TARGETS = [
  { target: "claude", root: ".claude", source: "claude-cli", family: "claude" },
  { target: "tclaude", root: ".tclaude", source: "tclaude-cli", family: "claude" },
  { target: "codex", root: ".codex", source: "codex-cli", family: "codex" },
  { target: "tcodex", root: ".tcodex", source: "tcodex-cli", family: "codex" },
  { target: "codebuddy", root: ".codebuddy", source: "codebuddy-cli", family: "codebuddy" },
  { target: "cursor", root: ".cursor", source: "cursor-agent", family: "cursor" },
] as const satisfies readonly {
  target: MigrationTarget;
  root: string;
  source: SessionSource;
  family: "claude" | "codex" | "codebuddy" | "cursor";
}[];

function portable(): PortableSession {
  return {
    sourceSessionKey: "codex:source",
    sourceAgent: "codex",
    title: "迁移标题 🚀",
    projectPath: "/Users/测试/My Project",
    startedAt: "2026-06-20T01:02:03.004Z",
    messages: [
      { role: "user", content: "你好，世界 🌏", timestamp: "2026-06-20T01:02:04.005Z", index: 0 },
      { role: "assistant", content: "已收到\n第二行", timestamp: "2026-06-20T01:02:05.006Z", index: 1 },
      { role: "user", content: "继续", timestamp: "2026-06-20T01:02:06.007Z", index: 2 },
    ],
  };
}

function idFactory(ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index++];
    if (!id) throw new Error("Unexpected idFactory call");
    return id;
  };
}

function readRows(filePath: string): Array<Record<string, any>> {
  const text = fs.readFileSync(filePath, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  for (const line of text.trimEnd().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  return parseJsonlText(text) as Array<Record<string, any>>;
}

function expectRoundTrip(
  target: MigrationTarget,
  source: SessionSource,
  sessionId: string,
  filePath: string,
  rows: Array<Record<string, any>>,
  session: PortableSession = portable(),
): void {
  const loaded = loadWrittenSession(target, source, filePath, rows, session);

  const firstUser = session.messages.find((message) => message.role === "user")?.content || "";
  expect(loaded?.session).toMatchObject({
    rawId: sessionId,
    projectPath: session.projectPath,
    ...(target === "cursor"
      ? { firstQuestion: extractCursorUserQuery(firstUser) }
      : { originalTitle: session.title }),
    source,
  });
  if (target === "cursor") {
    expect(loaded?.messages.map(({ role, content }) => ({ role, content }))).toEqual(
      session.messages.map(({ role, content }) => ({
        role,
        content: role === "user" ? extractCursorUserQuery(content) : content,
      })),
    );
    return;
  }

  expect(loaded?.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp }))).toEqual(
    session.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })),
  );
}

function loadWrittenSession(
  target: MigrationTarget,
  source: SessionSource,
  filePath: string,
  rows: Array<Record<string, any>>,
  session: PortableSession = portable(),
): LoadedSession | null {
  if (target === "codebuddy") return loadCodeBuddyCliSessionFile(filePath);
  if (target === "cursor") {
    const { workspaceSlug } = parseCursorTranscriptPath(filePath);
    const workspacePathMap = workspaceSlug
      ? new Map([[workspaceSlug, session.projectPath]])
      : undefined;
    return loadCursorTranscriptFile(filePath, undefined, workspacePathMap);
  }
  if (target === "codex" || target === "tcodex") {
    return loadCodexSessionRows(filePath, rows, { sourceOverride: source });
  }
  return loadClaudeCliSessionRows(filePath, rows, { source });
}

describe("writeMigratedSession", () => {
  it("emits native Codex subagent activity without model-visible synthetic tool history", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-subagent-activity-"));
    try {
      const session = {
        ...portable(),
        subagents: [{
          ...portable(),
          sourceSessionKey: "cursor:child",
          sourceSessionId: CHILD_SESSION_ID,
          title: "Research child",
          startedAt: "2026-06-20T01:02:07.000Z",
          messages: [],
          isSubagent: true,
          parentSessionId: SESSION_ID,
          subagentDepth: 1,
          subagentPath: "/root/Migrated-Child",
          subagents: [],
        }],
      };
      const result = await writeMigratedSession({
        target: "codex",
        session,
        sessionId: SESSION_ID,
        homeDir,
        now: NOW,
      });
      const rows = readRows(result.filePath);
      const activity = rows.find((row) => row.type === "event_msg" && row.payload?.type === "sub_agent_activity");
      const syntheticToolRows = rows.filter((row) => row.type === "response_item"
        && (row.payload?.type === "function_call" || row.payload?.type === "function_call_output"));

      expect(result.sessionId).toBe(SESSION_ID);
      expect(syntheticToolRows).toHaveLength(0);
      expect(activity?.payload).toMatchObject({
        agent_thread_id: CHILD_SESSION_ID,
        agent_path: "/root/migrated_child",
        kind: "started",
      });
      expect(activity?.payload.event_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses the previous valid timestamp when a Codex message has no timestamp", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-empty-timestamp-"));
    try {
      const session = portable();
      session.messages[1] = { ...session.messages[1], timestamp: "" };
      const result = await writeMigratedSession({
        target: "codex",
        session,
        sessionId: SESSION_ID,
        homeDir,
        now: NOW,
      });
      const rows = readRows(result.filePath);
      const messageRows = rows.filter((row) => row.type === "response_item" && row.payload?.type === "message");

      expect(messageRows[1]?.timestamp).toBe(session.messages[0].timestamp);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("normalizes injected Codex user notifications before round-trip validation", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-codex-notifications-"));
    try {
      const session: PortableSession = {
        ...portable(),
        messages: [
          {
            role: "user",
            content: "<system_notification kind: subagent><user_query>继续修复恢复问题</user_query></system_notification>",
            timestamp: "2026-06-20T01:02:04.005Z",
            index: 0,
          },
          { role: "assistant", content: "正在处理", timestamp: "2026-06-20T01:02:05.006Z", index: 1 },
          {
            role: "user",
            content: "<subagent_notification>worker completed</subagent_notification>",
            timestamp: "2026-06-20T01:02:06.007Z",
            index: 2,
          },
          { role: "assistant", content: "处理完成", timestamp: "2026-06-20T01:02:07.008Z", index: 3 },
        ],
        turnBoundaries: [0, 2],
      };

      const result = await writeMigratedSession({
        target: "codex",
        session,
        sessionId: SESSION_ID,
        homeDir,
        now: NOW,
      });
      const rows = readRows(result.filePath);
      const messageRows = rows.filter((row) => row.type === "response_item" && row.payload?.type === "message");

      expect(messageRows.map((row) => row.payload.content[0].text)).toEqual([
        "继续修复恢复问题",
        "正在处理",
        "处理完成",
      ]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("coalesces fragmented assistant updates into resumable Codex turns", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-codex-fragments-"));
    try {
      const firstTimestamp = Date.parse("2026-06-20T01:02:04.005Z");
      const fragments = Array.from({ length: 260 }, (_, index) => ({
        role: "assistant" as const,
        content: `过程更新 ${index + 1}`,
        timestamp: new Date(firstTimestamp + index + 1).toISOString(),
        index: index + 1,
      }));
      const session: PortableSession = {
        ...portable(),
        messages: [
          { role: "user", content: "第一轮问题", timestamp: new Date(firstTimestamp).toISOString(), index: 0 },
          ...fragments,
          { role: "user", content: "第二轮问题", timestamp: new Date(firstTimestamp + 261).toISOString(), index: 261 },
          { role: "assistant", content: "第二轮回答", timestamp: new Date(firstTimestamp + 262).toISOString(), index: 262 },
        ],
      };

      const result = await writeMigratedSession({
        target: "codex",
        session,
        sessionId: SESSION_ID,
        homeDir,
        now: NOW,
      });
      const rows = readRows(result.filePath);
      const messageRows = rows.filter((row) => row.type === "response_item" && row.payload?.type === "message");

      expect(messageRows.map((row) => row.payload.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(messageRows[1].payload.content[0].text).toContain("过程更新 1\n\n过程更新 2");
      expect(messageRows[1].payload.content[0].text).toContain("过程更新 260");
      expect(messageRows.every((row) => /^[0-9a-f-]{36}$/.test(row.payload.id) && !row.payload.id.includes("_"))).toBe(true);
      expect(new Set(messageRows.map((row) => row.payload.id)).size).toBe(messageRows.length);
      expect(messageRows.filter((row) => row.payload.role === "assistant").every((row) => row.payload.phase === "final_answer")).toBe(true);
      expect(rows.filter((row) => row.payload?.type === "task_started")).toHaveLength(2);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each(TARGETS)(
    "creates the temporary and final $target files with mode 0600",
    async ({ target, root, family }) => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-mode-${target}-`));
      let temporaryMode = 0;
      const targetDirectory = family === "codex"
        ? path.join(homeDir, root, "sessions", "2026", "06", "23")
        : family === "claude"
          ? path.join(homeDir, root, "projects", "-Users----My-Project")
          : family === "cursor"
            ? path.join(
              homeDir,
              ".cursor",
              "projects",
              encodeCursorWorkspaceSlug(portable().projectPath),
              "agent-transcripts",
              SESSION_ID,
            )
            : path.join(homeDir, ".codebuddy", "projects", "Users----My-Project");
      fs.mkdirSync(targetDirectory, { recursive: true });
      const previousUmask = process.umask(0o777);

      try {
        let result;
        try {
          result = await writeMigratedSession({
            target,
            session: portable(),
            homeDir,
            now: NOW,
            idFactory: idFactory(family === "codex" || target === "cursor" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
            beforeValidate: (filePath) => {
              temporaryMode = fs.statSync(filePath).mode & 0o777;
              fs.chmodSync(filePath, 0o644);
            },
          });
        } finally {
          process.umask(previousUmask);
        }

        if (process.platform === "win32") {
          expect(temporaryMode).toBe(0o666);
          expect(fs.statSync(result.filePath).mode & 0o777).toBe(0o666);
        } else {
          expect(temporaryMode).toBe(0o600);
          expect(fs.statSync(result.filePath).mode & 0o777).toBe(0o600);
        }
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it.each(TARGETS)(
    "writes $target under $root and round-trips with its concrete source",
    async ({ target, root, source, family }) => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-roundtrip-${target}-`));
      try {
        const result = await writeMigratedSession({
          target,
          session: portable(),
          homeDir,
          now: NOW,
          idFactory: idFactory(family === "codex" || target === "cursor" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
        });

        expect(path.relative(homeDir, result.filePath).split(path.sep)[0]).toBe(root);
        const rows = readRows(result.filePath);
        expectRoundTrip(target, source, result.sessionId, result.filePath, rows);
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it("round-trips sessions without project paths across target formats", async () => {
    for (const { target, source, family } of TARGETS) {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-pathless-${target}-`));
      const session = { ...portable(), projectPath: "" };
      try {
        const result = await writeMigratedSession({
          target,
          session,
          homeDir,
          now: NOW,
          idFactory: idFactory(family === "codex" || target === "cursor" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
        });

        if (family === "claude" || family === "codebuddy" || family === "cursor") {
          expect(result.filePath.split(path.sep)).toContain("empty-window");
        }
        const rows = readRows(result.filePath);
        if (family === "codex") {
          expect(rows[0]).toMatchObject({
            type: "session_meta",
            payload: {
              cwd: homeDir,
              agent_recall_project_path: "",
            },
          });
        }
        expectRoundTrip(target, source, result.sessionId, result.filePath, rows, session);
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    }

    const codeWizHome = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-pathless-codewiz-"));
    try {
      await expect(writeMigratedSession({
        target: "codewiz",
        session: { ...portable(), projectPath: "" },
        homeDir: codeWizHome,
        now: NOW,
      })).resolves.toMatchObject({
        filePath: path.join(codeWizHome, ".local", "share", "codewiz", "opencode.db"),
      });
    } finally {
      fs.rmSync(codeWizHome, { recursive: true, force: true });
    }
  });

  it("writes a native Codex rollout and round-trips it through the existing loader", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-codex-"));
    const includesVsCodeEvents = true;

    const pending = writeMigratedSession({
      target: "codex",
      session: portable(),
      homeDir,
      now: NOW,
      idFactory: idFactory([SESSION_ID]),
    });
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;

    expect(result).toEqual({
      sessionId: SESSION_ID,
      filePath: path.join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "06",
        "23",
        `rollout-2026-06-23T06-07-08-${SESSION_ID}.jsonl`,
      ),
    });
    expect(readRows(path.join(homeDir, ".codex", "session_index.jsonl"))).toEqual([
      { id: SESSION_ID, thread_name: portable().title, updated_at: NOW.toISOString() },
    ]);

    const rows = readRows(result.filePath);
    expect(rows[0]).toMatchObject({
      type: "session_meta",
      timestamp: portable().startedAt,
      payload: {
        id: SESSION_ID,
        timestamp: portable().startedAt,
        cwd: portable().projectPath,
        title: portable().title,
        originator: "agent-recall",
        cli_version: "migration",
        model_provider: "openai",
      },
    });
    if (includesVsCodeEvents) {
      expect(rows[0]).toMatchObject({
        payload: {
          session_id: SESSION_ID,
          source: "vscode",
          thread_source: "user",
          history_mode: "legacy",
        },
      });
      expect(rows[1]).toMatchObject({
        type: "event_msg",
        payload: {
          type: "task_started",
        },
      });
    }
    const messageRows = rows.filter((row) => row.type === "response_item");
    expect(messageRows.map((row) => row.payload.content[0].type)).toEqual([
      "input_text",
      "output_text",
      "input_text",
    ]);
    if (includesVsCodeEvents) {
      expect(rows.filter((row) => ["user_message", "agent_message"].includes(row.payload?.type)).map((row) => [row.payload.type, row.payload.message])).toEqual([
        ["user_message", portable().messages[0].content],
        ["agent_message", portable().messages[1].content],
        ["user_message", portable().messages[2].content],
      ]);
      const lifecycleRows = rows.filter((row) => ["task_started", "task_complete"].includes(row.payload?.type));
      expect(lifecycleRows.map((row) => row.payload.type)).toEqual([
        "task_started",
        "task_complete",
        "task_started",
        "task_complete",
      ]);
      expect(lifecycleRows[0].payload.turn_id).toBe(lifecycleRows[1].payload.turn_id);
      expect(lifecycleRows[2].payload.turn_id).toBe(lifecycleRows[3].payload.turn_id);
      expect(lifecycleRows[0].payload.turn_id).not.toBe(lifecycleRows[2].payload.turn_id);
    }
    expectRoundTrip("codex", "codex-cli", result.sessionId, result.filePath, rows);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it.each([
    ["codex", "openai"],
    ["tcodex", "tencent"],
  ] as const)("writes the resumable $target model provider", async (target, modelProvider) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-provider-${target}-`));
    try {
      const result = await writeMigratedSession({
        target,
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      const rows = readRows(result.filePath);
      expect(rows[0]?.payload?.model_provider).toBe(modelProvider);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["codex", ".codex"],
    ["tcodex", ".tcodex"],
  ] as const)("updates the native session index for $target", async (target, root) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-index-${target}-`));
    try {
      const targetHome = path.join(homeDir, root);
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(
        path.join(targetHome, "session_index.jsonl"),
        `${JSON.stringify({ id: SESSION_ID, thread_name: "old title", updated_at: "2026-06-22T00:00:00.000Z" })}\n` +
        `${JSON.stringify({ id: "other-session", thread_name: "Other", updated_at: "2026-06-22T00:00:00.000Z" })}\n`,
      );

      await writeMigratedSession({
        target,
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(readRows(path.join(targetHome, "session_index.jsonl"))).toEqual([
        { id: "other-session", thread_name: "Other", updated_at: "2026-06-22T00:00:00.000Z" },
        { id: SESSION_ID, thread_name: portable().title, updated_at: NOW.toISOString() },
      ]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("registers a Codex migration in the VS Code app-server state database", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-vscode-state-"));
    const statePath = path.join(homeDir, ".codex", "state_1.sqlite");
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const db = new DatabaseSync(statePath);
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          model_provider TEXT NOT NULL,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          sandbox_policy TEXT NOT NULL,
          approval_mode TEXT NOT NULL,
          tokens_used INTEGER NOT NULL DEFAULT 0,
          has_user_event INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          cli_version TEXT NOT NULL DEFAULT '',
          first_user_message TEXT NOT NULL DEFAULT '',
          memory_mode TEXT NOT NULL DEFAULT 'enabled',
          model TEXT,
          reasoning_effort TEXT,
          agent_path TEXT,
          created_at_ms INTEGER,
          updated_at_ms INTEGER,
          thread_source TEXT,
          preview TEXT NOT NULL DEFAULT '',
          recency_at INTEGER NOT NULL DEFAULT 0,
          recency_at_ms INTEGER NOT NULL DEFAULT 0,
          history_mode TEXT NOT NULL DEFAULT 'legacy'
        );
        CREATE TABLE thread_spawn_edges (
          parent_thread_id TEXT NOT NULL,
          child_thread_id TEXT NOT NULL PRIMARY KEY,
          status TEXT NOT NULL
        )
      `);
      db.close();

      const result = await writeMigratedSession({
        target: "codex",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      const stateDb = new DatabaseSync(statePath);
      const row = stateDb.prepare("SELECT * FROM threads WHERE id = ?").get(SESSION_ID) as Record<string, unknown>;
      stateDb.close();
      expect(row).toMatchObject({
        rollout_path: path.toNamespacedPath(path.resolve(result.filePath)),
        cwd: path.toNamespacedPath(path.resolve(portable().projectPath)),
        title: portable().title,
        preview: portable().title,
        first_user_message: portable().messages[0].content,
        source: "vscode",
        thread_source: "user",
        has_user_event: 1,
        cli_version: "migration",
      });

      const childSession = {
        ...portable(),
        sourceSessionKey: "cursor:source-child",
        sourceSessionId: "source-child",
        title: "Child agent",
        projectPath: "",
        isSubagent: true,
        parentSessionId: SESSION_ID,
      };
      const childResult = await writeMigratedSession({
        target: "codex",
        session: childSession,
        homeDir,
        now: NOW,
        idFactory: idFactory([CHILD_SESSION_ID]),
      });
      const childRows = readRows(childResult.filePath);
      expect(childRows[0]).toMatchObject({
        type: "session_meta",
        payload: {
          id: CHILD_SESSION_ID,
          session_id: SESSION_ID,
          parent_thread_id: SESSION_ID,
          thread_source: "subagent",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: SESSION_ID,
                depth: 1,
              },
            },
          },
        },
      });
      const childStateDb = new DatabaseSync(statePath);
      const childRow = childStateDb.prepare("SELECT * FROM threads WHERE id = ?").get(CHILD_SESSION_ID) as Record<string, unknown>;
      const childEdge = childStateDb.prepare("SELECT * FROM thread_spawn_edges WHERE child_thread_id = ?")
        .get(CHILD_SESSION_ID) as Record<string, unknown>;
      childStateDb.close();
      expect(childRow).toMatchObject({
        cwd: path.toNamespacedPath(path.resolve(homeDir)),
        thread_source: "subagent",
        agent_path: "/root/migrated_source_child",
      });
      expect(JSON.parse(String(childRow.source))).toMatchObject({
        subagent: { thread_spawn: { parent_thread_id: SESSION_ID } },
      });
      expect(childEdge).toEqual({
        parent_thread_id: SESSION_ID,
        child_thread_id: CHILD_SESSION_ID,
        status: "open",
      });
      expect(readRows(path.join(homeDir, ".codex", "session_index.jsonl"))).toEqual([
        { id: SESSION_ID, thread_name: portable().title, updated_at: NOW.toISOString() },
      ]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not report a Codex migration when its native index is malformed", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-index-invalid-"));
    const targetHome = path.join(homeDir, ".codex");
    const finalFile = targetFilePath("codex", portable().projectPath, SESSION_ID, homeDir, NOW);
    try {
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(path.join(targetHome, "session_index.jsonl"), "not-json\n");

      await expect(
        writeMigratedSession({
          target: "codex",
          session: portable(),
          homeDir,
          now: NOW,
          idFactory: idFactory([SESSION_ID]),
        }),
      ).rejects.toThrow("Codex session index could not be read");
      expect(fs.existsSync(finalFile)).toBe(false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses POSIX separators for paths written into WSL or SSH environments", () => {
    expect(targetFilePathForRemoteEnvironment(
      "claude",
      "/home/alice/project",
      SESSION_ID,
      "/home/alice",
      NOW,
    )).toBe(`/home/alice/.claude/projects/-home-alice-project/${SESSION_ID}.jsonl`);
  });

  it.each([
    ["codex", ".codex", "custom-codex"],
    ["tcodex", ".tcodex", "custom-tcodex"],
  ] as const)("uses the active provider from the $target config", async (target, root, modelProvider) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-configured-provider-${target}-`));
    try {
      const targetHome = path.join(homeDir, root);
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(
        path.join(targetHome, "config.toml"),
        `model_provider = "${modelProvider}"\n\n[profiles.unused]\nmodel_provider = "profile-only"\n`,
      );

      const result = await writeMigratedSession({
        target,
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(readRows(result.filePath)[0]?.payload?.model_provider).toBe(modelProvider);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("ignores profile-scoped Codex providers when no active provider is configured", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-profile-provider-"));
    try {
      const targetHome = path.join(homeDir, ".codex");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(
        path.join(targetHome, "config.toml"),
        '[profiles.internal]\nmodel_provider = "profile-only"\n',
      );

      const result = await writeMigratedSession({
        target: "codex",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(readRows(result.filePath)[0]?.payload?.model_provider).toBe("openai");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses the provider from the selected Codex profile", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-active-profile-provider-"));
    try {
      const targetHome = path.join(homeDir, ".codex");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(
        path.join(targetHome, "config.toml"),
        [
          'profile = "work"',
          'model_provider = "root-provider"',
          "",
          "[profiles.work]",
          'model_provider = "profile-provider"',
          "",
        ].join("\n"),
      );

      const result = await writeMigratedSession({
        target: "codex",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(readRows(result.filePath)[0]?.payload?.model_provider).toBe("profile-provider");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back when the active Codex provider is malformed", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-malformed-provider-"));
    try {
      const targetHome = path.join(homeDir, ".tcodex");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(path.join(targetHome, "config.toml"), "model_provider = [\n");

      const result = await writeMigratedSession({
        target: "tcodex",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(readRows(result.filePath)[0]?.payload?.model_provider).toBe("tencent");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("writes native Claude rows with a unique UUID parent chain and embedded title", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-claude-"));

    const result = await writeMigratedSession({
      target: "claude",
      session: portable(),
      homeDir,
      now: NOW,
      idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
    });

    expect(result.filePath).toBe(
      path.join(homeDir, ".claude", "projects", "-Users----My-Project", `${SESSION_ID}.jsonl`),
    );
    expect(fs.existsSync(path.join(homeDir, ".claude", "sessions"))).toBe(false);

    const rows = readRows(result.filePath);
    expect(rows[0]).toMatchObject({ type: "ai-title", aiTitle: portable().title, sessionId: SESSION_ID });
    const messages = rows.slice(1);
    expect(messages.map((row) => row.uuid)).toEqual(MESSAGE_IDS);
    expect(messages.map((row) => row.parentUuid)).toEqual([null, MESSAGE_IDS[0], MESSAGE_IDS[1]]);
    expect(messages.map((row) => [row.type, row.message.role])).toEqual([
      ["user", "user"],
      ["assistant", "assistant"],
      ["user", "user"],
    ]);
    expect(messages[1]?.message?.model).toBe("session-migration");
    for (const [index, row] of messages.entries()) {
      expect(row).toMatchObject({
        cwd: portable().projectPath,
        sessionId: SESSION_ID,
        timestamp: portable().messages[index].timestamp,
        entrypoint: "cli",
        version: "migration",
      });
    }
    expectRoundTrip("claude", "claude-cli", result.sessionId, result.filePath, rows);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it.each([
    ["claude", ".claude", "configured-claude-model"],
    ["tclaude", ".tclaude", "configured-tclaude-model"],
  ] as const)("uses the routed model from the $target settings", async (target, root, model) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-configured-model-${target}-`));
    try {
      const targetHome = path.join(homeDir, root);
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(
        path.join(targetHome, "settings.json"),
        `${JSON.stringify({ model: "top-level-model", env: { ANTHROPIC_MODEL: `  ${model}  ` } }, null, 2)}\n`,
      );

      const result = await writeMigratedSession({
        target,
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
      });

      const assistantRows = readRows(result.filePath).filter((row) => row.type === "assistant");
      expect(assistantRows.map((row) => row.message.model)).toEqual([model]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses the top-level Claude model when no routed model is configured", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-top-level-model-"));
    try {
      const targetHome = path.join(homeDir, ".claude");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(path.join(targetHome, "settings.json"), '{"model":"  opus  ","env":{}}\n');

      const result = await writeMigratedSession({
        target: "claude",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
      });

      const assistantRows = readRows(result.filePath).filter((row) => row.type === "assistant");
      expect(assistantRows.map((row) => row.message.model)).toEqual(["opus"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back when the Claude settings are malformed", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-malformed-claude-settings-"));
    try {
      const targetHome = path.join(homeDir, ".claude");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(path.join(targetHome, "settings.json"), "{\n");

      const result = await writeMigratedSession({
        target: "claude",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
      });

      const assistantRows = readRows(result.filePath).filter((row) => row.type === "assistant");
      expect(assistantRows.map((row) => row.message.model)).toEqual(["session-migration"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("writes native CodeBuddy title and message rows with millisecond timestamps and a parent chain", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-codebuddy-"));

    const result = await writeMigratedSession({
      target: "codebuddy",
      session: portable(),
      homeDir,
      now: NOW,
      idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
    });

    expect(result.filePath).toBe(
      path.join(homeDir, ".codebuddy", "projects", "Users----My-Project", `${SESSION_ID}.jsonl`),
    );

    const rows = readRows(result.filePath);
    expect(rows[0]).toEqual({
      timestamp: new Date(portable().startedAt).getTime(),
      type: "ai-title",
      aiTitle: portable().title,
      sessionId: SESSION_ID,
      cwd: portable().projectPath,
    });
    const messages = rows.slice(1);
    expect(messages.map((row) => row.id)).toEqual(MESSAGE_IDS);
    expect(messages.map((row) => row.parentId)).toEqual([undefined, MESSAGE_IDS[0], MESSAGE_IDS[1]]);
    expect(messages.map((row) => row.timestamp)).toEqual(
      portable().messages.map((message) => new Date(message.timestamp).getTime()),
    );
    expect(messages.map((row) => row.content[0].type)).toEqual(["input_text", "output_text", "input_text"]);
    expectRoundTrip("codebuddy", "codebuddy-cli", result.sessionId, result.filePath, rows);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("uses crypto UUIDs by default and keeps all output under the injected home", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-default-id-"));

    const result = await writeMigratedSession({ target: "codex", session: portable(), homeDir, now: NOW });

    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(path.relative(homeDir, result.filePath)).not.toMatch(/^\.\./);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it.each(TARGETS)("deletes $target output when validation fails", async ({ target, family }) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-validation-${target}-`));
    let temporaryFile = "";
    try {
      await expect(
        writeMigratedSession({
          target,
          session: portable(),
          homeDir,
          now: NOW,
          idFactory: idFactory(family === "codex" || target === "cursor" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
          validate: (filePath) => {
            temporaryFile = filePath;
            return null;
          },
        }),
      ).rejects.toThrow(/validation/i);

      expect(temporaryFile).not.toBe("");
      expect(fs.existsSync(temporaryFile)).toBe(false);
      expect(filesUnder(homeDir)).toEqual([]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each(TARGETS)("deletes $target output when beforeValidate fails", async ({ target, family }) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-before-validate-${target}-`));
    try {
      await expect(
        writeMigratedSession({
          target,
          session: portable(),
          homeDir,
          now: NOW,
          idFactory: idFactory(family === "codex" || target === "cursor" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
          beforeValidate: () => {
            throw new Error("beforeValidate exploded");
          },
        }),
      ).rejects.toThrow("beforeValidate exploded");

      expect(filesUnder(homeDir)).toEqual([]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("deletes the temporary file and leaves no final file when atomic rename fails", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-rename-"));
    let temporaryFile = "";
    let finalFile = "";

    await expect(
      writeMigratedSession({
        target: "codex",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
        rename: (oldPath, newPath) => {
          temporaryFile = oldPath;
          finalFile = newPath;
          throw new Error("rename exploded");
        },
      }),
    ).rejects.toThrow("rename exploded");

    expect(temporaryFile).not.toBe("");
    expect(fs.existsSync(temporaryFile)).toBe(false);
    expect(fs.existsSync(finalFile)).toBe(false);
    expect(filesUnder(homeDir)).toEqual([]);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });


  it("writes native Cursor transcript rows and round-trips them through the existing loader", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-cursor-"));

    try {
      const result = await writeMigratedSession({
        target: "cursor",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(result.filePath).toBe(
        path.join(
          homeDir,
          ".cursor",
          "projects",
          encodeCursorWorkspaceSlug(portable().projectPath),
          "agent-transcripts",
          SESSION_ID,
          `${SESSION_ID}.jsonl`,
        ),
      );

      const rows = readRows(result.filePath);
      expect(rows[0].message.content[0].text).toContain("<user_query>");
      expect(rows[1].message.content[0].text).toBe("已收到\n第二行");
      expectRoundTrip("cursor", "cursor-agent", result.sessionId, result.filePath, rows);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each(TARGETS)(
    "rejects tampered $target native content before rename and cleans the temporary file",
    async ({ target, family }) => {
      await expectTamperedSessionRejected(target, (rows) => {
        if (family === "codex") rows[0].payload.title = "被篡改的标题";
        else if (family === "claude") rows[2].parentUuid = null;
        else if (family === "cursor") rows[0].role = "system";
        else rows[1].timestamp += 1;
      });
    },
  );

  it("uses DSH_HOME normally but keeps an explicit test home isolated", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-dsh-home-"));
    const explicitHome = path.join(root, "explicit-home");
    const dshHome = path.join(root, "custom-dsh-home");
    const previous = process.env.DSH_HOME;
    try {
      process.env.DSH_HOME = dshHome;
      const isolated = await writeMigratedSession({
        target: "deepseek", session: portable(), sessionId: SESSION_ID, homeDir: explicitHome, now: NOW,
      });
      expect(isolated.filePath.startsWith(path.join(explicitHome, ".dsh"))).toBe(true);
      expect(isolated.filePath.startsWith(dshHome)).toBe(false);

      const configured = await writeMigratedSession({
        target: "deepseek", session: portable(), sessionId: SESSION_ID, now: NOW,
      });
      expect(configured.filePath.startsWith(dshHome)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a tampered Codex model provider before rename", async () => {
    await expectTamperedSessionRejected("codex", (rows) => {
      rows[0].payload.model_provider = "tampered-provider";
    });
  });

  it("rejects a tampered Claude model before rename", async () => {
    await expectTamperedSessionRejected("claude", (rows) => {
      rows[2].message.model = "tampered-model";
    });
  });
});

describe("writeMigratedSession → zcode", () => {
  // Every migrated message consumes two ids (message row + text part row).
  const zcodeIds = (seed: number): string[] =>
    Array.from({ length: 14 }, (_, index) => `10000000-0000-4000-8000-${String(seed + index).padStart(12, "0")}`);

  it("writes into a synthetic ZCode database and round-trips through the ZCode loader", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-zcode-"));
    try {
      createZcodeHomeFixture(homeDir);
      const result = await writeMigratedSession({
        target: "zcode",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory(zcodeIds(1)),
      });
      const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");

      expect(result.sessionId).toBe(`sess_${SESSION_ID}`);
      expect(result.filePath).toBe(dbPath);
      expect(fs.existsSync(`${dbPath}.bak`)).toBe(true);

      const loaded = loadZcodeSessions(path.join(homeDir, ".zcode")).find((item) => item.session.rawId === result.sessionId);
      expect(loaded?.session).toMatchObject({
        source: "zcode-cli",
        projectPath: path.join(homeDir, ".zcode", "workspace", "default"),
        originalTitle: portable().title,
      });
      expect(loaded?.messages.map(({ role, content, timestamp }) => ({ role, content }))).toEqual(
        portable().messages.map(({ role, content }) => ({ role, content })),
      );
      expect(loaded?.messages.map(({ timestamp }) => new Date(timestamp).getTime())).toEqual(
        portable().messages.map(({ timestamp }) => new Date(timestamp).getTime()),
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("links a migrated subagent to its parent through session.parent_id", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-zcode-subagent-"));
    try {
      createZcodeHomeFixture(homeDir);
      const parent = await writeMigratedSession({
        target: "zcode",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory(zcodeIds(1)),
      });
      const child = await writeMigratedSession({
        target: "zcode",
        session: {
          ...portable(),
          sourceSessionKey: "cursor:child",
          title: "Research child",
          isSubagent: true,
          parentSessionId: parent.sessionId,
        },
        homeDir,
        now: NOW,
        idFactory: idFactory(zcodeIds(20)),
      });

      expect(child.sessionId).toMatch(/^sess_subagent_agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const db = new DatabaseSync(child.filePath);
      try {
        const row = db.prepare("SELECT parent_id FROM session WHERE id = ?").get(child.sessionId) as { parent_id?: unknown };
        expect(row.parent_id).toBe(parent.sessionId);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("registers the migrated session in the ZCode task index so the client lists it", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-zcode-taskindex-"));
    try {
      createZcodeHomeFixture(homeDir);
      const taskIndexPath = createZcodeTaskIndexFixture(homeDir);
      // The client's list query hard-filters on its current provider, so the index
      // already holds one native task whose provider/model the writer must reuse.
      const seed = new DatabaseSync(taskIndexPath);
      try {
        seed.prepare(
          `INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, provider, model, created_at, updated_at)
           VALUES ('C:\\native', 'C:\\native', 'sess_native', 'Native task', 'completed', 'glm', 'builtin:glm-4.6', 1, 2)`,
        ).run();
      } finally {
        seed.close();
      }
      const result = await writeMigratedSession({
        target: "zcode",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory(zcodeIds(1)),
      });

      const indexDb = new DatabaseSync(taskIndexPath);
      try {
        const row = indexDb.prepare("SELECT * FROM tasks WHERE task_id = ?").get(result.sessionId) as Record<string, unknown>;
        expect(row).toMatchObject({
          workspace_key: path.join(homeDir, ".zcode", "workspace", "default"),
          workspace_path: path.join(homeDir, ".zcode", "workspace", "default"),
          task_id: result.sessionId,
          title: portable().title,
          task_status: "completed",
          provider: "glm",
          model: "builtin:glm-4.6",
          migration_source: "claudeCode",
          deleted: 0,
        });
        expect(JSON.parse(String(row.meta_json))).toMatchObject({ taskId: result.sessionId, traceId: `zcode-${result.sessionId}`, status: "completed", provider: "glm", mode: "build" });
        expect(String(row.searchable_text)).toContain("你好，世界 🌏");
      } finally {
        indexDb.close();
      }

    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("fails loudly when the ZCode database does not exist", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-zcode-missing-"));
    try {
      await expect(writeMigratedSession({
        target: "zcode",
        session: portable(),
        homeDir,
        now: NOW,
      })).rejects.toThrow(/ZCode database not found/);
      expect(filesUnder(homeDir)).toEqual([]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("fails loudly when the ZCode database schema is incompatible", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-zcode-schema-"));
    try {
      const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)");
      } finally {
        db.close();
      }

      await expect(writeMigratedSession({
        target: "zcode",
        session: portable(),
        homeDir,
        now: NOW,
      })).rejects.toThrow(/schema is incompatible/);
      expect(fs.existsSync(`${dbPath}.bak`)).toBe(false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

function createZcodeHomeFixture(homeDir: string): string {
  const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, path TEXT,
        title TEXT, version TEXT, permission TEXT, trace_id TEXT, task_type TEXT DEFAULT 'interactive', title_source TEXT DEFAULT 'first_input',
        title_message_id TEXT, time_title_updated INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
  return dbPath;
}

function createZcodeTaskIndexFixture(homeDir: string): string {
  const taskIndexPath = path.join(homeDir, ".zcode", "v2", "tasks-index.sqlite");
  fs.mkdirSync(path.dirname(taskIndexPath), { recursive: true });
  const db = new DatabaseSync(taskIndexPath);
  try {
    db.exec(`
      CREATE TABLE tasks (
        workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
        task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
        mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT, forked_from_task_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
        last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
        title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
        searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT,
        PRIMARY KEY (workspace_key, task_id)
      );
    `);
  } finally {
    db.close();
  }
  return taskIndexPath;
}

async function expectTamperedSessionRejected(
  target: MigrationTarget,
  mutate: (rows: Array<Record<string, any>>) => void,
): Promise<void> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-tamper-${target}-`));
  let temporaryFile = "";

  try {
    await expect(
      writeMigratedSession({
        target,
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory(target === "codex" || target === "tcodex" || target === "cursor"
          ? [SESSION_ID]
          : [SESSION_ID, ...MESSAGE_IDS]),
        beforeValidate: (filePath) => {
          temporaryFile = filePath;
          const rows = parseJsonlText(fs.readFileSync(filePath, "utf8")) as Array<Record<string, any>>;
          mutate(rows);
          fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        },
      }),
    ).rejects.toThrow(/validation/i);

    expect(temporaryFile).not.toBe("");
    expect(fs.existsSync(temporaryFile)).toBe(false);
    expect(filesUnder(homeDir)).toEqual([]);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(entryPath));
    else files.push(entryPath);
  }
  return files;
}
