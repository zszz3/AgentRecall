import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SqliteEvaluationStore } from "../../automation/engine/main/sqlite-evaluation-store";
import type { EvaluationRun } from "../../automation/engine/shared/evaluation/types";
import type { TeamSessionContent } from "../../shared/team-sessions";
import type {
  EvaluationRepository,
  MemoryCardRepository,
  SessionRepository,
  SessionSearchRepository,
  SessionStatsRepository,
  SkillRepository,
  TeamSessionRepository,
} from "../storage/repositories";
import type { IndexedSession } from "../types";
import { SqliteDatabase } from "./database";
import { SqliteMemoryCardRepository } from "./memory-card-repository";
import { SQLITE_MIGRATIONS } from "./schema";
import { SqliteSessionRepository } from "./session-repository";
import { SqliteSessionSearchRepository } from "./session-search-repository";
import { SqliteSessionStatsRepository } from "./session-stats-repository";
import { SqliteSkillRepository } from "./skill-repository";
import { SqliteTeamSessionRepository } from "./team-session-repository";

interface DomainContractHarness {
  sessions: SessionRepository;
  search: SessionSearchRepository;
  stats: SessionStatsRepository;
  skills: SkillRepository;
  memoryCards: MemoryCardRepository;
  teamSessions: TeamSessionRepository;
  evaluation: EvaluationRepository;
  insertTurn(input: {
    id: string;
    sessionKey: string;
    turnIndex: number;
    startedAt: number;
    endedAt?: number | null;
    status?: string;
    userText?: string;
    assistantText?: string;
    toolText?: string;
    toolNames?: string[];
    totalTokens?: number;
    errorCount?: number;
  }): Promise<void>;
  insertToolSpan(input: {
    id: string;
    turnId: string;
    spanIndex: number;
    name: string;
    status: string;
    error?: string | null;
    attributes: Record<string, unknown>;
  }): Promise<void>;
  deleteSessionRaw(sessionKey: string): Promise<void>;
  countSessionsRaw(): Promise<number>;
  countTurnMessagesRaw(): Promise<number>;
  stripSnapshotRecordSource(cacheKey: string): Promise<void>;
  updateTurnTools(turnId: string, toolText: string, toolNames: string[]): Promise<void>;
  spyOnSessionUpsert(onCall: () => void): () => void;
  assertFtsIntegrity(): Promise<void>;
  close(): Promise<void>;
}

