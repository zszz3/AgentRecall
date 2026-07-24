import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IndexedSession, SessionMessage } from "../types";
import { PostgresDatabase } from "./database";
import { PostgresSessionRepository } from "./session-repository";
import { PostgresSessionSearchRepository } from "./session-search-repository";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";

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
        status: "success",
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
  });
});
