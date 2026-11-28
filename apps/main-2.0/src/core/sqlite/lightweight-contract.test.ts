import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeInvocationRecorder } from "../../automation/engine/main/agents/runtime/runtime-invocation-recorder";
import type { PersistedAppStateV5 } from "../../automation/engine/main/hub/persisted/agent-hub-persistence";
import type { AgentHubPersistedStore } from "../../automation/engine/main/hub/persisted/persisted-store";
import { SqliteAppStore } from "../../automation/engine/main/hub/persisted/sqlite-store";
import { SqliteMcpRegistryStore } from "../../automation/engine/main/sqlite-mcp-registry-store";
import type {
  EnvironmentRepository,
  McpRegistryRepository,
  MetadataRepository,
  SavedSearchRepository,
  SearchHistoryRepository,
} from "../storage/repositories";
import { SqliteDatabase } from "./database";
import { SqliteEnvironmentRepository } from "./environment-repository";
import { SqliteMetadataRepository } from "./metadata-repository";
import { SqliteRuntimeInvocationRepository } from "./runtime-invocation-repository";
import { SqliteSavedSearchStore } from "./saved-searches-store";
import { SQLITE_MIGRATIONS } from "./schema";
import { SqliteSearchHistoryStore } from "./search-history-store";

interface LightweightHarness {
  environments: EnvironmentRepository;
  metadata: MetadataRepository;
  runtimeInvocations: RuntimeInvocationRecorder & { recoverPending(finishedAt: number): Promise<number> };
  savedSearches: SavedSearchRepository;
  searchHistory: SearchHistoryRepository;
  mcpRegistry: McpRegistryRepository;
  appStore: AgentHubPersistedStore;
  seedSession(sessionKey: string, environmentId?: string): Promise<void>;
  countSessions(environmentId: string): Promise<number>;
  getInvocationStatus(id: string): Promise<{ status: string; error: string | null } | null>;
  getBindingBoundAt(invocationId: string, sessionId: string): Promise<{ turnId: string | null; relation: string; boundAt: number } | null>;
  close(): Promise<void>;
}

async function createSqliteHarness(): Promise<LightweightHarness> {
  const database = SqliteDatabase.open(":memory:", { migrations: SQLITE_MIGRATIONS });
  await database.initialize();
  return {
    environments: new SqliteEnvironmentRepository(database),
    metadata: new SqliteMetadataRepository(database),
    runtimeInvocations: new SqliteRuntimeInvocationRepository(database),
    savedSearches: new SqliteSavedSearchStore(database),
    searchHistory: new SqliteSearchHistoryStore(database),
    mcpRegistry: new SqliteMcpRegistryStore(database),
    appStore: new SqliteAppStore(database),
    async seedSession(sessionKey: string, environmentId = "local") {
      database.run(
        `INSERT INTO sessions (
          session_key, raw_id, source, environment_id, project_path, file_path,
          original_title, first_question, started_at, file_mtime_ms, file_size, indexed_at
        ) VALUES (?, ?, 'codex-cli', ?, '/repo', '/tmp/s.jsonl', ?, ?, 1000, 1, 1, 1000)`,
        sessionKey,
        sessionKey,
        environmentId,
        sessionKey,
        sessionKey,
      );
    },
    async countSessions(environmentId: string) {
      const row = database.get<{ count: number }>(
        "SELECT count(*) AS count FROM sessions WHERE environment_id = ?",
        environmentId,
      );
      return Number(row?.count ?? 0);
    },
    async getInvocationStatus(id: string) {
      const row = database.get<{ status: string; error: string | null }>(
        "SELECT status, error FROM runtime_invocations WHERE id = ?",
        id,
      );
      return row ? { status: row.status, error: row.error } : null;
    },
    async getBindingBoundAt(invocationId: string, sessionId: string) {
      const row = database.get<{ runtime_turn_id: string | null; relation: string; bound_at: number }>(
        `SELECT runtime_turn_id, relation, bound_at
         FROM runtime_session_bindings
         WHERE invocation_id = ? AND runtime_session_id = ?`,
        invocationId,
        sessionId,
      );
      return row ? { turnId: row.runtime_turn_id, relation: row.relation, boundAt: Number(row.bound_at) } : null;
    },
    close: () => database.close(),
  };
}

