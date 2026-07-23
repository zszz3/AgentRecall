import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TeamChatDispatch, TeamChatMessage, TeamChatRoom } from "../../shared/team-chat";
import { PostgresDatabase } from "../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../core/postgres/schema";
import { PGliteTestPool } from "../../core/postgres/test-pglite";
import { PostgresTeamChatStore } from "./postgres-team-chat-store";

const ROOM_ID = "019c0000-0000-7000-8000-000000000001";
const MESSAGE_ONE_ID = "019c0000-0000-7000-8000-000000000011";
const MESSAGE_TWO_ID = "019c0000-0000-7000-8000-000000000012";

let database: PostgresDatabase;
let store: PostgresTeamChatStore;

beforeEach(async () => {
  database = new PostgresDatabase(new PGliteTestPool(), {
    migrations: POSTGRES_MIGRATIONS,
    migrationLock: false,
  });
  await database.initialize();
  store = new PostgresTeamChatStore(database);
  await store.initialize();
});

afterEach(async () => {
  await database.close();
});

function roomFixture(): TeamChatRoom {
  const timestamp = "2026-07-23T08:00:00.000Z";
  return {
    id: ROOM_ID,
    name: "Release room",
    workDir: "/synthetic/repo",
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    agents: [
      {
        roomId: ROOM_ID,
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
        roomId: ROOM_ID,
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

function messageFixture(id: string, content: string, createdAt: string): TeamChatMessage {
  return {
    id,
    roomId: ROOM_ID,
    senderType: "human",
    senderName: "You",
    content,
    rootMessageId: id,
    hop: 0,
    status: "final",
    createdAt,
    updatedAt: createdAt,
  };
}

describe("PostgresTeamChatStore", () => {
  it("persists rooms, ordered members, and message pagination", async () => {
    const room = roomFixture();
    await store.createRoom(room);
    await store.insertMessage(messageFixture(
      MESSAGE_ONE_ID,
      "first",
      "2026-07-23T08:01:00.000Z",
    ));
    await store.insertMessage(messageFixture(
      MESSAGE_TWO_ID,
      "second",
      "2026-07-23T08:02:00.000Z",
    ));

    await expect(store.getRoom(ROOM_ID)).resolves.toEqual({
      ...room,
      updatedAt: "2026-07-23T08:02:00.000Z",
    });
    await expect(store.listRooms()).resolves.toEqual([
      expect.objectContaining({
        id: ROOM_ID,
        agentCount: 2,
        lastMessage: "second",
      }),
    ]);
    await expect(store.listMessages({ roomId: ROOM_ID, limit: 1 })).resolves.toEqual({
      messages: [expect.objectContaining({ id: MESSAGE_TWO_ID, content: "second" })],
      nextBefore: MESSAGE_TWO_ID,
    });
    await expect(store.listMessages({
      roomId: ROOM_ID,
      before: MESSAGE_TWO_ID,
      limit: 10,
    })).resolves.toEqual({
      messages: [expect.objectContaining({ id: MESSAGE_ONE_ID, content: "first" })],
    });
  });

  it("persists Agent continuation state and interrupts stale dispatches", async () => {
    await store.createRoom(roomFixture());
    await store.insertMessage(messageFixture(
      MESSAGE_ONE_ID,
      "build it",
      "2026-07-23T08:01:00.000Z",
    ));
    await store.upsertAgentSession({
      roomId: ROOM_ID,
      agentId: "builder",
      runtimeId: "codex",
      channelId: "codex-main",
      modelId: "gpt-5",
      runtimeConversation: {
        runtimeId: "codex",
        codecVersion: "1",
        payload: { threadId: "thread-1" },
      },
      lastContextMessageId: MESSAGE_ONE_ID,
      updatedAt: "2026-07-23T08:02:00.000Z",
    });
    const dispatch: TeamChatDispatch = {
      id: "019c0000-0000-7000-8000-000000000021",
      roomId: ROOM_ID,
      rootMessageId: MESSAGE_ONE_ID,
      sourceMessageId: MESSAGE_ONE_ID,
      targetAgentId: "builder",
      hop: 0,
      status: "running",
      createdAt: "2026-07-23T08:02:00.000Z",
      updatedAt: "2026-07-23T08:02:00.000Z",
    };
    await store.insertDispatch(dispatch);

    await store.initialize();

    await expect(store.listAgentSessions(ROOM_ID)).resolves.toEqual([
      expect.objectContaining({
        agentId: "builder",
        lastContextMessageId: MESSAGE_ONE_ID,
        runtimeConversation: expect.objectContaining({ runtimeId: "codex" }),
      }),
    ]);
    const result = await database.query<{ status: string }>(
      "SELECT status FROM agent_recall.chat_dispatches WHERE id = $1",
      [dispatch.id],
    );
    expect(result.rows[0]?.status).toBe("interrupted");
  });

  it("updates membership atomically and archives the room", async () => {
    const room = roomFixture();
    await store.createRoom(room);
    const updated = {
      ...room,
      name: "Focused room",
      agents: [room.agents[1]!],
      updatedAt: "2026-07-23T08:03:00.000Z",
    };

    await expect(store.updateRoom(updated)).resolves.toEqual(updated);
    await expect(store.getRoom(ROOM_ID)).resolves.toEqual(updated);
    await store.archiveRoom(ROOM_ID, "2026-07-23T08:04:00.000Z");
    await expect(store.listRooms()).resolves.toEqual([]);
  });
});
