import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  EnvironmentRepository,
  MetadataRepository,
  SessionFamilyFinder,
  SessionRepository,
  SessionSearchRepository,
  SessionStatsRepository,
  SessionTurnRepository,
} from "../storage/repositories";
import { SESSION_TRAJECTORY_PREVIEW_LENGTH } from "../storage/types";
import type {
  CodexIncrementalState,
  IndexedSession,
  SessionMessage,
  SessionTraceEvent,
  TokenUsageEvent,
} from "../types";
import { SqliteDatabase } from "./database";
import { SqliteEnvironmentRepository } from "./environment-repository";
import { SqliteMetadataRepository } from "./metadata-repository";
import { SqliteRuntimeInvocationRepository } from "./runtime-invocation-repository";
import { SQLITE_MIGRATIONS } from "./schema";
import { findSqliteSessionFamily } from "./session-family";
import { SqliteSessionRepository } from "./session-repository";
import { SqliteSessionSearchRepository } from "./session-search-repository";
import { SqliteSessionStatsRepository } from "./session-stats-repository";
import { SqliteSessionTurnRepository } from "./session-turn-repository";

interface SessionContractHarness {
  sessions: SessionRepository;
  turns: SessionTurnRepository;
  search: SessionSearchRepository;
  stats: SessionStatsRepository;
  metadata: MetadataRepository;
  environments: EnvironmentRepository;
  invocations: SqliteRuntimeInvocationRepository;
  findSessionFamily: SessionFamilyFinder;
  setSessionProjectPath(sessionKey: string, projectPath: string): Promise<void>;
  setSessionPinned(sessionKey: string, pinned: boolean): Promise<void>;
  getAiSummaryBasis(sessionKey: string): Promise<number>;
  countDerivedRows(): Promise<{ rawEvents: number; turns: number; messages: number; spans: number }>;
  setLegacyTraceStatusFailure(sessionKey: string, traceIndex: number): Promise<void>;
  clearFingerprints(): Promise<void>;
  countMissingFingerprints(): Promise<number>;
  getSpanParentSummary(): Promise<Array<{ id: string; callId: string | null; parentSpanId: string | null; spanIndex: number }>>;
  insertBulkNegativeCacheTokenEvents(sessionKey: string, nowMs: number): Promise<void>;
  assertFtsIntegrity(): Promise<void>;
  close(): Promise<void>;
}

async function createHarness(): Promise<SessionContractHarness> {
  const db = SqliteDatabase.open(":memory:", { migrations: SQLITE_MIGRATIONS });
  await db.initialize();
  return {
    sessions: new SqliteSessionRepository(db),
    turns: new SqliteSessionTurnRepository(db),
    search: new SqliteSessionSearchRepository(db),
    stats: new SqliteSessionStatsRepository(db),
    metadata: new SqliteMetadataRepository(db),
    environments: new SqliteEnvironmentRepository(db),
    invocations: new SqliteRuntimeInvocationRepository(db),
    findSessionFamily: (sessionKey) => findSqliteSessionFamily(db, sessionKey),
    async setSessionProjectPath(sessionKey, projectPath) {
      db.run(
        "update sessions set project_path = ? where session_key = ? and team_snapshot_key is null",
        projectPath,
        sessionKey,
      );
    },
    async setSessionPinned(sessionKey, pinned) {
      db.run(
        "update sessions set pinned = ? where session_key = ?",
        pinned ? 1 : 0,
        sessionKey,
      );
    },
    async getAiSummaryBasis(sessionKey) {
      const row = db.get<{ ai_summary_basis: number }>(
        "select ai_summary_basis from sessions where session_key = ?",
        sessionKey,
      );
      return Number(row?.ai_summary_basis);
    },
    async countDerivedRows() {
      const row = db.get<{
        raw_events: number;
        turns: number;
        messages: number;
        spans: number;
      }>(`
        select
          (select count(*) from session_raw_events) as raw_events,
          (select count(*) from session_turns) as turns,
          (select count(*) from turn_messages) as messages,
          (select count(*) from trace_spans) as spans
      `)!;
      return { rawEvents: row.raw_events, turns: row.turns, messages: row.messages, spans: row.spans };
    },
    async setLegacyTraceStatusFailure(sessionKey, traceIndex) {
      db.run(
        `
          update session_raw_events
          set payload = json_set(payload, '$.status', 'failure')
          where session_key = ?
            and kind = 'trace'
            and cast(json_extract(payload, '$.traceIndex') as integer) = ?
        `,
        sessionKey,
        traceIndex,
      );
    },
    async clearFingerprints() {
      db.run("update session_turns set index_fingerprint = null");
      db.run("update session_raw_events set index_fingerprint = null");
    },
    async countMissingFingerprints() {
      const row = db.get<{ missing: number }>(`
        select count(*) as missing from (
          select index_fingerprint from session_turns
          union all select index_fingerprint from session_raw_events
        ) where index_fingerprint is null
      `)!;
      return Number(row.missing);
    },
    async getSpanParentSummary() {
      const rows = db.all<{
        id: string;
        call_id: string | null;
        parent_span_id: string | null;
        span_index: number;
      }>(`
        select id, call_id, parent_span_id, span_index
        from trace_spans
        where call_id in ('child-call', 'parent-call')
        order by span_index
      `);
      return rows.map((row) => ({
        id: row.id,
        callId: row.call_id,
        parentSpanId: row.parent_span_id,
        spanIndex: Number(row.span_index),
      }));
    },
    async insertBulkNegativeCacheTokenEvents(sessionKey, nowMs) {
      await db.transaction(async (tx) => {
        for (let n = 1; n <= 300; n += 1) {
          tx.run(
            `
              insert into token_events
                (session_key, dedupe_key, occurred_at, input_tokens, output_tokens, total_tokens, cache_creation_input_tokens)
              values (?, ?, ?, 2, 3, 5, ?)
            `,
            sessionKey,
            `bulk-${n}`,
            nowMs - (n % 20) * 86_400_000,
            n % 2 === 0 ? -3 : 2,
          );
        }
      });
    },
    async assertFtsIntegrity() {
      db.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('integrity-check')");
      db.exec("INSERT INTO session_turns_fts(session_turns_fts) VALUES('integrity-check')");
    },
    async close() {
      await db.close();
    },
  };
}