async function createHarness(): Promise<DomainContractHarness> {
  const db = SqliteDatabase.open(":memory:", { migrations: SQLITE_MIGRATIONS });
  await db.initialize();
  return {
    sessions: new SqliteSessionRepository(db),
    search: new SqliteSessionSearchRepository(db),
    stats: new SqliteSessionStatsRepository(db),
    skills: new SqliteSkillRepository(db),
    memoryCards: new SqliteMemoryCardRepository(db),
    teamSessions: new SqliteTeamSessionRepository(db),
    evaluation: new SqliteEvaluationStore(db),
    async insertTurn(input) {
      const userText = input.userText ?? `question ${input.turnIndex}`;
      const assistantText = input.assistantText ?? `answer ${input.turnIndex}`;
      db.run(
        `
          insert into session_turns (
            id, session_key, turn_index, status, started_at, ended_at,
            user_text, assistant_text, tool_text, search_text, tool_names,
            total_tokens, error_count, derivation_version
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 7)
        `,
        input.id,
        input.sessionKey,
        input.turnIndex,
        input.status ?? "completed",
        input.startedAt,
        input.endedAt !== undefined && input.endedAt !== null ? input.endedAt : null,
        userText,
        assistantText,
        input.toolText ?? "",
        `${userText} ${assistantText}`,
        JSON.stringify(input.toolNames ?? ["shell"]),
        input.totalTokens ?? 0,
        input.errorCount ?? 0,
      );
    },
    async insertToolSpan(input) {
      db.run(
        `
          insert into trace_spans (
            id, turn_id, span_index, kind, name, status, error, attributes
          ) values (?, ?, ?, 'tool', ?, ?, ?, ?)
        `,
        input.id,
        input.turnId,
        input.spanIndex,
        input.name,
        input.status,
        input.error ?? null,
        JSON.stringify(input.attributes),
      );
    },
    async deleteSessionRaw(sessionKey) {
      db.run("delete from sessions where session_key = ?", sessionKey);
    },
    async countSessionsRaw() {
      return Number(db.get<{ count: number }>("select count(*) as count from sessions")!.count);
    },
    async countTurnMessagesRaw() {
      return Number(db.get<{ count: number }>("select count(*) as count from turn_messages")!.count);
    },
    async stripSnapshotRecordSource(cacheKey) {
      const row = db.get<{ metadata: string }>(
        "select metadata from team_session_snapshots where cache_key = ?",
        cacheKey,
      )!;
      const parsed = JSON.parse(row.metadata) as { records: Array<Record<string, unknown>> };
      delete parsed.records[0].source;
      db.run(
        "update team_session_snapshots set metadata = ? where cache_key = ?",
        JSON.stringify(parsed),
        cacheKey,
      );
    },
    async updateTurnTools(turnId, toolText, toolNames) {
      db.run(
        "update session_turns set tool_text = ?, tool_names = ? where id = ?",
        toolText,
        JSON.stringify(toolNames),
        turnId,
      );
    },
    spyOnSessionUpsert(onCall) {
      const orig = SqliteSessionRepository.prototype.upsertIndexedSession;
      const spy = vi.spyOn(SqliteSessionRepository.prototype, "upsertIndexedSession").mockImplementation(async function (this: SqliteSessionRepository, ...args) {
        await orig.apply(this, args);
        onCall();
      });
      return () => spy.mockRestore();
    },
    async assertFtsIntegrity() {
      db.exec("INSERT INTO sessions_fts(sessions_fts) VALUES('integrity-check')");
      db.exec("INSERT INTO session_turns_fts(session_turns_fts) VALUES('integrity-check')");
      db.exec("INSERT INTO memory_cards_fts(memory_cards_fts) VALUES('integrity-check')");
    },
    async close() {
      await db.close();
    },
  };
}

