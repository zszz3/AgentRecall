import { describe, expect, test } from "vitest";
import { restorePersistedCollections } from "./agent-hub-persisted-restore";

function baseRecord() {
  return {
    version: 5, workDir: "C:/repo", sessions: [], messages: [], events: [], tasks: [], taskMessages: [], taskEvents: [], teams: [], teamRuns: [],
  } as any;
}

describe("restorePersistedCollections resilience", () => {
  test("skips malformed messages instead of dropping all chat history", () => {
    const record = baseRecord();
    record.messages = [
      { id: "bad", chatId: "chat-1" },
      { id: "good", chatId: "chat-1", role: "user", content: "hello", timestamp: 1 },
    ];
    record.sessions = [{ id: "chat-1" }];
    const restored = restorePersistedCollections(record, {
      restoreChatState: (raw: any) => ({ ...raw, title: "Chat" }),
      restoreTaskState: () => null,
      restoreTeamState: () => null,
      restoreTeamRunState: () => null,
    });
    expect(restored?.chats).toHaveLength(1);
    expect(restored?.chats[0]?.messages).toEqual([expect.objectContaining({ id: "good", content: "hello" })]);
  });

  test("skips one invalid chat while preserving valid chats", () => {
    const record = baseRecord();
    record.sessions = [{ id: "bad" }, { id: "good" }];
    const restored = restorePersistedCollections(record, {
      restoreChatState: (raw: any) => raw.id === "good" ? ({ ...raw, title: "Good", messages: raw.messages ?? [] }) : null,
      restoreTaskState: () => null,
      restoreTeamState: () => null,
      restoreTeamRunState: () => null,
    });
    expect(restored?.chats.map((chat) => chat.id)).toEqual(["good"]);
  });
});