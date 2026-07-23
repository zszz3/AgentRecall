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
    archiveRoom: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => ({ messages: [] })),
    sendMessage: vi.fn(async (request) => ({ rootMessageId: "message-1", message: request })),
    stopTurn: vi.fn(async () => true),
    subscribe: vi.fn((listener) => {
      eventListener = listener;
      return () => { eventListener = undefined; };
    }),
  } as unknown as TeamChatService;
  const send = vi.fn();
  const dispose = registerTeamChatIpc({ ipc, service, send });
  const invoke = (channel: string, value?: unknown) => handlers.get(channel)?.({}, value);
  return { handlers, invoke, ipc, service, send, dispose, emit: (event: TeamChatEvent) => eventListener?.(event) };
}

describe("registerTeamChatIpc", () => {
  it("registers only Team Chat channels and forwards service events", () => {
    const fixture = setup();
    const event: TeamChatEvent = { type: "rooms-changed" };

    fixture.emit(event);

    expect([...fixture.handlers.keys()]).toHaveLength(12);
    expect([...fixture.handlers.keys()].every((channel) => channel.startsWith("team-chat:"))).toBe(true);
    expect(fixture.send).toHaveBeenCalledWith(TEAM_CHAT_CHANNELS.event, event);
  });

  it("switches back to the managed local database without accepting a path from Renderer", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.connectionUseLocal)).resolves.toMatchObject({ mode: "local" });

    expect(service.useLocalDatabase).toHaveBeenCalledWith();
  });

  it("validates connection URLs and delegates a valid connection", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.connectionConnect, { connectionUrl: "https://example.com/db" }))
      .rejects.toThrow(/postgres/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.connectionConnect, {
      connectionUrl: "postgresql://user:secret@localhost/agent_recall",
    })).resolves.toMatchObject({ state: "ready" });
    expect(service.connect).toHaveBeenCalledWith("postgresql://user:secret@localhost/agent_recall");
  });

  it("bounds room names and member selection before delegation", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.roomsCreate, {
      name: "x".repeat(121), workDir: "", agentIds: ["builder"],
    })).rejects.toThrow(/too big|too long|maximum/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.roomsCreate, {
      name: "Room", workDir: "", agentIds: [],
    })).rejects.toThrow(/too small|at least/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.roomsCreate, {
      name: "Room", workDir: "", agentIds: Array.from({ length: 25 }, (_, index) => `agent-${index}`),
    })).rejects.toThrow(/too big|maximum/i);
    expect(service.createRoom).not.toHaveBeenCalled();
  });

  it("bounds message length and pagination, then delegates valid requests", async () => {
    const { invoke, service } = setup();

    await expect(invoke(TEAM_CHAT_CHANNELS.messagesSend, { roomId: "room-1", content: "x".repeat(100_001) }))
      .rejects.toThrow(/too big|too long|maximum/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.messagesList, { roomId: "room-1", limit: 101 }))
      .rejects.toThrow(/too big|less than or equal|maximum/i);
    await expect(invoke(TEAM_CHAT_CHANNELS.messagesSend, { roomId: "room-1", content: "hello" }))
      .resolves.toMatchObject({ rootMessageId: "message-1" });
    expect(service.sendMessage).toHaveBeenCalledWith({ roomId: "room-1", content: "hello" });
  });

  it("removes registered handlers and the service listener on dispose", () => {
    const fixture = setup();

    fixture.dispose();
    fixture.emit({ type: "rooms-changed" });

    expect(fixture.ipc.removeHandler).toHaveBeenCalledTimes(12);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
