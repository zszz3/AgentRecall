import { describe, expect, it, vi } from "vitest";
import { TEAM_CHAT_CHANNELS } from "../shared/ipc/team-chat";
import type { TeamChatEvent } from "../shared/team-chat";
import type { TeamChatService } from "./team-chat/team-chat-service";
import { registerTeamChatIpc } from "./ipc/team-chat";

function setup() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let eventListener: ((event: TeamChatEvent) => void) | undefined;
  const ipc = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const service = {
    getConnectionStatus: vi.fn(() => ({ state: "ready", databaseLabel: "localhost/db" })),
    connect: vi.fn(async () => ({ state: "ready", databaseLabel: "localhost/db" })),
    useLocalDatabase: vi.fn(async () => ({ state: "ready", mode: "local", databaseLabel: "Local database" })),
    disconnect: vi.fn(async () => ({ state: "unconfigured" })),
    listRooms: vi.fn(async () => []),
    getRoom: vi.fn(async (roomId) => ({ id: roomId })),
    createRoom: vi.fn(async (request) => ({ id: "room-1", ...request })),
    updateRoom: vi.fn(async (request) => request),
    removeRoomMember: vi.fn(async (roomId) => ({ id: roomId, agents: [] })),
    archiveRoom: vi.fn(async () => undefined),
    deleteRoom: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => ({ messages: [] })),
    sendMessage: vi.fn(async (request) => ({ rootMessageId: "message-1", message: request })),
    stopTurn: vi.fn(async () => true),
    resetAgentSession: vi.fn(async (roomId, agentId) => ({ id: roomId, resetAgentId: agentId })),
    subscribe: vi.fn((listener) => {
      eventListener = listener;
      return () => { eventListener = undefined; };
    }),
  } as unknown as TeamChatService;
  const send = vi.fn();
  const ensureReady = vi.fn(async () => undefined);
  const dispose = registerTeamChatIpc({ ipc, service, send, ensureReady });
  const invoke = (channel: string, value?: unknown) => handlers.get(channel)?.({}, value);
  return { handlers, invoke, ipc, service, send, ensureReady, dispose, emit: (event: TeamChatEvent) => eventListener?.(event) };
}

