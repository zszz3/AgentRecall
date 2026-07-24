import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryStore } from "./postgres/test-session-store";
import type { IndexedSession, SessionMessage } from "./types";

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