function makeSession(overrides: Partial<IndexedSession> = {}): IndexedSession {
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

const baseMessages: SessionMessage[] = [
  { role: "user", content: "Find the login failure", timestamp: "2026-07-20T08:00:00.000Z", index: 0 },
  { role: "assistant", content: "The cache key is stale.", timestamp: "2026-07-20T08:00:01.000Z", index: 1 },
  { role: "user", content: "Fix the cache and retry", timestamp: "2026-07-20T08:01:00.000Z", index: 2 },
];

const baseTraces: SessionTraceEvent[] = [
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

const baseTokens: TokenUsageEvent[] = [{
  timestamp: Date.parse("2026-07-20T08:00:04.000Z"),
  dedupeKey: "usage-a",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 40,
  cacheCreationInputTokens: 10,
  reasoningOutputTokens: 5,
  totalTokens: 175,
}];

describe("SQLite core session/search/stats/family contract", () => {
  let h: SessionContractHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.assertFtsIntegrity();
    await h.close();
  });

  it("upserts sessions, preserves user state, refreshes fingerprints, and sanitizes NUL/surrogates", async () => {
    const fileMtimeMs = 1_786_512_474_899.402;
    await h.sessions.upsertIndexedSession(makeSession({ fileMtimeMs }), baseMessages, baseTokens, baseTraces);
    await expect(h.sessions.setAiSummary("codex:session-a", "Summary text", "test-model")).resolves.toBe(true);
    expect(await h.getAiSummaryBasis("codex:session-a")).toBe(fileMtimeMs);

    await h.sessions.setCustomTitle("codex:session-a", "My login investigation");
    await h.sessions.setFavorited("codex:session-a", true);
    await h.sessions.addTag("codex:session-a", "important");

    const changedMessages = [
      ...baseMessages,
      { role: "assistant" as const, content: "Fixed and verified.", timestamp: "2026-07-20T08:01:02.000Z", index: 3 },
    ];
    await h.sessions.upsertIndexedSession(
      makeSession({ fileMtimeMs: 300, fileSize: 120 }),
      changedMessages,
      baseTokens,
      baseTraces.slice(0, 1),
    );

    const stored = await h.sessions.getSession("codex:session-a");
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
    expect(await h.countDerivedRows()).toEqual({
      rawEvents: changedMessages.length + baseTokens.length + 1,
      turns: 2,
      messages: changedMessages.length,
      spans: 1,
    });

    await h.clearFingerprints();
    expect(await h.countMissingFingerprints()).toBeGreaterThan(0);
    await h.sessions.upsertIndexedSession(makeSession({ fileMtimeMs: 300, fileSize: 120 }), changedMessages, baseTokens, baseTraces.slice(0, 1));
    expect(await h.countMissingFingerprints()).toBe(0);

    // NUL bytes and unpaired surrogates
    const dirtyMessages = baseMessages.map((msg, i) =>
      i === 1 ? { ...msg, content: "The cache\u0000key has \uD83D and \uDCA5; emoji 😀 stays." } : msg);
    const dirtyTraces = baseTraces.map((event, i) =>
      i === 1 ? {
        ...event,
        detail: "login\u0000test \uD83D failed \uDCA5",
        attributes: {
          output: {
            text: "W\u0000s\u0000l\uD83D",
            values: ["keep 中文 😀", "nested\u0000value", "low \uDCA5"],
            "nul\u0000key\uD83D": "key value",
          },
        },
      } : event);
    await h.sessions.upsertIndexedSession(makeSession(), dirtyMessages, baseTokens, dirtyTraces);
    await expect(h.turns.getMessages("codex:session-a", 1, 1)).resolves.toEqual([{
      ...dirtyMessages[1],
      content: "The cache\u2400key has \uFFFD and \uFFFD; emoji 😀 stays.",
    }]);
    await expect(h.turns.getTraceEvents("codex:session-a")).resolves.toEqual([
      dirtyTraces[0],
      {
        ...dirtyTraces[1],
        detail: "login\u2400test \uFFFD failed \uFFFD",
        attributes: {
          output: {
            text: "W\u2400s\u2400l\uFFFD",
            values: ["keep 中文 😀", "nested\u2400value", "low \uFFFD"],
            "nul\u2400key\uFFFD": "key value",
          },
        },
      },
    ]);
  });

  it("handles Codex lifecycle turns, incremental tail append, trajectory previews, context, and child spans across batches", async () => {
    const lifecycleMessages: SessionMessage[] = [
      { role: "assistant", content: "done", timestamp: "2026-07-30T08:00:01.000Z", index: 0, sourceTurnId: "turn-1", phase: "final_answer" },
      { role: "user", content: "keep working", timestamp: "2026-07-30T08:01:00.000Z", index: 1, sourceTurnId: "turn-2" },
    ];
    const lifecycleTraces: SessionTraceEvent[] = [
      { index: 0, kind: "event", source: "codex", title: "Turn started", detail: "", timestamp: "2026-07-30T08:00:00.000Z", eventType: "codex.turn.started", status: "running", sourceTurnId: "turn-1", attributes: { startedAt: "2026-07-30T08:00:00.000Z" } },
      { index: 1, kind: "event", source: "codex", title: "Agent message", detail: "continue", timestamp: "2026-07-30T08:00:00.100Z", eventType: "codex.collaboration.message", status: "completed", sourceTurnId: "turn-1", attributes: { collaboration: { direction: "incoming", triggerTurn: true, messageType: "new_task" } } },
      { index: 2, kind: "event", source: "codex", title: "Turn completed", detail: "", timestamp: "2026-07-30T08:00:03.000Z", eventType: "codex.turn.completed", status: "completed", sourceTurnId: "turn-1", attributes: { endedAt: "2026-07-30T08:00:03.000Z", durationMs: 3_000, timeToFirstTokenMs: 200 } },
      { index: 3, kind: "event", source: "codex", title: "Turn started", detail: "", timestamp: "2026-07-30T08:01:00.000Z", eventType: "codex.turn.started", status: "running", sourceTurnId: "turn-2" },
    ];
    const toolCallState: NonNullable<CodexIncrementalState["toolCallState"]> = {
      observations: [{
        callId: "exec-parent#ast-0",
        parentCallId: "exec-parent",
        turnId: "turn-1",
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

    await h.sessions.upsertIndexedSession(
      makeSession({ sessionKey: "codex:lifecycle", rawId: "lifecycle" }),
      lifecycleMessages,
      [{ timestamp: Date.parse("2026-07-30T08:00:02.000Z"), dedupeKey: "turn-1-usage", inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 11, sourceTurnId: "turn-1" }],
      lifecycleTraces,
      {
        historyMode: "paginated",
        messageProvenance: [
          { messageIndex: 0, sourceRecordId: "response_item:answer-1" },
          { messageIndex: 1, sourceRecordId: "response_item:user-2" },
        ],
        activeTurnIds: ["turn-2"],
        toolCallState,
      },
    );

    const turns = await h.turns.listSessionTurns("codex:lifecycle");
    expect(turns).toMatchObject([
      { sourceTurnId: "turn-1", status: "completed", durationMs: 3_000, timeToFirstTokenMs: 200, spanCount: 0, agentTriggered: true, subagentExecutionStart: true },
      { sourceTurnId: "turn-2", status: "running", spanCount: 0, agentTriggered: false, subagentExecutionStart: false },
    ]);
    await expect(h.turns.getCodexIncrementalState("codex:lifecycle")).resolves.toEqual({
      historyMode: "paginated",
      messageProvenance: [
        { messageIndex: 0, sourceRecordId: "response_item:answer-1" },
        { messageIndex: 1, sourceRecordId: "response_item:user-2" },
      ],
      activeTurnIds: ["turn-2"],
      toolCallState,
    });

    // Trajectory previews + context + legacy trace status normalization + assistant text positions
    const longAnswer = `The cache key is stale. ${"x".repeat(2_000)}`;
    const laterCall: TokenUsageEvent = {
      timestamp: Date.parse("2026-07-20T08:01:02.000Z"),
      dedupeKey: "usage-b",
      inputTokens: 30,
      outputTokens: 8,
      cachedInputTokens: 150,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 188,
    };
    await h.sessions.upsertIndexedSession(
      makeSession(),
      baseMessages.map((msg, i) => (i === 1 ? { ...msg, content: longAnswer } : msg)),
      [...baseTokens, laterCall],
      baseTraces,
    );
    const trajectory = await h.turns.listSessionTrajectory("codex:session-a");
    expect(trajectory.map((t) => [t.turnIndex, t.messages.length, t.spans.length])).toEqual([[0, 2, 1], [1, 1, 0]]);
    expect(trajectory[0].messages[1].content).toHaveLength(SESSION_TRAJECTORY_PREVIEW_LENGTH);
    expect(trajectory[0].spans[0]).toMatchObject({
      name: "shell",
      status: "failed",
      callId: "call-1",
      input: { text: "{\"command\":\"npm test\"}" },
      output: { text: "login test failed" },
      error: "login test failed",
      attributes: { traceKind: "tool_call" },
    });
    expect(await h.turns.listSessionContext("codex:session-a")).toEqual([
      { turnId: trajectory[0].id, turnIndex: 0, occurredAt: "2026-07-20T08:00:04.000Z", inputTokens: 100, cachedInputTokens: 40, cacheCreationInputTokens: 10, outputTokens: 20 },
      { turnId: trajectory[1].id, turnIndex: 1, occurredAt: "2026-07-20T08:01:02.000Z", inputTokens: 30, cachedInputTokens: 150, cacheCreationInputTokens: 0, outputTokens: 8 },
    ]);
    await h.setLegacyTraceStatusFailure("codex:session-a", 1);
    expect((await h.turns.getTraceEvents("codex:session-a"))[1]?.status).toBe("failed");
    expect(await h.turns.getAssistantTextPositions("codex:session-a")).toEqual([
      { traceIndex: null, text: longAnswer },
    ]);

    // Legacy Codex tail append
    await h.sessions.upsertIndexedSession(
      makeSession({ sessionKey: "codex:tail", rawId: "tail", fileMtimeMs: 500, fileSize: 100 }),
      baseMessages,
      [],
      [],
      { historyMode: "legacy", activeTurnIds: [], messageProvenance: baseMessages.map((m) => ({ messageIndex: m.index, sourceRecordId: null })) },
    );
    const tail = await h.turns.getCodexMessageTail("codex:tail", 100);
    expect(tail).not.toBeNull();
    await h.sessions.appendIndexedMessages({
      session: makeSession({ sessionKey: "codex:tail", rawId: "tail", fileMtimeMs: 600, fileSize: 150 }),
      messages: [
        ...tail!.messages,
        { role: "assistant", content: "Appended answer", timestamp: "2026-07-20T08:01:05.000Z", index: 3 },
      ],
      tokenEvents: [],
      traceEvents: [],
      codexIncrementalState: tail!.codexIncrementalState,
      messageAppend: tail!.messageAppend,
    });
    expect(await h.turns.getMessageCount("codex:tail")).toBe(4);
    expect((await h.turns.getAllMessages("codex:tail")).at(-1)?.content).toBe("Appended answer");

    // Child span whose parent appears later
    const baseTime = Date.parse("2026-07-20T08:00:02.000Z");
    await h.sessions.upsertIndexedSession(
      makeSession({ sessionKey: "codex:spans", rawId: "spans" }),
      [baseMessages[0]],
      [],
      [
        {
          index: 0,
          kind: "tool_call",
          source: "codex",
          title: "exec_command",
          detail: "{\"cmd\":\"npm test\"}",
          timestamp: new Date(baseTime).toISOString(),
          callId: "child-call",
          status: "completed",
          attributes: { tool: { canonicalName: "exec_command", executionEvidence: "runtime-confirmed", parentCallId: "parent-call", parsedFromCodeMode: true } },
        },
        {
          index: 1,
          kind: "tool_call",
          source: "codex",
          title: "exec",
          detail: "await tools.exec_command(...)",
          timestamp: new Date(baseTime + 1).toISOString(),
          callId: "parent-call",
          status: "completed",
          attributes: { tool: { canonicalName: "exec", executionEvidence: "recorded-request" } },
        },
      ],
    );
    const spanRows = await h.getSpanParentSummary();
    expect(spanRows).toHaveLength(2);
    expect(spanRows[0]).toMatchObject({ callId: "child-call", parentSpanId: spanRows[1].id, spanIndex: 0 });
    expect(spanRows[1]).toMatchObject({ callId: "parent-call", parentSpanId: null, spanIndex: 1 });
  });

  it("migrates session keys preserving user state, merges NULL timestamps safely, and cascades deletion", async () => {
    const legacyKey = "ssh:dev:codex:legacy-key";
    const targetKey = "ssh:dev:codex-cli:legacy-key";
    await h.sessions.upsertIndexedSession(makeSession({ sessionKey: legacyKey, rawId: "legacy-key" }), baseMessages);
    await h.sessions.setCustomTitle(legacyKey, "Preserved Title");
    await h.sessions.setFavorited(legacyKey, true);
    await h.sessions.markOpened(legacyKey);
    await h.sessions.addTag(legacyKey, "legacy-tag");
    await h.metadata.upsertSessionSyncBinding({
      localSessionKey: legacyKey,
      remoteSessionId: "remote-1",
      lastLocalRevision: "l1",
      lastRemoteRevision: "r1",
      lastSyncedAt: 300,
      direction: "upload",
    });

    // Case 1: merge into existing target where target.last_opened_at is NULL
    await h.sessions.upsertIndexedSession(makeSession({ sessionKey: targetKey, rawId: "legacy-key" }), baseMessages);
    await expect(h.sessions.migrateSessionKeyPreservingUserState(legacyKey, targetKey)).resolves.toBe(true);
    const merged = await h.sessions.getSession(targetKey);
    expect(merged).toMatchObject({
      customTitle: "Preserved Title",
      favorited: true,
      tags: expect.arrayContaining(["legacy-tag"]),
    });
    expect(merged?.lastOpenedAt).not.toBeNull();
    expect(await h.sessions.getSession(legacyKey)).toBeNull();
    expect(await h.metadata.getSessionSyncBindingForLocalKey(targetKey)).toMatchObject({ remoteSessionId: "remote-1" });

    // Cascade deletion of subagent descendants + orphan tag cleanup
    await h.sessions.upsertIndexedSession(makeSession({ sessionKey: "codex:parent", rawId: "parent", gitBranch: null }), baseMessages);
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:child",
      rawId: "child",
      isSubagent: true,
      parentSessionId: "parent",
      gitBranch: null,
    }), []);
    await h.sessions.addTag("codex:parent", "only-on-parent");
    const targets = await h.sessions.getSessionDeletionTargets(["codex:parent"]);
    expect(targets.map((t) => t.sessionKey)).toEqual(["codex:parent", "codex:child"]);
    expect(await h.sessions.deleteSessionRecords(["codex:parent"])).toEqual(["codex:parent", "codex:child"]);
    expect(await h.sessions.listTags()).not.toContain("only-on-parent");
  });

  it("matches search queries across FTS5 trigram, 2-char CJK, cross-turn AND, metadata, runtime origins, sorting, and Windows paths", async () => {
    const msg = (role: SessionMessage["role"], content: string, timestamp: string, index: number): SessionMessage => ({
      role, content, timestamp, index,
    });
    const mk = (key: string, title: string, ts: string, overrides: Partial<IndexedSession> = {}) =>
      makeSession({
        sessionKey: key,
        rawId: key.split(":").at(-1)!,
        projectPath: "/projects/search",
        filePath: `/fixtures/${key.replace(":", "-")}.jsonl`,
        originalTitle: title,
        firstQuestion: title,
        timestamp: Date.parse(ts),
        fileMtimeMs: Date.parse(ts),
        gitBranch: null,
        ...overrides,
      });

    await h.sessions.upsertIndexedSession(mk("codex:one", "登录故障排查", "2026-07-20T08:00:00.000Z"), [
      msg("user", "登录缓存失败，帮我定位", "2026-07-20T08:00:00.000Z", 0),
      msg("assistant", "问题来自过期 cache key", "2026-07-20T08:00:01.000Z", 1),
      msg("user", "please retry timeout handling", "2026-07-20T08:01:00.000Z", 2),
      msg("assistant", "retry timeout is now covered", "2026-07-20T08:01:01.000Z", 3),
    ]);
    await h.sessions.upsertIndexedSession(mk("codex:two", "缓存性能", "2026-07-21T08:00:00.000Z", { source: "claude-cli" }), [
      msg("user", "缓存需要优化", "2026-07-21T08:00:00.000Z", 0),
      msg("assistant", "没有登录失败", "2026-07-21T08:00:01.000Z", 1),
    ]);
    await h.sessions.upsertIndexedSession(mk("codex:subagent", "Subagent retry", "2026-07-22T08:00:00.000Z", { isSubagent: true, parentSessionId: "one" }), [
      msg("user", "retry timeout", "2026-07-22T08:00:00.000Z", 0),
    ]);
    await h.sessions.upsertIndexedSession(
      mk("codex:roles", "消息角色过滤", "2026-07-23T08:00:00.000Z"),
      [
        msg("user", "中文关键词只应命中对话", "2026-07-23T08:00:00.000Z", 0),
        msg("assistant", "已经理解", "2026-07-23T08:00:01.000Z", 1),
      ],
      [],
      [{ index: 0, kind: "tool_result", source: "codex", title: "工具输出", detail: "中文关键词也出现在工具结果中", timestamp: "2026-07-23T08:00:02.000Z", callId: "call-cn", status: "completed" }],
    );

    // 1. Single term FTS5 trigram match + best turn + message hits
    const retryPage = await h.search.searchSessionPage({ query: "retry", excludeSubagents: true, limit: 10 });
    expect(retryPage.totalCount).toBe(1);
    expect(retryPage.sessions[0]).toMatchObject({
      sessionKey: "codex:one",
      turnMatchCount: 1,
      bestTurn: { turnIndex: 1, sourceMessageIndex: 2 },
    });
    expect(retryPage.sessions[0].matchHits?.[0]).toMatchObject({ turnIndex: 1, messageIndex: 2, role: "user" });

    // 2. 2-char CJK AND + cross-turn mixed CJK/English
    const sameTurn = await h.search.searchSessionPage({ query: "登录 AND 失败", excludeSubagents: true });
    expect(sameTurn.sessions.map((s) => s.sessionKey).sort()).toEqual(["codex:one", "codex:two"]);

    const crossTurn = await h.search.searchSessionPage({ query: "登录 timeout", excludeSubagents: true });
    expect(crossTurn.sessions.map((s) => s.sessionKey)).toEqual(["codex:one"]);
    expect(crossTurn.sessions[0]).toMatchObject({ turnMatchCount: 2, metadataMatch: null });
    expect(crossTurn.sessions[0].matchHits?.map((hit) => [hit.turnIndex, hit.messageIndex])).toEqual([[0, 0], [1, 2]]);

    // 3. Chinese 5-char trigram + tool exclusion
    const cnPage = await h.search.searchSessionPage({ query: "中文关键词", excludeSubagents: true });
    expect(cnPage.sessions.map((s) => s.sessionKey)).toEqual(["codex:roles"]);
    expect((await h.search.searchSessionPage({ query: "工具结果中", excludeSubagents: true })).sessions).toEqual([]);

    // 4. Metadata-only (title + ai_summary) returns zero partial message hits
    await h.sessions.setAiSummary("codex:two", "Quantum cache summary marker", "gpt-5");
    const summaryHit = await h.search.searchSessionPage({ query: "Quantum cache summary", excludeSubagents: true });
    expect(summaryHit.sessions.map((s) => s.sessionKey)).toEqual(["codex:two"]);
    expect(summaryHit.sessions[0]).toMatchObject({ metadataMatch: "summary", messageMatchCount: 0, matchHits: [] });

    // 5. Runtime invocations: originCounts, invocationSurfaceCounts, resolveRuntimeInvocationSession, channel conflict
    await h.invocations.begin({
      id: "inv-created",
      initiator: "agentrecall",
      invocation: { surface: "evaluation", role: "subject", ownerReference: { runId: "run-1", caseResultId: "case-1" } },
      runtimeId: "codex",
      channelId: "codex-default",
      environmentId: "local",
      startedAt: Date.parse("2026-07-20T08:00:00.000Z"),
    });
    await h.invocations.bind("inv-created", {
      runtimeId: "codex", channelId: "codex-default", environmentId: "local",
      sessionId: "one", turnId: "turn-1", relation: "created", boundAt: Date.parse("2026-07-20T08:00:01.000Z"),
    });
    await h.invocations.finish("inv-created", "completed", Date.parse("2026-07-20T08:00:02.000Z"));

    const ordinary = await h.search.searchSessionPage({ origin: "ordinary", excludeSubagents: true });
    expect(ordinary.originCounts).toEqual({ ordinary: 2, agentRecall: 1, all: 3 });
    expect(ordinary.invocationSurfaceCounts).toEqual({
      workflow: 0, evaluation: 1, team_chat: 0, agent: 0, skill: 0, system: 0, all: 1,
    });
    await expect(h.sessions.resolveRuntimeInvocationSession({ ownerReference: { runId: "run-1" } }))
      .resolves.toMatchObject({ status: "found", session: { sessionKey: "codex:one" } });

    // 6. StepCode family merging + Windows drive-letter normalization
    await h.sessions.upsertIndexedSession(mk("claude:shared-win", "Win", "2026-07-24T08:00:00.000Z", {
      rawId: "shared-win", source: "claude-cli", projectPath: "C:\\repo",
    }), [msg("user", "win cli", "2026-07-24T08:00:00.000Z", 0)]);
    await h.sessions.upsertIndexedSession(mk("claude-app:shared-win", "Win", "2026-07-24T08:01:00.000Z", {
      rawId: "shared-win", source: "claude-app", projectPath: "C:\\repo",
    }), [msg("user", "win app", "2026-07-24T08:01:00.000Z", 0)]);
    await h.setSessionProjectPath("claude-app:shared-win", "c:\\repo");

    const winQuery = await h.search.searchSessionPage({ projectPath: "c:\\repo" });
    expect(winQuery.sessions).toHaveLength(1);
    expect(winQuery.sessions[0]).toMatchObject({
      sessionKey: "claude-app:shared-win",
      projectPath: "C:\\repo",
      availableSources: ["claude-app", "claude-cli"],
    });

    // 7. Sort modes: smart vs activity vs created + favorite priority ignoring pinned
    const dayMs = 86_400_000;
    const olderTs = new Date(Date.now() - 90 * dayMs).toISOString();
    const recentTs = new Date(Date.now() - dayMs).toISOString();
    await h.sessions.upsertIndexedSession(mk("codex:sort-exact", "needle", olderTs, { projectPath: "/projects/sort" }), [
      msg("user", "needle", olderTs, 0),
    ]);
    await h.sessions.upsertIndexedSession(mk("codex:sort-recent", "Unrelated current work", recentTs, {
      projectPath: "/projects/sort", firstQuestion: "needle pipeline broke after merge",
    }), [msg("user", "a recent message also mentions needle", recentTs, 0)]);

    expect((await h.search.searchSessionPage({ projectPath: "/projects/sort", sortBy: "created" })).sessions.map((s) => s.sessionKey))
      .toEqual(["codex:sort-exact", "codex:sort-recent"]);
    expect((await h.search.searchSessionPage({ projectPath: "/projects/sort", query: "needle", sortBy: "activity" })).sessions.map((s) => s.sessionKey))
      .toEqual(["codex:sort-exact", "codex:sort-recent"]);
    expect((await h.search.searchSessionPage({ projectPath: "/projects/sort", query: "needle", sortBy: "smart" })).sessions.map((s) => s.sessionKey))
      .toEqual(["codex:sort-recent", "codex:sort-exact"]);

    await h.sessions.setFavorited("codex:sort-exact", true);
    await h.setSessionPinned("codex:sort-recent", true);
    expect((await h.search.searchSessionPage({ projectPath: "/projects/sort" })).sessions.map((s) => s.sessionKey))
      .toEqual(["codex:sort-exact", "codex:sort-recent"]);
  });

  it("computes stats deduplication, hidden-session rescue, negative cache clamping, DST boundaries, and trends identically", async () => {
    await h.sessions.upsertIndexedSession(makeSession(), baseMessages, baseTokens, baseTraces);
    await h.sessions.upsertIndexedSession(
      makeSession({ sessionKey: "codex:subagent-a", rawId: "subagent-a", filePath: "/fixtures/sub.jsonl", isSubagent: true }),
      baseMessages,
      [{ ...baseTokens[0], inputTokens: 900, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 900 }],
      baseTraces,
    );

    const visible = await h.stats.getStats({ period: "allTime", excludeSubagents: true }, Date.parse("2026-07-20T12:00:00.000Z"));
    expect(visible.total.totalTokens).toBe(175);
    expect(visible.dailyTokenUsage.reduce((sum, d) => sum + d.totalTokens, 0)).toBe(175);

    const every = await h.stats.getStats({ period: "allTime" }, Date.parse("2026-07-20T12:00:00.000Z"));
    expect(every.total.totalTokens).toBe(900);

    const followingDay = Date.parse("2026-07-21T12:00:00.000Z");
    const todayStats = await h.stats.getStats({ period: "today", excludeSubagents: true }, followingDay);
    expect(todayStats.total.totalTokens).toBe(0);
    expect(todayStats.previousTotal?.totalTokens).toBe(175);

    const trend = await h.stats.getStatsTrend({ period: "today", excludeSubagents: true }, Date.parse("2026-07-20T12:00:00.000Z"));
    expect(trend).toMatchObject({ period: "today", granularity: "day", buckets: [{ totalTokens: 175 }] });

    // Negative cache_creation_input_tokens clamped to 0 in daily aggregates
    await h.sessions.deleteSessionRecords(["codex:session-a", "codex:subagent-a"]);
    await h.sessions.upsertIndexedSession(makeSession(), []);
    const bulkNow = Date.parse("2026-09-28T12:00:00Z");
    await h.insertBulkNegativeCacheTokenEvents("codex:session-a", bulkNow);
    const bulkStats = await h.stats.getStats({ period: "allTime", dailyHistoryDays: 30 }, bulkNow);
    expect(bulkStats.dailyTokenUsage.reduce((sum, d) => sum + d.totalTokens, 0)).toBe(1500);
    expect(bulkStats.dailyTokenUsage.reduce((sum, d) => sum + (d.cacheCreationInputTokens ?? 0), 0)).toBe(300);
  });

  it("resolves session families, spawn turns, unmatched-turn fallbacks, and nested descendants identically", async () => {
    const msgs: SessionMessage[] = [
      { index: 0, role: "user", content: "first", timestamp: "2026-08-12T09:00:00.000Z", sourceTurnId: "turn-1" },
      { index: 1, role: "user", content: "delegate", timestamp: "2026-08-12T09:05:00.000Z", sourceTurnId: "turn-2" },
    ];
    const spawn = (childId: string, sourceTurnId = "turn-2"): SessionTraceEvent => ({
      index: 0,
      kind: "event",
      source: "codex",
      title: "agent · spawn_agent",
      detail: "",
      timestamp: "2026-08-12T09:05:01.000Z",
      eventType: "codex.collaboration.tool",
      status: "completed",
      sourceTurnId,
      attributes: {
        codex: { rawType: "CollabAgentToolCall" },
        collaboration: { tool: "spawn_agent", receiverThreadIds: [childId] },
      },
    });
    await h.sessions.upsertIndexedSession(makeSession({ sessionKey: "codex:root", rawId: "root" }), msgs, [], [
      spawn("child"),
      { ...spawn("fallback-child", "unmatched-turn"), index: 1 },
    ]);
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:child", rawId: "child", filePath: "/tmp/child.jsonl", isSubagent: true, parentSessionId: "root",
    }), msgs, [], [spawn("grandchild")]);
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:fallback-child", rawId: "fallback-child", filePath: "/tmp/fallback.jsonl", isSubagent: true, parentSessionId: "root",
    }), [], [], []);
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:grandchild", rawId: "grandchild", filePath: "/tmp/grandchild.jsonl", isSubagent: true, parentSessionId: "child",
    }), [], [], []);

    const rootFamily = await h.findSessionFamily("codex:root");
    expect(rootFamily.children.map((c) => c.sessionKey).sort()).toEqual(["codex:child", "codex:fallback-child"]);
    const childNode = rootFamily.children.find((c) => c.sessionKey === "codex:child")!;
    const fallbackNode = rootFamily.children.find((c) => c.sessionKey === "codex:fallback-child")!;
    expect(childNode.originTurnIndex).toBe(1);
    expect(fallbackNode.originTurnIndex).toBe(1);
    expect(childNode.children[0]).toMatchObject({ sessionKey: "codex:grandchild", originTurnIndex: 1 });
    expect((await h.findSessionFamily("codex:grandchild")).parentOriginTurnIndex).toBe(1);
  });

  it("matches projects, tags, freshness, metadata refresh, live status, channel collision, and DST boundaries", async () => {
    // Projects & tags: Windows drive unification vs POSIX case sensitivity
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:win-lower", rawId: "win-lower", projectPath: "c:\\repo", filePath: "c:\\repo\\s1.jsonl", fileMtimeMs: 200,
    }), baseMessages);
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:win-upper", rawId: "win-upper", projectPath: "C:\\repo", filePath: "C:\\repo\\s2.jsonl", fileMtimeMs: 300,
    }), baseMessages);
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:win-legacy", rawId: "win-legacy", projectPath: "C:\\repo", filePath: "c:\\repo\\legacy.jsonl", fileMtimeMs: 400,
    }), baseMessages);
    await h.setSessionProjectPath("codex:win-legacy", "c:\\repo");
    await h.sessions.addTag("codex:win-lower", "win-tag");
    await h.sessions.addTag("codex:win-legacy", "legacy-tag");
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:posix-upper", rawId: "posix-upper", projectPath: "/work/Repo", filePath: "/work/Repo/s1.jsonl", fileMtimeMs: 500,
    }), baseMessages);
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:posix-lower", rawId: "posix-lower", projectPath: "/work/repo", filePath: "/work/repo/s2.jsonl", fileMtimeMs: 600,
    }), baseMessages);

    const projects = await h.sessions.listProjects();
    expect(projects.find((p) => p.path === "C:\\repo")?.sessionCount).toBe(3);
    expect(projects.some((p) => p.path === "c:\\repo")).toBe(false);
    expect(projects.filter((p) => p.path === "/work/Repo" || p.path === "/work/repo").map((p) => p.path).sort())
      .toEqual(["/work/Repo", "/work/repo"]);
    await expect(h.sessions.listTags({ projectPath: "c:\\repo" })).resolves.toEqual([
      "branch:feature/search", "legacy-tag", "win-tag",
    ]);
    const tagsByProject = await h.sessions.listTagsByProject();
    expect(tagsByProject.find((entry) => entry.projectPath === "C:\\repo")?.tags)
      .toEqual(["branch:feature/search", "legacy-tag", "win-tag"]);

    // Freshness, source availability, metadata refresh, and CodeWiz summary exclusion
    await expect(h.sessions.isIndexedSessionFresh(makeSession({
      sessionKey: "codex:win-lower", rawId: "win-lower", projectPath: "c:\\repo", filePath: "c:\\repo\\s1.jsonl", fileMtimeMs: 200,
    }))).resolves.toBe(true);
    await expect(h.sessions.isSessionContentFresh("codex:win-lower", 200, 100)).resolves.toBe(true);
    await h.sessions.setSessionSourceAvailable("codex:win-lower", false);
    expect((await h.sessions.getSession("codex:win-lower"))?.sourceAvailable).toBe(false);
    await h.sessions.touchIndexedAtIfMissing("codex:win-lower");
    expect((await h.sessions.getSession("codex:win-lower"))?.sourceAvailable).toBe(true);
    await h.sessions.refreshSessionSourceMetadata([{
      filePath: "c:\\repo\\s1.jsonl",
      rawId: "win-lower",
      source: "codex-cli",
      originalTitle: "Refreshed title",
      timestamp: Date.parse("2026-07-21T00:00:00.000Z"),
    }]);
    expect((await h.sessions.getSession("codex:win-lower"))?.originalTitle).toBe("Refreshed title");

    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codewiz:skip", rawId: "skip", source: "codewiz-cli", fileMtimeMs: 950,
    }), baseMessages);
    const needingSummary = await h.sessions.listSessionsNeedingSummary(1_000, 1_000, 25);
    expect(needingSummary.some((s) => s.source === "codewiz-cli")).toBe(false);

    // 22 runtime invocations capped at 20 on list, full 22 on detail + channel collision refusal
    for (let i = 0; i < 22; i += 1) {
      const id = `inv-hist-${String(i).padStart(2, "0")}`;
      await h.invocations.begin({
        id, initiator: "agentrecall", invocation: { surface: "workflow", ownerReference: { runId: id } },
        runtimeId: "codex", environmentId: "local", startedAt: Date.parse("2026-07-20T08:00:00.000Z") + i,
      });
      await h.invocations.bind(id, {
        runtimeId: "codex", environmentId: "local", sessionId: "posix-upper",
        relation: i === 0 ? "created" : "continued", boundAt: Date.parse("2026-07-20T08:00:00.000Z") + i,
      });
      await h.invocations.finish(id, "completed", Date.parse("2026-07-20T08:01:00.000Z") + i);
    }
    const listPage = await h.search.searchSessionPage({ origin: "agentrecall" });
    expect(listPage.sessions.find((s) => s.sessionKey === "codex:posix-upper")?.runtimeInvocations).toHaveLength(20);
    expect((await h.sessions.getSession("codex:posix-upper"))?.runtimeInvocations).toHaveLength(22);

    // Channel collision refusal
    await h.invocations.begin({
      id: "inv-ch-a", initiator: "agentrecall", invocation: { surface: "workflow", ownerReference: { runId: "ch-a" } },
      runtimeId: "codex", channelId: "chan-a", environmentId: "local", startedAt: 100,
    });
    await h.invocations.bind("inv-ch-a", {
      runtimeId: "codex", channelId: "chan-a", environmentId: "local", sessionId: "posix-lower", relation: "created", boundAt: 101,
    });
    await h.invocations.begin({
      id: "inv-ch-b", initiator: "agentrecall", invocation: { surface: "workflow", ownerReference: { runId: "ch-b" } },
      runtimeId: "codex", channelId: "chan-b", environmentId: "local", startedAt: 102,
    });
    await h.invocations.bind("inv-ch-b", {
      runtimeId: "codex", channelId: "chan-b", environmentId: "local", sessionId: "posix-lower", relation: "created", boundAt: 103,
    });
    await expect(h.sessions.resolveRuntimeInvocationSession({ invocationId: "inv-ch-a" }))
      .resolves.toEqual({ status: "not_indexed", invocationId: "inv-ch-a" });

    // Live status open/closed + tag + pagination beyond end
    const now = Date.now();
    const staleAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    const recentAt = new Date(now - 60 * 60 * 1000).toISOString();
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:stale-live", rawId: "stale-live", projectPath: "/projects/live", timestamp: Date.parse(staleAt), fileMtimeMs: Date.parse(staleAt),
    }), [{ role: "user", content: "old", timestamp: staleAt, index: 0 }]);
    await h.sessions.upsertIndexedSession(makeSession({
      sessionKey: "codex:recent-live", rawId: "recent-live", projectPath: "/projects/live", timestamp: Date.parse(recentAt), fileMtimeMs: Date.parse(recentAt),
    }), [{ role: "user", content: "recent", timestamp: recentAt, index: 0 }]);
    const liveKeys = ["codex:stale-live", "codex:recent-live"];
    expect((await h.search.searchSessionPage({ projectPath: "/projects/live", liveStatus: "open", liveSessionKeys: liveKeys })).sessions.map((s) => s.sessionKey))
      .toEqual(["codex:recent-live"]);
    expect((await h.search.searchSessionPage({ projectPath: "/projects/live", liveStatus: "closed", liveSessionKeys: liveKeys })).sessions.map((s) => s.sessionKey))
      .toEqual(["codex:stale-live"]);
    const pastEnd = await h.search.searchSessionPage({ projectPath: "/projects/live", limit: 2, offset: 10 });
    expect(pastEnd).toMatchObject({ sessions: [], totalCount: 2, hasMore: false });

    // Clear search index & delete by source
    await h.sessions.clearSearchIndex();
    expect(await h.turns.getMessageCount("codex:win-lower")).toBe(0);
    await h.sessions.deleteSessionsBySource(["codewiz-cli"]);
    expect(await h.sessions.getSession("codewiz:skip")).toBeNull();
  });
});

