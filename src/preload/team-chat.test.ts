import { describe, expect, it, vi } from "vitest";
import { TEAM_CHAT_CHANNELS } from "../shared/ipc/team-chat";
import { createTeamChatApi } from "./team-chat";

describe("createTeamChatApi", () => {
  it("maps the complete Team Chat API to prefixed channels", async () => {
    const ipc = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const api = createTeamChatApi(ipc as never);

    await api.getConnectionStatus();
    await api.connect("postgresql://localhost/agent_recall");
    await api.useLocalDatabase();
    await api.disconnect();
    await api.listRooms();
    await api.getRoom("room-1");
    await api.createRoom({ name: "Room", workDir: "", agentIds: ["builder"] });
    await api.updateRoom({ roomId: "room-1", name: "Renamed" });
    await api.archiveRoom("room-1");
    await api.listMessages({ roomId: "room-1", limit: 50 });
    await api.sendMessage({ roomId: "room-1", content: "hello" });
    await api.stopTurn("message-1");
    await api.resetAgentSession({ roomId: "room-1", agentId: "builder" });

    expect(ipc.invoke.mock.calls).toEqual([
      [TEAM_CHAT_CHANNELS.connectionStatus],
      [TEAM_CHAT_CHANNELS.connectionConnect, { connectionUrl: "postgresql://localhost/agent_recall" }],
      [TEAM_CHAT_CHANNELS.connectionUseLocal],
      [TEAM_CHAT_CHANNELS.connectionDisconnect],
      [TEAM_CHAT_CHANNELS.roomsList],
      [TEAM_CHAT_CHANNELS.roomsGet, "room-1"],
      [TEAM_CHAT_CHANNELS.roomsCreate, { name: "Room", workDir: "", agentIds: ["builder"] }],
      [TEAM_CHAT_CHANNELS.roomsUpdate, { roomId: "room-1", name: "Renamed" }],
      [TEAM_CHAT_CHANNELS.roomsArchive, "room-1"],
      [TEAM_CHAT_CHANNELS.messagesList, { roomId: "room-1", limit: 50 }],
      [TEAM_CHAT_CHANNELS.messagesSend, { roomId: "room-1", content: "hello" }],
      [TEAM_CHAT_CHANNELS.turnsStop, "message-1"],
      [TEAM_CHAT_CHANNELS.agentSessionReset, { roomId: "room-1", agentId: "builder" }],
    ]);
  });

  it("unsubscribes event listeners with the same callback", () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const api = createTeamChatApi(ipc as never);
    const unsubscribe = api.onEvent(() => undefined);
    const listener = ipc.on.mock.calls[0]?.[1];

    unsubscribe();

    expect(ipc.removeListener).toHaveBeenCalledWith(TEAM_CHAT_CHANNELS.event, listener);
  });
});
