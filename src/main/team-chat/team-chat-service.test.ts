import { describe, expect, it, vi } from "vitest";
import type { ConfiguredAgent, WorkflowAgentEvent } from "../../automation/engine/shared/types";
import type {
  ListTeamChatMessagesRequest,
  TeamChatDispatch,
  TeamChatEvent,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomSummary,
} from "../../shared/team-chat";
import type { TeamChatDispatchUpdate } from "./postgres-team-chat-store";
import { TeamChatService, type TeamChatStore } from "./team-chat-service";

class MemoryTeamChatStore implements TeamChatStore {
  readonly rooms: TeamChatRoom[] = [];
  readonly messages: TeamChatMessage[] = [];
  readonly dispatches: TeamChatDispatch[] = [];
  initialized = false;
  closed = false;

  async initialize(): Promise<void> { this.initialized = true; }
  async close(): Promise<void> { this.closed = true; }
  async listRooms(): Promise<TeamChatRoomSummary[]> {
    return this.rooms.filter((room) => !room.archived).map((room) => ({
      ...room,
      agentCount: room.agents.length,
      agents: undefined,
    })) as unknown as TeamChatRoomSummary[];
  }
  async getRoom(roomId: string): Promise<TeamChatRoom | undefined> {
    return this.rooms.find((room) => room.id === roomId);
  }
  async createRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    this.rooms.push(room);
    return room;
  }
  async updateRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    const index = this.rooms.findIndex((item) => item.id === room.id);
    if (index >= 0) this.rooms[index] = room;
    return room;
  }
  async archiveRoom(roomId: string, updatedAt: string): Promise<void> {
    const room = this.rooms.find((item) => item.id === roomId);
    if (room) Object.assign(room, { archived: true, updatedAt });
  }
  async listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage> {
    const limit = request.limit ?? 100;
    return { messages: this.messages.filter((message) => message.roomId === request.roomId).slice(-limit) };
  }
  async insertMessage(message: TeamChatMessage): Promise<TeamChatMessage> {
    this.messages.push(message);
    return message;
  }
  async insertDispatch(dispatch: TeamChatDispatch): Promise<TeamChatDispatch> {
    this.dispatches.push(dispatch);
    return dispatch;
  }
  async updateDispatch(dispatchId: string, patch: TeamChatDispatchUpdate): Promise<void> {
    const dispatch = this.dispatches.find((item) => item.id === dispatchId);
    if (dispatch) Object.assign(dispatch, patch);
  }
  async markRunningDispatchesInterrupted(updatedAt: string): Promise<void> {
    for (const dispatch of this.dispatches) {
      if (dispatch.status === "queued" || dispatch.status === "running") {
        Object.assign(dispatch, { status: "interrupted", finishedAt: updatedAt, updatedAt });
      }
    }
  }
}

