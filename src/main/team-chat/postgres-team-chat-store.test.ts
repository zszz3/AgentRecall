import { describe, expect, it } from "vitest";
import type { TeamChatRoom } from "../../shared/team-chat";
import {
  PostgresTeamChatStore,
  type TeamChatClientLike,
  type TeamChatPoolLike,
  type TeamChatQueryResult,
} from "./postgres-team-chat-store";

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

class FakeClient implements TeamChatClientLike {
  readonly queries: RecordedQuery[] = [];
  released = false;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<TeamChatQueryResult<Row>> {
    this.queries.push({ text, values });
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released = true;
  }
}

class FakePool implements TeamChatPoolLike {
  readonly queries: RecordedQuery[] = [];
  readonly client = new FakeClient();
  closed = false;
  nextRows: Array<Record<string, unknown>> = [];
  rowQueue: Array<Array<Record<string, unknown>>> = [];
  connectError?: Error;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<TeamChatQueryResult<Row>> {
    this.queries.push({ text, values });
    const rows = this.rowQueue.length > 0 ? this.rowQueue.shift()! : this.nextRows;
    return { rows: rows as Row[], rowCount: rows.length };
  }

  async connect(): Promise<TeamChatClientLike> {
    if (this.connectError) throw this.connectError;
    return this.client;
  }

  async end(): Promise<void> {
    this.closed = true;
  }
}

function roomFixture(): TeamChatRoom {
  const timestamp = "2026-07-23T08:00:00.000Z";
  return {
    id: "019c0000-0000-7000-8000-000000000001",
    name: "Release room",
    workDir: "/synthetic/repo",
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    agents: [
      {
        roomId: "019c0000-0000-7000-8000-000000000001",
        agentId: "builder",
        displayName: "Builder",
        runtimeId: "codex",
        channelId: "codex-main",
        modelId: "gpt-5",
        enabled: true,
        position: 0,
        joinedAt: timestamp,
        continuationAvailable: false,
        hasActiveConversation: false,
      },
      {
        roomId: "019c0000-0000-7000-8000-000000000001",
        agentId: "reviewer",
        displayName: "Reviewer",
        runtimeId: "claude",
        channelId: "claude-main",
        modelId: "sonnet",
        enabled: true,
        position: 1,
        joinedAt: timestamp,
        continuationAvailable: false,
        hasActiveConversation: false,
      },
    ],
  };
}