describe("SQLite incremental indexing write avoidance", () => {
  it("retains unchanged raw events and completed Turns without rewriting them", async () => {
    const db = SqliteDatabase.open(":memory:", { migrations: SQLITE_MIGRATIONS });
    await db.initialize();
    const repo = new SqliteSessionRepository(db);
    try {
      await repo.upsertIndexedSession(makeSession(), baseMessages);
      const firstTurn = db.get<{ id: string }>("select id from session_turns order by turn_index limit 1")!.id;
      db.exec(`
        create temp table index_writes (table_name text, operation text, row_id text);
        create temp trigger capture_raw_ins after insert on session_raw_events begin
          insert into index_writes values ('session_raw_events', 'INSERT', cast(new.event_index as text));
        end;
        create temp trigger capture_raw_upd after update on session_raw_events begin
          insert into index_writes values ('session_raw_events', 'UPDATE', cast(new.event_index as text));
        end;
        create temp trigger capture_raw_del after delete on session_raw_events begin
          insert into index_writes values ('session_raw_events', 'DELETE', cast(old.event_index as text));
        end;
        create temp trigger capture_turn_ins after insert on session_turns begin
          insert into index_writes values ('session_turns', 'INSERT', new.id);
        end;
        create temp trigger capture_turn_upd after update on session_turns begin
          insert into index_writes values ('session_turns', 'UPDATE', new.id);
        end;
        create temp trigger capture_turn_del after delete on session_turns begin
          insert into index_writes values ('session_turns', 'DELETE', old.id);
        end;
      `);

      const appended: SessionMessage[] = [
        ...baseMessages,
        { role: "assistant", content: "Only the latest Turn changes.", timestamp: "2026-07-20T08:01:02.000Z", index: 3 },
      ];
      await repo.upsertIndexedSession(makeSession({ fileSize: 200 }), appended);
      expect(db.all("select operation from index_writes where table_name = 'session_raw_events'"))
        .toEqual([{ operation: "INSERT" }]);
      expect(db.all("select operation from index_writes where table_name = 'session_turns' and row_id = ?", firstTurn))
        .toEqual([]);

      db.exec("delete from index_writes");
      await repo.upsertIndexedSession(makeSession({ fileSize: 200 }), appended);
      expect(db.all("select * from index_writes")).toEqual([]);
      db.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('integrity-check')");
      db.exec("INSERT INTO session_turns_fts(session_turns_fts) VALUES('integrity-check')");
    } finally {
      await db.close();
    }
  });
});
