import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IndexedSession } from "../types";
import { PostgresDatabase } from "./database";
import { PostgresEnvironmentRepository } from "./environment-repository";
import { PostgresMetadataRepository } from "./metadata-repository";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PostgresSessionRepository } from "./session-repository";
import { PostgresSkillRepository } from "./skill-repository";
import { PGliteTestPool } from "./test-pglite";

function session(sessionKey: string): IndexedSession {
  return {
    sessionKey,
    rawId: sessionKey,
    source: "codex-cli",
    projectPath: "/repo",
    filePath: `/fixtures/${sessionKey}.jsonl`,
    originalTitle: sessionKey,
    firstQuestion: sessionKey,
    timestamp: 1,
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
  };
}

describe("PostgreSQL support repositories", () => {
  let database: PostgresDatabase;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
  });

  afterEach(async () => {
    await database.close();
  });

  it("manages environments without allowing the local environment to be deleted", async () => {
    const repository = new PostgresEnvironmentRepository(database);
    const first = await repository.upsertEnvironment({
      kind: "ssh",
      label: "devbox",
      host: "dev-a.example.com",
    });
    const second = await repository.upsertEnvironment({
      kind: "ssh",
      label: "devbox",
      host: "dev-b.example.com",
    });
    const aliased = await repository.upsertEnvironment({
      kind: "ssh",
      label: "production",
      hostAlias: "prod",
      host: "prod-a.example.com",
    });
    const updated = await repository.upsertEnvironment({
      kind: "ssh",
      label: "production-updated",
      hostAlias: "prod",
      host: "prod-b.example.com",
    });

    expect(first.id).toBe("devbox");
    expect(second.id).toBe("devbox-2");
    expect(updated.id).toBe(aliased.id);

    await repository.updateEnvironmentSyncState(updated.id, "error", {
      lastSyncedAt: 10,
      lastError: "connection failed",
    });
    await repository.updateEnvironmentSyncState(updated.id, "watching");
    await expect(repository.getEnvironment(updated.id)).resolves.toMatchObject({
      label: "production-updated",
      host: "prod-b.example.com",
      syncState: "watching",
      lastSyncedAt: 10,
      lastError: "connection failed",
    });
    await expect(repository.deleteEnvironment("local")).rejects.toThrow(
      "Local environment cannot be deleted",
    );
  });

  it("reuses WSL environments by distribution and clears SSH-only fields", async () => {
    const repository = new PostgresEnvironmentRepository(database);
    const created = await repository.upsertEnvironment({
      kind: "wsl",
      label: "WSL · Ubuntu",
      wslDistribution: "Ubuntu",
    });
    const updated = await repository.upsertEnvironment({
      kind: "wsl",
      label: "Ubuntu workspace",
      wslDistribution: "Ubuntu",
      host: "ignored.example.com",
      hostAlias: "ignored",
    });

    expect(updated.id).toBe(created.id);
    expect(updated).toMatchObject({
      kind: "wsl",
      label: "Ubuntu workspace",
      wslDistribution: "Ubuntu",
      host: null,
      hostAlias: null,
      authMode: "none",
    });
    await expect(repository.upsertEnvironment({
      kind: "wsl",
      label: "Missing distribution",
    })).rejects.toThrow("WSL distribution is required");
  });

  it("aggregates Skill usage and moves unique remote bindings to the latest local path", async () => {
    const repository = new PostgresSkillRepository(database);
    const source = {
      agent: "codex" as const,
      kind: "codex-session" as const,
      path: "/fixtures/session.jsonl",
      mtimeMs: 10,
      fileSize: 20,
    };

    await expect(repository.isSkillUsageSourceFresh(source)).resolves.toBe(false);
    await repository.upsertSkillUsageSource(source, [
      { agent: "codex", skill: "review", timestamp: 100 },
      { agent: "codex", skill: "review", timestamp: 200 },
    ]);
    await expect(repository.getSkillUsageSnapshot()).resolves.toMatchObject({
      exists: true,
      totalEvents: 2,
      stats: [{ skill: "review", count: 2, lastUsedAt: 200 }],
    });

    await repository.upsertSkillSyncBinding({
      localSkillPath: "/skills/old/SKILL.md",
      portableIdentity: "codex-user/review",
      remoteSkillId: "remote-1",
      remoteUpdatedAt: "2026-07-16T00:00:00.000Z",
      remoteVersion: 1,
      lastContentHash: "old",
      lastSyncedAt: 1,
      direction: "upload",
    });
    await repository.upsertSkillSyncBinding({
      localSkillPath: "/skills/new/SKILL.md",
      portableIdentity: "codex-user/review",
      remoteSkillId: "remote-1",
      remoteUpdatedAt: "2026-07-17T00:00:00.000Z",
      remoteVersion: 2,
      lastContentHash: "new",
      lastSyncedAt: 2,
      direction: "download",
    });
    await expect(repository.getSkillSyncBindingForLocalPath("/skills/old/SKILL.md")).resolves.toBeNull();
    await expect(repository.getSkillSyncBindingForRemoteId("remote-1")).resolves.toMatchObject({
      localSkillPath: "/skills/new/SKILL.md",
      remoteVersion: 2,
      lastContentHash: "new",
      direction: "download",
    });

    await repository.pruneSkillUsageSources([]);
    await expect(repository.getSkillUsageSnapshot()).resolves.toMatchObject({
      exists: false,
      totalEvents: 0,
    });
  });

  it("resolves skill triggers against indexed sessions and keeps legacy events unlinked", async () => {
    const repository = new PostgresSkillRepository(database);
    const sessionRepository = new PostgresSessionRepository(database);
    await sessionRepository.upsertIndexedSession({
      ...session("local:claude:abc"),
      rawId: "claude-session-abc",
      source: "claude-cli",
      filePath: "/fixtures/claude-abc.jsonl",
      originalTitle: "Fix login bug",
    }, []);
    await sessionRepository.upsertIndexedSession({
      ...session("local:codex:roll"),
      filePath: "/fixtures/codex-rollout.jsonl",
      originalTitle: "Codex rollout",
    }, []);
    await database.query(
      `
        insert into agent_recall.session_turns (
          id, session_key, turn_index, started_at, ended_at, derivation_version
        )
        values ('turn-1', 'local:claude:abc', 7, $1, $2, 1)
      `,
      [new Date(900).toISOString(), new Date(1_100).toISOString()],
    );

    await repository.upsertSkillUsageSource({
      agent: "claude",
      kind: "claude-hook",
      path: "/fixtures/skill-usage.jsonl",
      mtimeMs: 1,
      fileSize: 1,
    }, [
      { agent: "claude", skill: "review", timestamp: 1_000, sessionId: "claude-session-abc", cwd: "/repo" },
      { agent: "claude", skill: "review", timestamp: 500 },
    ]);
    await repository.upsertSkillUsageSource({
      agent: "codex",
      kind: "codex-session",
      path: "/fixtures/codex-rollout.jsonl",
      mtimeMs: 1,
      fileSize: 1,
    }, [
      { agent: "codex", skill: "review", timestamp: 2_000 },
    ]);

    const triggers = await repository.listRecentSkillTriggers({ skill: "Review" });
    expect(triggers).toHaveLength(3);
    expect(triggers[0]).toMatchObject({
      agent: "codex",
      linkState: "linked-session",
      sessionKey: "local:codex:roll",
      sessionTitle: "Codex rollout",
      turnId: null,
    });
    expect(triggers[1]).toMatchObject({
      agent: "claude",
      linkState: "linked-turn",
      sessionKey: "local:claude:abc",
      sessionTitle: "Fix login bug",
      turnId: "turn-1",
    });
    expect(triggers[2]).toMatchObject({
      agent: "claude",
      linkState: "unlinked",
      sessionKey: null,
      sessionTitle: null,
      turnId: null,
    });

    await expect(repository.listRecentSkillTriggers({ skill: "unknown" })).resolves.toEqual([]);
  });

  it("uses structured execution evidence and canonical tool names for Skill Eval outcomes", async () => {
    const repository = new PostgresSkillRepository(database);
    const sessionRepository = new PostgresSessionRepository(database);
    await sessionRepository.upsertIndexedSession({
      ...session("local:codex:eval-tools"),
      rawId: "codex-eval-tools",
    }, []);
    await database.query(
      `
        insert into agent_recall.session_turns (
          id, session_key, turn_index, started_at, ended_at, derivation_version
        )
        values ('eval-turn', 'local:codex:eval-tools', 0, $1, $2, 1)
      `,
      [new Date(900).toISOString(), new Date(1_100).toISOString()],
    );
    await database.query(
      `
        insert into agent_recall.trace_spans (
          id, turn_id, span_index, kind, name, status, attributes
        )
        values
          ('runtime-failed', 'eval-turn', 0, 'tool', 'web', 'failed', $1::jsonb),
          ('static-failed', 'eval-turn', 1, 'tool', 'exec_command', 'failed', $2::jsonb),
          ('request-running', 'eval-turn', 2, 'tool', 'skills.read', 'running', $3::jsonb),
          ('request-completed', 'eval-turn', 3, 'tool', 'shell', 'completed', $4::jsonb),
          ('legacy-failed', 'eval-turn', 4, 'tool', 'legacy_tool', 'failed', '{}'::jsonb)
      `,
      [
        JSON.stringify({ tool: { canonicalName: "web.run", executionEvidence: "runtime-confirmed" } }),
        JSON.stringify({ tool: { canonicalName: "exec_command", executionEvidence: "static-only" } }),
        JSON.stringify({ tool: { canonicalName: "skills.read", executionEvidence: "recorded-request" } }),
        JSON.stringify({ tool: { canonicalName: "exec_command", executionEvidence: "recorded-request" } }),
      ],
    );
    await repository.upsertSkillUsageSource({
      agent: "codex",
      kind: "codex-session",
      path: "/fixtures/eval-tools.jsonl",
      mtimeMs: 1,
      fileSize: 1,
    }, [{
      agent: "codex",
      skill: "review",
      timestamp: 1_000,
      sessionId: "codex-eval-tools",
    }]);

    await expect(repository.listSkillToolOutcomes("Review")).resolves.toEqual([
      {
        toolName: "legacy_tool",
        callCount: 1,
        failureCount: 1,
        sampleSpanIds: ["legacy-failed"],
        sampleErrors: [],
      },
      {
        toolName: "web.run",
        callCount: 1,
        failureCount: 1,
        sampleSpanIds: ["runtime-failed"],
        sampleErrors: [],
      },
      {
        toolName: "exec_command",
        callCount: 1,
        failureCount: 0,
        sampleSpanIds: [],
        sampleErrors: [],
      },
    ]);
  });

  it("aggregates the skill live report across overview, signals, and version groups", async () => {
    const repository = new PostgresSkillRepository(database);
    const sessionRepository = new PostgresSessionRepository(database);
    const now = Date.now();
    await sessionRepository.upsertIndexedSession({
      ...session("local:claude:live"),
      rawId: "claude-live",
      source: "claude-cli",
      filePath: "/fixtures/claude-live.jsonl",
      originalTitle: "Live report fixture",
    }, []);
    await database.query(
      `
        insert into agent_recall.session_turns (
          id, session_key, turn_index, started_at, ended_at, total_tokens, error_count, derivation_version
        )
        values
          ('live-turn-1', 'local:claude:live', 7, $1, $2, 30000, 1, 1),
          ('live-turn-2', 'local:claude:live', 8, $3, $4, 1000, 0, 1)
      `,
      [
        new Date(now - 60_000).toISOString(),
        new Date(now + 60_000).toISOString(),
        new Date(now + 120_000).toISOString(),
        new Date(now + 180_000).toISOString(),
      ],
    );

    await repository.upsertSkillUsageSource({
      agent: "codex",
      kind: "codex-session",
      path: "/fixtures/codex-live.jsonl",
      mtimeMs: 1,
      fileSize: 1,
    }, [
      { agent: "codex", skill: "other", timestamp: now },
    ]);
    // The claude observability floor trips once a claude session event carries
    // a skill_hash — the signature that the hook contributed version data.
    await expect(repository.hasClaudeHookUsageEvents()).resolves.toBe(false);

    await repository.upsertSkillUsageSource({
      agent: "claude",
      kind: "claude-session",
      path: "/fixtures/claude-session.jsonl",
      mtimeMs: 1,
      fileSize: 1,
    }, [
      { agent: "claude", skill: "review", timestamp: now, sessionId: "claude-live", skillHash: "hash-b" },
      { agent: "claude", skill: "review", timestamp: now - 10 * 86_400_000, skillHash: "hash-a" },
      { agent: "claude", skill: "review", timestamp: now - 40 * 86_400_000 },
    ]);
    await expect(repository.hasClaudeHookUsageEvents()).resolves.toBe(true);

    const overview = await repository.listSkillUsageOverview();
    expect(overview).toHaveLength(2);
    const review = overview.find((row) => row.skill === "review");
    expect(review).toMatchObject({
      agent: "claude",
      totalTriggers: 3,
      triggers7d: 1,
      triggers30d: 2,
      linkedTriggers: 1,
    });

    const signals = await repository.getSkillPerformanceSignals("Review");
    expect(signals.sampleSize).toBe(1);
    expect(signals.medianTotalTokens).toBe(30_000);
    expect(signals.medianDurationMs).toBe(120_000);
    expect(signals.errorTurnRatio).toBe(1);
    // Both fixture turns are non-synthetic; upsert's synthetic turn stays out.
    expect(signals.baselineTurnCount).toBe(2);
    expect(signals.baselineMedianTotalTokens).toBe(15_500);
    expect(signals.baselineErrorTurnRatio).toBe(0.5);

    const groups = await repository.listSkillVersionGroups("review");
    expect(groups.map((group) => group.skillHash)).toEqual(["hash-b", "hash-a", null]);
    expect(groups[0]).toMatchObject({ triggerCount: 1 });

    const emptySignals = await repository.getSkillPerformanceSignals("unknown");
    expect(emptySignals.sampleSize).toBe(0);
    expect(emptySignals.medianTotalTokens).toBeNull();
  });

  it("stores sync metadata, provider keys, and ordered migration history", async () => {
    const sessionRepository = new PostgresSessionRepository(database);
    await sessionRepository.upsertIndexedSession(session("local:old"), []);
    await sessionRepository.upsertIndexedSession(session("local:new"), []);
    const repository = new PostgresMetadataRepository(database);

    await repository.upsertSessionSyncBinding({
      localSessionKey: "local:old",
      remoteSessionId: "remote-1",
      lastLocalRevision: "local-a",
      lastRemoteRevision: "remote-a",
      lastSyncedAt: 1,
      direction: "upload",
    });
    await repository.upsertSessionSyncBinding({
      localSessionKey: "local:new",
      remoteSessionId: "remote-1",
      lastLocalRevision: "local-b",
      lastRemoteRevision: "remote-b",
      lastSyncedAt: 2,
      direction: "restore",
    });
    await expect(repository.getSessionSyncBindingForLocalKey("local:old")).resolves.toBeNull();
    await expect(repository.getSessionSyncBindingForRemoteId("remote-1")).resolves.toMatchObject({
      localSessionKey: "local:new",
      direction: "restore",
      lastSyncedAt: 2,
    });

    await repository.setApiProviderKey("codex", " deepseek ", " secret-key ");
    await expect(repository.getApiProviderKey("codex", "deepseek")).resolves.toBe("secret-key");

    await repository.recordSessionMigration({
      id: "migration-a",
      sourceSessionKey: "local:new",
      sourceAgent: "codex",
      targetAgent: "claude",
      targetSessionId: "claude-a",
      targetFilePath: "/tmp/a.jsonl",
      strategy: "complete",
      createdAt: 1,
    });
    await repository.recordSessionMigration({
      id: "migration-b",
      sourceSessionKey: "local:new",
      sourceAgent: "codex",
      targetAgent: "tcodex",
      targetSessionId: "tcodex-b",
      targetFilePath: "/tmp/b.jsonl",
      strategy: "ai-compressed",
      createdAt: 2,
    });
    await expect(repository.listSessionMigrations("local:new")).resolves.toMatchObject([
      { id: "migration-b", targetAgent: "tcodex" },
      { id: "migration-a", targetAgent: "claude" },
    ]);
  });
});