function makeSession(sessionKey: string, overrides: Partial<IndexedSession> = {}): IndexedSession {
  return {
    sessionKey,
    rawId: sessionKey,
    source: "codex-cli",
    projectPath: "/repo",
    filePath: `/fixtures/${sessionKey}.jsonl`,
    originalTitle: `Title ${sessionKey}`,
    firstQuestion: "Question",
    timestamp: Date.parse("2026-11-01T00:00:00.000Z"),
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

function teamContent(count = 1): TeamSessionContent {
  return {
    bytes: 10,
    files: [],
    missingAttachments: [],
    children: [],
    root: {
      schemaVersion: 2,
      exportedAt: 1700000000000,
      session: { sessionKey: "codex:original", source: "codex-cli", originalTitle: "Fixture", displayTitle: "Fixture" },
      messages: Array.from({ length: count * 2 }, (_, index) => ({
        index,
        role: index % 2 ? "assistant" as const : "user" as const,
        content: index % 2 ? "answer".repeat(2000) : `Question ${index / 2}`,
        timestamp: new Date(1700000000000 + index * 1000).toISOString(),
      })),
      traceEvents: [],
    },
  };
}

describe("SQLite domain repositories contract", () => {
  let h: DomainContractHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.assertFtsIntegrity();
    await h.close();
  });

  it("SkillRepository: triggers, tool outcomes, live report overview/medians/versions, and sync bindings", async () => {
    const now = Date.now();
    await h.sessions.upsertIndexedSession(makeSession("local:claude:live", {
      rawId: "claude-live", source: "claude-cli", filePath: "/fixtures/claude-live.jsonl", originalTitle: "Fix login bug",
    }), []);
    await h.sessions.upsertIndexedSession(makeSession("local:codex:eval-tools", {
      rawId: "codex-eval-tools", filePath: "/fixtures/codex-rollout.jsonl", originalTitle: "Codex rollout",
    }), []);
    await h.insertTurn({ id: "live-turn-1", sessionKey: "local:claude:live", turnIndex: 7, startedAt: now - 60_000, endedAt: now + 60_000, totalTokens: 30_000, errorCount: 1 });
    await h.insertTurn({ id: "live-turn-2", sessionKey: "local:claude:live", turnIndex: 8, startedAt: now + 120_000, endedAt: now + 180_000, totalTokens: 1_000, errorCount: 0 });
    await h.insertTurn({ id: "eval-turn", sessionKey: "local:codex:eval-tools", turnIndex: 0, startedAt: 900, endedAt: 1_100 });
    await h.insertToolSpan({ id: "runtime-failed", turnId: "eval-turn", spanIndex: 0, name: "web", status: "failed", error: "timeout 504", attributes: { tool: { canonicalName: "web.run", executionEvidence: "runtime-confirmed" } } });
    await h.insertToolSpan({ id: "static-failed", turnId: "eval-turn", spanIndex: 1, name: "exec_command", status: "failed", attributes: { tool: { canonicalName: "exec_command", executionEvidence: "static-only" } } });
    await h.insertToolSpan({ id: "request-running", turnId: "eval-turn", spanIndex: 2, name: "skills.read", status: "running", attributes: { tool: { canonicalName: "skills.read", executionEvidence: "recorded-request" } } });
    await h.insertToolSpan({ id: "request-completed", turnId: "eval-turn", spanIndex: 3, name: "shell", status: "completed", attributes: { tool: { canonicalName: "exec_command", executionEvidence: "recorded-request" } } });
    await h.insertToolSpan({ id: "legacy-failed", turnId: "eval-turn", spanIndex: 4, name: "legacy_tool", status: "failed", error: "boom", attributes: {} });

    await expect(h.skills.hasClaudeHookUsageEvents()).resolves.toBe(false);

    await h.skills.upsertSkillUsageSource(
      { agent: "claude", kind: "claude-session", path: "/fixtures/claude-session.jsonl", mtimeMs: 1, fileSize: 1 },
      [
        { agent: "claude", skill: "review", timestamp: now, sessionId: "claude-live", skillHash: "hash-b" },
        { agent: "claude", skill: "review", timestamp: now - 10 * 86_400_000, skillHash: "hash-a" },
        { agent: "claude", skill: "review", timestamp: now - 40 * 86_400_000 },
      ],
    );
    await h.skills.upsertSkillUsageSource(
      { agent: "codex", kind: "codex-session", path: "/fixtures/codex-rollout.jsonl", mtimeMs: 1, fileSize: 1 },
      [
        { agent: "codex", skill: "review", timestamp: 1_000, sessionId: "codex-eval-tools" },
        { agent: "codex", skill: "other", timestamp: 2_000 },
      ],
    );
    await expect(h.skills.hasClaudeHookUsageEvents()).resolves.toBe(true);
    await expect(h.skills.isSkillUsageSourceFresh({ agent: "codex", kind: "codex-session", path: "/fixtures/codex-rollout.jsonl", mtimeMs: 1, fileSize: 1 })).resolves.toBe(true);

    const triggers = await h.skills.listRecentSkillTriggers({ skill: "Review" });
    expect(triggers).toHaveLength(4);
    expect(triggers[0]).toMatchObject({ agent: "claude", linkState: "linked-turn", sessionKey: "local:claude:live", sessionTitle: "Fix login bug", turnId: "live-turn-1" });
    expect(triggers[1]).toMatchObject({ agent: "claude", linkState: "unlinked", sessionKey: null, turnId: null });
    expect(triggers[3]).toMatchObject({ agent: "codex", linkState: "linked-turn", sessionKey: "local:codex:eval-tools", turnId: "eval-turn" });
    await expect(h.skills.listSkillTriggersForSession("local:codex:eval-tools")).resolves.toEqual(["other", "review"]);

    const overview = await h.skills.listSkillUsageOverview();
    const review = overview.find((row) => row.skill === "review");
    expect(review).toMatchObject({ agent: "claude", totalTriggers: 4, triggers7d: 1, triggers30d: 2, linkedTriggers: 2 });

    const signals = await h.skills.getSkillPerformanceSignals("Review");
    expect(signals.sampleSize).toBe(2);
    expect(signals.medianTotalTokens).toBe(15_000);
    expect(signals.baselineTurnCount).toBe(3);
    expect(signals.baselineMedianTotalTokens).toBe(1_000);

    const groups = await h.skills.listSkillVersionGroups("review");
    expect(groups.map((g) => g.skillHash)).toEqual(["hash-b", "hash-a", null]);

    await expect(h.skills.listSkillToolOutcomes("Review")).resolves.toEqual([
      { toolName: "legacy_tool", callCount: 1, failureCount: 1, sampleSpanIds: ["legacy-failed"], sampleErrors: ["boom"] },
      { toolName: "web.run", callCount: 1, failureCount: 1, sampleSpanIds: ["runtime-failed"], sampleErrors: ["timeout 504"] },
      { toolName: "exec_command", callCount: 1, failureCount: 0, sampleSpanIds: [], sampleErrors: [] },
    ]);

    // Sync bindings move cleanly on remoteSkillId / portableIdentity reassignment
    await h.skills.upsertSkillSyncBinding({
      localSkillPath: "/skills/old/SKILL.md", portableIdentity: "codex-user/review", remoteSkillId: "remote-1",
      remoteUpdatedAt: "2026-07-16T00:00:00.000Z", remoteVersion: 1, lastContentHash: "old", lastSyncedAt: 1, direction: "upload",
    });
    await h.skills.upsertSkillSyncBinding({
      localSkillPath: "/skills/new/SKILL.md", portableIdentity: "codex-user/review", remoteSkillId: "remote-1",
      remoteUpdatedAt: "2026-07-17T00:00:00.000Z", remoteVersion: 2, lastContentHash: "new", lastSyncedAt: 2, direction: "download",
    });
    await expect(h.skills.getSkillSyncBindingForLocalPath("/skills/old/SKILL.md")).resolves.toBeNull();
    await expect(h.skills.getSkillSyncBindingForPortableIdentity("codex-user/review")).resolves.toMatchObject({
      localSkillPath: "/skills/new/SKILL.md", remoteVersion: 2, direction: "download",
    });
    await h.skills.deleteSkillSyncBindingsForRemoteIds(["remote-1"]);
    await expect(h.skills.listSkillSyncBindings()).resolves.toEqual([]);

    await h.skills.pruneSkillUsageSources([]);
    await expect(h.skills.getSkillUsageSnapshot()).resolves.toMatchObject({ exists: false, totalEvents: 0 });
  });

  it("MemoryCardRepository: CRUD, supersede, rollback, orphan trigger, FTS5/CJK search, scheduling & backoff", async () => {
    const ENABLED_AT = "2026-11-01T00:00:00.000Z";
    const NOW = "2026-11-10T12:00:00.000Z";
    await h.sessions.upsertIndexedSession(makeSession("s1"), []);
    await h.sessions.upsertIndexedSession(makeSession("s2"), []);
    await h.sessions.upsertIndexedSession(makeSession("other", { projectPath: "/other" }), []);

    const [id] = await h.memoryCards.applyExtraction({
      sessionKey: "s1", projectPath: "/repo", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: [], model: "test", now: NOW,
      inputTokens: 120, outputTokens: 30,
      operations: [{ op: "create", ref: "a", kind: "experience", problem: "git push denied 索引刷新后搜索结果为空", solution: "first fix", failedAttempts: ["retry blindly"], keywords: ["git", "ssh"] }],
    });
    await h.insertTurn({ id: "s2:4", sessionKey: "s2", turnIndex: 4, startedAt: Date.parse("2026-11-12T08:00:00.000Z") });
    await h.memoryCards.applyExtraction({
      sessionKey: "s2", projectPath: "/repo", firstTurnIndex: 3, lastTurnIndex: 4, candidateIds: [id], model: "m", now: "2026-11-12T09:00:00.000Z",
      operations: [{ op: "update", id, solution: "use https", failedAttempts: ["retry blindly", "reset keys"], keywords: ["SSH", "https"] }],
    });

    const [updated] = await h.memoryCards.listCards({ includeSuperseded: false });
    expect(updated).toMatchObject({
      solution: "use https",
      previousSolution: "first fix",
      failedAttempts: ["retry blindly", "reset keys"],
      keywords: ["git", "ssh", "https"],
    });
    expect(updated.sources).toEqual([
      { sessionKey: "s1", firstTurnIndex: 0, lastTurnIndex: 0, lastTurnAt: NOW },
      { sessionKey: "s2", firstTurnIndex: 3, lastTurnIndex: 4, lastTurnAt: "2026-11-12T08:00:00.000Z" },
    ]);

    // Chinese FTS5 substring search + ≥half-term active search + project-scoped findSimilarCards
    expect((await h.memoryCards.searchActiveCards({ query: "搜索结果" })).map((c) => c.id)).toEqual([id]);
    expect((await h.memoryCards.searchActiveCards({ query: "git https missing" })).map((c) => c.id)).toEqual([id]);
    expect((await h.memoryCards.findSimilarCards("/repo", ["https", "unrelated"], 10)).map((c) => c.id)).toEqual([id]);
    expect(await h.memoryCards.findSimilarCards("/other", ["https"], 10)).toEqual([]);

    // Supersede hides old card from active search
    const [replacement] = await h.memoryCards.applyExtraction({
      sessionKey: "s1", projectPath: "/repo", firstTurnIndex: 1, lastTurnIndex: 1, candidateIds: [id], model: "m", now: NOW,
      operations: [
        { op: "create", ref: "next", kind: "decision", problem: "git push replacement", solution: "token auth", failedAttempts: [], keywords: ["git"] },
        { op: "supersede", id, replacedBy: "next" },
      ],
    });
    expect((await h.memoryCards.searchActiveCards({ query: "git" })).map((c) => c.id)).toEqual([replacement]);
    expect((await h.memoryCards.listCards({ includeSuperseded: true })).find((c) => c.id === id)).toMatchObject({
      status: "superseded", supersededBy: replacement,
    });

    // Rollback on missing candidate
    await expect(h.memoryCards.applyExtraction({
      sessionKey: "other", projectPath: "/other", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: ["missing"], model: "m", now: NOW,
      operations: [
        { op: "create", ref: "x", kind: "experience", problem: "p", solution: "s", failedAttempts: [], keywords: [] },
        { op: "update", id: "missing", failedAttempts: [], keywords: [] },
      ],
    })).rejects.toThrow(/missing/);
    expect(await h.memoryCards.extractionState("other")).toBeNull();

    // Orphan trigger deletes card only after last source session is deleted
    await h.deleteSessionRaw("s1");
    expect((await h.memoryCards.listCards({ includeSuperseded: true })).find((c) => c.id === id)?.sources.map((s) => s.sessionKey)).toEqual(["s2"]);
    expect((await h.memoryCards.listCards({ includeSuperseded: true })).find((c) => c.id === replacement)).toBeUndefined();
    await h.deleteSessionRaw("s2");
    expect(await h.memoryCards.listCards({ includeSuperseded: true })).toEqual([]);

    // Scheduling: wait one unchanged pass + failure exponential backoff + manual retry
    await h.sessions.upsertIndexedSession(makeSession("sched-1"), []);
    await h.insertTurn({ id: "sched-1:0", sessionKey: "sched-1", turnIndex: 0, startedAt: Date.parse("2026-11-05T00:00:00.000Z") });
    expect(await h.memoryCards.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual([]);
    expect(await h.memoryCards.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual(["sched-1"]);
    const loaded = await h.memoryCards.loadExtractionInput("sched-1", ENABLED_AT);
    expect(loaded).toMatchObject({ sessionKey: "sched-1", projectPath: "/repo", title: "Title sched-1" });
    expect(loaded!.turns).toHaveLength(1);

    await h.memoryCards.recordExtractionFailure("sched-1", "offline", NOW, { maxAttempts: 2, baseDelayMs: 60_000 });
    expect(await h.memoryCards.extractionState("sched-1")).toMatchObject({
      status: "failed", attempts: 1, nextRetryAt: "2026-11-10T12:01:00.000Z", lastError: "offline",
    });
    expect(await h.memoryCards.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual([]);
    expect(await h.memoryCards.pickExtractionSessions({ enabledAt: ENABLED_AT, now: "2026-11-10T12:02:00.000Z", limit: 3 })).toEqual(["sched-1"]);
    await h.memoryCards.recordExtractionFailure("sched-1", "offline", "2026-11-10T12:02:00.000Z", { maxAttempts: 2, baseDelayMs: 60_000 });
    expect(await h.memoryCards.extractionState("sched-1")).toMatchObject({ status: "failed", attempts: 2, nextRetryAt: null });
    expect(await h.memoryCards.pickExtractionSessions({ enabledAt: ENABLED_AT, now: "2026-12-01T00:00:00.000Z", limit: 3 })).toEqual([]);
    expect(await h.memoryCards.retryFailedExtractions(NOW)).toBe(1);
    expect(await h.memoryCards.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual(["sched-1"]);
    const overview = await h.memoryCards.extractionOverview("2026-11-10T00:00:00.000Z");
    expect(overview.failures).toEqual([]);
  });

  it("TeamSessionRepository: import, isolation, abort rollback, excerpts, catalog search, and drafts", async () => {
    const origin = { repository: "https://github.com/example/assets", assetId: 17, digest: "a".repeat(64) };
    const snapshot = await h.teamSessions.import("share-a", teamContent(105), new AbortController().signal, origin);
    expect(snapshot.records[0]).toMatchObject({ turnCount: 105, source: "codex-cli" });
    expect((await h.teamSessions.sources(["share-a", "absent"])).get("share-a")).toBe("codex-cli");
    expect(await h.countTurnMessagesRaw()).toBe(210);

    // Isolated from local search, stats, clearSearchIndex, deleteSessionsBySource
    expect(await h.search.searchSessions()).toEqual([]);
    expect((await h.stats.getStats()).total.sessionCount).toBe(0);
    expect(await h.sessions.getSession("team:share-a:0")).toBeNull();
    await h.sessions.clearSearchIndex();
    await h.sessions.deleteSessionsBySource(["codex-cli"]);
    expect((await h.teamSessions.turns("share-a", 0, 0)).turns).toHaveLength(50);
    expect((await h.teamSessions.turns("share-a", 0, 100)).turns).toHaveLength(5);

    // Strip snapshot source fallback
    await h.stripSnapshotRecordSource("share-a");
    expect((await h.teamSessions.get("share-a"))?.records[0].source).toBe("codex-cli");

    // Catalog search beyond first page + literal % escape + tool opt-in
    const item = { id: 17, digest: origin.digest, title: "共享修复", author: "member", createdAt: "2026-09-30", bytes: 10, canWithdraw: false, source: "codex-cli" };
    await h.teamSessions.replaceCatalog("team-a", [{ item, key: "share-a" }], new AbortController().signal);
    const hit = await h.teamSessions.list("team-a", 1, "Question 104", "turns");
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0].match).toMatchObject({ record: 0, turnIndex: 104, offset: 100 });
    expect(hit.items[0].match?.snippet).toContain("Question 104");
    expect((await h.teamSessions.list("team-a", 1, "%", "turns")).items).toEqual([]);
    const firstTurn = (await h.teamSessions.turns("share-a", 0, 0)).turns[0];
    await h.updateTurnTools(firstTurn.id, "secret-output-marker", ["rg"]);
    expect((await h.teamSessions.list("team-a", 1, "secret-output-marker", "turns")).items).toEqual([]);
    expect((await h.teamSessions.list("team-a", 1, "secret-output-marker", "turns", true)).items).toHaveLength(1);
    expect((await h.teamSessions.list("team-a", 1, "rg", "turns")).items).toHaveLength(1);

    // Drafts (Buffer round-trip) + receipt + catalog cleanup on publish
    const packet = Buffer.from([1, 2, 3, 4]);
    const draftItem = { id: -1, digest: "d".repeat(64), title: "Draft share", author: "me", createdAt: "2026-10-01", bytes: 4, canWithdraw: true };
    await h.teamSessions.import("draft-1", teamContent(1), new AbortController().signal, { ...origin, assetId: -1, digest: draftItem.digest }, {
      scope: "team-draft", item: draftItem, packet,
    });
    expect(await h.teamSessions.drafts("team-draft")).toEqual([draftItem]);
    const storedDraft = await h.teamSessions.draft("team-draft", -1);
    expect(storedDraft).not.toBeNull();
    expect(Buffer.from(storedDraft!.packet).equals(packet)).toBe(true);
    const published = { ...draftItem, id: 99 };
    await h.teamSessions.receipt("team-draft", -1, draftItem.digest, published);
    expect(await h.teamSessions.drafts("team-draft")).toEqual([]);
    await h.teamSessions.replaceCatalog("team-draft", [{ item: published, key: "draft-1" }], new AbortController().signal);
    expect(await h.teamSessions.draft("team-draft", -1)).toBeNull();

    // Mid-import abort rollback
    const countBefore = await h.countSessionsRaw();
    const duringImport = new AbortController();
    const restore = h.spyOnSessionUpsert(() => duringImport.abort());
    try {
      await expect(h.teamSessions.import("interrupted", teamContent(1), duringImport.signal, origin)).rejects.toThrow();
      expect(await h.teamSessions.get("interrupted")).toBeNull();
      expect(await h.countSessionsRaw()).toBe(countBefore);
    } finally {
      restore();
    }
  });

  it("EvaluationStore: datasets, evaluators, experiments, graph runs, skill attribution, and trajectory results", async () => {
    const now = Date.now();
    await h.evaluation.saveDataset({
      id: "ds-1", name: "cases", description: "desc", createdAt: now, updatedAt: now,
      items: [{ id: "item-1", input: "q", expectedOutput: "4", metadata: { tag: "math" }, sequence: 0 }],
    });
    expect((await h.evaluation.listDatasets())[0].items).toEqual([
      { id: "item-1", input: "q", expectedOutput: "4", metadata: { tag: "math" }, sequence: 0 },
    ]);

    await h.evaluation.saveEvaluator({
      id: "eval-1", name: "script judge", kind: "script", threshold: 0.7, enabled: true,
      dimension: "简洁性", priority: "should", scriptMode: "command", command: "/usr/bin/python3",
      commandArgs: ["judge.py", "--strict"], subject: "trajectory", timeoutMs: 4_000, maxToolFailures: 3,
      createdAt: now, updatedAt: now,
    });
    expect((await h.evaluation.listEvaluators())[0]).toMatchObject({
      id: "eval-1", enabled: true, commandArgs: ["judge.py", "--strict"], maxToolFailures: 3,
    });

    await h.evaluation.saveExperiment({
      id: "exp-1", name: "graph exp", datasetId: "ds-1", agentId: "agent-1", evaluatorIds: ["eval-1"], repetitions: 2,
      skillName: "review", skillHash: "hash-a", source: "session",
      scoring: { weightByLabels: { dimension: { 正确性: 4 } }, resolvedThreshold: 0.8, minCoverage: 0.5, uncertain: "zero" },
      graph: { version: 1, spec: { name: "authored", version: 1, nodes: [{ id: "task", type: "task_source", config: {} }] }, layout: { task: { x: 1, y: 2 } } },
      createdAt: now, updatedAt: now,
    });
    expect((await h.evaluation.listExperiments())[0]).toMatchObject({
      id: "exp-1", evaluatorIds: ["eval-1"], skillName: "review", skillHash: "hash-a", source: "session",
    });

    const graphRun: EvaluationRun = {
      id: "run-1", experimentId: "exp-1", status: "running", skillHash: "hash-a", engine: "graph",
      startedAt: 100, scoredCaseCount: 1, unscoredCaseCount: 0, coverage: 0.8,
      dimensions: [{ dimension: "正确性", score: 0.75, weight: 4, scoredCaseCount: 1 }],
      results: [{
        id: "run-1:item-1:1", runId: "run-1", datasetItemId: "item-1", repetition: 1,
        input: "q", expectedOutput: "4", output: "4", durationMs: 20, gatePassed: false, score: 0.9, passed: true, coverage: 0.5,
        dimensions: [{ dimension: "正确性", score: 0.9, weight: 4, decided: 1, undecided: 0, met: 1, unmet: 0 }],
        byLabel: { dimension: { 正确性: 0.9 } }, skippedEvaluatorIds: ["tool-failures"],
        artifact: { origin: { kind: "agent_run", reference: "claude:t1" }, files: [{ path: "src/a.ts", status: "added" }] },
        sessionKey: "claude:t1", skillInjection: { skillName: "review", skillHash: "hash-a", contentLength: 42 },
        scores: [
          { evaluatorId: "exact", score: 1, passed: true, dimension: "正确性", durationMs: 1 },
          { evaluatorId: "exact", score: 0.8, passed: false, dimension: "格式", durationMs: 1 },
        ],
        nodes: [{
          nodeId: "judge-exact", nodeType: "deterministic_judge", nodeVersion: 1, role: "judge", status: "pass", durationMs: 1,
          verdicts: [{
            verdictId: "v1", evaluatorId: "exact", labels: { dimension: "output" }, status: "met",
            raw: 1, threshold: 1, reason: "ok", evidence: ["says 4"], sourceNodeId: "judge-exact", sourceNodeType: "deterministic_judge", durationMs: 1,
          }],
        }],
      }],
    };
    await h.evaluation.saveRun(graphRun);
    // Re-save without skillHash must preserve original skillHash
    await h.evaluation.saveRun({ ...graphRun, status: "completed", skillHash: undefined, finishedAt: 200 });
    const loaded = await h.evaluation.getRun("run-1");
    expect(loaded).toMatchObject({ status: "completed", skillHash: "hash-a", engine: "graph", finishedAt: 200 });
    expect(loaded!.results[0]).toMatchObject({ gatePassed: false, passed: true, artifact: graphRun.results[0].artifact });
    expect(loaded!.results[0].scores.map((s) => s.dimension)).toEqual(["格式", "正确性"]);
    expect(loaded!.results[0].nodes?.[0].verdicts).toEqual(graphRun.results[0].nodes![0].verdicts);
    const runPage = await h.evaluation.listRuns({ experimentId: "exp-1" });
    expect(runPage.items[0]).toMatchObject({ resultCount: 1, failedResultCount: 1, skillHash: "hash-a" });

    // Trajectory results
    await h.sessions.upsertIndexedSession(makeSession("traj-s1"), []);
    await h.evaluation.saveTrajectoryResult({
      id: "tr-1", subject: { type: "session", sessionKey: "traj-s1" }, evaluatorId: "eval-1",
      metric: "quality", score: 0.9, label: "good", passed: false, explanation: "check false bool",
      evidence: { note: "ok" }, evaluatorVersion: "1", createdAt: now,
    });
    expect(await h.evaluation.listTrajectoryResults({ type: "session", sessionKey: "traj-s1" })).toEqual([{
      id: "tr-1", subject: { type: "session", sessionKey: "traj-s1" }, evaluatorId: "eval-1",
      metric: "quality", score: 0.9, label: "good", passed: false, explanation: "check false bool",
      evidence: { note: "ok" }, evaluatorVersion: "1", createdAt: now,
    }]);
  });
});