describe("SQLite lightweight storage contract", () => {
  let harness: LightweightHarness;

  beforeEach(async () => {
    harness = await createSqliteHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("EnvironmentRepository: manages local, SSH, and WSL environments and cascades session deletion", async () => {
    const first = await harness.environments.upsertEnvironment({ kind: "ssh", label: "devbox", host: "dev-a.test" });
    const second = await harness.environments.upsertEnvironment({ kind: "ssh", label: "devbox", host: "dev-b.test" });
    const aliased = await harness.environments.upsertEnvironment({ kind: "ssh", label: "prod", hostAlias: "prod", host: "p1.test" });
    const updated = await harness.environments.upsertEnvironment({ kind: "ssh", label: "prod-2", hostAlias: "prod", host: "p2.test" });
    expect(first.id).toBe("devbox");
    expect(second.id).toBe("devbox-2");
    expect(updated.id).toBe(aliased.id);

    await harness.environments.updateEnvironmentSyncState(updated.id, "error", {
      lastSyncedAt: 100,
      lastError: "connection refused",
    });
    await harness.environments.updateEnvironmentSyncState(updated.id, "watching");
    await expect(harness.environments.getEnvironment(updated.id)).resolves.toMatchObject({
      label: "prod-2",
      host: "p2.test",
      syncState: "watching",
      lastSyncedAt: 100,
      lastError: "connection refused",
    });

    const wsl = await harness.environments.upsertEnvironment({
      kind: "wsl",
      label: "Ubuntu",
      wslDistribution: "Ubuntu",
      host: "ignored",
    });
    expect(wsl).toMatchObject({ kind: "wsl", wslDistribution: "Ubuntu", host: null, authMode: "none" });
    await expect(harness.environments.upsertEnvironment({ kind: "wsl", label: "bad" })).rejects.toThrow(/WSL distribution/i);

    await harness.seedSession("remote:s1", first.id);
    expect(await harness.countSessions(first.id)).toBe(1);
    await harness.environments.deleteEnvironment(first.id);
    expect(await harness.countSessions(first.id)).toBe(0);
    await expect(harness.environments.getEnvironment(first.id)).resolves.toBeNull();
    await expect(harness.environments.deleteEnvironment("local")).rejects.toThrow(/Local environment cannot be deleted/);
  });

  it("MetadataRepository: sync bindings, provider keys, and ordered migration records", async () => {
    await harness.seedSession("local:old");
    await harness.seedSession("local:new");

    await harness.metadata.upsertSessionSyncBinding({
      localSessionKey: "local:old",
      remoteSessionId: "remote-1",
      lastLocalRevision: "l1",
      lastRemoteRevision: "r1",
      lastSyncedAt: 1_000,
      direction: "upload",
    });
    await harness.metadata.upsertSessionSyncBinding({
      localSessionKey: "local:new",
      remoteSessionId: "remote-1",
      lastLocalRevision: "l2",
      lastRemoteRevision: "r2",
      lastSyncedAt: 2_000,
      direction: "restore",
    });
    await expect(harness.metadata.getSessionSyncBindingForLocalKey("local:old")).resolves.toBeNull();
    await expect(harness.metadata.getSessionSyncBindingForRemoteId("remote-1")).resolves.toMatchObject({
      localSessionKey: "local:new",
      lastSyncedAt: 2_000,
      direction: "restore",
    });
    await expect(harness.metadata.listSessionSyncBindings()).resolves.toHaveLength(1);
    await harness.metadata.deleteSessionSyncBindingForRemoteId("remote-1");
    await expect(harness.metadata.listSessionSyncBindings()).resolves.toEqual([]);

    await harness.metadata.setApiProviderKey("codex", " deepseek ", " secret-123 ");
    await expect(harness.metadata.getApiProviderKey("codex", "deepseek")).resolves.toBe("secret-123");
    await expect(harness.metadata.getApiProviderKey("codex", "missing")).resolves.toBe("");

    await harness.metadata.recordSessionMigration({
      id: "m1",
      sourceSessionKey: "local:new",
      sourceAgent: "codex",
      targetAgent: "claude",
      targetSessionId: "c1",
      targetFilePath: "/tmp/c1.jsonl",
      strategy: "complete",
      createdAt: 100,
    });
    await harness.metadata.recordSessionMigration({
      id: "m2",
      sourceSessionKey: "local:new",
      sourceAgent: "codex",
      targetAgent: "tcodex",
      targetSessionId: "t2",
      targetFilePath: "/tmp/t2.jsonl",
      strategy: "ai-compressed",
      createdAt: 200,
    });
    await expect(harness.metadata.listSessionMigrations("local:new")).resolves.toMatchObject([
      { id: "m2", targetAgent: "tcodex", createdAt: 200 },
      { id: "m1", targetAgent: "claude", createdAt: 100 },
    ]);
  });

  it("RuntimeInvocationRepository: lifecycle, binding upsert conflict rules, and pending recovery", async () => {
    await harness.runtimeInvocations.begin({
      id: "inv-stale",
      initiator: "agentrecall",
      invocation: { surface: "evaluation", role: "subject", ownerReference: { runId: "r1" } },
      runtimeId: "codex",
      startedAt: 1_000,
    });
    await harness.runtimeInvocations.begin({
      id: "inv-done",
      initiator: "agentrecall",
      invocation: { surface: "agent", role: "task", ownerReference: { taskId: "t1" } },
      runtimeId: "claude",
      startedAt: 2_000,
    });
    await harness.runtimeInvocations.bind("inv-done", {
      runtimeId: "claude",
      sessionId: "sess-1",
      turnId: "turn-a",
      relation: "created",
      boundAt: 2_500,
    });
    await harness.runtimeInvocations.bind("inv-done", {
      runtimeId: "claude",
      sessionId: "sess-1",
      relation: "continued",
      boundAt: 2_100,
    });
    await expect(harness.getBindingBoundAt("inv-done", "sess-1")).resolves.toEqual({
      turnId: "turn-a",
      relation: "continued",
      boundAt: 2_100,
    });

    await harness.runtimeInvocations.finish("inv-done", "completed", 3_000);
    await expect(harness.runtimeInvocations.recoverPending(4_000)).resolves.toBe(1);
    await expect(harness.getInvocationStatus("inv-done")).resolves.toEqual({ status: "completed", error: null });
    await expect(harness.getInvocationStatus("inv-stale")).resolves.toEqual({
      status: "failed",
      error: "AgentRecall stopped before this Runtime invocation finished.",
    });
  });

  it("SavedSearchStore & SearchHistoryStore: ordering, normalization, dedupe, and pruning", async () => {
    await expect(harness.savedSearches.createSavedSearch("   ", {})).rejects.toThrow(/required/i);
    const s1 = await harness.savedSearches.createSavedSearch("Legacy pinned", {
      query: "oauth",
      visibility: "pinned" as never,
    });
    const s2 = await harness.savedSearches.createSavedSearch("Frequent", { query: "sqlite" });
    expect(s1.options.visibility).toBe("favorites");

    await harness.savedSearches.touchSavedSearch(s2.id);
    const listed = await harness.savedSearches.listSavedSearches();
    expect(listed.map((item) => item.name)).toEqual(["Frequent", "Legacy pinned"]);
    expect(listed[0]?.useCount).toBe(1);
    expect(listed[0]?.lastUsedAt).not.toBeNull();
    expect(await harness.savedSearches.deleteSavedSearch(s1.id)).toBe(true);
    expect(await harness.savedSearches.getSavedSearch(s1.id)).toBeNull();

    await harness.searchHistory.recordSearch("OAuth Token", 3, { source: "claude" });
    await harness.searchHistory.recordSearch("SQLite WAL", 5);
    await harness.searchHistory.recordSearch("OAuth Token", 7);
    const recent = await harness.searchHistory.listRecentSearches();
    expect(recent.map((item) => [item.query, item.resultCount])).toEqual([
      ["OAuth Token", 7],
      ["SQLite WAL", 5],
    ]);
    const matched = await harness.searchHistory.searchHistory("oauth");
    expect(matched).toHaveLength(1);
    expect(matched[0]?.query).toBe("OAuth Token");

    expect(await harness.searchHistory.deleteEntry(recent[0]!.id)).toBe(true);
    await harness.searchHistory.clearHistory();
    expect(await harness.searchHistory.listRecentSearches()).toEqual([]);
  });

  it("McpRegistryStore: round-trips tools, readOnly, exposureMode, headers, disabledTools, and recordTest", async () => {
    await harness.mcpRegistry.upsert({
      id: "playwright",
      name: "Playwright",
      transport: "http",
      args: [],
      url: "https://example.test/mcp",
      env: {},
      headers: { Authorization: "PW_TOKEN" },
      enabled: true,
      exposureMode: "direct",
      tools: [
        { name: "navigate", description: "Open URL", inputSchema: { type: "object" }, readOnly: true },
        { name: "click", inputSchema: { type: "object" } },
      ],
      disabledTools: ["click", "stale_tool"],
      status: "untested",
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const [stored] = await harness.mcpRegistry.list();
    expect(stored).toMatchObject({
      id: "playwright",
      headers: { Authorization: "PW_TOKEN" },
      exposureMode: "direct",
      disabledTools: ["click"],
      tools: [
        { name: "navigate", description: "Open URL", readOnly: true },
        { name: "click" },
      ],
    });
    expect(stored!.tools[1]).not.toHaveProperty("readOnly");

    const failed = await harness.mcpRegistry.recordTest(stored!, stored!.tools, "boom");
    expect(failed).toMatchObject({ status: "error", lastError: "boom" });
    const ok = await harness.mcpRegistry.recordTest(failed, stored!.tools);
    expect(ok.status).toBe("connected");
    expect(ok.lastError).toBeUndefined();
    expect(await harness.mcpRegistry.delete("playwright")).toBe(true);
    expect(await harness.mcpRegistry.list()).toEqual([]);
  });

  it("AppStore: round-trips v5 state, chats, messages, events, and runtime sessions", async () => {
    expect(await harness.appStore.load()).toBeUndefined();

    const payload = {
      version: 5,
      activeChatId: "chat-1",
      workDir: "/workspace",
      configuredAgents: [{ id: "a1", name: "Agent 1" }],
      sessions: [{
        id: "chat-1",
        title: "Investigate SQLite",
        configuredAgentId: "a1",
        modelId: "m1",
        channelId: "ch1",
        runtimeState: { state: "idle" },
        runtimeConversation: { runtimeId: "codex", sessionId: "prov-1" },
        createdAt: 1_000,
        updatedAt: 2_000,
      }],
      messages: [{
        id: "msg-1",
        chatId: "chat-1",
        role: "assistant",
        content: "Ready",
        local: true,
        timestamp: 1_500,
      }],
      events: [{
        id: "evt-1",
        chatId: "chat-1",
        messageId: "msg-1",
        type: "meta",
        content: "done",
        metadata: { ok: true },
        timestamp: 1_600,
      }],
    } as unknown as PersistedAppStateV5;

    await harness.appStore.save(payload);
    const loaded = await harness.appStore.load() as Record<string, unknown>;
    expect(loaded).toMatchObject({
      version: 5,
      activeChatId: "chat-1",
      workDir: "/workspace",
      configuredAgents: [{ id: "a1", name: "Agent 1" }],
      sessions: [{
        id: "chat-1",
        title: "Investigate SQLite",
        channelId: "ch1",
        runtimeState: { state: "idle" },
        runtimeConversation: { runtimeId: "codex", sessionId: "prov-1" },
      }],
      messages: [{
        id: "msg-1",
        chatId: "chat-1",
        local: true,
      }],
      events: [{
        id: "evt-1",
        metadata: { ok: true },
      }],
    });

    await expect(harness.appStore.save({ ...payload, version: 4 as never })).rejects.toThrow(/version 5/);
  });
});
