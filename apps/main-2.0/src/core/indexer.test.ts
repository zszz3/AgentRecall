import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { indexMigratedSessionFile, syncDefaultSessionsInBatches, syncLoadedSessionsInBatches } from "./indexer";
import { createInMemoryStore } from "./postgres/test-session-store";
import { writeMigratedSession } from "./session-migration-writers";
import type { IndexedSession, LoadedSession, MigrationTarget, PortableSession, SessionSource } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function session(index: number): LoadedSession {
  const id = `session-${index}`;
  const item: IndexedSession = {
    sessionKey: `codex:${id}`,
    rawId: id,
    source: "codex-cli",
    projectPath: `/repo/${index}`,
    filePath: `/tmp/${id}.jsonl`,
    originalTitle: `Session ${index}`,
    firstQuestion: `Question ${index}`,
    timestamp: index,
    fileMtimeMs: index,
    fileSize: 100 + index,
    prUrl: null,
    prNumber: null,
  };

  return {
    session: item,
    messages: [{ role: "user", content: `Question ${index}`, timestamp: "2026-06-01T10:00:00Z", index: 0 }],
  };
}

describe("indexer", () => {
  it("indexes loaded sessions in batches and yields between batches", async () => {
    const store = createInMemoryStore();
    const progress: number[] = [];
    let yields = 0;

    const status = await syncLoadedSessionsInBatches(store, [session(1), session(2), session(3)], {
      batchSize: 1,
      onProgress: (nextStatus) => progress.push(nextStatus.indexed),
      yieldToEventLoop: async () => {
        yields++;
      },
    });

    expect(progress).toEqual([1, 2, 3]);
    expect(yields).toBe(3);
    expect(status).toMatchObject({ running: false, indexed: 3, total: 3, error: null });
    expect(await store.searchSessions({ query: "Question", limit: 10 })).toHaveLength(3);
  });

  it("yields when the time budget is exhausted before the batch limit", async () => {
    const store = createInMemoryStore();
    const progress: number[] = [];
    let yields = 0;
    let clock = 0;
    const loaded = (function* () {
      clock = 4;
      yield session(1);
      clock = 9;
      yield session(2);
      clock = 10;
      yield session(3);
    })();

    await syncLoadedSessionsInBatches(store, loaded, {
      batchSize: 100,
      timeBudgetMs: 8,
      now: () => clock,
      onProgress: (nextStatus) => progress.push(nextStatus.indexed),
      yieldToEventLoop: async () => {
        yields++;
      },
    });

    expect(progress).toEqual([2, 3]);
    expect(yields).toBe(2);
  });

  it("skips rebuilding unchanged sessions", async () => {
    const store = createInMemoryStore();
    await store.upsertIndexedSession(session(1).session, [
      { role: "user", content: "original indexed question", timestamp: "2026-06-01T10:00:00Z", index: 0 },
    ]);

    const unchanged = session(1);
    unchanged.messages = [{ role: "user", content: "should not replace unchanged content", timestamp: "2026-06-01T10:00:00Z", index: 0 }];

    const status = await syncLoadedSessionsInBatches(store, [unchanged], { batchSize: 1 });

    expect(status).toMatchObject({ indexed: 0, skipped: 1, total: 1 });
    expect(await store.searchSessions({ query: "original indexed question", limit: 10 })).toHaveLength(1);
    expect(await store.searchSessions({ query: "should not replace unchanged content", limit: 10 })).toHaveLength(0);
  });

  it("continues indexing after one malformed session fails", async () => {
    const store = createInMemoryStore();
    const malformed = session(1);
    malformed.session.sessionKey = "codex:invalid\u0000session";

    const status = await syncLoadedSessionsInBatches(store, [malformed, session(2)], { batchSize: 1 });

    expect(status).toMatchObject({
      running: false,
      indexed: 1,
      skipped: 1,
      total: 2,
      error: "1 session could not be indexed; the remaining sessions were processed.",
    });
    expect(await store.searchSessions({ query: "Question 2", limit: 10 })).toHaveLength(1);
  });

  it("creates a disabled SSH environment for locally stored Cursor Remote sessions", async () => {
    const store = createInMemoryStore();
    const remote = session(1);
    remote.session = {
      ...remote.session,
      sessionKey: "cursor:workspace:remote-1",
      rawId: "remote-1",
      source: "cursor-agent",
      storageEnvironmentId: "local",
    };
    remote.executionEnvironmentHint = { kind: "ssh", label: "dev", hostAlias: "dev" };
    let environmentsChanged = 0;

    await syncLoadedSessionsInBatches(store, [remote], {
      batchSize: 1,
      onEnvironmentsChanged: () => {
        environmentsChanged++;
      },
    });

    expect(await store.listEnvironments()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dev", kind: "ssh", label: "dev", hostAlias: "dev", enabled: false }),
    ]));
    expect(await store.getSession("cursor:workspace:remote-1")).toMatchObject({
      sessionKey: "cursor:workspace:remote-1",
      environmentId: "dev",
      environmentKind: "ssh",
      environmentLabel: "dev",
      storageEnvironmentId: "local",
    });
    expect(environmentsChanged).toBe(1);
  });

  it("reuses an enabled SSH environment for Cursor Remote sessions without disabling it", async () => {
    const store = createInMemoryStore();
    const existing = await store.upsertEnvironment({
      id: "ssh-dev",
      kind: "ssh",
      label: "Development",
      hostAlias: "dev",
      enabled: true,
    });
    const remote = session(1);
    remote.session = {
      ...remote.session,
      sessionKey: "cursor:workspace:remote-1",
      rawId: "remote-1",
      source: "cursor-agent",
      storageEnvironmentId: "local",
    };
    remote.executionEnvironmentHint = { kind: "ssh", label: "dev", hostAlias: "dev" };
    let environmentsChanged = 0;

    await syncLoadedSessionsInBatches(store, [remote], {
      batchSize: 1,
      onEnvironmentsChanged: () => {
        environmentsChanged++;
      },
    });

    expect(await store.getSession("cursor:workspace:remote-1")).toMatchObject({
      environmentId: existing.id,
      environmentKind: "ssh",
      environmentLabel: "Development",
      storageEnvironmentId: "local",
    });
    expect(await store.getEnvironment(existing.id)).toMatchObject({ enabled: true });
    expect(environmentsChanged).toBe(0);
  });

  it("skips unchanged default session files before reading them", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-default-skip-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-skip", "original question", "Original Title");
      const cold = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      expect(cold).toMatchObject({ indexed: 1, skipped: 0, total: 1 });

      const previousStat = (await store.listIndexedSessionFiles())[0]!;
      fs.writeFileSync(filePath, "{not jsonl".padEnd(previousStat.fileSize, "x"));
      fs.utimesSync(filePath, previousStat.fileMtimeMs / 1000, previousStat.fileMtimeMs / 1000);
      const oldIndexTime = new Date(Math.max(0, previousStat.indexedAt - 1000));
      fs.utimesSync(path.join(homeDir, ".codex", "session_index.jsonl"), oldIndexTime, oldIndexTime);
      const getAllMessages = vi.spyOn(store, "getAllMessages");

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm).toMatchObject({ indexed: 0, skipped: 1, total: 1 });
      expect(getAllMessages).not.toHaveBeenCalled();
      expect(await store.searchSessions({ query: "original question", limit: 10 })).toHaveLength(1);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("indexes only the appended Codex tail after the first scan", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-codex-tail-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-tail", "original question", "Tail");
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      const originalSize = fs.statSync(filePath).size;
      fs.writeFileSync(filePath, `${"x".repeat(originalSize)}\n${JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T10:02:00Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "appended answer" }] },
      })}\n`);

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm.indexed).toBe(1);
      expect((await store.getAllMessages("codex:codex-tail")).map((message) => message.content)).toEqual([
        "original question",
        "appended answer",
      ]);
    } finally {
      await store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps a Cursor conversation as cache when its row disappears from the shared database", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-cursor-cache-"));
    const stateDbPath = path.join(homeDir, "Cursor", "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    db.exec(`
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        createdAt INTEGER,
        isSubagent INTEGER,
        value TEXT
      );
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
    `);
    db.prepare("INSERT INTO composerHeaders (composerId, createdAt, isSubagent, value) VALUES (?, ?, 0, ?)").run(
      "live",
      Date.parse("2026-07-27T10:00:00Z"),
      JSON.stringify({
        name: "Live Cursor session",
        workspaceIdentifier: { uri: { scheme: "file", fsPath: "/repo/live" } },
      }),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "bubbleId:live:user-1",
      JSON.stringify({
        bubbleId: "user-1",
        type: 1,
        text: "Live prompt",
        createdAt: "2026-07-27T10:00:00Z",
      }),
    );
    db.close();
    const stat = fs.statSync(stateDbPath);
    const cached = session(99);
    cached.session = {
      ...cached.session,
      sessionKey: "cursor:repo-stale:stale",
      rawId: "stale",
      source: "cursor-agent",
      filePath: stateDbPath,
      fileMtimeMs: stat.mtimeMs,
      fileSize: stat.size,
    };
    cached.messages = [{
      role: "user",
      content: "Only cached prompt",
      timestamp: "2026-07-26T10:00:00Z",
      index: 0,
    }];
    await store.upsertIndexedSession(cached.session, cached.messages);

    try {
      await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeCursorAgent: true,
          cursorStateDbPath: stateDbPath,
        },
      });

      await expect(store.getSession("cursor:repo-stale:stale")).resolves.toMatchObject({
        sourceAvailable: false,
        messageCount: 1,
      });
      await expect(store.findByRawId("live")).resolves.toMatchObject({
        sourceAvailable: true,
        messageCount: 1,
      });
      await expect(store.searchSessions({ query: "Only cached prompt", limit: 10 })).resolves.toHaveLength(1);
    } finally {
      await store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rekeys a cached Cursor conversation when the same composer moves to a new workspace key", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-cursor-rekey-"));
    const stateDbPath = path.join(homeDir, "Cursor", "User", "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    db.exec(`
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        createdAt INTEGER,
        isSubagent INTEGER,
        value TEXT
      );
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
    `);
    db.prepare("INSERT INTO composerHeaders (composerId, createdAt, isSubagent, value) VALUES (?, ?, 0, ?)").run(
      "same-composer",
      Date.parse("2026-07-29T10:00:00Z"),
      JSON.stringify({
        name: "Moved Cursor session",
        workspaceIdentifier: { uri: { scheme: "file", fsPath: "/repo/new" } },
      }),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "bubbleId:same-composer:user-1",
      JSON.stringify({
        bubbleId: "user-1",
        type: 1,
        text: "Current Cursor prompt",
        createdAt: "2026-07-29T10:00:00Z",
      }),
    );
    db.close();
    const stat = fs.statSync(stateDbPath);
    const cached = session(99);
    cached.session = {
      ...cached.session,
      sessionKey: "cursor:repo-old:same-composer",
      rawId: "same-composer",
      source: "cursor-agent",
      filePath: stateDbPath,
      fileMtimeMs: stat.mtimeMs,
      fileSize: stat.size,
    };
    cached.messages = [{
      role: "user",
      content: "Cached Cursor prompt",
      timestamp: "2026-07-28T10:00:00Z",
      index: 0,
    }];
    await store.upsertIndexedSession(cached.session, cached.messages);
    await store.upsertIndexedSession({
      ...cached.session,
      sessionKey: "cursor:repo-new:same-composer",
      projectPath: "/repo/new",
      originalTitle: "Moved Cursor session",
      firstQuestion: "Current Cursor prompt",
      timestamp: Date.parse("2026-07-29T10:00:00Z"),
    }, [{
      role: "user",
      content: "Current Cursor prompt",
      timestamp: "2026-07-29T10:00:00Z",
      index: 0,
    }]);
    await store.setCustomTitle(cached.session.sessionKey, "Remembered Cursor title");
    await store.setFavorited(cached.session.sessionKey, true);
    await store.addTag(cached.session.sessionKey, "cursor-work");

    try {
      await syncDefaultSessionsInBatches(store, {
        batchSize: 1,
        loadOptions: {
          homeDir,
          includeCursorAgent: true,
          cursorStateDbPath: stateDbPath,
        },
      });

      await expect(store.getSession("cursor:repo-old:same-composer")).resolves.toBeNull();
      await expect(store.getSession("cursor:repo-new:same-composer")).resolves.toMatchObject({
        rawId: "same-composer",
        sourceAvailable: true,
        displayTitle: "Remembered Cursor title",
        favorited: true,
        tags: ["cursor-work"],
        messageCount: 1,
      });
      await expect(store.searchSessions({ query: "Cached Cursor prompt", limit: 10 })).resolves.toHaveLength(0);
      await expect(store.searchSessions({ query: "Current Cursor prompt", limit: 10 })).resolves.toHaveLength(1);
    } finally {
      await store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("re-reads Codex sessions when the session index changes", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-index-"));
    try {
      writeCodexSession(homeDir, "codex-title-refresh", "title refresh question", "Old Title");
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      expect(await store.searchSessions({ query: "Old Title", limit: 10 })).toHaveLength(1);

      const indexPath = path.join(homeDir, ".codex", "session_index.jsonl");
      fs.writeFileSync(
        indexPath,
        `${JSON.stringify({ id: "codex-title-refresh", thread_name: "New Title", updated_at: "2026-06-01T10:05:00Z" })}\n`,
      );
      const futureIndexTime = new Date(Date.now() + 2000);
      fs.utimesSync(indexPath, futureIndexTime, futureIndexTime);

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm).toMatchObject({ indexed: 1, skipped: 0, total: 1 });
      expect(await store.searchSessions({ query: "New Title", limit: 10 })).toHaveLength(1);
      expect(await store.searchSessions({ query: "Old Title", limit: 10 })).toHaveLength(0);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rebuilds unchanged session content when a metadata dependency changes", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-content-refresh-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-content-refresh", "alphaoldx", "Stable Title");
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      expect(await store.searchSessions({ query: "alphaoldx", limit: 10 })).toHaveLength(1);

      const previousStat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, "utf8").replace("alphaoldx", "betanewxx");
      fs.writeFileSync(filePath, content);
      fs.utimesSync(filePath, previousStat.atime, previousStat.mtime);

      const indexPath = path.join(homeDir, ".codex", "session_index.jsonl");
      const futureIndexTime = new Date(Date.now() + 2000);
      fs.utimesSync(indexPath, futureIndexTime, futureIndexTime);

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm).toMatchObject({ indexed: 1, skipped: 0, total: 1 });
      expect(await store.searchSessions({ query: "betanewxx", limit: 10 })).toHaveLength(1);
      expect(await store.searchSessions({ query: "alphaoldx", limit: 10 })).toHaveLength(0);
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    { target: "claude", source: "claude-cli" },
    { target: "tclaude", source: "tclaude-cli" },
    { target: "codex", source: "codex-cli" },
    { target: "tcodex", source: "tcodex-cli" },
    { target: "codebuddy", source: "codebuddy-cli" },
    { target: "codewiz", source: "codewiz-cli" },
    { target: "cursor", source: "cursor-agent" },
  ] as const satisfies readonly { target: MigrationTarget; source: SessionSource }[])(
    "indexes one migrated $target session file as its concrete source without a full scan",
    async ({ target, source }) => {
      const store = createInMemoryStore();
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-recall-index-migration-${target}-`));
      try {
        const written = await writeMigratedSession({
          target,
          homeDir,
          now: new Date("2026-06-24T10:00:00.000Z"),
          session: portableSession(),
        });

        const status = await indexMigratedSessionFile(store, target, written.filePath, written.sessionId);

        expect(status).toMatchObject({ running: false, indexed: 1, total: 1, error: null });
        const indexed = await store.searchSessions({ source, limit: 10 });
        expect(indexed).toHaveLength(1);
        const sessionKey = indexed[0].sessionKey;
        expect(indexed[0]).toMatchObject({ source, sessionKey });
        expect(await store.searchSessions({ query: "migrated question", source, limit: 10 })).toMatchObject([
          { sessionKey },
        ]);
      } finally {
        await store.close();
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it("indexes the exact migrated CodeWiz session from a shared database", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-codewiz-exact-"));
    try {
      await writeMigratedSession({
        target: "codewiz",
        homeDir,
        now: new Date("2026-06-24T10:00:00.000Z"),
        session: { ...portableSession(), title: "Old CodeWiz session", messages: [{ role: "user", content: "old codewiz question", timestamp: "2026-06-24T09:00:00.000Z", index: 0 }] },
      });
      const written = await writeMigratedSession({
        target: "codewiz",
        homeDir,
        now: new Date("2026-06-24T10:01:00.000Z"),
        session: portableSession(),
      });

      const status = await indexMigratedSessionFile(store, "codewiz", written.filePath, written.sessionId);

      expect(status).toMatchObject({ running: false, indexed: 1, total: 1, error: null });
      expect(await store.searchSessions({ query: "migrated question", source: "codewiz-cli", limit: 10 })).toHaveLength(1);
      expect(await store.searchSessions({ query: "old codewiz question", source: "codewiz-cli", limit: 10 })).toHaveLength(0);
    } finally {
      await store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each(["claude", "codex", "codebuddy"] as const)(
    "reports a stable domain error when a migrated %s session file is missing",
    async (target) => {
      const store = createInMemoryStore();
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-recall-index-missing-${target}-`));
      const filePath = path.join(homeDir, "missing.jsonl");
      try {
        await expect(indexMigratedSessionFile(store, target, filePath)).rejects.toThrow(
          `Migrated ${target} session could not be loaded from ${filePath}.`,
        );
      } finally {
        await store.close();
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );
});

function writeCodexSession(homeDir: string, id: string, question: string, title: string): string {
  const codexDir = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexDir, "sessions", "2026", "06", "01");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    `${JSON.stringify({ id, thread_name: title, updated_at: "2026-06-01T10:00:00Z" })}\n`,
  );
  const filePath = path.join(sessionDir, `${id}.jsonl`);
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-01T10:00:00Z",
        payload: { id, cwd: "/repo", title: "Embedded Title" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T10:01:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: question }] },
      }),
    ].join("\n"),
  );
  return filePath;
}

function portableSession(): PortableSession {
  return {
    sourceSessionKey: "codex:source",
    sourceAgent: "codex",
    title: "Migrated session",
    projectPath: "/tmp/migrated-project",
    startedAt: "2026-06-24T09:00:00.000Z",
    messages: [
      { role: "user", content: "migrated question", timestamp: "2026-06-24T09:00:00.000Z", index: 0 },
      { role: "assistant", content: "migrated answer", timestamp: "2026-06-24T09:00:01.000Z", index: 1 },
    ],
  };
}