function agent(id: string, name: string): ConfiguredAgent {
  return {
    id,
    name,
    description: "",
    runtimeAgentId: "codex",
    channelId: "codex-main",
    modelId: "gpt-5",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

const agents = [agent("builder", "Builder"), agent("reviewer", "Reviewer")];

async function createFixture(options: {
  configuredAgents?: ConfiguredAgent[];
  executeAgent?: (
    input: { configuredAgentId: string; prompt: string; workDir?: string },
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ) => Promise<{ output: string; durationMs: number }>;
} = {}) {
  const store = new MemoryTeamChatStore();
  const events: TeamChatEvent[] = [];
  let sequence = 0;
  const executeAgent = options.executeAgent ?? (async ({ configuredAgentId }) => ({
    output: `${configuredAgentId} complete`,
    durationMs: 1,
  }));
  const service = new TeamChatService({
    readConnectionUrl: () => "",
    writeConnectionUrl: vi.fn(),
    configuredAgents: () => options.configuredAgents ?? agents,
    executeAgent,
    storeFactory: () => store,
    emit: (event) => events.push(event),
    idFactory: () => `019c0000-0000-7000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 6, 23, 8, 0, sequence)),
  });
  await service.connect("postgresql://user:secret@localhost/agent_recall_test");
  const room = await service.createRoom({
    name: "Release room",
    workDir: "/synthetic/repo",
    agentIds: (options.configuredAgents ?? agents).map((item) => item.id),
  });
  return { service, store, events, room };
}

function waitForTurn(events: TeamChatEvent[], rootMessageId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (events.some((event) => event.type === "turn-finished" && event.rootMessageId === rootMessageId)) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 2_000) {
        reject(new Error("Timed out waiting for Team Chat turn"));
        return;
      }
      setTimeout(poll, 1);
    };
    poll();
  });
}

describe("TeamChatService", () => {
  it("opens the managed local database when no external connection is saved", async () => {
    const localStore = new MemoryTeamChatStore();
    const externalStoreFactory = vi.fn(() => new MemoryTeamChatStore());
    const writeConnectionUrl = vi.fn();
    const service = new TeamChatService({
      readConnectionUrl: () => "",
      writeConnectionUrl,
      configuredAgents: () => agents,
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      localStoreFactory: () => localStore,
      storeFactory: externalStoreFactory,
    });

    await expect(service.connect()).resolves.toEqual({
      state: "ready",
      mode: "local",
      databaseLabel: "Local database",
    });

    expect(localStore.initialized).toBe(true);
    expect(externalStoreFactory).not.toHaveBeenCalled();
    expect(writeConnectionUrl).not.toHaveBeenCalled();
  });

  it("coalesces concurrent automatic local database startup", async () => {
    const localStore = new MemoryTeamChatStore();
    const initialize = vi.spyOn(localStore, "initialize");
    const localStoreFactory = vi.fn(() => localStore);
    const service = new TeamChatService({
      readConnectionUrl: () => "",
      writeConnectionUrl: vi.fn(),
      configuredAgents: () => agents,
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      localStoreFactory,
      storeFactory: vi.fn(),
    });

    await Promise.all([service.connect(), service.connect()]);

    expect(localStoreFactory).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("can return from an external database to the managed local database", async () => {
    const localStore = new MemoryTeamChatStore();
    const externalStore = new MemoryTeamChatStore();
    const writeConnectionUrl = vi.fn();
    const service = new TeamChatService({
      readConnectionUrl: () => "postgresql://localhost/external",
      writeConnectionUrl,
      configuredAgents: () => agents,
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      localStoreFactory: () => localStore,
      storeFactory: () => externalStore,
    });
    await service.connect();

    await expect(service.useLocalDatabase()).resolves.toMatchObject({ state: "ready", mode: "local" });

    expect(externalStore.closed).toBe(true);
    expect(localStore.initialized).toBe(true);
    expect(writeConnectionUrl).toHaveBeenLastCalledWith("");
  });

  it("persists the human message and returns before a pending Agent finishes", async () => {
    let resolveExecution: ((value: { output: string; durationMs: number }) => void) | undefined;
    const execution = new Promise<{ output: string; durationMs: number }>((resolve) => { resolveExecution = resolve; });
    const { service, store, events, room } = await createFixture({ executeAgent: () => execution });

    const sent = await service.sendMessage({ roomId: room.id, content: "Please review" });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({ senderType: "human", content: "Please review" });
    expect(events.some((event) => event.type === "message-created" && event.message.id === sent.message.id)).toBe(true);
    resolveExecution?.({ output: "done", durationMs: 1 });
    await waitForTurn(events, sent.rootMessageId);
  });

  it("broadcasts an unmentioned human message and narrows an explicit mention", async () => {
    const calls: string[] = [];
    const fixture = await createFixture({
      executeAgent: async ({ configuredAgentId }) => {
        calls.push(configuredAgentId);
        return { output: "done", durationMs: 1 };
      },
    });

    const broadcast = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "一起看看" });
    await waitForTurn(fixture.events, broadcast.rootMessageId);
    expect(calls.sort()).toEqual(["builder", "reviewer"]);

    calls.length = 0;
    const mentioned = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "@Reviewer 请检查" });
    await waitForTurn(fixture.events, mentioned.rootMessageId);
    expect(calls).toEqual(["reviewer"]);
  });

  it("shows a visible routing message instead of silently broadcasting an unknown mention", async () => {
    const calls: string[] = [];
    const fixture = await createFixture({
      executeAgent: async ({ configuredAgentId }) => {
        calls.push(configuredAgentId);
        return { output: "unexpected", durationMs: 1 };
      },
    });

    const sent = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "@Unknown 请检查" });
    await waitForTurn(fixture.events, sent.rootMessageId);

    expect(calls).toEqual([]);
    expect(fixture.store.messages).toContainEqual(expect.objectContaining({
      senderType: "system",
      status: "error",
      content: expect.stringContaining("@Unknown"),
    }));
  });

  it("skips room members whose configured Agent was removed", async () => {
    const configuredAgents = [...agents];
    const calls: string[] = [];
    const fixture = await createFixture({
      configuredAgents,
      executeAgent: async ({ configuredAgentId }) => {
        calls.push(configuredAgentId);
        return { output: "done", durationMs: 1 };
      },
    });
    configuredAgents.splice(configuredAgents.findIndex((item) => item.id === "reviewer"), 1);

    const broadcast = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "一起看看" });
    await waitForTurn(fixture.events, broadcast.rootMessageId);
    expect(calls).toEqual(["builder"]);

    calls.length = 0;
    const mentioned = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "@Reviewer 请检查" });
    await waitForTurn(fixture.events, mentioned.rootMessageId);
    expect(calls).toEqual([]);
    expect(fixture.store.messages).toContainEqual(expect.objectContaining({
      senderType: "system",
      status: "error",
      content: expect.stringContaining("@Reviewer"),
    }));
  });

  it("forwards Codex deltas and persists the final Agent response in the room", async () => {
    const fixture = await createFixture({
      executeAgent: async (_input, onEvent) => {
        onEvent?.({ requestId: "codex-request", type: "delta", content: "正在" });
        onEvent?.({ requestId: "codex-request", type: "delta", content: "处理" });
        return { output: "正在处理", durationMs: 8 };
      },
    });

    const sent = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "@Builder 开始" });
    await waitForTurn(fixture.events, sent.rootMessageId);

    expect(fixture.events.filter((event) => event.type === "dispatch-delta").map((event) => event.content))
      .toEqual(["正在", "处理"]);
    expect(fixture.store.messages).toContainEqual(expect.objectContaining({
      senderType: "agent",
      senderAgentId: "builder",
      senderName: "Builder",
      content: "正在处理",
    }));
  });

  it("allows one Agent handoff while executing each Agent at most once", async () => {
    const calls: string[] = [];
    const fixture = await createFixture({
      executeAgent: async ({ configuredAgentId }) => {
        calls.push(configuredAgentId);
        return {
          output: configuredAgentId === "builder" ? "请 @Reviewer 继续" : "请 @Builder 再看一次",
          durationMs: 1,
        };
      },
    });

    const sent = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "@Builder 开始" });
    await waitForTurn(fixture.events, sent.rootMessageId);

    expect(calls).toEqual(["builder", "reviewer"]);
    expect(fixture.store.dispatches.map((dispatch) => dispatch.hop)).toEqual([0, 1]);
  });

  it("caps a root turn at eight Agent executions and writes a visible system notice", async () => {
    const manyAgents = Array.from({ length: 9 }, (_, index) => agent(`agent-${index}`, `Agent ${index}`));
    const calls: string[] = [];
    const fixture = await createFixture({
      configuredAgents: manyAgents,
      executeAgent: async ({ configuredAgentId }) => {
        calls.push(configuredAgentId);
        return { output: "done", durationMs: 1 };
      },
    });

    const sent = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "All Agents respond" });
    await waitForTurn(fixture.events, sent.rootMessageId);

    expect(calls).toHaveLength(8);
    expect(fixture.store.messages.some((message) => message.senderType === "system" && message.content.includes("8"))).toBe(true);
  });

  it("keeps sibling responses when one Agent fails", async () => {
    const fixture = await createFixture({
      executeAgent: async ({ configuredAgentId }) => {
        if (configuredAgentId === "builder") throw new Error("synthetic failure");
        return { output: "review complete", durationMs: 1 };
      },
    });

    const sent = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "一起看看" });
    await waitForTurn(fixture.events, sent.rootMessageId);

    expect(fixture.store.dispatches.find((item) => item.targetAgentId === "builder")?.status).toBe("failed");
    expect(fixture.store.dispatches.find((item) => item.targetAgentId === "reviewer")?.status).toBe("completed");
    expect(fixture.store.messages.some((message) => message.content === "review complete")).toBe(true);
    expect(fixture.store.messages.some((message) => message.status === "error")).toBe(true);
  });

  it("stops active Agent executions and marks them interrupted", async () => {
    const fixture = await createFixture({
      executeAgent: (_input, _onEvent, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    });

    const sent = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "@Builder wait" });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await fixture.service.stopTurn(sent.rootMessageId);
    await waitForTurn(fixture.events, sent.rootMessageId);

    expect(fixture.store.dispatches).toHaveLength(1);
    expect(fixture.store.dispatches[0]?.status).toBe("interrupted");
  });

  it("sanitizes connection failures before exposing status or events", async () => {
    const events: TeamChatEvent[] = [];
    const failingStore = new MemoryTeamChatStore();
    failingStore.initialize = async () => { throw new Error("postgresql://user:top-secret@private.example/db"); };
    const service = new TeamChatService({
      readConnectionUrl: () => "",
      writeConnectionUrl: vi.fn(),
      configuredAgents: () => agents,
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      storeFactory: () => failingStore,
      emit: (event) => events.push(event),
    });

    await expect(service.connect("postgresql://user:top-secret@private.example/db")).rejects.toThrow("Unable to connect");

    expect(JSON.stringify(service.getConnectionStatus())).not.toContain("top-secret");
    expect(JSON.stringify(events)).not.toContain("top-secret");
  });
});
