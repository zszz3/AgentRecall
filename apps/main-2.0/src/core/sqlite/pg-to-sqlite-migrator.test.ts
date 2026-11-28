import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationStore } from "../../automation/engine/main/evaluation-store";
import { PostgresAppStore } from "../../automation/engine/main/hub/persisted/postgres-store";
import { SqliteAppStore } from "../../automation/engine/main/hub/persisted/sqlite-store";
import { McpRegistryStore } from "../../automation/engine/main/mcp-registry-store";
import { SqliteEvaluationStore } from "../../automation/engine/main/sqlite-evaluation-store";
import { SqliteMcpRegistryStore } from "../../automation/engine/main/sqlite-mcp-registry-store";
import { PostgresDatabase } from "../postgres/database";
import { PostgresEnvironmentRepository } from "../postgres/environment-repository";
import { PostgresMemoryCardRepository } from "../postgres/memory-card-repository";
import { PostgresMetadataRepository } from "../postgres/metadata-repository";
import { PostgresRuntimeInvocationRepository } from "../postgres/runtime-invocation-repository";
import { POSTGRES_MIGRATIONS } from "../postgres/schema";
import { PostgresSessionRepository } from "../postgres/session-repository";
import { PostgresSkillRepository } from "../postgres/skill-repository";
import { PostgresTeamSessionRepository } from "../postgres/team-session-repository";
import { PGliteTestPool } from "../postgres/test-pglite";
import { SavedSearchStore } from "../store/saved-searches";
import { SearchHistoryStore } from "../store/search-history-store";
import {
  isSqliteConnectionUrl,
  parseSqliteConnectionUrl,
  resolveDbEngine,
  SqliteDatabase,
  toSqliteConnectionUrl,
} from "./database";
import { SqliteEnvironmentRepository } from "./environment-repository";
import { SqliteMemoryCardRepository } from "./memory-card-repository";
import { SqliteMetadataRepository } from "./metadata-repository";
import {
  migratePostgresDatabaseToSqlite,
  PG_TO_SQLITE_MIGRATION_TABLES,
} from "./pg-to-sqlite-migrator";
import { SqliteSavedSearchStore } from "./saved-searches-store";
import { SQLITE_MIGRATIONS } from "./schema";
import { SqliteSearchHistoryStore } from "./search-history-store";
import { SqliteSessionRepository } from "./session-repository";
import { SqliteSessionSearchRepository } from "./session-search-repository";
import { SqliteSessionTurnRepository } from "./session-turn-repository";
import { SqliteSkillRepository } from "./skill-repository";
import { SqliteTeamSessionRepository } from "./team-session-repository";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentrecall-pg-to-sqlite-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("SQLite connection URL helpers", () => {
  it("round-trips paths and resolves engine defaults safely", () => {
    expect(resolveDbEngine({})).toBe("sqlite");
    expect(resolveDbEngine({ AGENT_RECALL_DB_ENGINE: "postgres" })).toBe("postgres");
    expect(resolveDbEngine({ AGENT_RECALL_DB_ENGINE: "sqlite" })).toBe("sqlite");
    expect(resolveDbEngine({ AGENT_RECALL_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db" })).toBe("postgres");
    expect(resolveDbEngine({
      AGENT_RECALL_DB_ENGINE: "sqlite",
      AGENT_RECALL_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
    })).toBe("sqlite");
    expect(resolveDbEngine({ AGENT_RECALL_DATABASE_URL: "sqlite:/tmp/test.sqlite" })).toBe("sqlite");

    const url = toSqliteConnectionUrl("/tmp/agent recall #1/agent-recall.sqlite");
    expect(isSqliteConnectionUrl(url)).toBe(true);
    expect(isSqliteConnectionUrl("postgresql://127.0.0.1:5432/db")).toBe(false);
    expect(parseSqliteConnectionUrl(url)).toBe(path.resolve("/tmp/agent recall #1/agent-recall.sqlite"));
    expect(parseSqliteConnectionUrl(toSqliteConnectionUrl(":memory:"))).toBe(":memory:");
    expect(parseSqliteConnectionUrl("sqlite:C:\\Users\\demo\\agent-recall.sqlite"))
      .toBe("C:\\Users\\demo\\agent-recall.sqlite");
    expect(() => parseSqliteConnectionUrl("postgresql://127.0.0.1/db")).toThrow(/Expected sqlite:/);
  });
});

describe("migratePostgresDatabaseToSqlite", () => {
  it("covers every non-internal table and column defined in SQLITE_MIGRATIONS", async () => {
    const db = SqliteDatabase.open(":memory:", { migrations: SQLITE_MIGRATIONS });
    await db.initialize();
    try {
      const schemaTables = db
        .all<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%'
             AND name <> 'schema_migrations'
             AND name NOT LIKE '%\\_fts%' ESCAPE '\\'
           ORDER BY name`,
        )
        .map((row) => row.name);
      const migratorTables = PG_TO_SQLITE_MIGRATION_TABLES.map((spec) => spec.table).sort();
      expect(migratorTables).toEqual(schemaTables);

      for (const spec of PG_TO_SQLITE_MIGRATION_TABLES) {
        const schemaColumns = db
          .all<{ name: string }>(`PRAGMA table_info("${spec.table}")`)
          .map((row) => row.name);
        const migratorColumns = spec.columns.map(([name]) => name);
        expect(migratorColumns, `columns mismatch for ${spec.table}`).toEqual(schemaColumns);
      }
    } finally {
      await db.close();
    }
  });

  it("migrates all domains atomically with exact parity, FTS5 search, and clean AUTOINCREMENT continuation", async () => {
    const dir = makeTempDir();
    const pg = new PostgresDatabase(new PGliteTestPool(), {
      migrations: POSTGRES_MIGRATIONS,
      migrationLock: false,
    });
    await pg.initialize();

    const pgEnv = new PostgresEnvironmentRepository(pg);
    const pgSessions = new PostgresSessionRepository(pg);
    const pgMetadata = new PostgresMetadataRepository(pg);
    const pgSkills = new PostgresSkillRepository(pg);
    const pgSaved = new SavedSearchStore(pg);
    const pgHistory = new SearchHistoryStore(pg);
    const pgInvocations = new PostgresRuntimeInvocationRepository(pg);
    const pgMcp = new McpRegistryStore(pg);
    const pgApp = new PostgresAppStore(pg);
    const pgEval = new EvaluationStore(pg);
    const pgTeam = new PostgresTeamSessionRepository(pg);
    const pgCards = new PostgresMemoryCardRepository(pg);

    // 1. Environments
    await pgEnv.upsertEnvironment({
      id: "ssh-dev",
      kind: "ssh",
      label: "Dev Box",
      hostAlias: "dev",
      host: "10.0.0.2",
      user: "alice",
      port: 2222,
      authMode: "identityFile",
      identityFile: "~/.ssh/id_ed25519",
      enabled: true,
    });

    // 2. Sessions + turns + messages + spans (including nested parent/child) + tokens + tags
    const baseTime = new Date("2026-10-01T10:00:00.000Z").getTime();
    await pgSessions.upsertIndexedSession(
      {
        sessionKey: "codex:mig-1",
        rawId: "mig-1",
        source: "codex-cli",
        environmentId: "local",
        storageEnvironmentId: "local",
        projectPath: "/repo/alpha",
        filePath: "/repo/alpha/session.jsonl",
        originalTitle: "SQLite Migration Verification",
        firstQuestion: "如何排查认证超时",
        timestamp: baseTime,
        fileMtimeMs: baseTime + 1000,
        fileSize: 4096,
        prUrl: null,
        prNumber: null,
      },
      [
        { role: "user", content: "如何排查认证超时问题", timestamp: new Date(baseTime).toISOString(), index: 0 },
        { role: "assistant", content: "检查 token 过期时间与 WAL busy_timeout 配置。", timestamp: new Date(baseTime + 500).toISOString(), index: 1 },
      ],
      [
        {
          dedupeKey: "tok-1",
          timestamp: baseTime + 500,
          inputTokens: 120,
          outputTokens: 45,
          cachedInputTokens: 30,
          cacheCreationInputTokens: 10,
          reasoningOutputTokens: 5,
          totalTokens: 165,
        },
      ],
      [
        {
          index: 0,
          kind: "tool_call",
          source: "codex",
          title: "rg_search",
          detail: JSON.stringify({ query: "busy_timeout" }),
          timestamp: new Date(baseTime + 200).toISOString(),
        },
      ],
    );
    await pgSessions.setCustomTitle("codex:mig-1", "自定义迁移会话");
    await pgSessions.setFavorited("codex:mig-1", true);
    await pgSessions.setAiSummary("codex:mig-1", "认证超时与 SQLite 并发配置总结", "gpt-5");
    await pgSessions.addTag("codex:mig-1", "sqlite");
    await pgSessions.addTag("codex:mig-1", "urgent");

    // Insert nested parent/child trace_spans with child id sorting before parent id
    // to exercise self-referencing FK handling.
    const turnRow = (await pg.query<{ id: string }>(
      "SELECT id FROM agent_recall.session_turns WHERE session_key = $1 LIMIT 1",
      ["codex:mig-1"],
    )).rows[0]!;
    await pg.query(
      `INSERT INTO agent_recall.trace_spans (id, turn_id, parent_span_id, span_index, kind, name, status, attributes)
       VALUES ('z-parent-span', $1, NULL, 98, 'tool', 'outer', 'completed', '{"depth":0}'::jsonb),
              ('a-child-span', $1, 'z-parent-span', 99, 'tool', 'inner', 'completed', '{"depth":1}'::jsonb)`,
      [turnRow.id],
    );

    // 3. Skills, metadata, saved searches, search history
    await pgSkills.upsertSkillUsageSource(
      { path: "/hooks/claude.jsonl", agent: "claude", kind: "claude-session", mtimeMs: baseTime, fileSize: 200 },
      [{ agent: "claude", skill: "sql-debug", timestamp: baseTime + 100, sessionId: "mig-1", cwd: "/repo/alpha", skillHash: "h1" }],
    );
    await pgMetadata.setApiProviderKey("agent", "openai", "sk-test-secret");
    await pgMetadata.recordSessionMigration({
      id: "sm-1",
      sourceSessionKey: "codex:mig-1",
      sourceAgent: "codex",
      targetAgent: "claude",
      targetSessionId: "claude-99",
      targetFilePath: "/tmp/claude-99.jsonl",
      strategy: "complete",
      createdAt: baseTime + 2000,
    });
    const saved = await pgSaved.createSavedSearch("认证排查", { query: "认证超时", source: "codex-cli" });
    await pgHistory.recordSearch("认证超时", 1, { source: "codex-cli" });

    // 4. Runtime invocations, MCP, AppStore
    await pgInvocations.begin({
      id: "inv-1",
      initiator: "agentrecall",
      runtimeId: "codex",
      channelId: "ch-1",
      startedAt: baseTime,
      invocation: { surface: "evaluation", role: "subject", ownerReference: { runId: "run-1" } },
    });
    await pgInvocations.bind("inv-1", {
      runtimeId: "codex",
      channelId: "ch-1",
      sessionId: "mig-1",
      relation: "created",
      boundAt: baseTime + 100,
    });
    await pgInvocations.finish("inv-1", "completed", baseTime + 500);

    await pgMcp.upsert({
      id: "mcp-1",
      name: "Docs MCP",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { MODE: "read" },
      headers: {},
      enabled: true,
      exposureMode: "direct",
      disabledTools: [],
      tools: [{ name: "lookup", description: "Lookup docs", inputSchema: { type: "object" }, readOnly: true }],
      status: "connected",
      createdAt: baseTime,
      updatedAt: baseTime,
    });

    await pgApp.save({
      version: 5,
      activeChatId: "chat-1",
      workDir: "/repo/alpha",
      configuredAgents: [],
      channels: [],
      sessions: [
        {
          id: "chat-1",
          title: "Debug Session",
          configuredAgentId: "agent-1",
          createdAt: baseTime,
          updatedAt: baseTime,
        },
      ],
      messages: [
        {
          id: "msg-1",
          sessionId: "chat-1",
          role: "user",
          content: "Check logs",
          createdAt: baseTime,
        },
      ],
      events: [
        {
          id: "evt-1",
          sessionId: "chat-1",
          messageId: "msg-1",
          type: "note",
          content: "ok",
          createdAt: baseTime,
        },
      ],
    } as never);

    // 5. Evaluations
    await pgEval.saveDataset({
      id: "ds-1",
      name: "Auth suite",
      description: "Regression cases",
      items: [{ id: "item-1", input: "Explain timeout", expectedOutput: "WAL", metadata: { tag: "db" }, sequence: 0 }],
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    await pgEval.saveEvaluator({
      id: "ev-1",
      name: "Exact",
      kind: "exact_match",
      threshold: 0.8,
      enabled: true,
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    await pgEval.saveExperiment({
      id: "exp-1",
      name: "Auth exp",
      datasetId: "ds-1",
      agentId: "agent-1",
      evaluatorIds: ["ev-1"],
      repetitions: 1,
      skillName: "sql-debug",
      skillHash: "h1",
      createdAt: baseTime,
      updatedAt: baseTime,
    });
    await pgEval.saveRun({
      id: "run-1",
      experimentId: "exp-1",
      status: "completed",
      engine: "graph",
      skillHash: "h1",
      startedAt: baseTime,
      finishedAt: baseTime + 1000,
      averageScore: 1,
      minimumScore: 1,
      passRate: 1,
      scoredCaseCount: 1,
      unscoredCaseCount: 0,
      results: [
        {
          id: "case-res-1",
          runId: "run-1",
          datasetItemId: "item-1",
          repetition: 1,
          input: "Explain timeout",
          output: "WAL",
          durationMs: 250,
          sessionKey: "codex:mig-1",
          score: 1,
          passed: true,
          scores: [{ evaluatorId: "ev-1", dimension: "accuracy", score: 1, passed: true, durationMs: 10 }],
          nodes: [
            {
              nodeId: "n-1",
              nodeType: "exact_match",
              nodeVersion: 1,
              role: "judge",
              status: "pass",
              durationMs: 10,
              verdicts: [
                {
                  verdictId: "v-1",
                  sourceNodeId: "n-1",
                  sourceNodeType: "exact_match",
                  evaluatorId: "ev-1",
                  status: "met",
                  raw: 1,
                  threshold: 0.8,
                  labels: { dimension: "accuracy" },
                  durationMs: 10,
                },
              ],
            },
          ],
        },
      ],
    });

    // 6. Team session snapshot + binary draft
    const draftPacket = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);
    await pgTeam.import(
      "cache-mig-1",
      {
        root: {
          schemaVersion: 2,
          exportedAt: baseTime,
          session: {
            sessionKey: "codex:shared-1",
            source: "codex-cli",
            originalTitle: "Shared Session",
            displayTitle: "Shared Session",
          },
          messages: [
            { role: "user", content: "shared question", timestamp: new Date(baseTime).toISOString(), index: 0 },
            { role: "assistant", content: "shared answer", timestamp: new Date(baseTime + 100).toISOString(), index: 1 },
          ],
          traceEvents: [],
        },
        children: [],
        files: [],
        missingAttachments: [],
        bytes: 128,
      },
      new AbortController().signal,
      { repository: "org/repo", assetId: -1, digest: "d1" },
      {
        scope: '["org/repo",null]',
        item: {
          id: -1,
          title: "Shared Session",
          author: "本地",
          source: "codex-cli",
          createdAt: new Date(baseTime).toISOString(),
          bytes: 128,
          digest: "d1",
          canWithdraw: false,
          local: true,
        },
        packet: draftPacket,
      },
    );

    // 7. Memory cards including superseded self-FK + sources + extraction state
    const createdCardIds = await pgCards.applyExtraction({
      sessionKey: "codex:mig-1",
      projectPath: "/repo/alpha",
      firstTurnIndex: 0,
      lastTurnIndex: 0,
      candidateIds: [],
      operations: [
        {
          op: "create",
          ref: "c1",
          kind: "experience",
          problem: "SQLite 写入竞争",
          solution: "开启 WAL 与 BEGIN IMMEDIATE",
          failedAttempts: ["默认 journal_mode=DELETE"],
          keywords: ["sqlite", "wal"],
        },
      ],
      model: "gpt-5",
      now: new Date(baseTime + 3000).toISOString(),
      inputTokens: 100,
      outputTokens: 50,
    });
    const secondCardIds = await pgCards.applyExtraction({
      sessionKey: "codex:mig-1",
      projectPath: "/repo/alpha",
      firstTurnIndex: 0,
      lastTurnIndex: 0,
      candidateIds: createdCardIds,
      operations: [
        {
          op: "create",
          ref: "c2",
          kind: "decision",
          problem: "SQLite 写入竞争",
          solution: "开启 WAL + BEGIN IMMEDIATE + 进程内事务队列",
          failedAttempts: ["仅使用 WAL"],
          keywords: ["sqlite", "wal", "queue"],
        },
        {
          op: "supersede",
          id: createdCardIds[0]!,
          replacedBy: "c2",
        },
      ],
      model: "gpt-5",
      now: new Date(baseTime + 4000).toISOString(),
    });
    expect(secondCardIds).toHaveLength(1);

    // Run migration with a tiny batchSize (2) to exercise multi-batch cursor fetching!
    const sqlitePath = path.join(dir, "agent-recall.sqlite");
    const result = await migratePostgresDatabaseToSqlite(pg, sqlitePath, { batchSize: 2 });

    expect(result.sqlitePath).toBe(path.resolve(sqlitePath));
    expect(result.totalRows).toBeGreaterThan(20);
    expect(result.tableCounts.environments).toBe(2);
    expect(result.tableCounts.sessions).toBe(2); // 1 local + 1 team snapshot session
    expect(result.tableCounts.tags).toBe(2);
    expect(result.tableCounts.memory_cards).toBe(2);
    expect(fs.existsSync(`${sqlitePath}.migrating`)).toBe(false);
    expect(fs.existsSync(sqlitePath)).toBe(true);

    // Verify every repository reads identical data back from the migrated SQLite file!
    const sqlite = SqliteDatabase.open(sqlitePath, { migrations: SQLITE_MIGRATIONS });
    await sqlite.initialize();
    try {
      const sEnv = new SqliteEnvironmentRepository(sqlite);
      const sSessions = new SqliteSessionRepository(sqlite);
      const sTurns = new SqliteSessionTurnRepository(sqlite);
      const sSearch = new SqliteSessionSearchRepository(sqlite);
      const sMetadata = new SqliteMetadataRepository(sqlite);
      const sSkills = new SqliteSkillRepository(sqlite);
      const sSaved = new SqliteSavedSearchStore(sqlite);
      const sHistory = new SqliteSearchHistoryStore(sqlite);
      const sMcp = new SqliteMcpRegistryStore(sqlite);
      const sApp = new SqliteAppStore(sqlite);
      const sEval = new SqliteEvaluationStore(sqlite);
      const sTeam = new SqliteTeamSessionRepository(sqlite);
      const sCards = new SqliteMemoryCardRepository(sqlite);

      expect((await sEnv.listEnvironments()).map((e) => e.id).sort()).toEqual(["local", "ssh-dev"]);
      const migratedSession = await sSessions.getSession("codex:mig-1");
      expect(migratedSession).toMatchObject({
        sessionKey: "codex:mig-1",
        customTitle: "自定义迁移会话",
        favorited: true,
        aiSummary: "认证超时与 SQLite 并发配置总结",
        tags: ["sqlite", "urgent"],
      });

      // FTS5 search works immediately on migrated turns, titles, and memory cards
      const turnHit = await sSearch.searchSessions({ query: "busy_timeout" });
      expect(turnHit.map((s) => s.sessionKey)).toEqual(["codex:mig-1"]);
      const chineseHit = await sSearch.searchSessions({ query: "认证超时" });
      expect(chineseHit.map((s) => s.sessionKey)).toEqual(["codex:mig-1"]);
      const summaryHit = await sSearch.searchSessions({ query: "并发配置总结" });
      expect(summaryHit.map((s) => s.sessionKey)).toEqual(["codex:mig-1"]);

      const messages = await sTurns.getAllMessages("codex:mig-1");
      expect(messages).toHaveLength(2);
      expect(await sMetadata.getApiProviderKey("agent", "openai")).toBe("sk-test-secret");
      expect((await sMetadata.listSessionMigrations("codex:mig-1"))).toHaveLength(1);
      expect((await sSkills.listSkillUsageOverview())).toHaveLength(1);
      expect((await sSaved.listSavedSearches())[0]?.id).toBe(saved.id);
      expect((await sHistory.listRecentSearches())).toHaveLength(1);
      expect((await sMcp.list())[0]).toMatchObject({ id: "mcp-1", exposureMode: "direct" });
      expect(await sApp.load()).toMatchObject({ activeChatId: "chat-1", workDir: "/repo/alpha" });
      const run = await sEval.getRun("run-1");
      expect(run?.results[0]?.nodes?.[0]?.nodeId).toBe("n-1");
      expect(run?.results[0]?.nodes?.[0]?.verdicts?.[0]?.verdictId).toBe("v-1");

      const draft = await sTeam.draft('["org/repo",null]', -1);
      expect(draft?.packet.equals(draftPacket)).toBe(true);

      const cards = await sCards.listCards({ query: "进程内事务队列", includeSuperseded: false });
      expect(cards).toHaveLength(1);
      expect(cards[0]?.solution).toContain("进程内事务队列");
      const allCards = await sCards.listCards({ includeSuperseded: true });
      expect(allCards).toHaveLength(2);

      // Verify AUTOINCREMENT continues cleanly without colliding with migrated IDs
      await sSessions.addTag("codex:mig-1", "post-migration-tag");
      expect((await sSessions.getSession("codex:mig-1"))?.tags).toContain("post-migration-tag");
      const newSaved = await sSaved.createSavedSearch("迁移后保存搜索", { query: "wal" });
      expect(newSaved.id).toBeGreaterThan(saved.id);
    } finally {
      await sqlite.close();
      await pg.close();
    }
  });

  it("cleans up temporary files and never creates target database if migration fails", async () => {
    const dir = makeTempDir();
    const sqlitePath = path.join(dir, "broken.sqlite");
    const brokenPg = {
      transaction: async () => {
        throw new Error("simulated PG read error");
      },
    } as unknown as PostgresDatabase;

    await expect(migratePostgresDatabaseToSqlite(brokenPg, sqlitePath)).rejects.toThrow("simulated PG read error");
    expect(fs.existsSync(sqlitePath)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}.migrating`)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}.migrating-wal`)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}.migrating-shm`)).toBe(false);
  });
});
