import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  IndexedSession,
  SessionMessage,
  SessionTraceEvent,
  TokenUsageEvent,
} from "../types";
import { PostgresDatabase } from "./database";
import { PostgresSessionRepository } from "./session-repository";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";

function session(overrides: Partial<IndexedSession> = {}): IndexedSession {
  return {
    sessionKey: "codex:session-a",
    rawId: "session-a",
    source: "codex-cli",
    projectPath: "/projects/agent-recall",
    filePath: "/fixtures/session-a.jsonl",
    originalTitle: "Fix flaky login",
    firstQuestion: "Why is login flaky?",
    timestamp: Date.parse("2026-07-20T08:00:00.000Z"),
    fileMtimeMs: 200,
    fileSize: 100,
    prUrl: null,
    prNumber: null,
    gitBranch: "feature/search",
    ...overrides,
  };
}

const messages: SessionMessage[] = [
  {
    role: "user",
    content: "Find the login failure",
    timestamp: "2026-07-20T08:00:00.000Z",
    index: 0,
  },
  {
    role: "assistant",
    content: "The cache key is stale.",
    timestamp: "2026-07-20T08:00:01.000Z",
    index: 1,
  },
  {
    role: "user",
    content: "Fix the cache and retry",
    timestamp: "2026-07-20T08:01:00.000Z",
    index: 2,
  },
];

const traces: SessionTraceEvent[] = [
  {
    index: 0,
    kind: "tool_call",
    source: "codex",
    title: "shell · npm test",
    detail: "{\"command\":\"npm test\"}",
    timestamp: "2026-07-20T08:00:02.000Z",
    callId: "call-1",
    status: "unknown",
  },
  {
    index: 1,
    kind: "tool_result",
    source: "codex",
    title: "tool output",
    detail: "login test failed",
    timestamp: "2026-07-20T08:00:03.000Z",
    callId: "call-1",
    status: "failure",
  },
];

const tokens: TokenUsageEvent[] = [{
  timestamp: Date.parse("2026-07-20T08:00:04.000Z"),
  dedupeKey: "usage-a",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 40,
  reasoningOutputTokens: 5,
  totalTokens: 165,
}];

describe("PostgresSessionRepository", () => {
  let database: PostgresDatabase;
  let repository: PostgresSessionRepository;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    repository = new PostgresSessionRepository(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("atomically replaces derived content while preserving user-owned state", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);
    await repository.setCustomTitle("codex:session-a", "My login investigation");
    await repository.setFavorited("codex:session-a", true);
    await repository.addTag("codex:session-a", "important");

    const changedMessages = [
      ...messages,
      {
        role: "assistant" as const,
        content: "Fixed and verified.",
        timestamp: "2026-07-20T08:01:02.000Z",
        index: 3,
      },
    ];
    await repository.upsertIndexedSession(
      session({ fileMtimeMs: 300, fileSize: 120 }),
      changedMessages,
      tokens,
      traces.slice(0, 1),
    );

    const stored = await repository.getSession("codex:session-a");
    expect(stored).toMatchObject({
      customTitle: "My login investigation",
      displayTitle: "My login investigation",
      favorited: true,
      messageCount: 4,
      tags: ["branch:feature/search", "important"],
      fileMtimeMs: 300,
      fileSize: 120,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        reasoningOutputTokens: 5,
        totalTokens: 165,
      },
    });

    const counts = await database.query<{
      raw_events: number;
      turns: number;
      messages: number;
      spans: number;
    }>(`
      select
        (select count(*)::int from agent_recall.session_raw_events) as raw_events,
        (select count(*)::int from agent_recall.session_turns) as turns,
        (select count(*)::int from agent_recall.turn_messages) as messages,
        (select count(*)::int from agent_recall.trace_spans) as spans
    `);
    expect(counts.rows[0]).toEqual({
      raw_events: changedMessages.length + tokens.length + 1,
      turns: 2,
      messages: changedMessages.length,
      spans: 1,
    });
  });

  it("paginates messages and reconstructs the original trace events", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);

    await expect(repository.getMessages("codex:session-a", 1, 1)).resolves.toEqual([messages[1]]);
    await expect(repository.getTraceEvents("codex:session-a")).resolves.toEqual(traces);
    await expect(repository.getTraceEvents("codex:session-a", {
      startTimestamp: "2026-07-20T08:00:02.500Z",
    })).resolves.toEqual([traces[1]]);
  });

  it("checks index freshness and lists indexed files without reading source files", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);

    await expect(repository.isIndexedSessionFresh(session())).resolves.toBe(true);
    await expect(repository.isIndexedSessionFresh(session({ fileSize: 101 }))).resolves.toBe(false);
    await expect(repository.listIndexedSessionFiles()).resolves.toEqual([{
      filePath: "/fixtures/session-a.jsonl",
      fileMtimeMs: 200,
      fileSize: 100,
      indexedAt: expect.any(Number),
    }]);
  });

  it("counts remote summary messages and deduplicates synchronized Token events", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);
    const remote = session({
      sessionKey: "codex:remote-a",
      rawId: "remote-a",
      source: "codex-app",
      environmentId: "remote",
      environmentKind: "ssh",
      environmentLabel: "Remote",
      filePath: "/remote/session-a.jsonl",
    });
    await repository.upsertIndexedSessionSummary(
      remote,
      2,
      tokens,
      [
        { index: 0, timestamp: Date.parse("2026-07-20T08:00:00.000Z") },
        { index: 1, timestamp: Date.parse("2026-07-20T08:00:01.000Z") },
      ],
    );

    const stats = await repository.getStats(
      { period: "allTime" },
      Date.parse("2026-07-23T12:00:00.000Z"),
    );
    expect(stats.total).toEqual({
      sessionCount: 2,
      messageCount: messages.length + 2,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      reasoningOutputTokens: 5,
      totalTokens: 165,
    });
    expect(stats.bySource).toEqual([
      expect.objectContaining({ source: "codex-app", sessionCount: 1, messageCount: 2 }),
      expect.objectContaining({ source: "codex-cli", sessionCount: 1, messageCount: messages.length }),
    ]);
    expect(stats.dailyTokenUsage).toHaveLength(7);
    expect(stats.dailyTokenUsage.reduce((sum, day) => sum + day.totalTokens, 0)).toBe(165);
  });
});