describe("registerTeamChatIpc", () => {
  it("registers only Team Chat channels and forwards service events", () => {
    const fixture = setup();
    const event: TeamChatEvent = { type: "rooms-changed" };

    fixture.emit(event);

    expect([...fixture.handlers.keys()]).toHaveLength(15);
    expect([...fixture.handlers.keys()].every((channel) => channel.startsWith("team-chat:"))).toBe(true);
    expect(fixture.send).toHaveBeenCalledWith(TEAM_CHAT_CHANNELS.event, event);
  });

  it("switches back to the managed local database without accepting a path from Renderer", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.connectionUseLocal)).resolves.toMatchObject({ mode: "local" });

    expect(service.useLocalDatabase).toHaveBeenCalledWith();
  });

  it("uses the shared managed database and ignores Renderer connection payloads", async () => {
    const { invoke, service, ensureReady } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.connectionConnect, {
      connectionUrl: "https://renderer-must-not-select-storage.example",
    })).resolves.toMatchObject({ state: "ready" });
    expect(ensureReady).toHaveBeenCalledOnce();
    expect(service.connect).toHaveBeenCalledWith();
  });

  it("does not start Automation just to report the current Chat connection status", async () => {
    const { invoke, ensureReady } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.connectionStatus)).resolves.toMatchObject({ state: "ready" });
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it("opens the managed Chat store before listing groups", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.roomsList)).resolves.toEqual([]);

    expect(service.connect).toHaveBeenCalledOnce();
    expect(service.listRooms).toHaveBeenCalledOnce();
  });

  it("bounds room names and member selection before delegation", async () => {
    const { invoke, service } = setup();
    const member = (index: number) => ({
      configuredAgentId: `agent-${index}`,
      displayName: `Employee ${index}`,
    });

    await expect(invoke(TEAM_CHAT_CHANNELS.roomsCreate, {
      name: "x".repeat(121), workDir: "", members: [member(1)],
    })).rejects.toThrow(/too big|too long|maximum/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.roomsCreate, {
      name: "Room", workDir: "", members: [],
    })).rejects.toThrow(/too small|at least/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.roomsCreate, {
      name: "Room", workDir: "", members: Array.from({ length: 25 }, (_, index) => member(index)),
    })).rejects.toThrow(/too big|maximum/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.roomsCreate, {
      name: "Room",
      workDir: "",
      members: [
        { configuredAgentId: "codex", displayName: "Codex" },
        { configuredAgentId: "codex", displayName: "codex" },
      ],
    })).rejects.toThrow(/unique/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.roomsCreate, {
      name: "Room",
      workDir: "",
      members: [
        { configuredAgentId: "codex", displayName: "Codex" },
        { configuredAgentId: "codex", displayName: "Codex2" },
      ],
    })).resolves.toMatchObject({ id: "room-1" });
    expect(service.createRoom).toHaveBeenCalledOnce();
    expect(service.createRoom).toHaveBeenCalledWith({
      name: "Room",
      workDir: "",
      members: [
        { configuredAgentId: "codex", displayName: "Codex" },
        { configuredAgentId: "codex", displayName: "Codex2" },
      ],
    });
  });

  it("allows a room update to remove its final unavailable employee", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.roomsUpdate, {
      roomId: "room-1",
      members: [],
    })).resolves.toEqual({ roomId: "room-1", members: [] });
    expect(service.updateRoom).toHaveBeenCalledWith({ roomId: "room-1", members: [] });
  });

  it("removes a room employee by member id without checking its configured Agent", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.roomsRemoveMember, {
      roomId: "room-1",
      memberId: "employee-1",
    })).resolves.toMatchObject({ id: "room-1" });
    expect(service.removeRoomMember).toHaveBeenCalledWith("room-1", "employee-1");
  });

  it("bounds message length and pagination, then delegates valid requests", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.messagesSend, {
      roomId: "room-1",
      content: "x".repeat(100_001),
      targetMemberIds: ["builder"],
    }))
      .rejects.toThrow(/too big|too long|maximum/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.messagesList, { roomId: "room-1", limit: 101 }))
      .rejects.toThrow(/too big|less than or equal|maximum/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.messagesSend, {
      roomId: "room-1",
      content: "hello",
      targetMemberIds: [],
    })).resolves.toMatchObject({ rootMessageId: "message-1" });
    await expect(invoke(TEAM_CHAT_CHANNELS.messagesSend, {
      roomId: "room-1",
      content: "hello",
      targetMemberIds: ["builder"],
    }))
      .resolves.toMatchObject({ rootMessageId: "message-1" });
    expect(service.sendMessage).toHaveBeenCalledWith({
      roomId: "room-1",
      content: "hello",
      targetMemberIds: ["builder"],
    });
  });

  it("validates and delegates a room Agent conversation reset", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.agentSessionReset, {
      roomId: "",
      agentId: "builder",
    })).rejects.toThrow();
    await expect(invoke(TEAM_CHAT_CHANNELS.agentSessionReset, {
      roomId: "room-1",
      agentId: "builder",
      runtimeConversation: { payload: "must not cross IPC" },
    })).rejects.toThrow();
    await expect(invoke(TEAM_CHAT_CHANNELS.agentSessionReset, {
      roomId: "room-1",
      agentId: "builder",
    })).resolves.toMatchObject({ id: "room-1", resetAgentId: "builder" });

    expect(service.resetAgentSession).toHaveBeenCalledWith("room-1", "builder");
  });

  it("validates and delegates permanent room deletion", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.roomsDelete, "")).rejects.toThrow();
    await expect(invoke(TEAM_CHAT_CHANNELS.roomsDelete, "room-1")).resolves.toBeUndefined();

    expect(service.deleteRoom).toHaveBeenCalledWith("room-1");
  });

  it("removes registered handlers and the service listener on dispose", () => {
    const fixture = setup();

    fixture.dispose();
    fixture.emit({ type: "rooms-changed" });

    expect(fixture.ipc.removeHandler).toHaveBeenCalledTimes(15);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
