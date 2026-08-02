import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TeamChatDispatch, TeamChatMessage, TeamChatRoom } from "../../shared/team-chat";
import { PostgresDatabase } from "../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../core/postgres/schema";
import { PGliteTestPool } from "../../core/postgres/test-pglite";
import { PostgresTeamChatStore } from "./postgres-team-chat-store";
import type {
  TeamChatExecutionAttempt,
  TeamChatPendingActivation,
} from "./team-chat-store";

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
        configuredAgentId: "builder",
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
        configuredAgentId: "reviewer",
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
    sequence: 0,
    senderType: "human",
    senderName: "You",
    content,
    deliveryType: "message",
    rootMessageId: id,
    hop: 0,
    status: "final",
    createdAt,
    updatedAt: createdAt,
  };
}

describe("PostgresTeamChatStore", () => {
  it("persists two employees backed by the same configured Agent", async () => {
    const room = roomFixture();
    room.agents = [
      { ...room.agents[0]!, agentId: "member-1", configuredAgentId: "builder", displayName: "Codex" },
      { ...room.agents[0]!, agentId: "member-2", configuredAgentId: "builder", displayName: "Codex2", position: 1 },
    ];
    await store.createRoom(room);
    await store.insertMessage({
      ...messageFixture(MESSAGE_ONE_ID, "Please review", "2026-07-23T08:01:00.000Z"),
      recipientMemberId: "member-2",
      deliveryType: "reply",
    });

    await expect(store.getRoom(ROOM_ID)).resolves.toMatchObject({
      agents: [
        { agentId: "member-1", configuredAgentId: "builder", displayName: "Codex" },
        { agentId: "member-2", configuredAgentId: "builder", displayName: "Codex2" },
      ],
    });
    await expect(store.listMessages({ roomId: ROOM_ID, limit: 10 })).resolves.toMatchObject({
      messages: [{
        id: MESSAGE_ONE_ID,
        recipientMemberId: "member-2",
        deliveryType: "reply",
        sequence: 1,
      }],
    });
  });

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

  it("atomically persists a mention Task and queued Turn at the trigger snapshot", async () => {
    await store.createRoom(roomFixture());
    const createdAt = "2026-07-23T08:01:00.000Z";
    const activation: TeamChatPendingActivation = {
      mention: {
        id: "019c0000-0000-7000-8000-000000000021",
        roomId: ROOM_ID,
        messageId: MESSAGE_ONE_ID,
        memberId: "builder",
        createdAt,
      },
      task: {
        id: "019c0000-0000-7000-8000-000000000022",
        roomId: ROOM_ID,
        memberId: "builder",
        rootMessageId: MESSAGE_ONE_ID,
        status: "in_progress",
        evidence: [],
        createdAt,
        updatedAt: createdAt,
      },
      dispatch: {
        id: "019c0000-0000-7000-8000-000000000023",
        roomId: ROOM_ID,
        mentionId: "019c0000-0000-7000-8000-000000000021",
        taskId: "019c0000-0000-7000-8000-000000000022",
        rootMessageId: MESSAGE_ONE_ID,
        sourceMessageId: MESSAGE_ONE_ID,
        targetAgentId: "builder",
        roomSnapshotSequence: 0,
        hop: 0,
        status: "queued",
        createdAt,
        updatedAt: createdAt,
      },
    };

    const persisted = await store.insertMessageWithActivations(
      messageFixture(MESSAGE_ONE_ID, "@Builder inspect auth", createdAt),
      [activation],
    );

    expect(persisted.message.sequence).toBe(1);
    expect(persisted.activations[0]?.dispatch).toMatchObject({
      id: activation.dispatch.id,
      roomSnapshotSequence: 1,
      status: "queued",
    });
    await expect(store.listQueuedDispatches()).resolves.toEqual([
      expect.objectContaining({
        id: activation.dispatch.id,
        mentionId: activation.mention.id,
        taskId: activation.task.id,
        roomSnapshotSequence: 1,
      }),
    ]);
    await expect(store.listInbox(ROOM_ID, "builder", undefined, 20)).resolves.toEqual([
      expect.objectContaining({
        mentionId: activation.mention.id,
        messageId: MESSAGE_ONE_ID,
        taskId: activation.task.id,
        turnId: activation.dispatch.id,
        status: "queued",
      }),
    ]);
  });

  it("persists ordered native Attempt events under one Studio Turn", async () => {
    await store.createRoom(roomFixture());
    const createdAt = "2026-07-23T08:01:00.000Z";
    const activation: TeamChatPendingActivation = {
      mention: {
        id: "019c0000-0000-7000-8000-000000000031",
        roomId: ROOM_ID,
        messageId: MESSAGE_ONE_ID,
        memberId: "builder",
        createdAt,
      },
      task: {
        id: "019c0000-0000-7000-8000-000000000032",
        roomId: ROOM_ID,
        memberId: "builder",
        rootMessageId: MESSAGE_ONE_ID,
        status: "in_progress",
        evidence: [],
        createdAt,
        updatedAt: createdAt,
      },
      dispatch: {
        id: "019c0000-0000-7000-8000-000000000033",
        roomId: ROOM_ID,
        mentionId: "019c0000-0000-7000-8000-000000000031",
        taskId: "019c0000-0000-7000-8000-000000000032",
        rootMessageId: MESSAGE_ONE_ID,
        sourceMessageId: MESSAGE_ONE_ID,
        targetAgentId: "builder",
        roomSnapshotSequence: 0,
        hop: 0,
        status: "queued",
        createdAt,
        updatedAt: createdAt,
      },
    };
    await store.insertMessageWithActivations(
      messageFixture(MESSAGE_ONE_ID, "@Builder inspect auth", createdAt),
      [activation],
    );
    const attempt: TeamChatExecutionAttempt = {
      id: "019c0000-0000-7000-8000-000000000034",
      dispatchId: activation.dispatch.id,
      attemptNumber: 1,
      runtimeId: "codex",
      runtimeSessionRef: "thread-private",
      nativeTurnId: "turn-native-1",
      roomSnapshotSequence: 1,
      status: "running",
      startedAt: "2026-07-23T08:02:00.000Z",
    };

    await store.insertExecutionAttempt(attempt);
    await store.insertAttemptEvent({
      id: "019c0000-0000-7000-8000-000000000035",
      attemptId: attempt.id,
      sequence: 1,
      type: "tool_call",
      name: "shell_command",
      content: "npm test",
      createdAt: "2026-07-23T08:02:01.000Z",
    });
    await store.insertAttemptEvent({
      id: "019c0000-0000-7000-8000-000000000036",
      attemptId: attempt.id,
      sequence: 2,
      type: "tool_result",
      name: "shell_command",
      content: "passed",
      createdAt: "2026-07-23T08:02:02.000Z",
    });

    await expect(store.listExecutionAttempts(activation.dispatch.id)).resolves.toEqual([
      expect.objectContaining({
        id: attempt.id,
        runtimeSessionRef: "thread-private",
        nativeTurnId: "turn-native-1",
        roomSnapshotSequence: 1,
      }),
    ]);
    await expect(store.listTurnEvents(ROOM_ID, activation.dispatch.id, 20)).resolves.toEqual([
      expect.objectContaining({ sequence: 1, type: "tool_call", content: "npm test" }),
      expect.objectContaining({ sequence: 2, type: "tool_result", content: "passed" }),
    ]);

    await expect(store.listRoomTurns(ROOM_ID, 20)).resolves.toEqual([
      expect.objectContaining({
        dispatch: expect.objectContaining({ id: activation.dispatch.id }),
        task: expect.objectContaining({
          id: activation.task.id,
          status: "in_progress",
        }),
        triggerMessage: expect.objectContaining({ id: MESSAGE_ONE_ID }),
      }),
    ]);
    await expect(store.getRoomTurn(ROOM_ID, activation.dispatch.id)).resolves.toEqual(
      expect.objectContaining({
        dispatch: expect.objectContaining({ id: activation.dispatch.id }),
        task: expect.objectContaining({ id: activation.task.id }),
      }),
    );

    const completed = await store.finishTask(
      ROOM_ID,
      "builder",
      activation.task.id,
      {
        status: "completed",
        summary: "Auth inspection passed",
        evidence: ["npm test"],
        finishedAt: "2026-07-23T08:03:00.000Z",
      },
    );
    await expect(store.finishTask(
      ROOM_ID,
      "builder",
      activation.task.id,
      {
        status: "completed",
        summary: "Auth inspection passed",
        evidence: ["npm test"],
        finishedAt: "2026-07-23T08:04:00.000Z",
      },
    )).resolves.toEqual(completed);
    await expect(store.finishTask(
      ROOM_ID,
      "reviewer",
      activation.task.id,
      {
        status: "blocked",
        summary: "wrong owner",
        evidence: [],
        finishedAt: "2026-07-23T08:05:00.000Z",
      },
    )).resolves.toBeUndefined();
    await expect(store.listRoomTurns(ROOM_ID, 20)).resolves.toEqual([
      expect.objectContaining({
        task: expect.objectContaining({
          status: "completed",
          summary: "Auth inspection passed",
          evidence: ["npm test"],
        }),
      }),
    ]);
    await expect(store.listThreadMessages(ROOM_ID, MESSAGE_ONE_ID, 20)).resolves.toEqual([
      expect.objectContaining({ id: MESSAGE_ONE_ID }),
    ]);
  });

  it("reads public room updates only through the immutable Turn snapshot", async () => {
    await store.createRoom(roomFixture());
    await store.insertMessage(messageFixture(
      MESSAGE_ONE_ID,
      "@Builder first task",
      "2026-07-23T08:01:00.000Z",
    ));
    await store.insertMessage(messageFixture(
      MESSAGE_TWO_ID,
      "background for the next task",
      "2026-07-23T08:02:00.000Z",
    ));
    await store.insertMessage(messageFixture(
      "019c0000-0000-7000-8000-000000000013",
      "@Builder second task",
      "2026-07-23T08:03:00.000Z",
    ));

    await expect(store.getLatestMessageSequence(ROOM_ID)).resolves.toBe(3);
    await expect(store.listRoomContext(ROOM_ID, 0, 2, 10)).resolves.toEqual({
      messages: [
        expect.objectContaining({ id: MESSAGE_ONE_ID }),
        expect.objectContaining({ id: MESSAGE_TWO_ID }),
      ],
      truncated: false,
      snapshotSequence: 2,
    });
    await expect(store.listRoomContext(ROOM_ID, 0, 2, 1)).resolves.toEqual({
      messages: [expect.objectContaining({ id: MESSAGE_TWO_ID })],
      truncated: true,
      snapshotSequence: 2,
      omittedSequenceRange: { from: 1, to: 1 },
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
      roomContextSequence: 1,
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
        roomContextSequence: 1,
        runtimeConversation: expect.objectContaining({ runtimeId: "codex" }),
      }),
    ]);
    const result = await database.query<{ status: string }>(
      "SELECT status FROM agent_recall.chat_dispatches WHERE id = $1",
      [dispatch.id],
    );
    expect(result.rows[0]?.status).toBe("interrupted");
  });

  it("provides scoped message lookup and workspace reservations", async () => {
    await store.createRoom(roomFixture());
    await store.insertMessage({
      ...messageFixture(MESSAGE_ONE_ID, "authentication changed", "2026-07-23T08:01:00.000Z"),
      recipientMemberId: "builder",
    });
    await store.insertMessage({
      ...messageFixture(MESSAGE_TWO_ID, "review authentication", "2026-07-23T08:02:00.000Z"),
      senderType: "agent",
      senderAgentId: "builder",
      senderName: "Builder",
      recipientMemberId: "reviewer",
    });
    await store.insertDispatch({
      id: "019c0000-0000-7000-8000-000000000022",
      roomId: ROOM_ID,
      rootMessageId: MESSAGE_ONE_ID,
      sourceMessageId: MESSAGE_ONE_ID,
      targetAgentId: "builder",
      hop: 0,
      status: "completed",
      createdAt: "2026-07-23T08:01:00.000Z",
      updatedAt: "2026-07-23T08:01:00.000Z",
    });

    await expect(store.getMessages(ROOM_ID, [MESSAGE_TWO_ID]))
      .resolves.toEqual([expect.objectContaining({ id: MESSAGE_TWO_ID })]);
    await expect(store.readMessageRange(ROOM_ID, { after: 1, limit: 10 }))
      .resolves.toEqual([expect.objectContaining({ id: MESSAGE_TWO_ID })]);
    await expect(store.searchMessages(ROOM_ID, "authentication", 10))
      .resolves.toHaveLength(2);
    const reservation = {
      roomId: ROOM_ID,
      memberId: "builder",
      relativePath: "src/auth.ts",
      reason: "editing",
      expiresAt: "2030-07-23T08:10:00.000Z",
      createdAt: "2026-07-23T08:03:00.000Z",
      updatedAt: "2026-07-23T08:03:00.000Z",
    };
    await expect(store.reserveWorkspacePaths([reservation])).resolves.toEqual([reservation]);
    await expect(store.listWorkspaceReservations(ROOM_ID)).resolves.toEqual([reservation]);
    await expect(store.releaseWorkspacePaths(ROOM_ID, "builder", ["src/auth.ts"]))
      .resolves.toBe(1);
    await expect(store.listWorkspaceReservations(ROOM_ID)).resolves.toEqual([]);
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
    const empty = { ...updated, agents: [], updatedAt: "2026-07-23T08:03:30.000Z" };
    await expect(store.updateRoom(empty)).resolves.toEqual(empty);
    await expect(store.getRoom(ROOM_ID)).resolves.toEqual(empty);
    await store.archiveRoom(ROOM_ID, "2026-07-23T08:04:00.000Z");
    await expect(store.listRooms()).resolves.toEqual([]);
  });

  it("permanently deletes a room and its dependent Chat data", async () => {
    await store.createRoom(roomFixture());
    await store.insertMessage(
      messageFixture(MESSAGE_ONE_ID, "delete this room", "2026-07-23T08:01:00.000Z"),
    );
    await store.reserveWorkspacePaths([{
      roomId: ROOM_ID,
      memberId: "builder",
      relativePath: "src/delete.ts",
      expiresAt: "2030-07-23T08:10:00.000Z",
      createdAt: "2026-07-23T08:03:00.000Z",
      updatedAt: "2026-07-23T08:03:00.000Z",
    }]);

    await expect(store.deleteRoom(ROOM_ID)).resolves.toBe(true);
    await expect(store.deleteRoom(ROOM_ID)).resolves.toBe(false);
    await expect(store.getRoom(ROOM_ID)).resolves.toBeUndefined();
    await expect(store.listMessages({ roomId: ROOM_ID, limit: 10 }))
      .resolves.toEqual({ messages: [] });
    await expect(store.listWorkspaceReservations(ROOM_ID)).resolves.toEqual([]);
  });
});
