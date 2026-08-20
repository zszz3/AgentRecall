import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInMemoryStore } from "./postgres/test-session-store";
import type { IndexedSession, SessionMessage } from "./types";

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

const openStores: Array<ReturnType<typeof createInMemoryStore>> = [];

afterEach(async () => {
  await Promise.all(openStores.splice(0).map((store) => store.close()));
});

function createStore(): ReturnType<typeof createInMemoryStore> {
  const store = createInMemoryStore();
  openStores.push(store);
  return store;
}

function indexedSession(overrides: Partial<IndexedSession> = {}): IndexedSession {
  return {
    sessionKey: "codex:session-a",
    rawId: "session-a",
    source: "codex-cli",
    projectPath: "/synthetic/repo",
    filePath: "/synthetic/repo/session-a.jsonl",
    originalTitle: "Investigate login",
    firstQuestion: "Why does login fail?",
    timestamp: Date.parse("2026-07-20T08:00:00.000Z"),
    fileMtimeMs: 100,
    fileSize: 200,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

const messages: SessionMessage[] = [
  {
    role: "user",
    content: "Find the stale cache key",
    timestamp: "2026-07-20T08:00:00.000Z",
    index: 0,
  },
  {
    role: "assistant",
    content: "The account cache was not invalidated.",
    timestamp: "2026-07-20T08:00:01.000Z",
    index: 1,
  },
];

describe("SessionStore PostgreSQL facade", () => {
  it("removes NUL characters from message and trace text before indexing", async () => {
    const store = createStore();

    await store.upsertIndexedSession(
      indexedSession(),
      [
        {
          role: "user",
          content: "before\u0000after",
          timestamp: "2026-07-20T08:00:00.000Z",
          index: 0,
        },
      ],
      [],
      [
        {
          index: 0,
          kind: "tool_call",
          source: "codex",
          title: "shell\u0000command",
          detail: "stdout:\u0000pass",
          timestamp: "2026-07-20T08:00:01.000Z",
          callId: "call-1",
        },
      ],
    );

    await expect(store.getMessages("codex:session-a")).resolves.toEqual([
      expect.objectContaining({ content: "beforeafter" }),
    ]);
    await expect(store.getTraceEvents("codex:session-a")).resolves.toEqual([
      expect.objectContaining({
        title: "shellcommand",
        detail: "stdout:pass",
      }),
    ]);
  });

  it("indexes a Session and exposes Turn-backed search through the stable facade", async () => {
    const store = createStore();
    await store.upsertIndexedSession(indexedSession(), messages);

    const results = await store.searchSessions({ query: "stale cache" });

    expect(results).toEqual([
      expect.objectContaining({
        sessionKey: "codex:session-a",
        messageCount: 2,
        bestTurn: expect.objectContaining({ turnId: expect.any(String) }),
        matchSnippet: expect.stringContaining("stale cache"),
      }),
    ]);
    await expect(store.getAllMessages("codex:session-a")).resolves.toEqual(messages);
  });

  it("preserves user title, favorite, and tags when source content is re-indexed", async () => {
    const store = createStore();
    await store.upsertIndexedSession(indexedSession(), messages);
    await store.setCustomTitle("codex:session-a", "Login incident");
    await store.setFavorited("codex:session-a", true);
    await store.addTag("codex:session-a", "important");

    await store.upsertIndexedSession(
      indexedSession({ fileMtimeMs: 300, fileSize: 400 }),
      [...messages, {
        role: "assistant",
        content: "Fixed and verified.",
        timestamp: "2026-07-20T08:01:00.000Z",
        index: 2,
      }],
    );

    await expect(store.getSession("codex:session-a")).resolves.toMatchObject({
      displayTitle: "Login incident",
      favorited: true,
      tags: ["important"],
      messageCount: 3,
      fileMtimeMs: 300,
    });
  });

  it("keeps an AgentRecall title when the Cursor title changes", async () => {
    const store = createStore();
    const cursor = indexedSession({
      sessionKey: "cursor:repo:session-a",
      source: "cursor-agent",
      originalTitle: "Old Cursor title",
    });
    await store.upsertIndexedSession(cursor, messages);
    await store.setCustomTitle(cursor.sessionKey, "Old AgentRecall title");

    await store.upsertIndexedSession({
      ...cursor,
      originalTitle: "Renamed in Cursor",
      fileMtimeMs: cursor.fileMtimeMs + 1,
    }, messages);

    await expect(store.getSession(cursor.sessionKey)).resolves.toMatchObject({
      originalTitle: "Renamed in Cursor",
      customTitle: "Old AgentRecall title",
      displayTitle: "Old AgentRecall title",
    });

    await store.setCustomTitle(cursor.sessionKey, null);
    await expect(store.getSession(cursor.sessionKey)).resolves.toMatchObject({
      customTitle: null,
      displayTitle: "Renamed in Cursor",
    });
  });

  it("tracks full-content freshness separately from remote summary metadata", async () => {
    const store = createStore();
    const session = indexedSession();

    await store.upsertIndexedSessionSummary(session, messages.length);
    await expect(
      store.isSessionContentFresh(session.sessionKey, session.fileMtimeMs, session.fileSize),
    ).resolves.toBe(false);

    await store.upsertIndexedSession(session, messages);
    await expect(
      store.isSessionContentFresh(session.sessionKey, session.fileMtimeMs, session.fileSize),
    ).resolves.toBe(true);

    const changed = { ...session, fileMtimeMs: 300, fileSize: 400 };
    await store.upsertIndexedSessionSummary(changed, messages.length);
    await expect(
      store.isSessionContentFresh(changed.sessionKey, changed.fileMtimeMs, changed.fileSize),
    ).resolves.toBe(false);
  });

  it("prunes zero-message Cursor state database shells even when the database still exists", async () => {
    const store = createStore();
    const stateDbPath = "/synthetic/Cursor/User/globalStorage/state.vscdb";
    const shell = indexedSession({
      sessionKey: "cursor:repo:empty",
      rawId: "empty",
      source: "cursor-agent",
      filePath: stateDbPath,
      originalTitle: "Empty Cursor shell",
      firstQuestion: "",
    });

    await store.upsertIndexedSessionSummary(shell, 0);

    await expect(
      store.listSessionKeysByFilePath("local", new Set([stateDbPath])),
    ).resolves.toContain(shell.sessionKey);
  });

  it("keeps cached Cursor messages deletable without touching the shared source database", async () => {
    const store = createStore();
    const sessionKey = "cursor:workspace:cached";
    const stateDbPath = "/synthetic/Cursor/User/globalStorage/state.vscdb";
    await store.upsertIndexedSession(
      indexedSession({
        sessionKey,
        rawId: "cached",
        source: "cursor-agent",
        filePath: stateDbPath,
      }),
      messages,
    );

    await store.setSessionSourceAvailable(sessionKey, false);

    await expect(store.getSession(sessionKey)).resolves.toMatchObject({
      sourceAvailable: false,
      messageCount: messages.length,
    });
    await expect(store.getSessionSourceArtifacts(sessionKey)).resolves.toEqual([]);
    await expect(store.deleteSession(sessionKey)).resolves.toBe(true);
    await expect(store.getSession(sessionKey)).resolves.toBeNull();
  });

  it("deletes only prepared targets while invalidating their online memory evidence", async () => {
    const store = createStore();
    const uri = "viking://user/memories/events/release.md";
    await store.upsertIndexedSession(indexedSession(), messages);
    await store.setSessionSourceAvailable("codex:session-a", false);
    await store.addOpenVikingWorkspace({
      id: "workspace-1",
      userId: "workspace_abcd",
      rootPath: "/synthetic/repo",
      identity: "path:workspace-1",
      displayName: "repo",
    });
    await store.applyOpenVikingCommitResult({
      run: {
        taskId: "task-1",
        workspaceId: "workspace-1",
        sessionId: "agent-recall-synthetic",
        sourceSessionId: "session-a",
        agent: "codex",
        trigger: "session-end",
        state: "completed",
        sourceTurnIds: ["turn-1"],
        tokenEstimate: 100,
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:10.000Z",
        updatedAt: "2026-08-05T00:00:10.000Z",
      },
      changes: [{ kind: "add", uri, memoryType: "events", after: "Release note required." }],
    });
    let policyRefreshes = 0;
    store.setOpenVikingControlChangedHandler(() => {
      policyRefreshes += 1;
    });

    const preparedTargets = await store.getSessionDeletionTargets(["codex:session-a"]);
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "codex:late-child",
      rawId: "late-child",
      isSubagent: true,
      parentSessionId: "session-a",
    }), messages);

    await expect(
      store.deleteExactSessionTargets(preparedTargets, "codex:session-a"),
    ).resolves.toBe(true);
    await expect(store.getSession("codex:session-a")).resolves.toBeNull();
    await expect(store.getSession("codex:late-child")).resolves.not.toBeNull();
    await expect(store.getOpenVikingMemoryControl("workspace-1", uri)).resolves.toMatchObject({
      lifecycle: "invalidated",
      evidenceStatus: "invalid",
      evidenceCount: 0,
    });
    expect(policyRefreshes).toBe(1);
  });

  it("deletes a Claude parent with indexed descendants and owned companion artifacts", async () => {
    const store = createStore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-claude-tree-delete-"));
    const parentFile = path.join(root, "parent.jsonl");
    const subagentsDir = path.join(root, "parent", "subagents");
    const childFile = path.join(subagentsDir, "agent-child.jsonl");
    const childMetadata = path.join(subagentsDir, "agent-child.meta.json");
    const toolResultsDir = path.join(root, "parent", "tool-results");
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.mkdirSync(toolResultsDir, { recursive: true });
    for (const filePath of [parentFile, childFile, childMetadata, path.join(toolResultsDir, "result.txt")]) {
      fs.writeFileSync(filePath, "fixture", "utf8");
    }
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "claude:parent", rawId: "parent", source: "claude-app", filePath: parentFile,
    }), messages);
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "claude:child", rawId: "child", source: "claude-cli", filePath: childFile,
      isSubagent: true, parentSessionId: "parent",
    }), messages);

    try {
      await expect(store.getSessionDeletionTargets([], true)).resolves.toEqual([]);
      await expect(store.deleteSession("claude:parent")).resolves.toBe(true);
      await expect(store.getSession("claude:parent")).resolves.toBeNull();
      await expect(store.getSession("claude:child")).resolves.toBeNull();
      expect(fs.existsSync(parentFile)).toBe(false);
      expect(fs.existsSync(path.join(root, "parent"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes DeepSeek Harness parent and descendant session directories together", async () => {
    const store = createStore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-dsh-tree-delete-"));
    const parentFile = path.join(root, "sessions", "--work--", "parent", "session.jsonl.zstd");
    const childFile = path.join(root, "sessions", "--work--", "child", "session.jsonl.zstd");
    for (const filePath of [parentFile, childFile]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "fixture");
    }
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "deepseek:parent", rawId: "parent", source: "deepseek-cli", filePath: parentFile,
    }), messages);
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "deepseek:child", rawId: "child", source: "deepseek-cli", filePath: childFile,
      isSubagent: true, parentSessionId: "parent",
    }), messages);

    try {
      await expect(store.deleteSession("deepseek:parent")).resolves.toBe(true);
      expect(fs.existsSync(path.dirname(parentFile))).toBe(false);
      expect(fs.existsSync(path.dirname(childFile))).toBe(false);
      await expect(store.getSession("deepseek:parent")).resolves.toBeNull();
      await expect(store.getSession("deepseek:child")).resolves.toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds orphaned subagent trees after an explicit record-only prune", async () => {
    const store = createStore();
    await store.upsertIndexedSession(indexedSession({ sessionKey: "codex:parent", rawId: "parent" }), messages);
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "codex:child", rawId: "child", isSubagent: true, parentSessionId: "parent",
    }), messages);
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "codex:grandchild", rawId: "grandchild", isSubagent: true, parentSessionId: "child",
    }), messages);
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "codex:sibling", rawId: "sibling", isSubagent: true, parentSessionId: "parent",
    }), messages);

    await expect(store.deleteSessionRecord("codex:parent")).resolves.toBe(true);
    const orphanTargets = await store.getSessionDeletionTargets([], true);
    expect(new Set(orphanTargets.map((target) => target.sessionKey))).toEqual(new Set([
      "codex:child",
      "codex:grandchild",
      "codex:sibling",
    ]));
    expect(new Set(orphanTargets.map((target) => target.cascadeRootSessionKey))).toEqual(new Set(["codex:child"]));
    expect(new Set(orphanTargets.map((target) => target.orphanedParentSessionId))).toEqual(new Set(["parent"]));
    const explicitOrphanTargets = await store.getSessionDeletionTargets(["codex:child", "codex:sibling"], true);
    expect(new Set(explicitOrphanTargets.map((target) => target.cascadeRootSessionKey))).toEqual(new Set([
      "codex:child",
      "codex:sibling",
    ]));
    for (const rootKey of ["codex:child", "codex:sibling"]) {
      expect(new Set(
        explicitOrphanTargets.filter((target) => target.cascadeRootSessionKey === rootKey).map((target) => target.sessionKey),
      )).toEqual(new Set(["codex:child", "codex:grandchild", "codex:sibling"]));
    }
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "codex:cycle-a", rawId: "cycle-a", isSubagent: true, parentSessionId: "cycle-b",
    }), messages);
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "codex:cycle-b", rawId: "cycle-b", isSubagent: true, parentSessionId: "cycle-a",
    }), messages);
    await expect(store.getSessionDeletionTargets(["codex:cycle-a"])).resolves.toEqual([
      expect.objectContaining({ sessionKey: "codex:cycle-a" }),
      expect.objectContaining({ sessionKey: "codex:cycle-b" }),
    ]);
  });

  it("expands bulk deletion targets and records to the full descendant tree", async () => {
    const store = createStore();
    await store.upsertIndexedSession(indexedSession({ sessionKey: "codex:parent", rawId: "parent" }), messages);
    await store.upsertIndexedSession(
      indexedSession({ sessionKey: "codex:child", rawId: "child", isSubagent: true, parentSessionId: "parent" }),
      messages,
    );
    await store.setFavorited("codex:parent", true);

    await expect(store.getSessionDeletionTargets(["codex:child"])).resolves.toEqual([
      expect.objectContaining({ sessionKey: "codex:child", ancestorRawIds: ["parent"] }),
    ]);

    await expect(store.getSessionDeletionTargets(["codex:child", "missing", "codex:parent"])).resolves.toEqual([
      expect.objectContaining({
        cascadeRootSessionKey: "codex:child",
        sessionKey: "codex:child",
        favorited: false,
        environmentKind: "local",
      }),
      expect.objectContaining({
        cascadeRootSessionKey: "codex:parent",
        sessionKey: "codex:parent",
        favorited: true,
        lastActivityAt: Date.parse("2026-07-20T08:00:01.000Z"),
      }),
      expect.objectContaining({ cascadeRootSessionKey: "codex:parent", sessionKey: "codex:child" }),
    ]);

    await expect(store.deleteSessionRecords(["codex:parent", "missing"])).resolves.toEqual(["codex:parent", "codex:child"]);
    await expect(store.getSession("codex:parent")).resolves.toBeNull();
    await expect(store.getSession("codex:child")).resolves.toBeNull();
  });

  it("can delete an already-expanded record set without capturing later descendants", async () => {
    const store = createStore();
    await store.upsertIndexedSession(indexedSession({ sessionKey: "codex:parent", rawId: "parent" }), messages);
    await store.upsertIndexedSession(
      indexedSession({ sessionKey: "codex:child", rawId: "child", isSubagent: true, parentSessionId: "parent" }),
      messages,
    );

    await expect(store.deleteSessionRecords(["codex:parent"], false)).resolves.toEqual(["codex:parent"]);
    await expect(store.getSession("codex:child")).resolves.not.toBeNull();
  });

  it("deletes a selected ZCode session tree from its shared database", async () => {
    const store = createStore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-zcode-delete-"));
    try {
      const dbDir = path.join(root, "cli", "db");
      const dbPath = path.join(dbDir, "db.sqlite");
      fs.mkdirSync(dbDir, { recursive: true });
      const taskIndexDir = path.join(root, "v2");
      const taskIndexPath = path.join(taskIndexDir, "tasks-index.sqlite");
      fs.mkdirSync(taskIndexDir, { recursive: true });
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
        db.prepare("INSERT INTO session (id) VALUES (?), (?), (?)").run("sess-delete", "sess-child", "sess-keep");
      } finally {
        db.close();
      }
      const taskIndex = new DatabaseSync(taskIndexPath);
      try {
        taskIndex.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY)");
        taskIndex.prepare("INSERT INTO tasks (task_id) VALUES (?), (?), (?)").run("sess-delete", "sess-child", "sess-keep");
      } finally {
        taskIndex.close();
      }

      await store.upsertIndexedSession(
        indexedSession({
          sessionKey: "zcode:sess-delete",
          rawId: "sess-delete",
          source: "zcode-cli",
          filePath: dbPath,
        }),
        messages,
      );
      await store.upsertIndexedSession(
        indexedSession({
          sessionKey: "zcode:sess-child",
          rawId: "sess-child",
          source: "zcode-cli",
          filePath: dbPath,
          isSubagent: true,
          parentSessionId: "sess-delete",
        }),
        messages,
      );

      await expect(store.deleteSession("zcode:sess-delete")).resolves.toBe(true);
      expect(fs.existsSync(dbPath)).toBe(true);
      const remainingDb = new DatabaseSync(dbPath);
      try {
        expect(remainingDb.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([{ id: "sess-keep" }]);
      } finally {
        remainingDb.close();
      }
      const remainingTaskIndex = new DatabaseSync(taskIndexPath);
      try {
        expect(remainingTaskIndex.prepare("SELECT task_id FROM tasks ORDER BY task_id").all()).toEqual([{ task_id: "sess-keep" }]);
      } finally {
        remainingTaskIndex.close();
      }
      await expect(store.getSession("zcode:sess-delete")).resolves.toBeNull();
      await expect(store.getSession("zcode:sess-child")).resolves.toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes the prepared Hermes tree from the shared database without hidden expansion", async () => {
    const store = createStore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-hermes-store-delete-"));
    try {
      const dbPath = path.join(root, "state.db");
      const db = new DatabaseSync(dbPath);
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          parent_session_id TEXT REFERENCES sessions(id),
          model_config TEXT,
          started_at REAL NOT NULL
        );
        CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, timestamp REAL NOT NULL);
      `);
      const insert = db.prepare(
        "INSERT INTO sessions (id, parent_session_id, model_config, started_at) VALUES (?, ?, ?, ?)",
      );
      insert.run("parent", null, "{}", 1);
      insert.run("delegate", "parent", JSON.stringify({ _delegate_from: "parent" }), 2);
      insert.run("hidden", "parent", JSON.stringify({ _delegate_from: "parent" }), 3);
      db.close();

      await store.upsertIndexedSession(indexedSession({
        sessionKey: "hermes:parent",
        rawId: "parent",
        source: "hermes",
        filePath: dbPath,
      }), messages);
      await store.upsertIndexedSession(indexedSession({
        sessionKey: "hermes:delegate",
        rawId: "delegate",
        source: "hermes",
        filePath: dbPath,
        isSubagent: true,
        parentSessionId: "parent",
      }), messages);

      const prepared = await store.getSessionDeletionTargets(["hermes:parent"]);
      expect(prepared.map((item) => item.sessionKey)).toEqual(["hermes:parent", "hermes:delegate"]);
      await expect(store.deleteExactSessionTargets(prepared, "hermes:parent")).resolves.toBe(true);
      await expect(store.getSession("hermes:parent")).resolves.toBeNull();
      await expect(store.getSession("hermes:delegate")).resolves.toBeNull();

      const verify = new DatabaseSync(dbPath);
      try {
        expect(verify.prepare("SELECT id, parent_session_id FROM sessions").all()).toEqual([
          { id: "hidden", parent_session_id: null },
        ]);
      } finally {
        verify.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["opencode-cli", "codewiz-cli"] as const)(
    "deletes an unavailable %s cache without touching its shared database",
    async (source) => {
      const store = createStore();
      const sessionKey = `${source}:cached`;
      await store.upsertIndexedSession(indexedSession({
        sessionKey,
        rawId: "cached",
        source,
        filePath: `/synthetic/${source}.db`,
      }), messages);
      await store.setSessionSourceAvailable(sessionKey, false);

      await expect(store.deleteSession(sessionKey)).resolves.toBe(true);
      await expect(store.getSession(sessionKey)).resolves.toBeNull();
    },
  );

  it("rejects exact SSH cache deletion when an expanded descendant is still available", async () => {
    const store = createStore();
    const root = indexedSession({
      sessionKey: "ssh:dev:opencode-cli:parent",
      rawId: "parent",
      source: "opencode-cli",
      filePath: "/remote/opencode.db",
      environmentId: "dev",
      environmentKind: "ssh",
    });
    const child = indexedSession({
      sessionKey: "ssh:dev:opencode-cli:child",
      rawId: "child",
      source: "opencode-cli",
      filePath: "/remote/opencode.db",
      environmentId: "dev",
      environmentKind: "ssh",
      isSubagent: true,
      parentSessionId: "parent",
    });
    await store.upsertIndexedSession(root, messages);
    await store.upsertIndexedSession(child, messages);
    await store.setSessionSourceAvailable(root.sessionKey, false);
    const targets = await store.getSessionDeletionTargets([root.sessionKey]);

    await expect(store.deleteExactSessionTargets(targets, root.sessionKey)).rejects.toThrow(
      "Cannot delete sessions stored on SSH remote environments.",
    );
    await expect(store.getSession(root.sessionKey)).resolves.not.toBeNull();
    await expect(store.getSession(child.sessionKey)).resolves.not.toBeNull();
  });

  it("refuses to delete the shared CodeWiz database", async () => {
    const store = createStore();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-codewiz-delete-"));
    try {
      const dbPath = path.join(root, "codewiz.db");
      fs.writeFileSync(dbPath, "shared database", "utf8");
      await store.upsertIndexedSession(
        indexedSession({
          sessionKey: "codewiz:sess-keep",
          rawId: "sess-keep",
          source: "codewiz-cli",
          filePath: dbPath,
        }),
        messages,
      );

      await expect(store.deleteSession("codewiz:sess-keep")).rejects.toThrow(
        "Cannot delete shared CodeWiz source database.",
      );
      expect(fs.existsSync(dbPath)).toBe(true);
      await expect(store.getSession("codewiz:sess-keep")).resolves.not.toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects Pi source deletion while record-only source pruning keeps the file", async () => {
    const store = createStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-delete-pi-"));
    const filePath = path.join(dir, "pi-session.jsonl");
    fs.writeFileSync(filePath, "{}\n", "utf8");
    await store.upsertIndexedSession(
      indexedSession({
        sessionKey: "pi:session-a",
        rawId: "session-a",
        source: "pi-cli",
        filePath,
      }),
      messages,
    );

    await expect(store.deleteSession("pi:session-a")).rejects.toThrow("Pi session source files are read-only.");
    expect(fs.existsSync(filePath)).toBe(true);
    await expect(store.getSession("pi:session-a")).resolves.not.toBeNull();

    await store.deleteSessionsBySource(["pi-cli"]);

    await expect(store.getSession("pi:session-a")).resolves.toBeNull();
    expect(fs.existsSync(filePath)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps WorkBuddy source files and indexed records when direct deletion is attempted", async () => {
    const store = createStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-delete-workbuddy-"));
    const filePath = path.join(dir, "workbuddy-session.jsonl");
    fs.writeFileSync(filePath, "{}\n", "utf8");
    await store.upsertIndexedSession(
      indexedSession({
        sessionKey: "workbuddy:session-a",
        rawId: "session-a",
        source: "workbuddy-cli",
        filePath,
      }),
      messages,
    );

    try {
      await expect(store.deleteSession("workbuddy:session-a")).rejects.toThrow(
        "WorkBuddy session source files are read-only.",
      );
      expect(fs.existsSync(filePath)).toBe(true);
      await expect(store.getSession("workbuddy:session-a")).resolves.not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects Kimi source deletion while record-only source pruning keeps the file", async () => {
    const store = createStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-delete-kimi-"));
    const filePath = path.join(dir, "context.jsonl");
    fs.writeFileSync(filePath, "{}\n", "utf8");
    await store.upsertIndexedSession(indexedSession({
      sessionKey: "kimi:session-a",
      rawId: "session-a",
      source: "kimi-cli",
      filePath,
    }), messages);

    await expect(store.deleteSession("kimi:session-a")).rejects.toThrow("Kimi Code session source files are read-only.");
    expect(fs.existsSync(filePath)).toBe(true);
    await expect(store.getSession("kimi:session-a")).resolves.not.toBeNull();

    await store.deleteSessionsBySource(["kimi-cli"]);

    await expect(store.getSession("kimi:session-a")).resolves.toBeNull();
    expect(fs.existsSync(filePath)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps Session search results paged while filtering subagents in SQL", async () => {
    const store = createStore();
    await store.upsertIndexedSession(indexedSession(), messages);
    await store.upsertIndexedSession(
      indexedSession({
        sessionKey: "codex:subagent-a",
        rawId: "subagent-a",
        filePath: "/synthetic/repo/subagent-a.jsonl",
        isSubagent: true,
        parentSessionId: "session-a",
      }),
      messages,
    );

    await expect(store.searchSessionPage({
      excludeSubagents: true,
      limit: 10,
    })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionKey: "codex:session-a" })],
      totalCount: 1,
      hasMore: false,
    });
  });

  it("round-trips remote environment and sync metadata through the same database", async () => {
    const store = createStore();
    await store.upsertIndexedSession(indexedSession(), messages);
    const environment = await store.upsertEnvironment({
      kind: "ssh",
      label: "Synthetic remote",
      host: "example.invalid",
    });
    await store.upsertSessionSyncBinding({
      localSessionKey: "codex:session-a",
      remoteSessionId: "remote-a",
      lastLocalRevision: "local-1",
      lastRemoteRevision: "remote-1",
      lastSyncedAt: 10,
      direction: "upload",
    });

    await expect(store.getEnvironment(environment.id)).resolves.toMatchObject({
      label: "Synthetic remote",
      host: "example.invalid",
    });
    await expect(store.getSessionSyncBindingForRemoteId("remote-a")).resolves.toMatchObject({
      localSessionKey: "codex:session-a",
      direction: "upload",
    });
  });
});
