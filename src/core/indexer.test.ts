import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { indexMigratedSessionFile, syncDefaultSessionsInBatches, syncLoadedSessionsInBatches } from "./indexer";
import { createInMemoryStore } from "./session-store";
import { writeMigratedSession } from "./session-migration-writers";
import type { IndexedSession, LoadedSession, MigrationTarget, PortableSession, SessionSource } from "./types";

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
    expect(store.searchSessions({ query: "Question", limit: 10 })).toHaveLength(3);
  });

  it("skips rebuilding unchanged sessions", async () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(session(1).session, [
      { role: "user", content: "original indexed question", timestamp: "2026-06-01T10:00:00Z", index: 0 },
    ]);

    const unchanged = session(1);
    unchanged.messages = [{ role: "user", content: "should not replace unchanged content", timestamp: "2026-06-01T10:00:00Z", index: 0 }];

    const status = await syncLoadedSessionsInBatches(store, [unchanged], { batchSize: 1 });

    expect(status).toMatchObject({ indexed: 0, skipped: 1, total: 1 });
    expect(store.searchSessions({ query: "original indexed question", limit: 10 })).toHaveLength(1);
    expect(store.searchSessions({ query: "should not replace unchanged content", limit: 10 })).toHaveLength(0);
  });

  it("skips unchanged default session files before reading them", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-search-default-skip-"));
    try {
      const filePath = writeCodexSession(homeDir, "codex-skip", "original question", "Original Title");
      const cold = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      expect(cold).toMatchObject({ indexed: 1, skipped: 0, total: 1 });

      const previousStat = store.listIndexedSessionFiles()[0];
      fs.writeFileSync(filePath, "{not jsonl".padEnd(previousStat.fileSize, "x"));
      fs.utimesSync(filePath, previousStat.fileMtimeMs / 1000, previousStat.fileMtimeMs / 1000);
      const oldIndexTime = new Date(Math.max(0, previousStat.indexedAt - 1000));
      fs.utimesSync(path.join(homeDir, ".codex", "session_index.jsonl"), oldIndexTime, oldIndexTime);

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm).toMatchObject({ indexed: 0, skipped: 1, total: 1 });
      expect(store.searchSessions({ query: "original question", limit: 10 })).toHaveLength(1);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("re-reads Codex sessions when the session index changes", async () => {
    const store = createInMemoryStore();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-search-codex-index-"));
    try {
      writeCodexSession(homeDir, "codex-title-refresh", "title refresh question", "Old Title");
      await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });
      expect(store.searchSessions({ query: "Old Title", limit: 10 })).toHaveLength(1);

      const indexPath = path.join(homeDir, ".codex", "session_index.jsonl");
      fs.writeFileSync(
        indexPath,
        `${JSON.stringify({ id: "codex-title-refresh", thread_name: "New Title", updated_at: "2026-06-01T10:05:00Z" })}\n`,
      );
      const futureIndexTime = new Date(Date.now() + 2000);
      fs.utimesSync(indexPath, futureIndexTime, futureIndexTime);

      const warm = await syncDefaultSessionsInBatches(store, { batchSize: 1, loadOptions: { homeDir } });

      expect(warm).toMatchObject({ indexed: 1, skipped: 0, total: 1 });
      expect(store.searchSessions({ query: "New Title", limit: 10 })).toHaveLength(1);
      expect(store.searchSessions({ query: "Old Title", limit: 10 })).toHaveLength(0);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    { target: "claude", source: "claude-cli" },
    { target: "tclaude", source: "tclaude-cli" },
    { target: "claude-internal", source: "claude-internal" },
    { target: "codex", source: "codex-cli" },
    { target: "tcodex", source: "tcodex-cli" },
    { target: "codex-internal", source: "codex-internal" },
    { target: "codebuddy", source: "codebuddy-cli" },
  ] as const satisfies readonly { target: MigrationTarget; source: SessionSource }[])(
    "indexes one migrated $target session file as its concrete source without a full scan",
    async ({ target, source }) => {
      const store = createInMemoryStore();
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-session-search-index-migration-${target}-`));
      try {
        const written = await writeMigratedSession({
          target,
          homeDir,
          now: new Date("2026-06-24T10:00:00.000Z"),
          session: portableSession(),
        });

        const status = indexMigratedSessionFile(store, target, written.filePath);

        expect(status).toMatchObject({ running: false, indexed: 1, total: 1, error: null });
        const indexed = store.searchSessions({ source, limit: 10 });
        expect(indexed).toHaveLength(1);
        expect(indexed[0]).toMatchObject({
          source,
          sessionKey: `${target}:${written.sessionId}`,
        });
        expect(store.searchSessions({ query: "migrated question", source, limit: 10 })).toMatchObject([
          { sessionKey: `${target}:${written.sessionId}` },
        ]);
      } finally {
        store.close();
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["claude", "codex", "codebuddy"] as const)(
    "reports a stable domain error when a migrated %s session file is missing",
    (target) => {
      const store = createInMemoryStore();
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-session-search-index-missing-${target}-`));
      const filePath = path.join(homeDir, "missing.jsonl");
      try {
        expect(() => indexMigratedSessionFile(store, target, filePath)).toThrow(
          `Migrated ${target} session could not be loaded from ${filePath}.`,
        );
      } finally {
        store.close();
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