describe("PostgresTeamChatStore", () => {
  it("initializes under an advisory lock and interrupts stale dispatches", async () => {
    const pool = new FakePool();
    const store = new PostgresTeamChatStore("postgresql://user:secret@localhost/agent_recall_test", { pool });

    await store.initialize();

    const sql = pool.client.queries.map((query) => query.text).join("\n");
    expect(sql).toContain("pg_advisory_lock");
    expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS agent_recall");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_recall.chat_rooms");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_recall.chat_agent_sessions");
    expect(sql).toContain("UPDATE agent_recall.chat_dispatches");
    expect(sql).toContain("status = 'interrupted'");
    expect(sql).toContain("pg_advisory_unlock");
    expect(pool.client.released).toBe(true);
  });

  it("creates a room and all member snapshots in one transaction", async () => {
    const pool = new FakePool();
    const store = new PostgresTeamChatStore("postgresql://localhost/agent_recall_test", { pool });
    const room = roomFixture();

    await store.createRoom(room);

    expect(pool.client.queries[0]?.text).toBe("BEGIN");
    expect(pool.client.queries.filter((query) => query.text.includes("chat_room_agents"))).toHaveLength(2);
    expect(pool.client.queries.at(-1)?.text).toBe("COMMIT");
    expect(pool.client.released).toBe(true);
  });

  it("returns a chronological message page with an opaque next cursor", async () => {
    const pool = new FakePool();
    pool.nextRows = [
      messageRow("019c0000-0000-7000-8000-000000000013", "third", "2026-07-23T08:03:00.000Z"),
      messageRow("019c0000-0000-7000-8000-000000000012", "second", "2026-07-23T08:02:00.000Z"),
      messageRow("019c0000-0000-7000-8000-000000000011", "first", "2026-07-23T08:01:00.000Z"),
    ];
    const store = new PostgresTeamChatStore("postgresql://localhost/agent_recall_test", { pool });

    const page = await store.listMessages({ roomId: roomFixture().id, limit: 2 });

    expect(page.messages.map((message) => message.content)).toEqual(["second", "third"]);
    expect(page.nextBefore).toBe("019c0000-0000-7000-8000-000000000012");
    expect(pool.queries[0]?.values).toEqual([roomFixture().id, null, 3]);
  });

  it("does not leak a connection URL when PostgreSQL rejects initialization", async () => {
    const pool = new FakePool();
    pool.connectError = new Error("failed postgresql://user:super-secret@private.example/database");
    const store = new PostgresTeamChatStore("postgresql://user:super-secret@private.example/database", { pool });

    await expect(store.initialize()).rejects.toThrow("Unable to connect to PostgreSQL");
    await expect(store.initialize()).rejects.not.toThrow("super-secret");
  });

  it("maps room summaries and a room with ordered member snapshots", async () => {
    const pool = new FakePool();
    const room = roomFixture();
    pool.rowQueue = [
      [{
        id: room.id,
        name: room.name,
        work_dir: room.workDir,
        archived: false,
        agent_count: "2",
        last_message: "ready",
        last_message_at: room.updatedAt,
        created_at: room.createdAt,
        updated_at: room.updatedAt,
      }],
      [{
        id: room.id,
        name: room.name,
        work_dir: room.workDir,
        archived: false,
        created_at: room.createdAt,
        updated_at: room.updatedAt,
      }],
      room.agents.map((agent) => ({
        room_id: agent.roomId,
        agent_id: agent.agentId,
        display_name: agent.displayName,
        runtime_id: agent.runtimeId,
        channel_id: agent.channelId,
        model_id: agent.modelId,
        enabled: agent.enabled,
        position: agent.position,
        joined_at: agent.joinedAt,
      })),
    ];
    const store = new PostgresTeamChatStore("postgresql://localhost/agent_recall_test", { pool });

    const summaries = await store.listRooms();
    const loaded = await store.getRoom(room.id);

    expect(summaries[0]).toMatchObject({ id: room.id, agentCount: 2, lastMessage: "ready" });
    expect(loaded).toEqual(room);
    expect(pool.queries.at(-1)?.values).toEqual([room.id]);
  });

  it("updates a room and replaces its member snapshots transactionally", async () => {
    const pool = new FakePool();
    const store = new PostgresTeamChatStore("postgresql://localhost/agent_recall_test", { pool });
    const room = { ...roomFixture(), name: "Renamed room", agents: [roomFixture().agents[1]!] };

    await store.updateRoom(room);

    const sql = pool.client.queries.map((query) => query.text).join("\n");
    expect(pool.client.queries[0]?.text).toBe("BEGIN");
    expect(sql).toContain("UPDATE agent_recall.chat_rooms");
    expect(sql).toContain("DELETE FROM agent_recall.chat_room_agents");
    expect(sql).toContain("DELETE FROM agent_recall.chat_agent_sessions");
    expect(pool.client.queries.filter((query) => query.text.includes("INSERT INTO agent_recall.chat_room_agents"))).toHaveLength(1);
    expect(pool.client.queries.find((query) => query.text.includes("DELETE FROM agent_recall.chat_agent_sessions"))?.values)
      .toEqual([room.id, ["reviewer"]]);
    expect(pool.client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("persists and returns opaque room Agent conversations", async () => {
    const pool = new FakePool();
    const store = new PostgresTeamChatStore("postgresql://localhost/agent_recall_test", { pool });
    const room = roomFixture();
    const session = {
      roomId: room.id,
      agentId: "builder",
      runtimeId: "codex",
      channelId: "codex-main",
      modelId: "gpt-5",
      runtimeConversation: {
        runtimeId: "codex" as const,
        codecVersion: "1",
        payload: { native: { threadId: "thread-1" } },
      },
      lastContextMessageId: "019c0000-0000-7000-8000-000000000010",
      updatedAt: "2026-07-23T08:10:00.000Z",
    };

    await store.upsertAgentSession(session);
    pool.nextRows = [{
      room_id: session.roomId,
      agent_id: session.agentId,
      runtime_id: session.runtimeId,
      channel_id: session.channelId,
      model_id: session.modelId,
      runtime_conversation: session.runtimeConversation,
      last_context_message_id: session.lastContextMessageId,
      updated_at: session.updatedAt,
    }];

    await expect(store.listAgentSessions(room.id)).resolves.toEqual([session]);
    expect(pool.queries[0]?.text).toContain("INSERT INTO agent_recall.chat_agent_sessions");
    expect(pool.queries[0]?.text).toContain("ON CONFLICT (room_id, agent_id)");
    expect(pool.queries[0]?.values).toEqual([
      session.roomId,
      session.agentId,
      session.runtimeId,
      session.channelId,
      session.modelId,
      JSON.stringify(session.runtimeConversation),
      session.lastContextMessageId,
      session.updatedAt,
    ]);
  });

  it("returns only the latest messages after a context marker in chronological order", async () => {
    const pool = new FakePool();
    pool.nextRows = [
      messageRow("019c0000-0000-7000-8000-000000000014", "fourth", "2026-07-23T08:04:00.000Z"),
      messageRow("019c0000-0000-7000-8000-000000000013", "third", "2026-07-23T08:03:00.000Z"),
      messageRow("019c0000-0000-7000-8000-000000000012", "second", "2026-07-23T08:02:00.000Z"),
    ];
    const store = new PostgresTeamChatStore("postgresql://localhost/agent_recall_test", { pool });

    const page = await store.listMessagesAfter(
      roomFixture().id,
      "019c0000-0000-7000-8000-000000000011",
      2,
    );

    expect(page).toMatchObject({
      messages: [{ content: "third" }, { content: "fourth" }],
      truncated: true,
    });
    expect(pool.queries[0]?.text).toContain("(created_at, id) >");
    expect(pool.queries[0]?.values).toEqual([
      roomFixture().id,
      "019c0000-0000-7000-8000-000000000011",
      3,
    ]);
  });

  it("persists a message and bumps room ordering in one transaction", async () => {
    const pool = new FakePool();
    const store = new PostgresTeamChatStore("postgresql://localhost/agent_recall_test", { pool });
    const row = messageRow("019c0000-0000-7000-8000-000000000013", "hello", "2026-07-23T08:03:00.000Z");
    const message = {
      id: String(row.id),
      roomId: String(row.room_id),
      senderType: "agent" as const,
      senderAgentId: "builder",
      senderName: "Builder",
      content: "hello",
      rootMessageId: String(row.root_message_id),
      sourceMessageId: String(row.source_message_id),
      hop: 1,
      status: "final" as const,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };

    await expect(store.insertMessage(message)).resolves.toEqual(message);

    const sql = pool.client.queries.map((query) => query.text).join("\n");
    expect(sql).toContain("INSERT INTO agent_recall.chat_messages");
    expect(sql).toContain("UPDATE agent_recall.chat_rooms");
    expect(pool.client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("persists and updates dispatch lifecycle fields", async () => {
    const pool = new FakePool();
    const store = new PostgresTeamChatStore("postgresql://localhost/agent_recall_test", { pool });
    const timestamp = "2026-07-23T08:03:00.000Z";
    const dispatch = {
      id: "019c0000-0000-7000-8000-000000000020",
      roomId: roomFixture().id,
      rootMessageId: "019c0000-0000-7000-8000-000000000010",
      sourceMessageId: "019c0000-0000-7000-8000-000000000010",
      targetAgentId: "builder",
      hop: 0,
      status: "queued" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await store.insertDispatch(dispatch);
    await store.updateDispatch(dispatch.id, {
      status: "failed",
      error: "synthetic failure",
      startedAt: timestamp,
      finishedAt: timestamp,
      updatedAt: timestamp,
    });

    expect(pool.queries[0]?.text).toContain("INSERT INTO agent_recall.chat_dispatches");
    expect(pool.queries[1]?.text).toContain("UPDATE agent_recall.chat_dispatches");
    expect(pool.queries[1]?.values).toEqual([
      dispatch.id,
      "failed",
      "synthetic failure",
      timestamp,
      timestamp,
      timestamp,
    ]);
  });

  it("archives rooms, interrupts running dispatches, and closes its pool", async () => {
    const pool = new FakePool();
    const store = new PostgresTeamChatStore("postgresql://localhost/agent_recall_test", { pool });

    await store.archiveRoom(roomFixture().id, "2026-07-23T08:04:00.000Z");
    await store.markRunningDispatchesInterrupted("2026-07-23T08:05:00.000Z");
    await store.close();

    expect(pool.queries[0]?.text).toContain("archived = true");
    expect(pool.queries[1]?.text).toContain("status = 'interrupted'");
    expect(pool.closed).toBe(true);
  });
});

function messageRow(id: string, content: string, createdAt: string): Record<string, unknown> {
  return {
    id,
    room_id: roomFixture().id,
    sender_type: "agent",
    sender_agent_id: "builder",
    sender_name: "Builder",
    content,
    root_message_id: "019c0000-0000-7000-8000-000000000010",
    source_message_id: "019c0000-0000-7000-8000-000000000010",
    hop: 1,
    status: "final",
    created_at: createdAt,
    updated_at: createdAt,
  };
}
