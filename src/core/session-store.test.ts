import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createInMemoryStore } from "./session-store";
import { TRACE_DETAIL_PREVIEW_MAX_CHARS } from "./trace-detail";
import type { SkillUsageEvent, SkillUsageSource } from "./skill-usage";
import type { IndexedSession, SessionMessage, SessionTraceEvent } from "./types";

function sampleSession(overrides: Partial<IndexedSession> = {}): IndexedSession {
  return {
    sessionKey: "codex:abc",
    rawId: "abc",
    source: "codex-cli",
    projectPath: "/repo",
    filePath: "/tmp/rollout.jsonl",
    originalTitle: "修复登录态失效",
    firstQuestion: "修复登录态失效",
    timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
    fileMtimeMs: 10,
    fileSize: 100,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

const messages: SessionMessage[] = [
  { role: "user", content: "修复登录态失效", timestamp: "2026-06-01T10:00:00Z", index: 0 },
  { role: "assistant", content: "refresh token expired after 30 minutes", timestamp: "2026-06-01T10:01:00Z", index: 1 },
];

const traceEvents: SessionTraceEvent[] = [
  {
    index: 0,
    kind: "tool_call",
    source: "codex",
    title: "shell_command · npm test",
    detail: '{\n  "command": "npm test"\n}',
    timestamp: "2026-06-01T10:02:00Z",
    callId: "call-1",
  },
  {
    index: 1,
    kind: "event",
    source: "codex",
    eventType: "exec_command_end",
    title: "shell · npm test",
    detail: "stdout:\npass",
    timestamp: "2026-06-01T10:03:00Z",
    callId: "call-1",
    status: "success",
  },
];

describe("SessionStore", () => {
  it("indexes sessions, searches full text, and returns match snippets", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages);

    const results = store.searchSessions({ query: "refresh token" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sessionKey: "codex:abc",
      displayTitle: "修复登录态失效",
      source: "codex-cli",
    });
    expect(results[0].matchSnippet).toContain("refresh token");
  });

  it("stores token usage per session and aggregates selected stats periods by source", () => {
    const store = createInMemoryStore();
    const now = new Date("2026-06-01T12:00:00Z").getTime();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const sixDaysAgo = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();
    const twentyDaysAgo = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString();
    const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    store.upsertIndexedSession(
      sampleSession({
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 40,
          cachedInputTokens: 20,
          reasoningOutputTokens: 10,
          totalTokens: 170,
        },
      }),
      messages,
      [
        {
          dedupeKey: "codex:today",
          timestamp: now - 60 * 60 * 1000,
          inputTokens: 100,
          outputTokens: 40,
          cachedInputTokens: 20,
          reasoningOutputTokens: 10,
          totalTokens: 170,
        },
      ],
    );
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "claude:def",
        rawId: "def",
        source: "claude-cli",
        tokenUsage: {
          inputTokens: 400,
          outputTokens: 115,
          cachedInputTokens: 65,
          reasoningOutputTokens: 0,
          totalTokens: 580,
        },
      }),
      [
        { role: "user", content: "six days ago", timestamp: sixDaysAgo, index: 0 },
        { role: "assistant", content: "twenty days ago", timestamp: twentyDaysAgo, index: 1 },
        { role: "assistant", content: "forty days ago", timestamp: fortyDaysAgo, index: 2 },
      ],
      [
        {
          dedupeKey: "claude:seven-day",
          timestamp: now - 6 * 24 * 60 * 60 * 1000,
          inputTokens: 300,
          outputTokens: 80,
          cachedInputTokens: 50,
          reasoningOutputTokens: 0,
          totalTokens: 430,
        },
        {
          dedupeKey: "claude:older",
          timestamp: now - 8 * 24 * 60 * 60 * 1000,
          inputTokens: 70,
          outputTokens: 20,
          cachedInputTokens: 10,
          reasoningOutputTokens: 0,
          totalTokens: 100,
        },
        {
          dedupeKey: "claude:forty-day",
          timestamp: now - 40 * 24 * 60 * 60 * 1000,
          inputTokens: 30,
          outputTokens: 15,
          cachedInputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 50,
        },
      ],
    );

    expect(store.getSession("codex:abc")?.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 20,
      reasoningOutputTokens: 10,
      totalTokens: 170,
    });
    expect(store.getStats({ period: "today" }, now)).toEqual({
      total: {
        sessionCount: 1,
        messageCount: 2,
        inputTokens: 100,
        outputTokens: 40,
        cachedInputTokens: 20,
        reasoningOutputTokens: 10,
        totalTokens: 170,
      },
      bySource: [
        {
          source: "codex-cli",
          sessionCount: 1,
          messageCount: 2,
          inputTokens: 100,
          outputTokens: 40,
          cachedInputTokens: 20,
          reasoningOutputTokens: 10,
          totalTokens: 170,
        },
      ],
      range: {
        period: "today",
        since: todayStart.getTime(),
        until: now,
      },
    });
    expect(store.getStats({ period: "sevenDay" }, now).total).toEqual({
      sessionCount: 2,
      messageCount: 3,
      inputTokens: 400,
      outputTokens: 120,
      cachedInputTokens: 70,
      reasoningOutputTokens: 10,
      totalTokens: 600,
    });
    expect(store.getStats({ period: "thirtyDay" }, now)).toEqual({
      total: {
        sessionCount: 2,
        messageCount: 4,
        inputTokens: 470,
        outputTokens: 140,
        cachedInputTokens: 80,
        reasoningOutputTokens: 10,
        totalTokens: 700,
      },
      bySource: [
        {
          source: "claude-cli",
          sessionCount: 1,
          messageCount: 2,
          inputTokens: 370,
          outputTokens: 100,
          cachedInputTokens: 60,
          reasoningOutputTokens: 0,
          totalTokens: 530,
        },
        {
          source: "codex-cli",
          sessionCount: 1,
          messageCount: 2,
          inputTokens: 100,
          outputTokens: 40,
          cachedInputTokens: 20,
          reasoningOutputTokens: 10,
          totalTokens: 170,
        },
      ],
      range: {
        period: "thirtyDay",
        since: now - 30 * 24 * 60 * 60 * 1000,
        until: now,
      },
    });
    expect(store.getStats({ period: "allTime" }, now).total).toEqual({
      sessionCount: 2,
      messageCount: 5,
      inputTokens: 500,
      outputTokens: 155,
      cachedInputTokens: 85,
      reasoningOutputTokens: 10,
      totalTokens: 750,
    });
  });

  it("dedupes mirrored token events across sources", () => {
    const store = createInMemoryStore();
    const now = new Date("2026-06-01T12:00:00Z").getTime();
    const mirroredEvent = {
      dedupeKey: "codex:mirrored-turn",
      timestamp: now - 60 * 60 * 1000,
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 20,
      reasoningOutputTokens: 10,
      totalTokens: 170,
    };
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:cli", rawId: "cli", source: "codex-cli" }), messages, [mirroredEvent]);
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:app", rawId: "app", source: "codex-app" }), messages, [mirroredEvent]);

    const stats = store.getStats({ period: "today" }, now);

    expect(stats.total.totalTokens).toBe(170);
    expect(stats.bySource.find((item) => item.source === "codex-cli")?.totalTokens).toBe(170);
    expect(stats.bySource.find((item) => item.source === "codex-app")?.totalTokens).toBe(0);
  });

  it("stores skill usage events by source and replaces them on rescan", () => {
    const store = createInMemoryStore();
    const source: SkillUsageSource = {
      agent: "codex",
      kind: "codex-session",
      path: "/tmp/codex-session.jsonl",
      mtimeMs: 100,
      fileSize: 200,
    };
    const firstEvents: SkillUsageEvent[] = [
      { agent: "codex", skill: "brainstorming", timestamp: Date.parse("2026-06-01T10:00:00.000Z") },
      { agent: "codex", skill: "brainstorming", timestamp: Date.parse("2026-06-02T10:00:00.000Z") },
    ];

    store.upsertSkillUsageSource(source, firstEvents);

    expect(store.isSkillUsageSourceFresh(source)).toBe(true);
    expect(store.getSkillUsageSnapshot().stats).toEqual([
      { skill: "brainstorming", count: 2, lastUsedAt: Date.parse("2026-06-02T10:00:00.000Z") },
    ]);

    store.upsertSkillUsageSource(
      { ...source, mtimeMs: 101, fileSize: 220 },
      [{ agent: "codex", skill: "tdd", timestamp: Date.parse("2026-06-03T10:00:00.000Z") }],
    );

    const snapshot = store.getSkillUsageSnapshot();
    expect(store.isSkillUsageSourceFresh(source)).toBe(false);
    expect(snapshot.totalEvents).toBe(1);
    expect(snapshot.stats).toEqual([{ skill: "tdd", count: 1, lastUsedAt: Date.parse("2026-06-03T10:00:00.000Z") }]);
    expect(snapshot.byAgentName["codex:tdd"]?.count).toBe(1);
  });

  it("prunes skill usage sources that no longer exist", () => {
    const store = createInMemoryStore();
    const codexSource: SkillUsageSource = {
      agent: "codex",
      kind: "codex-session",
      path: "/tmp/codex-session.jsonl",
      mtimeMs: 100,
      fileSize: 200,
    };
    const claudeSource: SkillUsageSource = {
      agent: "claude",
      kind: "claude-hook",
      path: "/tmp/skill-usage.jsonl",
      mtimeMs: 300,
      fileSize: 400,
    };
    store.upsertSkillUsageSource(codexSource, [{ agent: "codex", skill: "brainstorming", timestamp: 10 }]);
    store.upsertSkillUsageSource(claudeSource, [{ agent: "claude", skill: "tdd", timestamp: 20 }]);

    store.pruneSkillUsageSources([claudeSource.path]);

    const snapshot = store.getSkillUsageSnapshot();
    expect(snapshot.totalEvents).toBe(1);
    expect(snapshot.stats).toEqual([{ skill: "tdd", count: 1, lastUsedAt: 20 }]);
    expect(store.isSkillUsageSourceFresh(codexSource)).toBe(false);
    expect(store.isSkillUsageSourceFresh(claudeSource)).toBe(true);
  });

  it("stores API keys separately by target and provider", () => {
    const store = createInMemoryStore();

    store.setApiProviderKey("codex", "codexzh", "sk-codexzh");
    store.setApiProviderKey("codex", "zhipu_glm", "sk-glm");
    store.setApiProviderKey("claude", "zhipu_glm", "sk-claude-glm");

    expect(store.getApiProviderKey("codex", "codexzh")).toBe("sk-codexzh");
    expect(store.getApiProviderKey("codex", "zhipu_glm")).toBe("sk-glm");
    expect(store.getApiProviderKey("claude", "zhipu_glm")).toBe("sk-claude-glm");
    expect(store.getApiProviderKey("claude", "codexzh")).toBe("");

    store.setApiProviderKey("codex", "zhipu_glm", "");

    expect(store.getApiProviderKey("codex", "zhipu_glm")).toBe("");
    expect(store.getApiProviderKey("codex", "codexzh")).toBe("sk-codexzh");
  });

  it("dedupes token events after applying the selected stats range", () => {
    const store = createInMemoryStore();
    const now = new Date("2026-06-01T12:00:00Z").getTime();
    const sharedKey = "codex:replayed-turn";
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codex:today", rawId: "today", source: "codex-cli" }),
      messages,
      [
        {
          dedupeKey: sharedKey,
          timestamp: now - 60 * 60 * 1000,
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 120,
        },
      ],
    );
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codex:old", rawId: "old", source: "codex-app" }),
      [
        {
          role: "user",
          content: "old mirrored turn",
          timestamp: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(),
          index: 0,
        },
      ],
      [
        {
          dedupeKey: sharedKey,
          timestamp: now - 40 * 24 * 60 * 60 * 1000,
          inputTokens: 500,
          outputTokens: 100,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 600,
        },
      ],
    );

    const today = store.getStats({ period: "today" }, now);

    expect(today.total.totalTokens).toBe(120);
    expect(today.bySource).toEqual([
      expect.objectContaining({
        source: "codex-cli",
        totalTokens: 120,
      }),
    ]);
  });

  it("keeps custom title, tags, favorite, pinned, and hidden state separate from reindexing", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages);
    store.setCustomTitle("codex:abc", "Auth bug");
    store.addTag("codex:abc", "backend");
    store.setFavorited("codex:abc", true);
    store.setPinned("codex:abc", true);
    store.setHidden("codex:abc", true);

    store.upsertIndexedSession(sampleSession({ originalTitle: "New extracted title" }), messages);
    const hidden = store.searchSessions({ query: "", visibility: "hidden" });

    expect(hidden[0]).toMatchObject({
      customTitle: "Auth bug",
      displayTitle: "Auth bug",
      favorited: true,
      pinned: true,
      hidden: true,
      tags: ["backend"],
    });
  });

  it("filters favorite sessions while excluding hidden sessions", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:fav", rawId: "fav" }), messages);
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:plain", rawId: "plain" }), messages);
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:hidden-fav", rawId: "hidden-fav" }), messages);

    store.setFavorited("codex:fav", true);
    store.setFavorited("codex:hidden-fav", true);
    store.setHidden("codex:hidden-fav", true);

    expect(store.searchSessions({ visibility: "favorites" }).map((session) => session.sessionKey)).toEqual(["codex:fav"]);
    expect(store.searchSessions({ visibility: "hidden" }).map((session) => session.sessionKey)).toEqual(["codex:hidden-fav"]);
  });

  it("does not search tag names from the text search box, but supports explicit tag filtering", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages);
    store.addTag("codex:abc", "backend");

    expect(store.searchSessions({ query: "backend" })).toHaveLength(0);
    expect(store.searchSessions({ query: "", tag: "backend" })).toHaveLength(1);
  });

  it("keeps personal sources out of the regular Claude and Codex source filters", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession({ sessionKey: "claude:regular", rawId: "regular", source: "claude-cli" }), messages);
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "claude-internal:internal", rawId: "internal", source: "claude-internal" }),
      messages,
    );
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:regular", rawId: "codex-regular", source: "codex-cli" }), messages);
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codex-internal:internal", rawId: "codex-internal", source: "codex-internal" }),
      messages,
    );
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codebuddy:regular", rawId: "codebuddy-regular", source: "codebuddy-cli" }),
      messages,
    );

    expect(store.searchSessions({ source: "claude" }).map((session) => session.source)).toEqual(["claude-cli"]);
    expect(store.searchSessions({ source: "codex" }).map((session) => session.source)).toEqual(["codex-cli"]);
    expect(store.searchSessions({ source: "claude-internal" }).map((session) => session.sessionKey)).toEqual(["claude-internal:internal"]);
    expect(store.searchSessions({ source: "codex-internal" }).map((session) => session.sessionKey)).toEqual(["codex-internal:internal"]);
    expect(store.searchSessions({ source: "codebuddy-cli" }).map((session) => session.sessionKey)).toEqual(["codebuddy:regular"]);
  });

  it("deletes indexed sessions by source and removes unused tags", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession({ sessionKey: "claude-internal:one", rawId: "one", source: "claude-internal" }), messages);
    store.addTag("claude-internal:one", "internal");
    store.upsertIndexedSession(sampleSession({ sessionKey: "codebuddy:one", rawId: "codebuddy-one", source: "codebuddy-cli" }), messages);
    store.addTag("codebuddy:one", "codebuddy");

    store.deleteSessionsBySource(["claude-internal", "codebuddy-cli"]);

    expect(store.searchSessions({ source: "claude-internal" })).toEqual([]);
    expect(store.searchSessions({ source: "codebuddy-cli" })).toEqual([]);
    expect(store.listTags()).toEqual([]);
  });

  it("adds a branch tag from indexed Codex metadata", () => {
    const store = createInMemoryStore();

    store.upsertIndexedSession(sampleSession({ gitBranch: "feat/session-tags" }), messages);

    expect(store.listTags()).toEqual(["branch:feat/session-tags"]);
    expect(store.searchSessions({ tag: "branch:feat/session-tags" }).map((session) => session.sessionKey)).toEqual(["codex:abc"]);
  });

  it("lists projects with counts and disambiguates duplicate folder names", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codex:one", rawId: "one", projectPath: "/work/team-a/app" }),
      messages,
    );
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "claude:two", rawId: "two", source: "claude-cli", projectPath: "/work/team-a/app" }),
      messages,
    );
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codex:three", rawId: "three", projectPath: "/work/team-b/app" }),
      messages,
    );
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:no-project", rawId: "no-project", projectPath: "" }), messages);

    expect(store.listProjects()).toEqual([
      { path: "/work/team-a/app", label: "team-a/app", sessionCount: 2 },
      { path: "/work/team-b/app", label: "team-b/app", sessionCount: 1 },
    ]);
  });

  it("filters sessions by exact project path and composes with other filters", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:app", rawId: "app", projectPath: "/work/app" }), messages);
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "claude:app", rawId: "claude-app", source: "claude-cli", projectPath: "/work/app" }),
      messages,
    );
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:api", rawId: "api", projectPath: "/work/api" }), messages);
    store.addTag("claude:app", "backend");

    expect(store.searchSessions({ projectPath: "/work/app" }).map((session) => session.sessionKey).sort()).toEqual([
      "claude:app",
      "codex:app",
    ]);
    expect(store.searchSessions({ projectPath: "/work/app", source: "claude" }).map((session) => session.sessionKey)).toEqual([
      "claude:app",
    ]);
    expect(store.searchSessions({ projectPath: "/work/app", tag: "backend" }).map((session) => session.sessionKey)).toEqual([
      "claude:app",
    ]);
  });

  it("optionally groups projects by repository root", () => {
    const store = createInMemoryStore();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-search-projects-"));

    try {
      const repoA = path.join(tempRoot, "repo-a");
      const repoB = path.join(tempRoot, "repo-b");
      const frontend = path.join(repoA, "frontend");
      const backend = path.join(repoA, "backend");
      const worker = path.join(repoB, "worker");
      for (const dir of [frontend, backend, worker]) fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(repoA, ".git"));
      fs.mkdirSync(path.join(repoB, ".git"));

      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:frontend", rawId: "frontend", projectPath: frontend }), messages);
      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:backend", rawId: "backend", projectPath: backend }), messages);
      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:worker", rawId: "worker", projectPath: worker }), messages);

      expect(store.listProjects("repo")).toEqual([
        { path: repoA, label: "repo-a", sessionCount: 2 },
        { path: repoB, label: "repo-b", sessionCount: 1 },
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("prefers promoted sub-roots over the detected repository root", () => {
    const store = createInMemoryStore();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-search-promoted-root-"));

    try {
      const repoRoot = path.join(tempRoot, "repo");
      const frontendRoot = path.join(repoRoot, "frontend");
      const frontendApp = path.join(frontendRoot, "app");
      const frontendWeb = path.join(frontendRoot, "web");
      const backendApi = path.join(repoRoot, "backend", "api");
      for (const dir of [frontendApp, frontendWeb, backendApi]) fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".git"));

      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:frontend-app", rawId: "frontend-app", projectPath: frontendApp }), messages);
      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:frontend-web", rawId: "frontend-web", projectPath: frontendWeb }), messages);
      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:backend-api", rawId: "backend-api", projectPath: backendApi }), messages);

      expect(store.listProjects("repo", [frontendRoot])).toEqual([
        { path: frontendRoot, label: "frontend", sessionCount: 2 },
        { path: repoRoot, label: "repo", sessionCount: 1 },
      ]);
      expect(
        store.searchSessions({
          projectPath: frontendRoot,
          projectGrouping: "repo",
          promotedProjectRoots: [frontendRoot],
        }).map((session) => session.sessionKey).sort(),
      ).toEqual(["codex:frontend-app", "codex:frontend-web"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to the repository root after removing a promoted sub-root", () => {
    const store = createInMemoryStore();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-search-promoted-root-revert-"));

    try {
      const repoRoot = path.join(tempRoot, "repo");
      const frontendRoot = path.join(repoRoot, "frontend");
      const frontendApp = path.join(frontendRoot, "app");
      const backendApi = path.join(repoRoot, "backend", "api");
      for (const dir of [frontendApp, backendApi]) fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".git"));

      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:frontend-app", rawId: "frontend-app", projectPath: frontendApp }), messages);
      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:backend-api", rawId: "backend-api", projectPath: backendApi }), messages);

      expect(store.searchSessions({ projectPath: frontendRoot, projectGrouping: "repo", promotedProjectRoots: [frontendRoot] })).toHaveLength(1);
      expect(
        store.searchSessions({
          projectPath: repoRoot,
          projectGrouping: "repo",
          promotedProjectRoots: [],
        }).map((session) => session.sessionKey).sort(),
      ).toEqual(["codex:backend-api", "codex:frontend-app"]);
      expect(store.listProjects("repo", [])).toEqual([{ path: repoRoot, label: "repo", sessionCount: 2 }]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("optionally filters sessions by repository root while preserving cwd filters", () => {
    const store = createInMemoryStore();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-search-filter-"));

    try {
      const repoRoot = path.join(tempRoot, "repo");
      const appDir = path.join(repoRoot, "app");
      const apiDir = path.join(repoRoot, "api");
      const otherDir = path.join(tempRoot, "other");
      for (const dir of [appDir, apiDir, otherDir]) fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".git"));

      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:app", rawId: "app", projectPath: appDir }), messages);
      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:api", rawId: "api", projectPath: apiDir }), messages);
      store.upsertIndexedSession(sampleSession({ sessionKey: "codex:other", rawId: "other", projectPath: otherDir }), messages);

      expect(
        store.searchSessions({ projectPath: repoRoot, projectGrouping: "repo" }).map((session) => session.sessionKey).sort(),
      ).toEqual(["codex:api", "codex:app"]);
      expect(store.searchSessions({ projectPath: repoRoot }).map((session) => session.sessionKey)).toEqual([]);
      expect(store.searchSessions({ projectPath: appDir }).map((session) => session.sessionKey)).toEqual(["codex:app"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("sorts default results by created time", () => {
    const store = createInMemoryStore();
    const oldButActive = sampleSession({
      sessionKey: "codex:active",
      rawId: "active",
      timestamp: new Date("2026-05-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T12:00:00Z").getTime(),
    });
    const newerButIdle = sampleSession({
      sessionKey: "codex:idle",
      rawId: "idle",
      timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T10:00:00Z").getTime(),
    });
    store.upsertIndexedSession(oldButActive, messages);
    store.upsertIndexedSession(newerButIdle, messages);

    expect(store.searchSessions({ query: "" }).map((session) => session.sessionKey)).toEqual(["codex:idle", "codex:active"]);
  });

  it("sorts by explicit activity, created, and updated time modes", () => {
    const store = createInMemoryStore();
    const oldButUpdated = sampleSession({
      sessionKey: "codex:updated",
      rawId: "updated",
      timestamp: new Date("2026-05-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T12:00:00Z").getTime(),
    });
    const newButIdle = sampleSession({
      sessionKey: "codex:created",
      rawId: "created",
      timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T10:00:00Z").getTime(),
    });
    store.upsertIndexedSession(oldButUpdated, messages);
    store.upsertIndexedSession(newButIdle, messages);

    expect(store.searchSessions({ query: "", sortBy: "activity" }).map((session) => session.sessionKey)).toEqual([
      "codex:updated",
      "codex:created",
    ]);
    expect(store.searchSessions({ query: "", sortBy: "created" }).map((session) => session.sessionKey)).toEqual([
      "codex:created",
      "codex:updated",
    ]);
    expect(store.searchSessions({ query: "", sortBy: "updated" }).map((session) => session.sessionKey)).toEqual([
      "codex:updated",
      "codex:created",
    ]);
  });

  it("deletes tags globally and removes unused tags after unlinking", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages);
    store.upsertIndexedSession(sampleSession({ sessionKey: "claude:def", rawId: "def", source: "claude-cli" }), messages);
    store.addTag("codex:abc", "backend");
    store.addTag("claude:def", "backend");
    store.addTag("codex:abc", "solo");

    store.removeTag("codex:abc", "solo");
    expect(store.listTags()).toEqual(["backend"]);

    store.deleteTag("backend");
    expect(store.listTags()).toEqual([]);
    expect(store.searchSessions({ tag: "backend" })).toHaveLength(0);
    expect(store.getSession("claude:def")?.tags).toEqual([]);
  });

  it("loads messages in pages for responsive detail views", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), [
      ...messages,
      { role: "user", content: "third", timestamp: "2026-06-01T10:02:00Z", index: 2 },
    ]);

    expect(store.getMessages("codex:abc", 0, 2).map((message) => message.content)).toEqual([
      "修复登录态失效",
      "refresh token expired after 30 minutes",
    ]);
    expect(store.getMessages("codex:abc", 2, 2).map((message) => message.content)).toEqual(["third"]);
  });

  it("stores and loads trace events for detail views", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages, [], traceEvents);

    expect(store.getTraceEvents("codex:abc")).toEqual(traceEvents);

    store.upsertIndexedSession(sampleSession(), messages, [], [traceEvents[0]]);
    expect(store.getTraceEvents("codex:abc")).toEqual([traceEvents[0]]);
  });

  it("stores trace detail as a bounded indexed preview", () => {
    const store = createInMemoryStore();
    const longDetail = "x".repeat(TRACE_DETAIL_PREVIEW_MAX_CHARS + 25);
    store.upsertIndexedSession(sampleSession(), messages, [], [{ ...traceEvents[0], detail: longDetail }]);

    const [stored] = store.getTraceEvents("codex:abc");
    expect(stored.detail.length).toBeLessThanOrEqual(TRACE_DETAIL_PREVIEW_MAX_CHARS);
    expect(stored.detail).toContain("Indexed preview truncated");
    expect(stored.detail).toContain("characters omitted");
  });
});
