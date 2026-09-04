import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IndexedSession, SessionMessage } from "../types";
import { PostgresDatabase } from "./database";
import { PostgresSessionRepository } from "./session-repository";
import { PostgresSessionSearchRepository } from "./session-search-repository";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";
import { PostgresRuntimeInvocationRepository } from "./runtime-invocation-repository";

function session(
  sessionKey: string,
  title: string,
  timestamp: string,
  overrides: Partial<IndexedSession> = {},
): IndexedSession {
  return {
    sessionKey,
    rawId: sessionKey.split(":").at(-1) || sessionKey,
    source: "codex-cli",
    projectPath: "/projects/search",
    filePath: `/fixtures/${sessionKey.replace(":", "-")}.jsonl`,
    originalTitle: title,
    firstQuestion: title,
    timestamp: Date.parse(timestamp),
    fileMtimeMs: Date.parse(timestamp),
    fileSize: 100,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

function message(
  role: SessionMessage["role"],
  content: string,
  timestamp: string,
  index: number,
): SessionMessage {
  return { role, content, timestamp, index };
}

describe("PostgreSQL Turn search", () => {
  let database: PostgresDatabase;
  let repository: PostgresSessionRepository;
  let searchRepository: PostgresSessionSearchRepository;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    repository = new PostgresSessionRepository(database);
    searchRepository = new PostgresSessionSearchRepository(database);

    await repository.upsertIndexedSession(
      session("codex:one", "登录故障排查", "2026-07-20T08:00:00.000Z"),
      [
        message("user", "登录缓存失败，帮我定位", "2026-07-20T08:00:00.000Z", 0),
        message("assistant", "问题来自过期 cache key", "2026-07-20T08:00:01.000Z", 1),
        message("user", "please retry timeout handling", "2026-07-20T08:01:00.000Z", 2),
        message("assistant", "retry timeout is now covered", "2026-07-20T08:01:01.000Z", 3),
      ],
    );
    await repository.upsertIndexedSession(
      session("codex:two", "缓存性能", "2026-07-21T08:00:00.000Z", {
        source: "claude-cli",
      }),
      [
        message("user", "缓存需要优化", "2026-07-21T08:00:00.000Z", 0),
        message("assistant", "没有登录失败", "2026-07-21T08:00:01.000Z", 1),
      ],
    );
    await repository.upsertIndexedSession(
      session("codex:subagent", "Subagent retry", "2026-07-22T08:00:00.000Z", {
        isSubagent: true,
        parentSessionId: "one",
      }),
      [
        message("user", "retry timeout", "2026-07-22T08:00:00.000Z", 0),
      ],
    );
    await repository.upsertIndexedSession(
      session("codex:roles", "消息角色过滤", "2026-07-23T08:00:00.000Z"),
      [
        message("user", "中文关键词只应命中对话", "2026-07-23T08:00:00.000Z", 0),
        message("assistant", "已经理解", "2026-07-23T08:00:01.000Z", 1),
      ],
      [],
      [{
        index: 0,
        kind: "tool_result",
        source: "codex",
        title: "工具输出",
        detail: "中文关键词也出现在工具结果中",
        timestamp: "2026-07-23T08:00:02.000Z",
        callId: "call-chinese-search",
        status: "completed",
      }],
    );
  });

  afterEach(async () => {
    await database.close();
  });

  it("returns one Session with the best matching Turn and the number of matching Turns", async () => {
    const page = await searchRepository.searchSessionPage({
      query: "retry",
      excludeSubagents: true,
      limit: 10,
    });

    expect(page.totalCount).toBe(1);
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]).toMatchObject({
      sessionKey: "codex:one",
      turnMatchCount: 1,
      bestTurn: {
        turnIndex: 1,
        sourceMessageIndex: 2,
      },
    });
    expect(page.sessions[0].matchSnippet).toContain("retry timeout");
    expect(page.sessions[0].matchHits?.[0]).toMatchObject({
      turnIndex: 1,
      messageIndex: 2,
      role: "user",
    });
  });

  it("requires every AND term to occur in the same Turn", async () => {
    const page = await searchRepository.searchSessionPage({
      query: "登录 AND 失败",
      excludeSubagents: true,
    });

    expect(page.sessions.map((item) => item.sessionKey).sort()).toEqual(["codex:one", "codex:two"]);

    const noCrossTurnMatch = await searchRepository.searchSessionPage({
      query: "登录 AND timeout",
      excludeSubagents: true,
    });
    expect(noCrossTurnMatch.sessions).toEqual([]);
  });

  it("searches Chinese conversation text without returning tool-result hits", async () => {
    const page = await searchRepository.searchSessionPage({
      query: "中文关键词",
      excludeSubagents: true,
    });

    expect(page.sessions.map((item) => item.sessionKey)).toEqual(["codex:roles"]);
    expect(page.sessions[0].matchHits).toHaveLength(1);
    expect(page.sessions[0].matchHits?.[0]).toMatchObject({
      role: "user",
      snippet: expect.stringContaining("中文关键词"),
    });

    const toolOnly = await searchRepository.searchSessionPage({
      query: "工具结果中",
      excludeSubagents: true,
    });
    expect(toolOnly.sessions).toEqual([]);
  });

  it("does not show partial message hits when only Session metadata matches every term", async () => {
    await repository.upsertIndexedSession(
      session("codex:metadata-only", "重启服务 剩下下载文件 筛选", "2026-07-24T09:00:00.000Z"),
      [
        message("user", "重启服务", "2026-07-24T09:00:00.000Z", 0),
        message("assistant", "服务已重新启动", "2026-07-24T09:00:01.000Z", 1),
        message("user", "剩下下载文件", "2026-07-24T09:01:00.000Z", 2),
        message("assistant", "下一步再讨论筛选", "2026-07-24T09:01:01.000Z", 3),
      ],
    );

    const page = await searchRepository.searchSessionPage({
      query: "重启服务 剩下下载文件 筛选",
      excludeSubagents: true,
    });

    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]).toMatchObject({
      sessionKey: "codex:metadata-only",
      metadataMatch: "title",
      messageMatchCount: 0,
      matchHits: [],
    });
  });

  it("supports exact phrases, source/date filters, and paginated Session totals", async () => {
    const phrase = await searchRepository.searchSessionPage({
      query: "\"retry timeout\"",
      excludeSubagents: true,
    });
    expect(phrase.sessions.map((item) => item.sessionKey)).toEqual(["codex:one"]);

    const filtered = await searchRepository.searchSessionPage({
      source: "claude",
      dateFrom: Date.parse("2026-07-21T00:00:00.000Z"),
      limit: 1,
    });
    expect(filtered.sessions.map((item) => item.sessionKey)).toEqual(["codex:two"]);
    expect(filtered.totalCount).toBe(1);
    expect(filtered.hasMore).toBe(false);

    const limited = await searchRepository.searchSessionPage({
      excludeSubagents: false,
      limit: 2,
    });
    expect(limited.sessions).toHaveLength(2);
    expect(limited.totalCount).toBe(4);
    expect(limited.hasMore).toBe(true);

    const secondPage = await searchRepository.searchSessionPage({
      excludeSubagents: false,
      limit: 2,
      offset: 2,
    });
    expect(secondPage.sessions.map((item) => item.sessionKey)).toEqual(["codex:two", "codex:one"]);
    expect(secondPage.totalCount).toBe(4);
    expect(secondPage.hasMore).toBe(false);

    const normalizedPage = await searchRepository.searchSessionPage({
      excludeSubagents: false,
      limit: 1.9,
      offset: 1.9,
    });
    expect(normalizedPage.sessions.map((item) => item.sessionKey)).toEqual(["codex:subagent"]);
    expect(normalizedPage.totalCount).toBe(4);

    const emptyPage = await searchRepository.searchSessionPage({
      excludeSubagents: false,
      limit: 2,
      offset: 10,
    });
    expect(emptyPage.sessions).toEqual([]);
    expect(emptyPage.totalCount).toBe(4);
    expect(emptyPage.hasMore).toBe(false);
  });

  it("groups only sessions explicitly created by AgentRecall and keeps continued user sessions ordinary", async () => {
    const invocations = new PostgresRuntimeInvocationRepository(database);
    await invocations.begin({
      id: "inv-created",
      initiator: "agentrecall",
      invocation: {
        surface: "evaluation",
        role: "subject",
        ownerReference: { runId: "run-1", caseResultId: "case-1" },
      },
      runtimeId: "codex",
      channelId: "codex-default",
      environmentId: "local",
      startedAt: Date.parse("2026-07-20T08:00:00.000Z"),
    });
    await invocations.bind("inv-created", {
      runtimeId: "codex",
      channelId: "codex-default",
      environmentId: "local",
      sessionId: "one",
      turnId: "turn-1",
      relation: "created",
      boundAt: Date.parse("2026-07-20T08:00:01.000Z"),
    });
    await invocations.finish("inv-created", "completed", Date.parse("2026-07-20T08:00:02.000Z"));

    await invocations.begin({
      id: "inv-continued",
      initiator: "agentrecall",
      invocation: { surface: "team_chat", role: "member", ownerReference: { roomId: "room-1" } },
      runtimeId: "claude",
      channelId: "claude-default",
      environmentId: "local",
      startedAt: Date.parse("2026-07-21T08:00:00.000Z"),
    });
    await invocations.bind("inv-continued", {
      runtimeId: "claude",
      channelId: "claude-default",
      environmentId: "local",
      sessionId: "two",
      relation: "continued",
      boundAt: Date.parse("2026-07-21T08:00:01.000Z"),
    });
    await invocations.finish("inv-continued", "cancelled", Date.parse("2026-07-21T08:00:02.000Z"));

    const ordinary = await searchRepository.searchSessionPage({ origin: "ordinary", excludeSubagents: true });
    expect(ordinary.sessions.map((item) => item.sessionKey).sort()).toEqual(["codex:roles", "codex:two"]);
    expect(ordinary.originCounts).toEqual({ ordinary: 2, agentRecall: 1, all: 3 });
    expect(ordinary.invocationSurfaceCounts).toEqual({
      workflow: 0,
      evaluation: 1,
      team_chat: 0,
      agent: 0,
      skill: 0,
      system: 0,
      all: 1,
    });
    expect(ordinary.sessions.find((item) => item.sessionKey === "codex:two")).toMatchObject({
      createdByAgentRecall: false,
      runtimeInvocations: [expect.objectContaining({
        invocationId: "inv-continued",
        relation: "continued",
        surface: "team_chat",
        status: "cancelled",
      })],
    });

    const created = await searchRepository.searchSessionPage({ origin: "agentrecall", excludeSubagents: true });
    expect(created.sessions).toHaveLength(1);
    expect(created.sessions[0]).toMatchObject({
      sessionKey: "codex:one",
      createdByAgentRecall: true,
      runtimeInvocations: [expect.objectContaining({
        invocationId: "inv-created",
        relation: "created",
        runtimeTurnId: "turn-1",
        ownerReference: { runId: "run-1", caseResultId: "case-1" },
      })],
    });
    const evaluationSessions = await searchRepository.searchSessionPage({
      origin: "agentrecall",
      invocationSurface: "evaluation",
      excludeSubagents: true,
    });
    expect(evaluationSessions.sessions.map((item) => item.sessionKey)).toEqual(["codex:one"]);
    expect(evaluationSessions.originCounts).toEqual({ ordinary: 2, agentRecall: 1, all: 3 });
    const workflowSessions = await searchRepository.searchSessionPage({
      origin: "agentrecall",
      invocationSurface: "workflow",
      excludeSubagents: true,
    });
    expect(workflowSessions.sessions).toEqual([]);
    await expect(repository.resolveRuntimeInvocationSession({ runId: "run-1" }))
      .resolves.toMatchObject({ status: "found", session: { sessionKey: "codex:one" } });
    await expect(repository.resolveRuntimeInvocationSession({ runId: "missing" }))
      .resolves.toEqual({ status: "not_recorded" });

    await invocations.begin({
      id: "inv-no-reference",
      initiator: "agentrecall",
      invocation: { surface: "workflow", ownerReference: { runId: "run-no-reference" } },
      runtimeId: "dsh",
      environmentId: "local",
      startedAt: Date.parse("2026-07-22T08:00:00.000Z"),
    });
    await invocations.finish(
      "inv-no-reference",
      "failed",
      Date.parse("2026-07-22T08:00:01.000Z"),
    );
    await expect(repository.resolveRuntimeInvocationSession({ runId: "run-no-reference" }))
      .resolves.toEqual({
        status: "no_session_reference",
        invocationId: "inv-no-reference",
        invocationStatus: "failed",
      });

    await invocations.begin({
      id: "inv-awaiting-index",
      initiator: "agentrecall",
      invocation: { surface: "workflow", ownerReference: { runId: "run-awaiting-index" } },
      runtimeId: "codex",
      environmentId: "local",
      startedAt: Date.parse("2026-07-23T08:00:00.000Z"),
    });
    await invocations.bind("inv-awaiting-index", {
      runtimeId: "codex",
      environmentId: "local",
      sessionId: "not-indexed-yet",
      relation: "created",
      boundAt: Date.parse("2026-07-23T08:00:01.000Z"),
    });
    await expect(repository.resolveRuntimeInvocationSession({ runId: "run-awaiting-index" }))
      .resolves.toEqual({ status: "not_indexed", invocationId: "inv-awaiting-index" });
  });

  it("filters both Claude and Codex StepCode variants as one source", async () => {
    await repository.upsertIndexedSession(
      session("stepcode-claude:two", "StepCode Claude", "2026-07-24T08:00:00.000Z", {
        source: "stepcode-claude",
      }),
      [message("user", "stepcode shared source", "2026-07-24T08:00:00.000Z", 0)],
    );
    await repository.upsertIndexedSession(
      session("stepcode-codex:one", "StepCode Codex", "2026-07-25T08:00:00.000Z", {
        source: "stepcode-codex",
      }),
      [message("user", "stepcode shared source", "2026-07-25T08:00:00.000Z", 0)],
    );

    const page = await searchRepository.searchSessionPage({
      query: "stepcode shared source",
      source: "stepcode",
    });

    expect(page.sessions).toHaveLength(2);
    expect(page.sessions.map((item) => JSON.stringify(item.availableSources?.sort())).sort()).toEqual([
      JSON.stringify(["claude-cli", "stepcode-claude"]),
      JSON.stringify(["codex-cli", "stepcode-codex"]),
    ].sort());
  });

  it("keeps smart, recent, and oldest sorting behavior distinct", async () => {
    const dayMs = 24 * 60 * 60 * 1_000;
    const projectPath = "/projects/sort-modes";
    const olderTimestamp = new Date(Date.now() - 90 * dayMs).toISOString();
    const recentTimestamp = new Date(Date.now() - dayMs).toISOString();
    await repository.upsertIndexedSession(
      session("codex:sort-exact", "needle", olderTimestamp, { projectPath }),
      [message("user", "needle", olderTimestamp, 0)],
    );
    await repository.upsertIndexedSession(
      session("codex:sort-recent", "Unrelated current work", recentTimestamp, {
        projectPath,
        firstQuestion: "needle pipeline broke after merge",
      }),
      [message("user", "a recent message also mentions needle", recentTimestamp, 0)],
    );

    const oldest = await searchRepository.searchSessionPage({
      projectPath,
      sortBy: "created",
      limit: 10,
    });
    expect(oldest.sessions.map((item) => item.sessionKey)).toEqual([
      "codex:sort-exact",
      "codex:sort-recent",
    ]);

    const recent = await searchRepository.searchSessionPage({
      projectPath,
      sortBy: "activity",
      limit: 10,
    });
    expect(recent.sessions.map((item) => item.sessionKey)).toEqual([
      "codex:sort-recent",
      "codex:sort-exact",
    ]);

    const recentWithQuery = await searchRepository.searchSessionPage({
      projectPath,
      query: "needle",
      sortBy: "activity",
      limit: 10,
      liveSessionKeys: ["codex:sort-recent"],
    });
    expect(recentWithQuery.sessions.map((item) => item.sessionKey)).toEqual([
      "codex:sort-exact",
      "codex:sort-recent",
    ]);

    const smart = await searchRepository.searchSessionPage({
      projectPath,
      query: "needle",
      sortBy: "smart",
      limit: 10,
    });
    expect(smart.sessions.map((item) => item.sessionKey)).toEqual([
      "codex:sort-recent",
      "codex:sort-exact",
    ]);
  });

  it("prioritizes exact phrase hits over messages that only contain all terms", async () => {
    await repository.upsertIndexedSession(
      session("codex:phrase", "Exact phrase ranking", "2026-07-24T08:00:00.000Z"),
      [
        message("user", "UPSERT is how the latest state is maintained", "2026-07-24T08:00:00.000Z", 0),
        message("assistant", "The latest state uses UPSERT and a unique device id", "2026-07-24T08:00:01.000Z", 1),
        message("user", "UPSERT is how the latest state is maintained", "2026-07-24T08:01:00.000Z", 2),
      ],
    );

    const page = await searchRepository.searchSessionPage({
      query: "UPSERT is how the latest state is maintained",
      excludeSubagents: true,
    });
    const result = page.sessions.find((item) => item.sessionKey === "codex:phrase");

    expect(result?.messageMatchCount).toBe(3);
    expect(result?.matchHits?.map((hit) => hit.messageIndex)).toEqual([0, 2]);
    expect(result?.matchHits?.[0]?.matchedTerms[0]).toBe("upsert is how the latest state is maintained");
  });

  it("prioritizes favorites while ignoring legacy pin state", async () => {
    await repository.setFavorited("codex:one", true);
    await database.query(
      "update agent_recall.sessions set pinned = true where session_key = $1",
      ["codex:two"],
    );

    const page = await searchRepository.searchSessionPage({ limit: 10 });

    expect(page.sessions.map((item) => item.sessionKey)).toEqual([
      "codex:one",
      "codex:roles",
      "codex:subagent",
      "codex:two",
    ]);
  });

  it("keeps an old open session on the first unfiltered page", async () => {
    const page = await searchRepository.searchSessionPage({
      limit: 1,
      liveSessionKeys: ["claude:two"],
    });

    expect(page.sessions[0]?.sessionKey).toBe("codex:two");
    expect(page.totalCount).toBe(4);
  });

  it("moves a detected session from closed back to open after a new conversation", async () => {
    const now = Date.now();
    const staleAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    const recentAt = new Date(now - 60 * 60 * 1000).toISOString();
    const projectPath = "/projects/live-status";
    const staleSession = session("codex:stale-live", "Stale live session", staleAt, { projectPath });
    await repository.upsertIndexedSession(staleSession, [
      message("user", "old conversation", staleAt, 0),
    ]);
    await repository.upsertIndexedSession(
      session("codex:recent-live", "Recent live session", recentAt, { projectPath }),
      [message("user", "recent conversation", recentAt, 0)],
    );
    const liveSessionKeys = ["codex:stale-live", "codex:recent-live"];

    const openPage = await searchRepository.searchSessionPage({
      projectPath,
      liveStatus: "open",
      liveSessionKeys,
    });
    const closedPage = await searchRepository.searchSessionPage({
      projectPath,
      liveStatus: "closed",
      liveSessionKeys,
    });
    expect(openPage.sessions.map((item) => item.sessionKey)).toEqual(["codex:recent-live"]);
    expect(closedPage.sessions.map((item) => item.sessionKey)).toEqual(["codex:stale-live"]);

    const resumedAt = new Date().toISOString();
    await repository.upsertIndexedSession(staleSession, [
      message("user", "old conversation", staleAt, 0),
      message("user", "new conversation", resumedAt, 1),
    ]);

    const reopenedPage = await searchRepository.searchSessionPage({
      projectPath,
      liveStatus: "open",
      liveSessionKeys,
    });
    const remainingClosedPage = await searchRepository.searchSessionPage({
      projectPath,
      liveStatus: "closed",
      liveSessionKeys,
    });
    expect(reopenedPage.sessions.map((item) => item.sessionKey).sort()).toEqual([
      "codex:recent-live",
      "codex:stale-live",
    ]);
    expect(remainingClosedPage.sessions).toEqual([]);
  });
});
