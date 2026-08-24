import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CodexIncrementalState,
  IndexedSession,
  SessionMessage,
  SessionTraceEvent,
  TokenUsageEvent,
} from "../types";
import { PostgresDatabase } from "./database";
import { PostgresMetadataRepository } from "./metadata-repository";
import { PostgresSessionRepository } from "./session-repository";
import { PostgresSessionStatsRepository } from "./session-stats-repository";
import { PostgresSessionTurnRepository } from "./session-turn-repository";
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
    status: "failed",
  },
];

const tokens: TokenUsageEvent[] = [{
  timestamp: Date.parse("2026-07-20T08:00:04.000Z"),
  dedupeKey: "usage-a",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 40,
  cacheCreationInputTokens: 10,
  reasoningOutputTokens: 5,
  totalTokens: 175,
}];

describe("PostgresSessionRepository", () => {
  let database: PostgresDatabase;
  let repository: PostgresSessionRepository;
  let metadataRepository: PostgresMetadataRepository;
  let statsRepository: PostgresSessionStatsRepository;
  let turnsRepository: PostgresSessionTurnRepository;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    repository = new PostgresSessionRepository(database);
    metadataRepository = new PostgresMetadataRepository(database);
    statsRepository = new PostgresSessionStatsRepository(database);
    turnsRepository = new PostgresSessionTurnRepository(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("stores AI summary freshness for millisecond file timestamps", async () => {
    const fileMtimeMs = 1_786_512_474_899.402;
    const indexed = session({ fileMtimeMs });
    await repository.upsertIndexedSession(indexed, messages, tokens, traces);

    await expect(repository.setAiSummary(indexed.sessionKey, "Summary", "test-model")).resolves.toBe(true);

    const result = await database.query<{ ai_summary_basis: number | string }>(
      "select ai_summary_basis from agent_recall.sessions where session_key = $1",
      [indexed.sessionKey],
    );
    expect(Number(result.rows[0]?.ai_summary_basis)).toBe(fileMtimeMs);
  });

  it("preserves paginated Codex history when migrating to a new Session key", async () => {
    const legacyKey = "ssh:dev:codex:legacy-paginated";
    const targetKey = "ssh:dev:codex-cli:legacy-paginated";
    const toolCallState: NonNullable<CodexIncrementalState["toolCallState"]> = {
      observations: [{
        callId: "exec-parent#ast-0",
        parentCallId: "exec-parent",
        turnId: "legacy-turn-1",
        namespace: null,
        rawName: "exec_command",
        input: { cmd: "pwd" },
        cwd: "/repo",
        status: "unknown",
        evidence: "code-mode-ast",
        durationMs: null,
        timestamp: Date.parse("2026-07-30T08:00:00.000Z"),
      }],
      cwd: "/repo",
      declaredSessionFormat: "paginated",
      sawToolCompletion: false,
    };
    await repository.upsertIndexedSession(
      session({ sessionKey: legacyKey, rawId: "legacy-paginated" }),
      [{
        role: "assistant",
        content: "legacy answer",
        timestamp: "2026-07-30T08:00:01.000Z",
        index: 0,
        sourceTurnId: "legacy-turn-1",
        phase: "final_answer",
      }],
      [],
      [{
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn started",
        detail: "",
        timestamp: "2026-07-30T08:00:00.000Z",
        eventType: "codex.turn.started",
        status: "running",
        sourceTurnId: "legacy-turn-1",
      }],
      {
        historyMode: "paginated",
        messageProvenance: [{ messageIndex: 0, sourceRecordId: "response_item:legacy-answer" }],
        activeTurnIds: ["legacy-turn-1"],
        toolCallState,
      },
    );
    await metadataRepository.upsertSessionSyncBinding({
      localSessionKey: legacyKey,
      remoteSessionId: "remote-legacy-paginated",
      lastLocalRevision: "local-revision",
      lastRemoteRevision: "remote-revision",
      lastSyncedAt: 300,
      direction: "upload",
    });

    await expect(repository.migrateSessionKeyPreservingUserState(legacyKey, targetKey))
      .resolves.toBe(true);

    await expect(repository.getSession(legacyKey)).resolves.toBeNull();
    await expect(turnsRepository.getCodexIncrementalState(targetKey)).resolves.toEqual({
      historyMode: "paginated",
      messageProvenance: [{ messageIndex: 0, sourceRecordId: "response_item:legacy-answer" }],
      activeTurnIds: ["legacy-turn-1"],
      toolCallState,
    });
    await expect(metadataRepository.getSessionSyncBindingForLocalKey(legacyKey)).resolves.toBeNull();
    await expect(metadataRepository.getSessionSyncBindingForLocalKey(targetKey)).resolves.toMatchObject({
      remoteSessionId: "remote-legacy-paginated",
      lastLocalRevision: "local-revision",
      lastRemoteRevision: "remote-revision",
    });
  });

  it("fills a missing target Codex history mode while merging Session keys", async () => {
    const legacyKey = "ssh:dev:codex:shared-paginated";
    const targetKey = "ssh:dev:codex-cli:shared-paginated";
    await repository.upsertIndexedSession(
      session({ sessionKey: targetKey, rawId: "shared-paginated" }),
      messages,
    );
    await repository.upsertIndexedSession(
      session({ sessionKey: legacyKey, rawId: "shared-paginated" }),
      [],
      [],
      [],
      {
        historyMode: "paginated",
        messageProvenance: [],
        activeTurnIds: [],
      },
    );

    await expect(repository.migrateSessionKeyPreservingUserState(legacyKey, targetKey))
      .resolves.toBe(true);

    await expect(turnsRepository.getCodexIncrementalState(targetKey)).resolves.toMatchObject({
      historyMode: "paginated",
    });
  });

  it("round-trips Codex lifecycle Turns and private incremental state", async () => {
    const lifecycleMessages: SessionMessage[] = [
      {
        role: "assistant",
        content: "done",
        timestamp: "2026-07-30T08:00:01.000Z",
        index: 0,
        sourceTurnId: "turn-1",
        phase: "final_answer",
      },
      {
        role: "user",
        content: "keep working",
        timestamp: "2026-07-30T08:01:00.000Z",
        index: 1,
        sourceTurnId: "turn-2",
      },
    ];
    const lifecycleTraces: SessionTraceEvent[] = [
      {
        index: 0,
        kind: "event",
        source: "codex",
        title: "Turn started",
        detail: "",
        timestamp: "2026-07-30T08:00:00.000Z",
        eventType: "codex.turn.started",
        status: "running",
        sourceTurnId: "turn-1",
        attributes: { startedAt: "2026-07-30T08:00:00.000Z" },
      },
      {
        index: 1,
        kind: "event",
        source: "codex",
        title: "Agent message",
        detail: "continue the delegated task",
        timestamp: "2026-07-30T08:00:00.100Z",
        eventType: "codex.collaboration.message",
        status: "completed",
        sourceTurnId: "turn-1",
        attributes: {
          collaboration: {
            direction: "incoming",
            triggerTurn: true,
            messageType: "new_task",
          },
        },
      },
      {
        index: 2,
        kind: "event",
        source: "codex",
        title: "Turn completed",
        detail: "",
        timestamp: "2026-07-30T08:00:03.000Z",
        eventType: "codex.turn.completed",
        status: "completed",
        sourceTurnId: "turn-1",
        attributes: {
          endedAt: "2026-07-30T08:00:03.000Z",
          durationMs: 3_000,
          timeToFirstTokenMs: 200,
        },
      },
      {
        index: 3,
        kind: "event",
        source: "codex",
        title: "Turn started",
        detail: "",
        timestamp: "2026-07-30T08:01:00.000Z",
        eventType: "codex.turn.started",
        status: "running",
        sourceTurnId: "turn-2",
      },
    ];
    await repository.upsertIndexedSession(
      session({ sessionKey: "codex:lifecycle", rawId: "lifecycle" }),
      lifecycleMessages,
      [{
        timestamp: Date.parse("2026-07-30T08:00:02.000Z"),
        dedupeKey: "turn-1-usage",
        inputTokens: 10,
        outputTokens: 1,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 11,
        sourceTurnId: "turn-1",
      }],
      lifecycleTraces,
      {
        historyMode: "paginated",
        messageProvenance: [
          { messageIndex: 0, sourceRecordId: "response_item:answer-1" },
          { messageIndex: 1, sourceRecordId: "response_item:user-2" },
        ],
        activeTurnIds: ["turn-2"],
      },
    );

    const turns = await turnsRepository.listSessionTurns("codex:lifecycle");
    expect(turns).toMatchObject([
      {
        sourceTurnId: "turn-1",
        status: "completed",
        durationMs: 3_000,
        timeToFirstTokenMs: 200,
        spanCount: 0,
        agentTriggered: true,
        subagentExecutionStart: true,
      },
      {
        sourceTurnId: "turn-2",
        status: "running",
        spanCount: 0,
        agentTriggered: false,
        subagentExecutionStart: false,
      },
    ]);
    expect(await turnsRepository.getAllMessages("codex:lifecycle")).toMatchObject([
      {
        sourceTurnId: "turn-1",
        phase: "final_answer",
      },
      {
        sourceTurnId: "turn-2",
      },
    ]);
    expect(await turnsRepository.getTraceEvents("codex:lifecycle")).toMatchObject([
      { sourceTurnId: "turn-1", eventType: "codex.turn.started" },
      {
        sourceTurnId: "turn-1",
        eventType: "codex.collaboration.message",
        attributes: { collaboration: { triggerTurn: true, messageType: "new_task" } },
      },
      {
        sourceTurnId: "turn-1",
        eventType: "codex.turn.completed",
        attributes: { durationMs: 3_000 },
      },
      { sourceTurnId: "turn-2", eventType: "codex.turn.started" },
    ]);
    expect(await repository.getTokenEvents("codex:lifecycle")).toMatchObject([{
      dedupeKey: "turn-1-usage",
      sourceTurnId: "turn-1",
    }]);
    expect(await turnsRepository.getCodexIncrementalState("codex:lifecycle")).toEqual({
      historyMode: "paginated",
      messageProvenance: [
        { messageIndex: 0, sourceRecordId: "response_item:answer-1" },
        { messageIndex: 1, sourceRecordId: "response_item:user-2" },
      ],
      activeTurnIds: ["turn-2"],
    });
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
        cacheCreationInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 175,
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

  it("lists distinct tags in case-insensitive order", async () => {
    await repository.upsertIndexedSession(session({ gitBranch: null }), messages, tokens, traces);
    await repository.addTag("codex:session-a", "zebra");
    await repository.addTag("codex:session-a", "Alpha");

    await expect(repository.listTags()).resolves.toEqual(["Alpha", "zebra"]);
  });

  it("paginates messages and reconstructs the original trace events", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);

    await expect(turnsRepository.getMessages("codex:session-a", 1, 1)).resolves.toEqual([messages[1]]);
    await expect(turnsRepository.getTraceEvents("codex:session-a")).resolves.toEqual(traces);
    await expect(turnsRepository.getTraceEvents("codex:session-a", {
      startTimestamp: "2026-07-20T08:00:02.500Z",
    })).resolves.toEqual([traces[1]]);
  });

  it("normalizes legacy trace statuses when reading raw events", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);
    await database.query(`
      update agent_recall.session_raw_events
      set payload = payload || '{"status":"failure"}'::jsonb
      where session_key = 'codex:session-a'
        and kind = 'trace'
        and (payload->>'traceIndex')::integer = 1
    `);

    const stored = await turnsRepository.getTraceEvents("codex:session-a");
    expect(stored[1]?.status).toBe("failed");
  });

  it("replaces unsupported NUL characters while indexing a session", async () => {
    const messagesWithNul = messages.map((message, index) => (
      index === 1 ? { ...message, content: "The cache\u0000key is stale." } : message
    ));
    const tracesWithNul = traces.map((event, index) => (
      index === 1 ? {
        ...event,
        detail: "login\u0000test failed",
        attributes: {
          output: {
            text: "W\u0000s\u0000l",
            values: ["keep 中文 😀", "nested\u0000value"],
            "nul\u0000key": "key value",
          },
        },
      } : event
    ));

    await repository.upsertIndexedSession(session(), messagesWithNul, tokens, tracesWithNul);

    await expect(turnsRepository.getMessages("codex:session-a", 1, 1)).resolves.toEqual([
      { ...messagesWithNul[1], content: "The cache\u2400key is stale." },
    ]);
    await expect(turnsRepository.getTraceEvents("codex:session-a")).resolves.toEqual([
      tracesWithNul[0],
      {
        ...tracesWithNul[1],
        detail: "login\u2400test failed",
        attributes: {
          output: {
            text: "W\u2400s\u2400l",
            values: ["keep 中文 😀", "nested\u2400value"],
            "nul\u2400key": "key value",
          },
        },
      },
    ]);

    const spans = await database.query<{ output: unknown; attributes: unknown }>(`
      select output, attributes
      from agent_recall.trace_spans
      where turn_id in (
        select id from agent_recall.session_turns where session_key = 'codex:session-a'
      )
    `);
    expect(spans.rows).toEqual([
      expect.objectContaining({
        output: {
          text: "W\u2400s\u2400l",
          values: ["keep 中文 😀", "nested\u2400value"],
          "nul\u2400key": "key value",
        },
      }),
    ]);
  });

  it("lists lightweight Turn summaries in conversation order", async () => {
    const tracesWithRichEvent: SessionTraceEvent[] = [
      ...traces,
      {
        index: 2,
        kind: "event",
        source: "codex",
        title: "Plan",
        detail: "Retry after fixing the cache",
        timestamp: "2026-07-20T08:01:01.000Z",
        eventType: "codex.plan",
        status: "failed",
      },
    ];
    await repository.upsertIndexedSession(session(), messages, tokens, tracesWithRichEvent);

    const turns = await turnsRepository.listSessionTurns("codex:session-a");
    expect(turns).toMatchObject([
      {
        turnIndex: 0,
        sourceMessageIndex: 0,
        synthetic: false,
        status: "failed",
        userPreview: "Find the login failure",
        assistantPreview: "The cache key is stale.",
        totalTokens: 175,
        errorCount: 1,
        toolNames: ["shell"],
        messageCount: 2,
        spanCount: 1,
      },
      {
        turnIndex: 1,
        sourceMessageIndex: 2,
        synthetic: false,
        status: "completed",
        userPreview: "Fix the cache and retry",
        assistantPreview: "",
        totalTokens: 0,
        errorCount: 0,
        toolNames: [],
        messageCount: 1,
        spanCount: 0,
      },
    ]);
    await expect(turnsRepository.getSessionTurn("codex:session-a", turns[1].id)).resolves.toMatchObject({
      spanCount: 0,
      spans: [expect.objectContaining({ kind: "event", name: "Plan" })],
    });
  });

  it("loads one Turn trajectory and rejects a mismatched Session", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);
    const [turn] = await turnsRepository.listSessionTurns("codex:session-a");

    await expect(turnsRepository.getSessionTurn("codex:session-a", turn.id)).resolves.toMatchObject({
      id: turn.id,
      turnIndex: 0,
      messages: [
        {
          messageIndex: 0,
          sourceMessageIndex: 0,
          role: "user",
          content: "Find the login failure",
          timestamp: "2026-07-20T08:00:00.000Z",
        },
        {
          messageIndex: 1,
          sourceMessageIndex: 1,
          role: "assistant",
          content: "The cache key is stale.",
          timestamp: "2026-07-20T08:00:01.000Z",
        },
      ],
      spans: [
        {
          parentSpanId: null,
          spanIndex: 0,
          kind: "tool",
          name: "shell",
          status: "failed",
          startedAt: "2026-07-20T08:00:02.000Z",
          endedAt: "2026-07-20T08:00:03.000Z",
          callId: "call-1",
          input: { text: "{\"command\":\"npm test\"}" },
          output: { text: "login test failed" },
          error: "login test failed",
        },
      ],
    });
    await expect(turnsRepository.getSessionTurn("codex:another-session", turn.id)).resolves.toBeNull();
    await expect(turnsRepository.getSessionTurn("codex:session-a", "missing-turn")).resolves.toBeNull();
  });

  it("stores a child span when its parent falls in the next insert batch", async () => {
    const baseTime = Date.parse("2026-07-20T08:00:02.000Z");
    const batchBoundaryTraces: SessionTraceEvent[] = [
      ...Array.from({ length: 999 }, (_, index) => ({
        index,
        kind: "event" as const,
        source: "codex" as const,
        title: `Event ${index}`,
        detail: "",
        timestamp: new Date(baseTime + index).toISOString(),
        status: "completed" as const,
      })),
      {
        index: 999,
        kind: "tool_call",
        source: "codex" as const,
        title: "exec_command",
        detail: "{\"cmd\":\"npm test\"}",
        timestamp: new Date(baseTime + 999).toISOString(),
        callId: "child-call",
        status: "completed",
        attributes: {
          tool: {
            canonicalName: "exec_command",
            executionEvidence: "runtime-confirmed",
            parentCallId: "parent-call",
            parsedFromCodeMode: true,
          },
        },
      },
      {
        index: 1_000,
        kind: "tool_call",
        source: "codex" as const,
        title: "exec",
        detail: "await tools.exec_command(...)",
        timestamp: new Date(baseTime + 1_000).toISOString(),
        callId: "parent-call",
        status: "completed",
        attributes: {
          tool: {
            canonicalName: "exec",
            executionEvidence: "recorded-request",
          },
        },
      },
    ];

    await expect(repository.upsertIndexedSession(
      session(),
      [messages[0]],
      [],
      batchBoundaryTraces,
    )).resolves.toBeUndefined();

    const result = await database.query<{
      id: string;
      call_id: string;
      parent_span_id: string | null;
      span_index: number;
    }>(`
      select id, call_id, parent_span_id, span_index
      from agent_recall.trace_spans
      where call_id in ('child-call', 'parent-call')
      order by span_index
    `);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      call_id: "child-call",
      parent_span_id: result.rows[1].id,
      span_index: 999,
    });
    expect(result.rows[1]).toMatchObject({
      call_id: "parent-call",
      parent_span_id: null,
      span_index: 1_000,
    });
  });

  it("checks index freshness and lists indexed files without reading source files", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);

    await expect(repository.isIndexedSessionFresh(session())).resolves.toBe(true);
    await expect(repository.isIndexedSessionFresh(session({ fileSize: 101 }))).resolves.toBe(false);
    await expect(repository.listIndexedSessionFiles()).resolves.toEqual([{
      sessionKey: "codex:session-a",
      source: "codex-cli",
      filePath: "/fixtures/session-a.jsonl",
      fileMtimeMs: 200,
      fileSize: 100,
      contentIndexedMtimeMs: 200,
      contentIndexedSize: 100,
      turnDerivationCurrent: true,
      indexedAt: expect.any(Number),
    }]);
  });

  it("marks cached source data available again when the original Session reappears", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);
    await repository.setSessionSourceAvailable("codex:session-a", false);
    await expect(repository.getSession("codex:session-a")).resolves.toMatchObject({
      sourceAvailable: false,
    });

    await repository.touchIndexedAtIfMissing("codex:session-a");

    await expect(repository.getSession("codex:session-a")).resolves.toMatchObject({
      sourceAvailable: true,
    });
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

    const stats = await statsRepository.getStats(
      { period: "allTime" },
      Date.parse("2026-07-23T12:00:00.000Z"),
    );
    expect(stats.total).toEqual({
      sessionCount: 2,
      messageCount: messages.length + 2,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      cacheCreationInputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 175,
    });
    expect(stats.bySource).toEqual([
      expect.objectContaining({ source: "codex-app", sessionCount: 1, messageCount: 2 }),
      expect.objectContaining({ source: "codex-cli", sessionCount: 1, messageCount: messages.length }),
    ]);
    expect(stats.dailyTokenUsage).toHaveLength(7);
    expect(stats.dailyTokenUsage.reduce((sum, day) => sum + day.totalTokens, 0)).toBe(175);
  });

  it("compares the previous period and returns a trimmed Token trend", async () => {
    await repository.upsertIndexedSession(session(), messages, tokens, traces);

    const currentDay = Date.parse("2026-07-20T12:00:00.000Z");
    const currentStats = await statsRepository.getStats({ period: "today" }, currentDay);
    expect(currentStats.total.totalTokens).toBe(175);
    expect(currentStats.previousTotal?.totalTokens).toBe(0);

    const followingDay = Date.parse("2026-07-21T12:00:00.000Z");
    const followingStats = await statsRepository.getStats({ period: "today" }, followingDay);
    expect(followingStats.total.totalTokens).toBe(0);
    expect(followingStats.previousTotal?.totalTokens).toBe(175);
    expect((await statsRepository.getStats({ period: "allTime" }, followingDay)).previousTotal)
      .toBeNull();

    await expect(statsRepository.getStatsTrend({ period: "today" }, currentDay))
      .resolves.toMatchObject({
        period: "today",
        granularity: "day",
        buckets: [{ totalTokens: 175 }],
      });
  });
});
