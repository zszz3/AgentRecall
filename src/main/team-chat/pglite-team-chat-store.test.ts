import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TeamChatRoom } from "../../shared/team-chat";

const modulePath = "./pglite-team-chat-store";
const temporaryDirectories: string[] = [];

async function temporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-team-chat-pglite-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PGliteTeamChatStore", () => {
  it("persists rooms and messages across managed local database restarts", async () => {
    const { PGliteTeamChatStore } = await import(modulePath);
    const directory = await temporaryDataDirectory();
    const createdAt = "2026-07-23T08:00:00.000Z";
    const room: TeamChatRoom = {
      id: "019c0000-0000-7000-8000-000000000001",
      name: "Local room",
      workDir: "",
      archived: false,
      agents: [{
        roomId: "019c0000-0000-7000-8000-000000000001",
        agentId: "builder",
        displayName: "Builder",
        runtimeId: "codex",
        channelId: "codex-main",
        modelId: "gpt-5",
        enabled: true,
        position: 0,
        joinedAt: createdAt,
        continuationAvailable: true,
        hasActiveConversation: false,
      }],
      createdAt,
      updatedAt: createdAt,
    };

    const first = new PGliteTeamChatStore(directory);
    await first.initialize();
    await first.createRoom(room);
    const firstMessage = {
      id: "019c0000-0000-7000-8000-000000000002",
      roomId: room.id,
      senderType: "human" as const,
      senderName: "You",
      content: "Persist this",
      rootMessageId: "019c0000-0000-7000-8000-000000000002",
      hop: 0,
      status: "final" as const,
      createdAt,
      updatedAt: createdAt,
    };
    await first.insertMessage(firstMessage);
    await first.upsertAgentSession({
      roomId: room.id,
      agentId: "builder",
      runtimeId: "codex",
      channelId: "codex-main",
      modelId: "gpt-5",
      runtimeConversation: {
        runtimeId: "codex",
        codecVersion: "1",
        payload: { native: { threadId: "thread-1" } },
      },
      lastContextMessageId: firstMessage.id,
      updatedAt: "2026-07-23T10:00:00.000Z",
    });
    for (const [index, content] of ["second", "third", "fourth"].entries()) {
      const timestamp = `2026-07-23T08:0${index + 1}:00.000Z`;
      await first.insertMessage({
        ...firstMessage,
        id: `019c0000-0000-7000-8000-00000000000${index + 3}`,
        content,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    await first.close();

    const reopened = new PGliteTeamChatStore(directory);
    await reopened.initialize();
    await expect(reopened.listRooms()).resolves.toMatchObject([{ id: room.id, name: "Local room" }]);
    await expect(reopened.listMessages({ roomId: room.id })).resolves.toMatchObject({
      messages: [
        { content: "Persist this" },
        { content: "second" },
        { content: "third" },
        { content: "fourth" },
      ],
    });
    await expect(reopened.listAgentSessions(room.id)).resolves.toEqual([{
      roomId: room.id,
      agentId: "builder",
      runtimeId: "codex",
      channelId: "codex-main",
      modelId: "gpt-5",
      runtimeConversation: {
        runtimeId: "codex",
        codecVersion: "1",
        payload: { native: { threadId: "thread-1" } },
      },
      lastContextMessageId: firstMessage.id,
      updatedAt: "2026-07-23T10:00:00.000Z",
    }]);
    await expect(reopened.listMessagesAfter(room.id, firstMessage.id, 2)).resolves.toMatchObject({
      messages: [{ content: "third" }, { content: "fourth" }],
      truncated: true,
    });
    await reopened.close();
  });
});
