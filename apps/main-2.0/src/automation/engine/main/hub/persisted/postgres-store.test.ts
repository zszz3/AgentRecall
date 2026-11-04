import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostgresDatabase } from "../../../../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../../../../core/postgres/schema";
import { PGliteTestPool } from "../../../../../core/postgres/test-pglite";
import type { PersistedAppStateV5 } from "./agent-hub-persistence";
import { PostgresAppStore } from "./postgres-store";

describe("PostgreSQL AgentHub persistence", () => {
  let database: PostgresDatabase;
  let store: PostgresAppStore;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), {
      migrationLock: false,
      migrations: POSTGRES_MIGRATIONS,
    });
    await database.initialize();
    store = new PostgresAppStore(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("persists chat runtime state", async () => {
    const payload = {
      version: 5,
      activeChatId: "chat-1",
      workDir: "/workspace",
      sessions: [{
        id: "chat-1",
        title: "Fix search",
        configuredAgentId: "codex",
        runtimeState: { state: "idle" },
        runtimeConversation: {
          runtimeId: "codex",
          sessionId: "provider-session",
          codecVersion: "1",
          payload: {},
        },
        createdAt: 1_000,
        updatedAt: 2_000,
      }],
      messages: [{
        id: "message-1",
        chatId: "chat-1",
        role: "assistant",
        content: "Done",
        timestamp: 1_500,
      }],
      events: [{
        id: "event-1",
        chatId: "chat-1",
        messageId: "message-1",
        type: "meta",
        content: "completed",
        timestamp: 1_600,
      }],
    } as unknown as PersistedAppStateV5;

    await store.save(payload);
    const restored = await store.load() as Record<string, unknown>;

    expect(restored).toMatchObject({
      version: 5,
      activeChatId: "chat-1",
      workDir: "/workspace",
      sessions: [{
        id: "chat-1",
        runtimeConversation: expect.objectContaining({
          sessionId: "provider-session",
        }),
      }],
    });

    const counts = await database.query<{ chats: number }>(
      "select count(*)::integer as chats from agent_recall.automation_chats",
    );
    expect(counts.rows[0]).toEqual({ chats: 1 });
  });

  it("round-trips DeepSeek Harness channels and configured Agents in auxiliary state", async () => {
    const payload = {
      version: 5,
      activeChatId: null,
      workDir: "/workspace",
      channels: [{
        id: "dsh-default",
        agentId: "dsh",
        label: "DeepSeek Harness",
        presetId: "dsh-default",
        models: [{ id: "default", label: "Default" }],
      }],
      configuredAgents: [{
        id: "dsh-agent",
        name: "DSH Agent",
        description: "",
        runtimeAgentId: "dsh",
        channelId: "dsh-default",
        modelId: "default",
        tags: [],
        createdAt: 1,
        updatedAt: 2,
      }],
      sessions: [],
      messages: [],
      events: [],
    } as unknown as PersistedAppStateV5;

    await store.save(payload);

    await expect(store.load()).resolves.toMatchObject({
      channels: [{
        id: "dsh-default",
        agentId: "dsh",
        models: [{ id: "default" }],
      }],
      configuredAgents: [{
        id: "dsh-agent",
        runtimeAgentId: "dsh",
        channelId: "dsh-default",
        modelId: "default",
      }],
    });
  });
});
