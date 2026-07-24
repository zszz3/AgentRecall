import { describe, expect, it, vi } from "vitest";
import type {
  ConfiguredAgent,
  RuntimeConversation,
  WorkflowAgentEvent,
} from "../../automation/contracts";
import type {
  ListTeamChatMessagesRequest,
  TeamChatDispatch,
  TeamChatEvent,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomSummary,
} from "../../shared/team-chat";
import { TeamChatService } from "./team-chat-service";
import type { TeamChatAgentSession, TeamChatDispatchUpdate, TeamChatStore } from "./team-chat-store";

class MemoryTeamChatStore implements TeamChatStore {
  readonly rooms: TeamChatRoom[] = [];
  readonly messages: TeamChatMessage[] = [];
  readonly dispatches: TeamChatDispatch[] = [];
  readonly sessions: TeamChatAgentSession[] = [];
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
  async listMessagesAfter(roomId: string, afterMessageId: string, limit: number) {
    const roomMessages = this.messages.filter((message) => message.roomId === roomId);
    const marker = roomMessages.findIndex((message) => message.id === afterMessageId);
    const messages = marker >= 0 ? roomMessages.slice(marker + 1) : [];
    return { messages: messages.slice(-limit), truncated: messages.length > limit };
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
  async listAgentSessions(roomId: string): Promise<TeamChatAgentSession[]> {
    return this.sessions.filter((session) => session.roomId === roomId).map((session) => structuredClone(session));
  }
  async upsertAgentSession(session: TeamChatAgentSession): Promise<void> {
    const index = this.sessions.findIndex((item) =>
      item.roomId === session.roomId && item.agentId === session.agentId);
    if (index >= 0) this.sessions[index] = structuredClone(session);
    else this.sessions.push(structuredClone(session));
  }
  async deleteAgentSession(roomId: string, agentId: string): Promise<void> {
    const index = this.sessions.findIndex((session) =>
      session.roomId === roomId && session.agentId === agentId);
    if (index >= 0) this.sessions.splice(index, 1);
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
    input: {
      configuredAgentId: string;
      prompt: string;
      workDir?: string;
      runtimeConversation?: RuntimeConversation;
    },
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ) => Promise<{ output: string; durationMs: number; runtimeConversation?: RuntimeConversation }>;
} = {}) {
  const store = new MemoryTeamChatStore();
  const events: TeamChatEvent[] = [];
  let sequence = 0;
  const executeAgent = options.executeAgent ?? (async ({ configuredAgentId }) => ({
    output: `${configuredAgentId} complete`,
    durationMs: 1,
  }));
  const service = new TeamChatService({
    configuredAgents: () => options.configuredAgents ?? agents,
    executeAgent,
    storeFactory: () => store,
    emit: (event) => events.push(event),
    idFactory: () => `019c0000-0000-7000-8000-${String(++sequence).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 6, 23, 8, 0, sequence)),
  });
  await service.connect();
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
  it("opens the shared AgentRecall database without user configuration", async () => {
    const store = new MemoryTeamChatStore();
    const storeFactory = vi.fn(() => store);
    const service = new TeamChatService({
      configuredAgents: () => agents,
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      storeFactory,
    });

    await expect(service.connect()).resolves.toEqual({
      state: "ready",
      mode: "local",
      databaseLabel: "AgentRecall database",
    });

    expect(store.initialized).toBe(true);
    expect(storeFactory).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent automatic database startup", async () => {
    const store = new MemoryTeamChatStore();
    const initialize = vi.spyOn(store, "initialize");
    const storeFactory = vi.fn(() => store);
    const service = new TeamChatService({
      configuredAgents: () => agents,
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      storeFactory,
    });

    await Promise.all([service.connect(), service.connect()]);

    expect(storeFactory).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("reopens the shared database after disconnecting", async () => {
    const stores = [new MemoryTeamChatStore(), new MemoryTeamChatStore()];
    let nextStore = 0;
    const service = new TeamChatService({
      configuredAgents: () => agents,
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      storeFactory: () => stores[nextStore++]!,
    });
    await service.connect();
    await service.disconnect();

    await expect(service.connect()).resolves.toMatchObject({ state: "ready", mode: "local" });

    expect(stores[0]!.closed).toBe(true);
    expect(stores[1]!.initialized).toBe(true);
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

  it("persists a room Agent conversation and reuses it with only incremental context", async () => {
    const firstConversation: RuntimeConversation = {
      runtimeId: "codex",
      codecVersion: "1",
      payload: { native: { threadId: "thread-1" } },
    };
    const secondConversation: RuntimeConversation = {
      runtimeId: "codex",
      codecVersion: "1",
      payload: { native: { threadId: "thread-2" } },
    };
    const calls: Array<{
      configuredAgentId: string;
      prompt: string;
      runtimeConversation?: RuntimeConversation;
    }> = [];
    const fixture = await createFixture({
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        return {
          output: calls.length === 1 ? "first answer" : "second answer",
          durationMs: 1,
          runtimeConversation: calls.length === 1 ? firstConversation : secondConversation,
        };
      },
    });

    const first = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "@Builder first request" });
    await waitForTurn(fixture.events, first.rootMessageId);
    const roomAfterFirst = await fixture.service.getRoom(fixture.room.id);

    expect(fixture.store.sessions).toContainEqual(expect.objectContaining({
      roomId: fixture.room.id,
      agentId: "builder",
      runtimeConversation: firstConversation,
    }));
    expect(roomAfterFirst?.agents[0]).toMatchObject({
      continuationAvailable: true,
      hasActiveConversation: true,
    });
    expect(Object.prototype.hasOwnProperty.call(roomAfterFirst?.agents[0] ?? {}, "runtimeConversation")).toBe(false);

    const second = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "@Builder second request" });
    await waitForTurn(fixture.events, second.rootMessageId);

    expect(calls[0]?.runtimeConversation).toBeUndefined();
    expect(calls[1]?.runtimeConversation).toEqual(firstConversation);
    expect(calls[1]?.prompt).toContain("Room updates since your previous turn:");
    expect(calls[1]?.prompt.match(/second request/g)).toHaveLength(1);
    expect(calls[1]?.prompt).not.toContain("first request");
    expect(fixture.store.sessions[0]?.runtimeConversation).toEqual(secondConversation);
  });

  it("keeps the same configured Agent conversation isolated between rooms", async () => {
    const conversation: RuntimeConversation = {
      runtimeId: "codex",
      codecVersion: "1",
      payload: { native: { threadId: "room-one-thread" } },
    };
    const calls: Array<{ runtimeConversation?: RuntimeConversation }> = [];
    const fixture = await createFixture({
      configuredAgents: [agents[0]!],
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        return { output: "done", durationMs: 1, runtimeConversation: conversation };
      },
    });
    const first = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "first room" });
    await waitForTurn(fixture.events, first.rootMessageId);
    const otherRoom = await fixture.service.createRoom({
      name: "Other room",
      workDir: "/synthetic/repo",
      agentIds: ["builder"],
    });

    const second = await fixture.service.sendMessage({ roomId: otherRoom.id, content: "second room" });
    await waitForTurn(fixture.events, second.rootMessageId);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.runtimeConversation).toBeUndefined();
    expect(calls[1]?.runtimeConversation).toBeUndefined();
    expect(fixture.store.sessions.map((session) => session.roomId).sort())
      .toEqual([fixture.room.id, otherRoom.id].sort());
  });

  it("drops an incompatible conversation when the configured Agent Runtime settings change", async () => {
    const configuredAgents = [structuredClone(agents[0]!)];
    const conversation: RuntimeConversation = {
      runtimeId: "codex",
      codecVersion: "1",
      payload: { native: { threadId: "old-thread" } },
    };
    const calls: Array<{ runtimeConversation?: RuntimeConversation }> = [];
    const fixture = await createFixture({
      configuredAgents,
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        return { output: "done", durationMs: 1, runtimeConversation: conversation };
      },
    });
    const first = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "first" });
    await waitForTurn(fixture.events, first.rootMessageId);
    configuredAgents[0] = {
      ...configuredAgents[0]!,
      channelId: "codex-next",
      modelId: "gpt-5-next",
    };

    const second = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "second" });
    await waitForTurn(fixture.events, second.rootMessageId);

    expect(calls[1]?.runtimeConversation).toBeUndefined();
    expect(fixture.store.sessions[0]).toMatchObject({
      channelId: "codex-next",
      modelId: "gpt-5-next",
    });
  });

  it("lets a user start a fresh conversation for one room Agent without removing room history", async () => {
    const conversation: RuntimeConversation = {
      runtimeId: "codex",
      codecVersion: "1",
      payload: { native: { threadId: "thread-to-reset" } },
    };
    const fixture = await createFixture({
      configuredAgents: [agents[0]!],
      executeAgent: async () => ({ output: "done", durationMs: 1, runtimeConversation: conversation }),
    });
    const sent = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "remember this" });
    await waitForTurn(fixture.events, sent.rootMessageId);
    const messageCount = fixture.store.messages.length;

    const room = await fixture.service.resetAgentSession(fixture.room.id, "builder");

    expect(fixture.store.sessions).toEqual([]);
    expect(fixture.store.messages).toHaveLength(messageCount);
    expect(room.agents[0]).toMatchObject({
      continuationAvailable: true,
      hasActiveConversation: false,
    });
  });

  it("retries fresh once when an untouched native conversation is no longer available", async () => {
    const expiredConversation: RuntimeConversation = {
      runtimeId: "codex",
      codecVersion: "1",
      payload: { native: { threadId: "expired-thread" } },
    };
    const replacementConversation: RuntimeConversation = {
      runtimeId: "codex",
      codecVersion: "1",
      payload: { native: { threadId: "replacement-thread" } },
    };
    const calls: Array<{ runtimeConversation?: RuntimeConversation }> = [];
    const fixture = await createFixture({
      configuredAgents: [agents[0]!],
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        if (calls.length === 1) {
          return { output: "first", durationMs: 1, runtimeConversation: expiredConversation };
        }
        if (input.runtimeConversation) throw new Error("Runtime conversation not found");
        return { output: "fresh retry", durationMs: 1, runtimeConversation: replacementConversation };
      },
    });
    const first = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "first" });
    await waitForTurn(fixture.events, first.rootMessageId);

    const second = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "continue" });
    await waitForTurn(fixture.events, second.rootMessageId);

    expect(calls).toHaveLength(3);
    expect(calls[1]?.runtimeConversation).toEqual(expiredConversation);
    expect(calls[2]?.runtimeConversation).toBeUndefined();
    expect(fixture.store.messages).toContainEqual(expect.objectContaining({
      senderType: "agent",
      content: "fresh retry",
    }));
    expect(fixture.store.sessions[0]?.runtimeConversation).toEqual(replacementConversation);
  });

  it("does not retry an unavailable conversation after text has already streamed", async () => {
    const conversation: RuntimeConversation = {
      runtimeId: "codex",
      codecVersion: "1",
      payload: { native: { threadId: "streaming-thread" } },
    };
    let calls = 0;
    const fixture = await createFixture({
      configuredAgents: [agents[0]!],
      executeAgent: async (input, onEvent) => {
        calls += 1;
        if (calls === 1) return { output: "first", durationMs: 1, runtimeConversation: conversation };
        onEvent?.({ requestId: "request-2", type: "delta", content: "partial" });
        throw new Error("Runtime conversation not found");
      },
    });
    const first = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "first" });
    await waitForTurn(fixture.events, first.rootMessageId);

    const second = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "continue" });
    await waitForTurn(fixture.events, second.rootMessageId);

    expect(calls).toBe(2);
    expect(fixture.store.dispatches.at(-1)?.status).toBe("failed");
  });

  it("does not retry a generic failure from a continued conversation", async () => {
    const conversation: RuntimeConversation = {
      runtimeId: "codex",
      codecVersion: "1",
      payload: { native: { threadId: "healthy-thread" } },
    };
    let calls = 0;
    const fixture = await createFixture({
      configuredAgents: [agents[0]!],
      executeAgent: async () => {
        calls += 1;
        if (calls === 1) return { output: "first", durationMs: 1, runtimeConversation: conversation };
        throw new Error("Network unavailable");
      },
    });
    const first = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "first" });
    await waitForTurn(fixture.events, first.rootMessageId);

    const second = await fixture.service.sendMessage({ roomId: fixture.room.id, content: "continue" });
    await waitForTurn(fixture.events, second.rootMessageId);

    expect(calls).toBe(2);
    expect(fixture.store.dispatches.at(-1)?.status).toBe("failed");
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

  it("does not expose database failure details in status or events", async () => {
    const events: TeamChatEvent[] = [];
    const failingStore = new MemoryTeamChatStore();
    failingStore.initialize = async () => { throw new Error("postgresql://user:top-secret@private.example/db"); };
    const service = new TeamChatService({
      configuredAgents: () => agents,
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      storeFactory: () => failingStore,
      emit: (event) => events.push(event),
    });

    await expect(service.connect()).rejects.toThrow("Unable to open Chat data");

    expect(JSON.stringify(service.getConnectionStatus())).not.toContain("top-secret");
    expect(JSON.stringify(events)).not.toContain("top-secret");
  });
});
