import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInMemoryStore, SessionStore } from "./session-store";
import { TRACE_DETAIL_PREVIEW_MAX_CHARS } from "./trace-detail";
import type { SkillUsageEvent, SkillUsageSource } from "./skill-usage";
import type {
  IndexedSession,
  SearchOptions,
  SessionMessage,
  SessionMigrationRecord,
  SessionTraceEvent,
} from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync };

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
  it("returns structured message hits and metadata-only match reasons", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codex:conversation", rawId: "conversation", originalTitle: "Auth work", firstQuestion: "Auth work" }),
      [
        { role: "user", content: "Investigate login behavior", timestamp: "2026-06-01T10:00:00Z", index: 0 },
        { role: "assistant", content: "The token expired yesterday", timestamp: "2026-06-01T10:01:00Z", index: 1 },
        { role: "user", content: "Login should recover after expired credentials", timestamp: "2026-06-01T10:02:00Z", index: 2 },
      ],
    );
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codex:title", rawId: "title", originalTitle: "login expired metadata", firstQuestion: "other" }),
      [{ role: "user", content: "unrelated conversation", timestamp: "2026-06-01T10:00:00Z", index: 0 }],
    );

    const results = store.searchSessions({ query: "login AND expired" });
    const conversation = results.find((result) => result.sessionKey === "codex:conversation");
    const title = results.find((result) => result.sessionKey === "codex:title");

    expect(conversation).toMatchObject({ messageMatchCount: 3, metadataMatch: null });
    expect(conversation?.matchHits).toEqual([
      expect.objectContaining({ messageIndex: 0, role: "user", matchedTerms: ["login"] }),
      expect.objectContaining({ messageIndex: 1, role: "assistant", matchedTerms: ["expired"] }),
    ]);
    expect(title).toMatchObject({ messageMatchCount: 0, matchHits: [], metadataMatch: "title" });
    expect(store.searchSessions({ query: "" })[0]).toMatchObject({ messageMatchCount: 0, matchHits: [], metadataMatch: null });
    store.close();
  });

  it("treats standalone explicit AND as the existing implicit AND operator", () => {
    const store = createInMemoryStore();
    const cases = [
      ["both", "login expired"],
      ["login", "login only"],
      ["expired", "expired only"],
      ["android", "android client"],
    ] as const;
    for (const [id, content] of cases) {
      store.upsertIndexedSession(
        sampleSession({ sessionKey: `codex:${id}`, rawId: id, originalTitle: content, firstQuestion: content }),
        [{ role: "user", content, timestamp: "2026-06-01T10:00:00Z", index: 0 }],
      );
    }

    for (const query of ["login AND expired", "login and expired", "login expired"]) {
      expect(store.searchSessions({ query }).map((item) => item.sessionKey)).toEqual(["codex:both"]);
    }
    expect(store.searchSessions({ query: "android" }).map((item) => item.sessionKey)).toEqual(["codex:android"]);
    expect(store.searchSessionPage({ query: "AND" }).totalCount).toBe(4);
    store.close();
  });

  it("persists subagent relationships and excludes them consistently when requested", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:root", rawId: "root", isSubagent: false }), messages, [], []);
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:child",
        rawId: "child",
        isSubagent: true,
        parentSessionId: "root",
        tokenUsage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 15 },
      }),
      [{ role: "user", content: "subagent task", timestamp: "2026-06-01T10:00:00Z", index: 0 }],
      [],
      [],
    );

    expect(store.searchSessionPage({ excludeSubagents: false }).totalCount).toBe(2);
    expect(store.searchSessionPage({ excludeSubagents: true })).toMatchObject({ totalCount: 1 });
    expect(store.searchSessions({ excludeSubagents: true }).map((session) => session.sessionKey)).toEqual(["codex:root"]);
    expect(store.listProjects({ excludeSubagents: true })[0].sessionCount).toBe(1);
    expect(store.getStats({ period: "allTime", excludeSubagents: true }).total).toMatchObject({
      sessionCount: 1,
      messageCount: 2,
    });
    expect(store.getSession("codex:child")).toMatchObject({
      isSubagent: true,
      parentSessionId: "root",
    });
    store.close();
  });

  function migrationRecord(overrides: Partial<SessionMigrationRecord> = {}): SessionMigrationRecord {
    return {
      id: "migration-1",
      sourceSessionKey: "codex:abc",
      sourceAgent: "codex",
      targetAgent: "claude",
      targetSessionId: "claude-session-1",
      targetFilePath: "/tmp/claude/session.jsonl",
      strategy: "ai-compressed",
      createdAt: Date.parse("2026-06-01T10:00:00Z"),
      ...overrides,
    };
  }

  it("migrates old sessions tables before creating environment indexes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        raw_id TEXT NOT NULL,
        source TEXT NOT NULL,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_title TEXT NOT NULL,
        first_question TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        file_mtime_ms REAL NOT NULL,
        file_size INTEGER NOT NULL,
        pr_url TEXT,
        pr_number INTEGER,
        custom_title TEXT,
        favorited INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER,
        last_resumed_at INTEGER,
        message_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      `
      INSERT INTO sessions (
        session_key, raw_id, source, project_path, file_path, original_title, first_question,
        timestamp, file_mtime_ms, file_size, pr_url, pr_number, message_count,
        input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, total_tokens
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "codex:old",
      "old",
      "codex-cli",
      "/repo",
      "/tmp/old.jsonl",
      "Old title",
      "Old question",
      1,
      2,
      3,
      null,
      null,
      0,
      0,
      0,
      0,
      0,
      0,
    );

    const store = new SessionStore(db);

    expect(store.getSession("codex:old")).toMatchObject({
      sessionKey: "codex:old",
      environmentId: "local",
      environmentKind: "local",
      environmentLabel: "Local",
      fileMtimeMs: 0,
      isSubagent: false,
      parentSessionId: null,
    });
    expect(store.listEnvironments()).toEqual([expect.objectContaining({ id: "local", label: "Local" })]);
  });

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

  it("uses the indexed title for display when first question is a long remote summary prompt", () => {
    const store = createInMemoryStore();
    const longFirstQuestion = [
      "# AGENTS.md instructions for /data00/home/xuguowei.x/meta_resource_generator",
      "<INSTRUCTIONS>",
      "Global Coding Preferences - Before concrete code work or commit preparation, read the target repository's local rules first.",
    ].join("\n");
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "ssh:dev:codex:remote",
        rawId: "remote",
        environmentId: "ssh-dev",
        environmentKind: "ssh",
        environmentLabel: "SSH · dev",
        originalTitle: "# AGENTS.md instructions for /data00/home/xuguowei.x/meta_resource_generator",
        firstQuestion: longFirstQuestion,
      }),
      [],
    );

    const session = store.getSession("ssh:dev:codex:remote");

    expect(session?.displayTitle).toBe("# AGENTS.md instructions for /data00/home/xuguowei.x/meta_resource_generator");
    expect(session?.displayTitle).not.toContain("<INSTRUCTIONS>");
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

  it("stores skill sync bindings for local and remote lookup", () => {
    const store = createInMemoryStore();

    store.upsertSkillSyncBinding({
      localSkillPath: "/tmp/.codex/skills/review-code/SKILL.md",
      remoteSkillId: "remote-review",
      remoteUpdatedAt: "2026-06-29T10:00:00.000Z",
      remoteVersion: 3,
      lastSyncedAt: 100,
      direction: "upload",
    });

    expect(store.getSkillSyncBindingForLocalPath("/tmp/.codex/skills/review-code/SKILL.md")).toEqual({
      localSkillPath: "/tmp/.codex/skills/review-code/SKILL.md",
      remoteSkillId: "remote-review",
      remoteUpdatedAt: "2026-06-29T10:00:00.000Z",
      remoteVersion: 3,
      lastSyncedAt: 100,
      direction: "upload",
    });
    expect(store.getSkillSyncBindingForRemoteId("remote-review")?.localSkillPath).toBe("/tmp/.codex/skills/review-code/SKILL.md");

    store.upsertSkillSyncBinding({
      localSkillPath: "/tmp/.codex/skills/review-code/SKILL.md",
      remoteSkillId: "remote-review",
      remoteUpdatedAt: "2026-06-29T11:00:00.000Z",
      remoteVersion: 5,
      lastSyncedAt: 200,
      direction: "download",
    });

    expect(store.listSkillSyncBindings()).toEqual([
      {
        localSkillPath: "/tmp/.codex/skills/review-code/SKILL.md",
        remoteSkillId: "remote-review",
        remoteUpdatedAt: "2026-06-29T11:00:00.000Z",
        remoteVersion: 5,
        lastSyncedAt: 200,
        direction: "download",
      },
    ]);

    store.close();
  });

  it("rebinds a remote skill to the latest local path instead of crashing on the unique remote id", () => {
    const store = createInMemoryStore();
    try {
      store.upsertSkillSyncBinding({
        localSkillPath: "/tmp/.claude/skills/foo/SKILL.md",
        remoteSkillId: "remote-foo",
        remoteUpdatedAt: "2026-06-29T10:00:00.000Z",
        remoteVersion: 1,
        lastSyncedAt: 100,
        direction: "upload",
      });

      // A different local skill that shares the same agent+name resolves to the same remote
      // fingerprint/id. Re-binding must move the remote pointer, not violate UNIQUE(remote_skill_id).
      expect(() =>
        store.upsertSkillSyncBinding({
          localSkillPath: "/work/project/.claude/skills/foo/SKILL.md",
          remoteSkillId: "remote-foo",
          remoteUpdatedAt: "2026-06-29T11:00:00.000Z",
          remoteVersion: 2,
          lastSyncedAt: 200,
          direction: "upload",
        }),
      ).not.toThrow();

      expect(store.listSkillSyncBindings()).toEqual([
        {
          localSkillPath: "/work/project/.claude/skills/foo/SKILL.md",
          remoteSkillId: "remote-foo",
          remoteUpdatedAt: "2026-06-29T11:00:00.000Z",
          remoteVersion: 2,
          lastSyncedAt: 200,
          direction: "upload",
        },
      ]);
      expect(store.getSkillSyncBindingForRemoteId("remote-foo")?.localSkillPath).toBe("/work/project/.claude/skills/foo/SKILL.md");
      expect(store.getSkillSyncBindingForLocalPath("/tmp/.claude/skills/foo/SKILL.md")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("records duplicate session migrations and lists them in descending creation order", () => {
    const store = createInMemoryStore();
    try {
      store.recordSessionMigration(migrationRecord({ id: "migration-a", createdAt: 100 }));
      store.recordSessionMigration(migrationRecord({ id: "migration-b", createdAt: 200 }));
      store.recordSessionMigration(migrationRecord({ id: "migration-c", createdAt: 200, targetSessionId: "claude-session-3" }));
      store.recordSessionMigration(migrationRecord({ id: "migration-d", createdAt: 200, sourceSessionKey: "codex:other" }));

      expect(store.listSessionMigrations("codex:abc")).toEqual([
        migrationRecord({ id: "migration-c", createdAt: 200, targetSessionId: "claude-session-3" }),
        migrationRecord({ id: "migration-b", createdAt: 200 }),
        migrationRecord({ id: "migration-a", createdAt: 100 }),
      ]);
      expect(store.listSessionMigrations("codex:other")).toEqual([
        migrationRecord({ id: "migration-d", createdAt: 200, sourceSessionKey: "codex:other" }),
      ]);
    } finally {
      store.close();
    }
  });

  it("round-trips a concrete migration target without changing the SQLite schema", () => {
    const store = createInMemoryStore();
    try {
      const record = migrationRecord({ targetAgent: "tcodex" });
      store.recordSessionMigration(record);

      expect(store.listSessionMigrations(record.sourceSessionKey)).toEqual([record]);
      const columns = (store as unknown as { db: InstanceType<typeof DatabaseSync> }).db
        .prepare("PRAGMA table_info(session_migrations)")
        .all() as Array<{ name: string; type: string }>;
      expect(columns.find(({ name }) => name === "target_agent")?.type).toBe("TEXT");
    } finally {
      store.close();
    }
  });

  it("rejects an unregistered migration target read from SQLite", () => {
    const store = createInMemoryStore();
    try {
      const db = (store as unknown as { db: InstanceType<typeof DatabaseSync> }).db;
      db.prepare(`
        INSERT INTO session_migrations (
          id, source_session_key, source_agent, target_agent, target_session_id, target_file_path, strategy, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("bad-target", "codex:abc", "codex", "hermes", "id", "/tmp/id", "complete", 1);

      expect(() => store.listSessionMigrations("codex:abc")).toThrow("Unsupported migration target: hermes");
    } finally {
      store.close();
    }
  });

  it("persists session migrations across database reopen with unicode paths and all strategy values", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-migration-"));
    const dbPath = path.join(tempDir, "store.sqlite");
    const firstStore = new SessionStore(dbPath);
    const reopenedStore = new SessionStore(dbPath);
    try {
      firstStore.recordSessionMigration(
        migrationRecord({
          id: "migration-unicode",
          sourceSessionKey: "claude:一二三",
          sourceAgent: "claude",
          targetAgent: "codebuddy",
          targetSessionId: "codebuddy-session-😀",
          targetFilePath: "/tmp/迁移/会话.jsonl",
          strategy: "complete",
          createdAt: 300,
        }),
      );
      firstStore.recordSessionMigration(
        migrationRecord({
          id: "migration-truncated",
          sourceSessionKey: "claude:一二三",
          sourceAgent: "claude",
          targetAgent: "claude",
          targetSessionId: "claude-session-2",
          targetFilePath: "/tmp/迁移/截断.jsonl",
          strategy: "locally-truncated",
          createdAt: 200,
        }),
      );

      expect(reopenedStore.listSessionMigrations("claude:一二三")).toEqual([
        migrationRecord({
          id: "migration-unicode",
          sourceSessionKey: "claude:一二三",
          sourceAgent: "claude",
          targetAgent: "codebuddy",
          targetSessionId: "codebuddy-session-😀",
          targetFilePath: "/tmp/迁移/会话.jsonl",
          strategy: "complete",
          createdAt: 300,
        }),
        migrationRecord({
          id: "migration-truncated",
          sourceSessionKey: "claude:一二三",
          sourceAgent: "claude",
          targetAgent: "claude",
          targetSessionId: "claude-session-2",
          targetFilePath: "/tmp/迁移/截断.jsonl",
          strategy: "locally-truncated",
          createdAt: 200,
        }),
      ]);
    } finally {
      firstStore.close();
      reopenedStore.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the composite session migration index for ordered lookups", () => {
    const store = createInMemoryStore();
    try {
      store.recordSessionMigration(migrationRecord({ id: "migration-a", createdAt: 100 }));
      store.recordSessionMigration(migrationRecord({ id: "migration-b", createdAt: 200 }));

      const db = store as unknown as { db: import("node:sqlite").DatabaseSync };
      const plan = db.db
        .prepare(
          `
          EXPLAIN QUERY PLAN
          SELECT id, source_session_key, source_agent, target_agent, target_session_id, target_file_path, strategy, created_at
          FROM session_migrations
          WHERE source_session_key = ?
          ORDER BY created_at DESC, id DESC
        `,
        )
        .all("codex:abc") as Array<{ detail: string }>;

      expect(plan.map((row) => row.detail).join("\n")).toContain("USING INDEX idx_session_migrations_source_session_key_created_at_id");
      expect(plan.map((row) => row.detail).join("\n")).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    } finally {
      store.close();
    }
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

  it("hard deletes a session source file and removes indexed data", () => {
    const store = createInMemoryStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-delete-session-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(filePath, "{}\n", "utf8");
    const session = sampleSession({
      filePath,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 20,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 30,
      },
    });
    store.upsertIndexedSession(session, messages);
    store.addTag("codex:abc", "backend");

    expect(fs.existsSync(filePath)).toBe(true);
    expect(store.deleteSession("codex:abc")).toBe(true);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.getSession("codex:abc")).toBeNull();
    expect(store.getMessages("codex:abc")).toEqual([]);
    expect(store.searchSessions({ query: "" })).toEqual([]);
    expect(store.searchSessions({ query: "refresh token" })).toEqual([]);
    expect(store.searchSessions({ visibility: "hidden" })).toEqual([]);
    expect(store.listTags()).toEqual([]);
    expect(store.listProjects()).toEqual([]);
    expect(store.getStats({ period: "allTime" }).total).toMatchObject({
      sessionCount: 0,
      messageCount: 0,
      totalTokens: 0,
    });
    expect(store.deleteSession("codex:abc")).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not delete shared SQLite source databases for database-backed agent sessions", () => {
    const store = createInMemoryStore();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-delete-db-session-"));
    const filePath = path.join(dir, "state.db");
    fs.writeFileSync(filePath, "sqlite placeholder", "utf8");
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "hermes:abc",
        rawId: "abc",
        source: "hermes",
        filePath,
      }),
      messages,
    );

    expect(() => store.deleteSession("hermes:abc")).toThrow("Cannot delete shared Hermes source database.");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(store.getSession("hermes:abc")).not.toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
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

    const createdAt = new Date("2026-06-01T10:00:00Z").getTime();
    const lastActivityAt = new Date("2026-06-01T10:01:00Z").getTime();
    expect(store.listProjects()).toEqual([
      {
        path: "/work/team-a/app",
        label: "team-a/app",
        sessionCount: 2,
        environmentId: "local",
        environmentLabel: "Local",
        createdAt,
        lastActivityAt,
      },
      {
        path: "/work/team-b/app",
        label: "team-b/app",
        sessionCount: 1,
        environmentId: "local",
        environmentLabel: "Local",
        createdAt,
        lastActivityAt,
      },
    ]);
  });

  it("lists project creation and latest activity timestamps", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:old-active",
        rawId: "old-active",
        projectPath: "/work/app",
        timestamp: Date.parse("2026-06-01T10:00:00Z"),
        fileMtimeMs: Date.parse("2026-06-01T10:00:00Z"),
      }),
      [{ role: "user", content: "latest project conversation", timestamp: "2026-06-04T10:00:00Z", index: 0 }],
    );
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:new-created",
        rawId: "new-created",
        projectPath: "/work/app",
        timestamp: Date.parse("2026-06-03T10:00:00Z"),
        fileMtimeMs: Date.parse("2026-06-03T10:00:00Z"),
      }),
      [{ role: "user", content: "older project conversation", timestamp: "2026-06-02T10:00:00Z", index: 0 }],
    );

    expect(store.listProjects()).toEqual([
      {
        path: "/work/app",
        label: "app",
        sessionCount: 2,
        environmentId: "local",
        environmentLabel: "Local",
        createdAt: Date.parse("2026-06-03T10:00:00Z"),
        lastActivityAt: Date.parse("2026-06-04T10:00:00Z"),
      },
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

  it("sorts default results by recent conversation time", () => {
    const store = createInMemoryStore();
    const oldButRecent = sampleSession({
      sessionKey: "codex:recent",
      rawId: "recent",
      timestamp: new Date("2026-05-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-05-01T10:00:00Z").getTime(),
    });
    const newerButOlderConversation = sampleSession({
      sessionKey: "codex:created",
      rawId: "created",
      timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T10:00:00Z").getTime(),
    });
    store.upsertIndexedSession(oldButRecent, [
      { role: "user", content: "newer conversation", timestamp: "2026-06-02T10:00:00Z", index: 0 },
    ]);
    store.upsertIndexedSession(newerButOlderConversation, [
      { role: "user", content: "older conversation", timestamp: "2026-06-01T10:00:00Z", index: 0 },
    ]);

    expect(store.searchSessions({ query: "" }).map((session) => session.sessionKey)).toEqual(["codex:recent", "codex:created"]);
  });

  it("sorts by explicit recent conversation and created time modes", () => {
    const store = createInMemoryStore();
    const oldButRecent = sampleSession({
      sessionKey: "codex:recent",
      rawId: "recent",
      timestamp: new Date("2026-05-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T12:00:00Z").getTime(),
    });
    const newButOlderConversation = sampleSession({
      sessionKey: "codex:created",
      rawId: "created",
      timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T10:00:00Z").getTime(),
    });
    store.upsertIndexedSession(oldButRecent, [
      { role: "user", content: "newer conversation", timestamp: "2026-06-02T10:00:00Z", index: 0 },
    ]);
    store.upsertIndexedSession(newButOlderConversation, [
      { role: "user", content: "older conversation", timestamp: "2026-06-01T10:00:00Z", index: 0 },
    ]);

    expect(store.searchSessions({ query: "", sortBy: "activity" }).map((session) => session.sessionKey)).toEqual([
      "codex:recent",
      "codex:created",
    ]);
    expect(store.searchSessions({ query: "", sortBy: "created" }).map((session) => session.sessionKey)).toEqual([
      "codex:created",
      "codex:recent",
    ]);
  });

  it("sorts activity by latest conversation time instead of resume time", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:resumed",
        rawId: "resumed",
        timestamp: Date.parse("2026-06-01T10:00:00Z"),
        fileMtimeMs: Date.parse("2026-06-01T10:00:00Z"),
      }),
      [{ role: "user", content: "old conversation", timestamp: "2026-06-02T10:00:00Z", index: 0 }],
    );
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:conversation",
        rawId: "conversation",
        timestamp: Date.parse("2026-06-01T10:00:00Z"),
        fileMtimeMs: Date.parse("2026-06-01T10:00:00Z"),
      }),
      [{ role: "user", content: "new conversation", timestamp: "2026-06-03T10:00:00Z", index: 0 }],
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T10:00:00Z"));
    try {
      store.markResumed("codex:resumed");
    } finally {
      vi.useRealTimers();
    }

    const results = store.searchSessions({ query: "", sortBy: "activity" });
    expect(results.map((session) => session.sessionKey)).toEqual(["codex:conversation", "codex:resumed"]);
    expect(results[0].lastActivityAt).toBe(Date.parse("2026-06-03T10:00:00Z"));
    expect(results[1].lastActivityAt).toBe(Date.parse("2026-06-02T10:00:00Z"));
  });

  it("sorts summary-only sessions by remote message events before shared database mtime", () => {
    const store = createInMemoryStore();
    const sharedDatabaseMtime = Date.parse("2026-07-15T03:38:18Z");
    store.upsertIndexedSessionSummary(
      sampleSession({
        sessionKey: "codewiz:old",
        rawId: "old",
        source: "codewiz-cli",
        timestamp: Date.parse("2026-06-01T10:00:00Z"),
        fileMtimeMs: sharedDatabaseMtime,
      }),
      1,
      [],
      [{ index: 0, timestamp: Date.parse("2026-06-01T10:01:00Z") }],
    );
    store.upsertIndexedSessionSummary(
      sampleSession({
        sessionKey: "codewiz:recent",
        rawId: "recent",
        source: "codewiz-cli",
        timestamp: Date.parse("2026-06-02T10:00:00Z"),
        fileMtimeMs: sharedDatabaseMtime,
      }),
      1,
      [],
      [{ index: 0, timestamp: Date.parse("2026-06-02T10:01:00Z") }],
    );

    const results = store.searchSessions({ source: "codewiz-cli", sortBy: "activity" });
    expect(results.map((session) => session.sessionKey)).toEqual(["codewiz:recent", "codewiz:old"]);
    expect(results.map((session) => session.lastActivityAt)).toEqual([
      Date.parse("2026-06-02T10:01:00Z"),
      Date.parse("2026-06-01T10:01:00Z"),
    ]);
  });

  it("filters sessions by activity date range", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:recent",
        rawId: "recent",
        timestamp: Date.parse("2026-06-01T10:00:00Z"),
        fileMtimeMs: Date.parse("2026-06-01T10:00:00Z"),
      }),
      [{ role: "user", content: "recent conversation", timestamp: "2026-06-10T10:00:00Z", index: 0 }],
    );
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:old",
        rawId: "old",
        timestamp: Date.parse("2026-05-01T10:00:00Z"),
        fileMtimeMs: Date.parse("2026-05-01T10:00:00Z"),
      }),
      [{ role: "user", content: "old conversation", timestamp: "2026-05-20T10:00:00Z", index: 0 }],
    );

    const page = store.searchSessionPage({
      query: "",
      dateFrom: Date.parse("2026-06-01T00:00:00Z"),
      dateTo: Date.parse("2026-06-30T23:59:59Z"),
      limit: 10,
    });

    expect(page.sessions.map((session) => session.sessionKey)).toEqual(["codex:recent"]);
    expect(page.totalCount).toBe(1);
  });

  it("returns a limited search page with the total matching session count", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:one",
        rawId: "one",
        timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
      }),
      messages,
    );
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:two",
        rawId: "two",
        timestamp: new Date("2026-06-02T10:00:00Z").getTime(),
      }),
      messages,
    );
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:three",
        rawId: "three",
        timestamp: new Date("2026-06-03T10:00:00Z").getTime(),
      }),
      messages,
    );

    const page = store.searchSessionPage({ query: "", sortBy: "created", limit: 2 });

    expect(page.sessions.map((session) => session.sessionKey)).toEqual(["codex:three", "codex:two"]);
    expect(page.totalCount).toBe(3);
    expect(page.hasMore).toBe(true);
  });

  it("applies live status filtering before page limits", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:closed-newest",
        rawId: "closed-newest",
        timestamp: new Date("2026-06-03T10:00:00Z").getTime(),
      }),
      messages,
    );
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:open-oldest",
        rawId: "open-oldest",
        timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
      }),
      messages,
    );

    const page = store.searchSessionPage({
      query: "",
      sortBy: "created",
      limit: 1,
      liveStatus: "open",
      liveSessionKeys: ["codex:open-oldest"],
    } as SearchOptions);

    expect(page.sessions.map((session) => session.sessionKey)).toEqual(["codex:open-oldest"]);
    expect(page.totalCount).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it("counts closed live status pages after excluding open sessions", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:open-newest",
        rawId: "open-newest",
        timestamp: new Date("2026-06-03T10:00:00Z").getTime(),
      }),
      messages,
    );
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "codex:closed-oldest",
        rawId: "closed-oldest",
        timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
      }),
      messages,
    );

    const page = store.searchSessionPage({
      query: "",
      sortBy: "created",
      limit: 1,
      liveStatus: "closed",
      liveSessionKeys: ["codex:open-newest"],
    } as SearchOptions);

    expect(page.sessions.map((session) => session.sessionKey)).toEqual(["codex:closed-oldest"]);
    expect(page.totalCount).toBe(1);
    expect(page.hasMore).toBe(false);
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

  it("limits trace events to the visible message timestamp window", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages, [], traceEvents);

    expect(
      store.getTraceEvents("codex:abc", {
        startTimestamp: "2026-06-01T10:02:30Z",
        endTimestamp: "2026-06-01T10:04:00Z",
        limit: 1,
      }),
    ).toEqual([traceEvents[1]]);
  });

  it("creates a local environment and stores environment metadata on sessions", () => {
    const store = createInMemoryStore();

    store.upsertIndexedSession(sampleSession(), messages);

    expect(store.listEnvironments()).toEqual([
      expect.objectContaining({
        id: "local",
        kind: "local",
        label: "Local",
        enabled: true,
        syncState: "idle",
      }),
    ]);
    expect(store.getSession("codex:abc")).toMatchObject({
      environmentId: "local",
      environmentKind: "local",
      environmentLabel: "Local",
    });
  });

  it("updates environment sync state while preserving omitted values and clearing explicit nulls", () => {
    const store = createInMemoryStore();
    store.upsertEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      host: "devbox.example.com",
      enabled: true,
    });

    store.updateEnvironmentSyncState("ssh-devbox", "syncing", { lastSyncedAt: 123, lastError: "boom" });
    store.updateEnvironmentSyncState("ssh-devbox", "watching");

    expect(store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "watching",
      lastSyncedAt: 123,
      lastError: "boom",
    });

    store.updateEnvironmentSyncState("ssh-devbox", "idle", { lastSyncedAt: null, lastError: null });

    expect(store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "idle",
      lastSyncedAt: null,
      lastError: null,
    });
  });

  it("truncates large stored environment errors before returning them to the renderer", () => {
    const store = createInMemoryStore();
    store.upsertEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      enabled: true,
    });

    store.updateEnvironmentSyncState("ssh-devbox", "error", {
      lastError: `${JSON.stringify({ kind: "codex-session", path: "/secret/path", contentBase64: "AAAA" })}\n`.repeat(1000),
    });

    const environment = store.getEnvironment("ssh-devbox");
    expect(environment?.lastError?.length).toBeLessThan(700);
    expect(environment?.lastError).toContain("truncated");
    expect(environment?.lastError).not.toContain("/secret/path");
  });

  it("does not allow public environment upserts to mutate the built-in local environment", () => {
    const store = createInMemoryStore();

    store.upsertEnvironment({
      id: "local",
      kind: "ssh",
      label: "not-local",
      hostAlias: "remote",
      host: "remote.example.com",
      user: "you",
      port: 22,
      authMode: "identityFile",
      identityFile: "~/.ssh/id_ed25519",
      enabled: false,
    });

    expect(store.getEnvironment("local")).toMatchObject({
      id: "local",
      kind: "local",
      label: "Local",
      hostAlias: null,
      host: null,
      user: null,
      port: null,
      authMode: "none",
      identityFile: null,
      enabled: true,
      syncState: "idle",
    });
  });

  it("generates distinct ids for ssh environments with duplicate labels", () => {
    const store = createInMemoryStore();

    const first = store.upsertEnvironment({
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox-a",
      host: "devbox-a.example.com",
    });
    const second = store.upsertEnvironment({
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox-b",
      host: "devbox-b.example.com",
    });

    expect(first.id).toBe("devbox");
    expect(second.id).toBe("devbox-2");
    expect(first.id).not.toBe(second.id);
    expect(
      store
        .listEnvironments()
        .filter((environment) => environment.kind === "ssh" && environment.label === "devbox")
        .map((environment) => environment.id),
    ).toEqual(["devbox", "devbox-2"]);
  });

  it("updates an existing ssh config environment when host alias is saved again", () => {
    const store = createInMemoryStore();

    const first = store.upsertEnvironment({
      kind: "ssh",
      label: "dev",
      hostAlias: "dev",
      host: "old.example.com",
      enabled: true,
    });
    const second = store.upsertEnvironment({
      kind: "ssh",
      label: "dev",
      hostAlias: "dev",
      host: "new.example.com",
      enabled: true,
    });

    expect(second.id).toBe(first.id);
    expect(store.listEnvironments().filter((environment) => environment.kind === "ssh" && environment.hostAlias === "dev")).toEqual([
      expect.objectContaining({ id: first.id, host: "new.example.com" }),
    ]);
  });

  it("does not route generated local-like ids through the built-in local environment", () => {
    const store = createInMemoryStore();

    const generated = store.upsertEnvironment({
      kind: "ssh",
      label: "Local",
      hostAlias: "local-devbox",
      host: "local-devbox.example.com",
    });

    expect(generated).toMatchObject({
      id: "ssh-local",
      kind: "ssh",
      label: "Local",
      hostAlias: "local-devbox",
    });
    expect(store.getEnvironment("local")).toMatchObject({
      id: "local",
      kind: "local",
      label: "Local",
    });
  });

  it("filters sessions by environment and composes with source, project, and tag filters", () => {
    const store = createInMemoryStore();
    store.upsertEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      host: "devbox.example.com",
      user: "you",
      port: 22,
      authMode: "identityFile",
      identityFile: "~/.ssh/id_ed25519",
      enabled: true,
    });
    store.upsertIndexedSession(sampleSession(), messages);
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "ssh:ssh-devbox:claude:remote-1",
        rawId: "remote-1",
        source: "claude-cli",
        projectPath: "/work/app",
        environmentId: "ssh-devbox",
        environmentKind: "ssh",
        environmentLabel: "devbox",
      }),
      messages,
    );
    store.addTag("ssh:ssh-devbox:claude:remote-1", "remote");

    expect(store.searchSessions({ environmentId: "local" }).map((session) => session.sessionKey)).toEqual(["codex:abc"]);
    expect(store.searchSessions({ environmentId: "ssh-devbox" }).map((session) => session.sessionKey)).toEqual([
      "ssh:ssh-devbox:claude:remote-1",
    ]);
    expect(
      store.searchSessions({ environmentId: "ssh-devbox", source: "claude", projectPath: "/work/app", tag: "remote" }).map(
        (session) => session.sessionKey,
      ),
    ).toEqual(["ssh:ssh-devbox:claude:remote-1"]);
  });

  it("lists project labels with environment hints when paths repeat across environments", () => {
    const store = createInMemoryStore();
    store.upsertEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      host: "devbox.example.com",
      user: null,
      port: null,
      authMode: "none",
      identityFile: null,
      enabled: true,
    });
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:local", rawId: "local", projectPath: "/work/app" }), messages);
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "ssh:ssh-devbox:codex:remote",
        rawId: "remote",
        projectPath: "/work/app",
        environmentId: "ssh-devbox",
        environmentKind: "ssh",
        environmentLabel: "devbox",
      }),
      messages,
    );

    const createdAt = new Date("2026-06-01T10:00:00Z").getTime();
    const lastActivityAt = new Date("2026-06-01T10:01:00Z").getTime();
    expect(store.listProjects()).toEqual([
      {
        path: "/work/app",
        label: "app · Local",
        sessionCount: 1,
        environmentId: "local",
        environmentLabel: "Local",
        createdAt,
        lastActivityAt,
      },
      {
        path: "/work/app",
        label: "app · devbox",
        sessionCount: 1,
        environmentId: "ssh-devbox",
        environmentLabel: "devbox",
        createdAt,
        lastActivityAt,
      },
    ]);
  });

  it("deletes an ssh environment with its sessions and unused tags", () => {
    const store = createInMemoryStore();
    store.upsertEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      host: "devbox.example.com",
      enabled: true,
    });
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:local", rawId: "local" }), messages, [], traceEvents);
    store.addTag("codex:local", "shared");
    store.upsertIndexedSession(
      sampleSession({
        sessionKey: "ssh:ssh-devbox:codex:remote",
        rawId: "remote",
        projectPath: "/work/app",
        environmentId: "ssh-devbox",
      }),
      messages,
      [
        {
          dedupeKey: "remote-token",
          timestamp: 123,
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 3,
        },
      ],
      traceEvents,
    );
    store.addTag("ssh:ssh-devbox:codex:remote", "shared");
    store.addTag("ssh:ssh-devbox:codex:remote", "remote-only");

    store.deleteEnvironment("ssh-devbox");

    expect(store.getEnvironment("ssh-devbox")).toBeNull();
    expect(store.searchSessions({ environmentId: "ssh-devbox" })).toEqual([]);
    expect(store.getSession("ssh:ssh-devbox:codex:remote")).toBeNull();
    expect(store.getMessages("ssh:ssh-devbox:codex:remote")).toEqual([]);
    expect(store.getTraceEvents("ssh:ssh-devbox:codex:remote")).toEqual([]);
    expect(store.getSession("codex:local")).toMatchObject({ environmentId: "local", tags: ["shared"] });
    expect(store.listTags()).toEqual(["shared"]);
  });

  it("rejects deleting the built-in local environment", () => {
    const store = createInMemoryStore();

    expect(() => store.deleteEnvironment("local")).toThrow(/local environment cannot be deleted/i);
    expect(store.getEnvironment("local")).toMatchObject({ id: "local", kind: "local" });
  });
});
