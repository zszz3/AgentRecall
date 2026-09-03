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
  TeamChatWorkspaceReservation,
} from "../../shared/team-chat";
import { TeamChatService } from "./team-chat-service";
import type {
  TeamChatAgentSession,
  TeamChatAttemptEvent,
  TeamChatDispatchUpdate,
  TeamChatExecutionAttempt,
  TeamChatExecutionAttemptUpdate,
  TeamChatMention,
  TeamChatPendingActivation,
  TeamChatRoomTurn,
  TeamChatStore,
  TeamChatTask,
  TeamChatTaskFinish,
} from "./team-chat-store";

class MemoryTeamChatStore implements TeamChatStore {
  readonly rooms: TeamChatRoom[] = [];
  readonly messages: TeamChatMessage[] = [];
  readonly dispatches: TeamChatDispatch[] = [];
  readonly mentions: TeamChatMention[] = [];
  readonly tasks: TeamChatTask[] = [];
  readonly attempts: TeamChatExecutionAttempt[] = [];
  readonly attemptEvents: TeamChatAttemptEvent[] = [];
  readonly sessions: TeamChatAgentSession[] = [];
  readonly reservations: TeamChatWorkspaceReservation[] = [];
  initialized = false;
  closed = false;

  async initialize(): Promise<void> { this.initialized = true; }
  async close(): Promise<void> { this.closed = true; }
  async listRooms(): Promise<TeamChatRoomSummary[]> {
    return this.rooms.filter((room) => !room.archived).map((room) => ({
      id: room.id,
      name: room.name,
      workDir: room.workDir,
      archived: room.archived,
      agentCount: room.agents.length,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    }));
  }
  async getRoom(roomId: string): Promise<TeamChatRoom | undefined> {
    return this.rooms.find((room) => room.id === roomId);
  }
  async createRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    this.rooms.push(structuredClone(room));
    return structuredClone(room);
  }
  async updateRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    const index = this.rooms.findIndex((item) => item.id === room.id);
    if (index >= 0) this.rooms[index] = structuredClone(room);
    return structuredClone(room);
  }
  async archiveRoom(roomId: string, updatedAt: string): Promise<void> {
    const room = this.rooms.find((item) => item.id === roomId);
    if (room) Object.assign(room, { archived: true, updatedAt });
  }
  async deleteRoom(roomId: string): Promise<boolean> {
    const index = this.rooms.findIndex((room) => room.id === roomId);
    if (index < 0) return false;
    this.rooms.splice(index, 1);
    for (const collection of [
      this.messages,
      this.dispatches,
      this.mentions,
      this.tasks,
      this.sessions,
      this.reservations,
    ]) {
      for (let itemIndex = collection.length - 1; itemIndex >= 0; itemIndex -= 1) {
        if (collection[itemIndex]?.roomId === roomId) collection.splice(itemIndex, 1);
      }
    }
    return true;
  }
  async listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage> {
    const limit = request.limit ?? 100;
    return {
      messages: this.messages
        .filter((message) => message.roomId === request.roomId)
        .slice(-limit)
        .map((message) => structuredClone(message)),
    };
  }
  async getLatestMessageSequence(roomId: string): Promise<number> {
    return Math.max(
      0,
      ...this.messages
        .filter((message) => message.roomId === roomId)
        .map((message) => message.sequence),
    );
  }
  async listRoomContext(
    roomId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number,
  ) {
    const matching = this.messages.filter((message) =>
      message.roomId === roomId &&
      message.sequence > afterSequence &&
      message.sequence <= throughSequence);
    const messages = matching.slice(-limit).map((message) => structuredClone(message));
    const firstSequence = messages[0]?.sequence;
    return {
      messages,
      truncated: matching.length > limit,
      snapshotSequence: throughSequence,
      ...(matching.length > limit && firstSequence !== undefined
        ? { omittedSequenceRange: { from: afterSequence + 1, to: firstSequence - 1 } }
        : {}),
    };
  }
  async getMessages(roomId: string, messageIds: string[]): Promise<TeamChatMessage[]> {
    const ids = new Set(messageIds);
    return this.messages
      .filter((message) => message.roomId === roomId && ids.has(message.id))
      .map((message) => structuredClone(message));
  }
  async readMessageRange(
    roomId: string,
    range: { after?: number; before?: number; limit: number },
  ): Promise<TeamChatMessage[]> {
    return this.messages
      .filter((message) =>
        message.roomId === roomId &&
        (range.after === undefined || message.sequence > range.after) &&
        (range.before === undefined || message.sequence < range.before))
      .slice(0, range.limit)
      .map((message) => structuredClone(message));
  }
  async searchMessages(roomId: string, query: string, limit: number): Promise<TeamChatMessage[]> {
    return this.messages
      .filter((message) =>
        message.roomId === roomId &&
        message.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .slice(-limit)
      .map((message) => structuredClone(message));
  }
  async insertMessage(message: TeamChatMessage): Promise<TeamChatMessage> {
    const saved = {
      ...structuredClone(message),
      sequence: this.messages.filter((item) => item.roomId === message.roomId).length + 1,
    };
    this.messages.push(saved);
    return structuredClone(saved);
  }
  async insertMessageWithActivations(
    message: TeamChatMessage,
    activations: TeamChatPendingActivation[],
  ) {
    const savedMessage = await this.insertMessage(message);
    const savedActivations = activations.map((activation) => ({
      mention: structuredClone(activation.mention),
      task: structuredClone(activation.task),
      dispatch: {
        ...structuredClone(activation.dispatch),
        roomSnapshotSequence: savedMessage.sequence,
      },
    }));
    for (const activation of savedActivations) {
      this.mentions.push(structuredClone(activation.mention));
      this.tasks.push(structuredClone(activation.task));
      this.dispatches.push(structuredClone(activation.dispatch));
    }
    return {
      message: savedMessage,
      activations: savedActivations,
    };
  }
  async insertDispatch(dispatch: TeamChatDispatch): Promise<TeamChatDispatch> {
    this.dispatches.push(structuredClone(dispatch));
    return structuredClone(dispatch);
  }
  async listQueuedDispatches(): Promise<TeamChatDispatch[]> {
    return this.dispatches
      .filter((dispatch) => dispatch.status === "queued")
      .sort((left, right) =>
        (left.roomSnapshotSequence ?? 0) - (right.roomSnapshotSequence ?? 0))
      .map((dispatch) => structuredClone(dispatch));
  }
  async listInbox(
    roomId: string,
    memberId: string,
    status: TeamChatDispatch["status"] | undefined,
    limit: number,
  ) {
    return this.dispatches
      .filter((dispatch) =>
        dispatch.roomId === roomId &&
        dispatch.targetAgentId === memberId &&
        (status === undefined || dispatch.status === status))
      .slice(-limit)
      .map((dispatch) => {
        const message = this.messages.find((item) => item.id === dispatch.sourceMessageId)!;
        return {
          mentionId: dispatch.mentionId!,
          messageId: message.id,
          taskId: dispatch.taskId!,
          turnId: dispatch.id,
          memberId,
          sequence: message.sequence,
          content: message.content,
          status: dispatch.status,
          createdAt: dispatch.createdAt,
          updatedAt: dispatch.updatedAt,
        };
      });
  }
  async insertExecutionAttempt(attempt: TeamChatExecutionAttempt): Promise<void> {
    this.attempts.push(structuredClone(attempt));
  }
  async updateExecutionAttempt(
    attemptId: string,
    patch: TeamChatExecutionAttemptUpdate,
  ): Promise<void> {
    const attempt = this.attempts.find((item) => item.id === attemptId);
    if (attempt) Object.assign(attempt, structuredClone(patch));
  }
  async listExecutionAttempts(dispatchId: string): Promise<TeamChatExecutionAttempt[]> {
    return this.attempts
      .filter((attempt) => attempt.dispatchId === dispatchId)
      .map((attempt) => structuredClone(attempt));
  }
  async insertAttemptEvent(event: TeamChatAttemptEvent): Promise<void> {
    this.attemptEvents.push(structuredClone(event));
  }
  async listTurnEvents(
    roomId: string,
    dispatchId: string,
    limit: number,
  ): Promise<TeamChatAttemptEvent[]> {
    const dispatch = this.dispatches.find((item) =>
      item.roomId === roomId && item.id === dispatchId);
    if (!dispatch) return [];
    const attemptIds = new Set(this.attempts
      .filter((attempt) => attempt.dispatchId === dispatchId)
      .map((attempt) => attempt.id));
    return this.attemptEvents
      .filter((event) => attemptIds.has(event.attemptId))
      .slice(0, limit)
      .map((event) => structuredClone(event));
  }
  async listRoomTurns(roomId: string, limit: number): Promise<TeamChatRoomTurn[]> {
    return this.dispatches
      .filter((dispatch) => dispatch.roomId === roomId)
      .slice(-limit)
      .reverse()
      .map((dispatch) => this.roomTurn(dispatch));
  }
  async getRoomTurn(
    roomId: string,
    dispatchId: string,
  ): Promise<TeamChatRoomTurn | undefined> {
    const dispatch = this.dispatches.find((item) =>
      item.roomId === roomId && item.id === dispatchId);
    return dispatch ? this.roomTurn(dispatch) : undefined;
  }
  async listThreadMessages(
    roomId: string,
    rootMessageId: string,
    limit: number,
  ): Promise<TeamChatMessage[]> {
    return this.messages
      .filter((message) =>
        message.roomId === roomId && message.rootMessageId === rootMessageId)
      .slice(0, limit)
      .map((message) => structuredClone(message));
  }
  async finishTask(
    roomId: string,
    memberId: string,
    taskId: string,
    finish: TeamChatTaskFinish,
  ): Promise<TeamChatTask | undefined> {
    const task = this.tasks.find((item) =>
      item.roomId === roomId && item.memberId === memberId && item.id === taskId);
    if (!task) return undefined;
    if (task.status !== "in_progress") {
      if (
        task.status !== finish.status ||
        task.summary !== finish.summary ||
        JSON.stringify(task.evidence) !== JSON.stringify(finish.evidence)
      ) {
        throw new Error("The Studio Task is already finished with a different result.");
      }
      return structuredClone(task);
    }
    Object.assign(task, {
      status: finish.status,
      summary: finish.summary,
      evidence: structuredClone(finish.evidence),
      updatedAt: finish.finishedAt,
      finishedAt: finish.finishedAt,
    });
    return structuredClone(task);
  }
  async updateDispatch(dispatchId: string, patch: TeamChatDispatchUpdate): Promise<void> {
    const dispatch = this.dispatches.find((item) => item.id === dispatchId);
    if (dispatch) Object.assign(dispatch, patch);
  }
  async markRunningDispatchesInterrupted(updatedAt: string): Promise<void> {
    for (const dispatch of this.dispatches) {
      if (dispatch.status === "running") {
        Object.assign(dispatch, { status: "interrupted", finishedAt: updatedAt, updatedAt });
      }
    }
  }
  async listAgentSessions(roomId: string): Promise<TeamChatAgentSession[]> {
    return this.sessions
      .filter((session) => session.roomId === roomId)
      .map((session) => structuredClone(session));
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
  async listWorkspaceReservations(
    roomId: string,
    relativePaths?: string[],
  ): Promise<TeamChatWorkspaceReservation[]> {
    const paths = relativePaths ? new Set(relativePaths) : undefined;
    return this.reservations
      .filter((reservation) =>
        reservation.roomId === roomId &&
        (!paths || paths.has(reservation.relativePath)))
      .map((reservation) => structuredClone(reservation));
  }
  async reserveWorkspacePaths(
    reservations: TeamChatWorkspaceReservation[],
  ): Promise<TeamChatWorkspaceReservation[]> {
    for (const reservation of reservations) {
      const index = this.reservations.findIndex((item) =>
        item.roomId === reservation.roomId && item.relativePath === reservation.relativePath);
      if (index >= 0) this.reservations[index] = structuredClone(reservation);
      else this.reservations.push(structuredClone(reservation));
    }
    return reservations.map((reservation) => structuredClone(reservation));
  }
  async releaseWorkspacePaths(
    roomId: string,
    memberId: string,
    relativePaths: string[],
  ): Promise<number> {
    const paths = new Set(relativePaths);
    let released = 0;
    for (let index = this.reservations.length - 1; index >= 0; index -= 1) {
      const reservation = this.reservations[index]!;
      if (
        reservation.roomId === roomId &&
        reservation.memberId === memberId &&
        paths.has(reservation.relativePath)
      ) {
        this.reservations.splice(index, 1);
        released += 1;
      }
    }
    return released;
  }

  private roomTurn(dispatch: TeamChatDispatch): TeamChatRoomTurn {
    const task = dispatch.taskId
      ? this.tasks.find((item) => item.id === dispatch.taskId)
      : undefined;
    const triggerMessage = this.messages.find((message) =>
      message.id === dispatch.sourceMessageId)!;
    const replyMessage = this.messages.find((message) =>
      message.roomId === dispatch.roomId &&
      message.rootMessageId === dispatch.rootMessageId &&
      message.sourceMessageId === dispatch.sourceMessageId &&
      message.senderAgentId === dispatch.targetAgentId &&
      message.deliveryType === "reply");
    return structuredClone({
      dispatch,
      ...(task ? { task } : {}),
      triggerMessage,
      ...(replyMessage ? { replyMessage } : {}),
    });
  }
}

function configuredAgent(id = "codex-profile", name = "Codex"): ConfiguredAgent {
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

type ExecuteInput = {
  configuredAgentId: string;
  prompt: string;
  workDir?: string;
  runtimeConversation?: RuntimeConversation;
  developerInstructions?: string;
  agentRecallMcp?: { studioToken?: string };
  ownerReference: Record<string, string>;
};

async function createFixture(options: {
  executeAgent?: (
    input: ExecuteInput,
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ) => Promise<{
    output: string;
    durationMs: number;
    runtimeConversation?: RuntimeConversation;
    executionReference?: { sessionId?: string; turnId?: string };
  }>;
  members?: Array<{ configuredAgentId: string; displayName: string }>;
} = {}) {
  const store = new MemoryTeamChatStore();
  const events: TeamChatEvent[] = [];
  let idSequence = 0;
  let timeSequence = 0;
  const profile = configuredAgent();
  const configuredAgents = [profile];
  const service = new TeamChatService({
    configuredAgents: () => configuredAgents,
    executeAgent: options.executeAgent ?? (async () => ({ output: "done", durationMs: 1 })),
    storeFactory: () => store,
    emit: (event) => events.push(event),
    idFactory: () => `019c0000-0000-7000-8000-${String(++idSequence).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 6, 23, 8, 0, ++timeSequence)),
  });
  await service.connect();
  const room = await service.createRoom({
    name: "Release studio",
    workDir: "/synthetic/repo",
    members: options.members ?? [
      { configuredAgentId: profile.id, displayName: "Codex" },
      { configuredAgentId: profile.id, displayName: "Codex2" },
    ],
  });
  return { service, store, events, room, configuredAgents };
}

function waitForRoot(events: TeamChatEvent[], rootMessageId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (events.some((event) =>
        event.type === "turn-finished" && event.rootMessageId === rootMessageId)) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 2_000) {
        reject(new Error("Timed out waiting for studio dispatches"));
        return;
      }
      setTimeout(poll, 1);
    };
    poll();
  });
}

function conversation(threadId: string): RuntimeConversation {
  return {
    runtimeId: "codex",
    codecVersion: "1",
    payload: { native: { threadId } },
  };
}

describe("TeamChatService studio employees", () => {
  it("reports every room member that references an Agent", async () => {
    const { service } = await createFixture();

    await expect(service.configuredAgentReferences(new Set(["codex-profile"]))).resolves.toEqual([
      { agentId: "codex-profile", location: "Team Chat room Release studio member Codex" },
      { agentId: "codex-profile", location: "Team Chat room Release studio member Codex2" },
    ]);
  });

  it("creates separate employee instances backed by the same configured Agent", async () => {
    const { room } = await createFixture();

    expect(room.agents).toHaveLength(2);
    expect(room.agents[0]?.agentId).not.toBe(room.agents[1]?.agentId);
    expect(room.agents.map((member) => member.configuredAgentId)).toEqual([
      "codex-profile",
      "codex-profile",
    ]);
    expect(room.agents.map((member) => member.displayName)).toEqual(["Codex", "Codex2"]);
  });

  it("removes unavailable employees while preserving other missing Agent ids", async () => {
    const { service, room, configuredAgents } = await createFixture();
    configuredAgents.length = 0;

    const oneRemaining = await service.updateRoom({
      roomId: room.id,
      members: [{
        memberId: room.agents[1]!.agentId,
        configuredAgentId: room.agents[1]!.configuredAgentId,
        displayName: room.agents[1]!.displayName,
      }],
    });
    expect(oneRemaining.agents).toEqual([
      expect.objectContaining({
        agentId: room.agents[1]!.agentId,
        configuredAgentId: "codex-profile",
        enabled: false,
      }),
    ]);

    await expect(service.updateRoom({ roomId: room.id, members: [] }))
      .resolves.toMatchObject({ agents: [] });
  });

  it("removes an employee even when its configured Agent no longer exists", async () => {
    const { service, room, configuredAgents } = await createFixture();
    configuredAgents.length = 0;

    await expect(service.removeRoomMember(room.id, room.agents[0]!.agentId))
      .resolves.toMatchObject({ agents: [expect.objectContaining({ configuredAgentId: "codex-profile" })] });
  });

  it("permanently deletes a studio and removes it from the room list", async () => {
    const fixture = await createFixture();

    await expect(fixture.service.deleteRoom(fixture.room.id)).resolves.toBeUndefined();

    await expect(fixture.service.getRoom(fixture.room.id)).resolves.toBeUndefined();
    await expect(fixture.service.listRooms()).resolves.toEqual([]);
    expect(fixture.events).toContainEqual({ type: "rooms-changed" });
  });

  it("activates only the employees named in the message text", async () => {
    const calls: ExecuteInput[] = [];
    const fixture = await createFixture({
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        return { output: "done", durationMs: 1 };
      },
    });
    const [first, second] = fixture.room.agents;

    // A recipient the caller still lists but no longer mentions must not be woken,
    // which is what happens when a typed "@name" is deleted before sending.
    await expect(fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "never mind",
      targetMemberIds: [first!.agentId],
    })).resolves.toMatchObject({ rejectedTargetMemberIds: [] });
    expect(calls).toEqual([]);
    expect(fixture.store.dispatches).toEqual([]);

    // Only the mentioned employee runs, even when another id is supplied.
    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex2 take this",
      targetMemberIds: [first!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(fixture.store.dispatches.map((dispatch) => dispatch.targetAgentId))
      .toEqual([second!.agentId]);
  });

  it("saves ordinary room messages and invokes only explicitly mentioned employees", async () => {
    const calls: ExecuteInput[] = [];
    const fixture = await createFixture({
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        return { output: "@Codex2 is text only", durationMs: 1 };
      },
    });

    await expect(fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "no target",
      targetMemberIds: [],
    })).resolves.toMatchObject({ rejectedTargetMemberIds: [] });
    expect(calls).toEqual([]);
    expect(fixture.store.messages).toEqual([
      expect.objectContaining({ content: "no target" }),
    ]);
    expect(fixture.store.messages[0]).not.toHaveProperty("recipientMemberId");
    expect(fixture.store.dispatches).toEqual([]);

    const target = fixture.room.agents[0]!;
    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex check auth",
      targetMemberIds: [target.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      configuredAgentId: "codex-profile",
      workDir: "/synthetic/repo",
    });
    expect(calls[0]?.prompt).toContain(`Runtime: Codex (${target.agentId})`);
    expect(calls[0]?.developerInstructions).toContain(`Your employee identity: Codex (${target.agentId})`);
    expect(calls[0]?.agentRecallMcp?.studioToken).toEqual(expect.any(String));
    expect(fixture.store.dispatches[0]?.targetAgentId).toBe(target.agentId);
    expect(sent.rejectedTargetMemberIds).toEqual([]);
  });

  it("bounds one user message to the collaboration activation limit", async () => {
    const fixture = await createFixture({
      members: Array.from({ length: 9 }, (_, index) => ({
        configuredAgentId: "codex-profile",
        displayName: `Codex${index + 1}`,
      })),
    });

    await expect(fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex1 @Codex2 @Codex3 @Codex4 @Codex5 @Codex6 @Codex7 @Codex8 @Codex9 Run everywhere",
      targetMemberIds: fixture.room.agents.map((member) => member.agentId),
    })).rejects.toThrow(/up to 8/i);
    expect(fixture.store.messages).toEqual([]);
  });

  it("does not let an employee activate a coworker through Studio MCP", async () => {
    let studioService: TeamChatService;
    let rejected: unknown;
    const fixture = await createFixture({
      executeAgent: async (input) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        try {
          await studioService.handleMcpRequest(token, "studio/send-message", {
            toMemberId: fixture.room.agents[1]!.agentId,
            content: "Please review src/auth.ts",
          });
        } catch (error) {
          rejected = error;
        }
        return { output: "done", durationMs: 1 };
      },
    });
    studioService = fixture.service;

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex Implement auth",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(rejected).toEqual(expect.objectContaining({
      message: expect.stringMatching(/unknown studio collaboration tool/i),
    }));
    expect(fixture.store.dispatches).toHaveLength(1);
  });

  it("posts without activating coworkers and scopes message reads to the current studio", async () => {
    const toolResults: unknown[] = [];
    let studioService: TeamChatService;
    const fixture = await createFixture({
      executeAgent: async (input) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        toolResults.push(await studioService.handleMcpRequest(token, "studio/list-members", {}));
        toolResults.push(await studioService.handleMcpRequest(token, "studio/post", {
          content: "Draft is in src/auth.ts",
        }));
        toolResults.push(await studioService.handleMcpRequest(token, "studio/search", {
          query: "Draft",
          limit: 10,
        }));
        return { output: "done", durationMs: 1 };
      },
    });
    studioService = fixture.service;

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex Create a draft",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(fixture.store.dispatches).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      members: [
        expect.objectContaining({ memberId: fixture.room.agents[0]!.agentId }),
        expect.objectContaining({ memberId: fixture.room.agents[1]!.agentId }),
      ],
    });
    expect(toolResults[2]).toMatchObject({ messages: expect.any(Array) });
    expect((toolResults[2] as { messages: TeamChatMessage[] }).messages)
      .toContainEqual(expect.objectContaining({ content: "Draft is in src/auth.ts" }));
  });

  it("validates and coordinates shared workspace path reservations", async () => {
    const toolResults: Record<string, unknown> = {};
    let studioService: TeamChatService;
    const fixture = await createFixture({
      executeAgent: async (input) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        await expect(studioService.handleMcpRequest(token, "workspace/reserve", {
          paths: ["/outside.ts"],
        })).rejects.toThrow(/relative/i);
        await expect(studioService.handleMcpRequest(token, "workspace/reserve", {
          paths: ["../outside.ts"],
        })).rejects.toThrow(/relative/i);
        toolResults.reserve = await studioService.handleMcpRequest(token, "workspace/reserve", {
          paths: ["src/auth.ts", "src/auth.ts"],
          reason: "editing",
        });
        toolResults.status = await studioService.handleMcpRequest(token, "workspace/status", {});
        toolResults.release = await studioService.handleMcpRequest(token, "workspace/release", {
          paths: ["src/auth.ts"],
        });
        return { output: "done", durationMs: 1 };
      },
    });
    studioService = fixture.service;

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex Edit auth",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(toolResults.reserve).toMatchObject({ ok: true, reservations: [{ relativePath: "src/auth.ts" }] });
    expect(toolResults.status).toMatchObject({ reservations: [{ relativePath: "src/auth.ts" }] });
    expect(toolResults.release).toEqual({ ok: true, released: 1 });
    expect(fixture.store.reservations).toEqual([]);
  });

  it("reports path reservations held by another explicitly mentioned employee", async () => {
    let studioService: TeamChatService;
    let conflict: unknown;
    const fixture = await createFixture({
      executeAgent: async (input) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        if (input.prompt.includes("Runtime: Codex (")) {
          await studioService.handleMcpRequest(token, "workspace/reserve", {
            paths: ["src/shared.ts"],
            reason: "editing",
          });
        } else {
          conflict = await studioService.handleMcpRequest(token, "workspace/reserve", {
            paths: ["src/shared.ts"],
            reason: "reviewing",
          });
        }
        return { output: "done", durationMs: 1 };
      },
    });
    studioService = fixture.service;

    const first = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex Reserve this edit",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, first.rootMessageId);
    const second = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex2 Review this edit",
      targetMemberIds: [fixture.room.agents[1]!.agentId],
    });
    await waitForRoot(fixture.events, second.rootMessageId);

    expect(conflict).toMatchObject({
      ok: false,
      conflicts: [expect.objectContaining({
        memberId: fixture.room.agents[0]!.agentId,
        relativePath: "src/shared.ts",
      })],
    });
    expect(fixture.store.reservations[0]?.memberId).toBe(fixture.room.agents[0]!.agentId);
  });

  it("finishes only its scoped Task and exposes sanitized same-room Turn history", async () => {
    let studioService: TeamChatService;
    let fixtureStore: MemoryTeamChatStore;
    let firstTurnId = "";
    const toolResults: Record<string, unknown> = {};
    const fixture = await createFixture({
      executeAgent: async (input, onEvent) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        if (input.prompt.includes("Runtime: Codex (")) {
          onEvent?.({
            type: "tool_call",
            requestId: "tool-1",
            name: "shell_command",
            content: `authorization: Bearer private-token\n${"x".repeat(5_000)}`,
          });
          toolResults.finished = await studioService.handleMcpRequest(
            token,
            "studio/task/finish",
            {
              status: "completed",
              summary: "Implemented auth",
              evidence: ["npm test"],
            },
          );
          toolResults.finishedAgain = await studioService.handleMcpRequest(
            token,
            "studio/task/finish",
            {
              status: "completed",
              summary: "Implemented auth",
              evidence: ["npm test"],
            },
          );
        } else {
          toolResults.context = await studioService.handleMcpRequest(
            token,
            "studio/get-context",
            {},
          );
          toolResults.roomState = await studioService.handleMcpRequest(
            token,
            "studio/get-room-state",
            {},
          );
          toolResults.inbox = await studioService.handleMcpRequest(
            token,
            "studio/inbox/list",
            {},
          );
          toolResults.turns = await studioService.handleMcpRequest(
            token,
            "studio/turn/list",
            {},
          );
          toolResults.turn = await studioService.handleMcpRequest(
            token,
            "studio/turn/get",
            { turnId: firstTurnId },
          );
          toolResults.events = await studioService.handleMcpRequest(
            token,
            "studio/turn/events",
            { turnId: firstTurnId },
          );
          toolResults.thread = await studioService.handleMcpRequest(
            token,
            "studio/read-thread",
            { rootMessageId: fixtureStore.dispatches[0]!.rootMessageId },
          );
          await expect(studioService.handleMcpRequest(
            token,
            "studio/task/finish",
            {
              taskId: fixtureStore.tasks[0]!.id,
              status: "blocked",
              summary: "wrong task",
            },
          )).rejects.toThrow(/current task/i);
        }
        return {
          output: "done",
          durationMs: 1,
          runtimeConversation: conversation("private-session"),
          executionReference: {
            sessionId: "private-session",
            turnId: "private-native-turn",
          },
        };
      },
    });
    studioService = fixture.service;
    fixtureStore = fixture.store;

    const first = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex Implement auth",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, first.rootMessageId);
    firstTurnId = fixture.store.dispatches[0]!.id;
    const second = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex2 Inspect the first Turn",
      targetMemberIds: [fixture.room.agents[1]!.agentId],
    });
    await waitForRoot(fixture.events, second.rootMessageId);

    expect(toolResults.finishedAgain).toEqual(toolResults.finished);
    expect(fixture.store.tasks[0]).toMatchObject({
      status: "completed",
      summary: "Implemented auth",
      evidence: ["npm test"],
    });
    expect(toolResults.context).toMatchObject({
      snapshotSequence: 3,
      triggerMessageId: second.message.id,
      messages: expect.any(Array),
    });
    expect(toolResults.roomState).toMatchObject({
      room: { id: fixture.room.id },
      currentMemberId: fixture.room.agents[1]!.agentId,
      latestSequence: expect.any(Number),
    });
    expect(toolResults.inbox).toMatchObject({ items: expect.any(Array) });
    expect(toolResults.turns).toMatchObject({ turns: expect.any(Array) });
    expect(toolResults.turn).toMatchObject({
      turn: {
        turnId: firstTurnId,
        task: { status: "completed" },
        attempts: [expect.objectContaining({
          attemptNumber: 1,
          status: "completed",
        })],
      },
    });
    expect(JSON.stringify(toolResults.turn)).not.toContain("private-session");
    expect(JSON.stringify(toolResults.turn)).not.toContain("private-native-turn");
    expect(toolResults.events).toMatchObject({
      events: [expect.objectContaining({
        type: "tool_call",
        content: expect.not.stringContaining("private-token"),
      })],
    });
    expect((toolResults.events as { events: TeamChatAttemptEvent[] }).events[0]!.content.length)
      .toBeLessThanOrEqual(4_004);
    expect(toolResults.thread).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ id: first.message.id }),
      ]),
    });
  });

  it("keeps Runtime sessions isolated between two employees using one profile", async () => {
    const calls: ExecuteInput[] = [];
    const fixture = await createFixture({
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        const member = input.prompt.includes("Runtime: Codex2 (") ? "two" : "one";
        return {
          output: `${member} done`,
          durationMs: 1,
          runtimeConversation: conversation(`${member}-thread-${calls.length}`),
        };
      },
    });
    const [one, two] = fixture.room.agents;

    for (const target of [one!, two!, one!, two!]) {
      const sent = await fixture.service.sendMessage({
        roomId: fixture.room.id,
        content: `@${target.displayName} message for ${target.displayName}`,
        targetMemberIds: [target.agentId],
      });
      await waitForRoot(fixture.events, sent.rootMessageId);
    }

    expect(calls[0]?.runtimeConversation).toBeUndefined();
    expect(calls[0]?.ownerReference).toMatchObject({
      roomId: fixture.room.id,
      messageId: expect.any(String),
      dispatchId: expect.any(String),
      attemptId: expect.any(String),
    });
    expect(calls[1]?.runtimeConversation).toBeUndefined();
    expect(calls[2]?.runtimeConversation).toEqual(conversation("one-thread-1"));
    expect(calls[3]?.runtimeConversation).toEqual(conversation("two-thread-2"));
    expect(fixture.store.sessions.map((session) => session.agentId).sort())
      .toEqual([one!.agentId, two!.agentId].sort());
  });

  it("binds the Studio Turn to its native Attempt and advances only its trigger snapshot", async () => {
    const fixture = await createFixture({
      executeAgent: async () => ({
        output: "implemented",
        durationMs: 1,
        runtimeConversation: conversation("thread-1"),
        executionReference: { sessionId: "thread-1", turnId: "native-turn-1" },
      }),
    });

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex implement auth",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(fixture.store.attempts).toEqual([
      expect.objectContaining({
        dispatchId: fixture.store.dispatches[0]!.id,
        attemptNumber: 1,
        runtimeId: "codex",
        runtimeSessionRef: "thread-1",
        nativeTurnId: "native-turn-1",
        roomSnapshotSequence: 1,
        status: "completed",
      }),
    ]);
    expect(fixture.store.messages.at(-1)).toMatchObject({
      senderType: "agent",
      basedOnSequence: 1,
    });
    expect(fixture.store.sessions[0]).toMatchObject({
      roomContextSequence: 1,
      lastContextMessageId: sent.message.id,
    });
    expect(fixture.store.tasks[0]?.status).toBe("in_progress");
  });

  it("retries a missing native Session once as a fresh Attempt before any output", async () => {
    const calls: ExecuteInput[] = [];
    const fixture = await createFixture({
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        if (calls.length === 1) {
          return {
            output: "first",
            durationMs: 1,
            runtimeConversation: conversation("old-thread"),
          };
        }
        if (calls.length === 2) throw new Error("thread not found");
        return {
          output: "recovered",
          durationMs: 1,
          runtimeConversation: conversation("new-thread"),
        };
      },
    });
    const target = fixture.room.agents[0]!;
    const first = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex first",
      targetMemberIds: [target.agentId],
    });
    await waitForRoot(fixture.events, first.rootMessageId);
    const second = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex second",
      targetMemberIds: [target.agentId],
    });
    await waitForRoot(fixture.events, second.rootMessageId);

    expect(calls).toHaveLength(3);
    expect(calls[1]?.runtimeConversation).toEqual(conversation("old-thread"));
    expect(calls[2]?.runtimeConversation).toBeUndefined();
    expect(fixture.store.attempts
      .filter((attempt) => attempt.dispatchId === fixture.store.dispatches[1]!.id))
      .toEqual([
        expect.objectContaining({ attemptNumber: 1, status: "failed" }),
        expect.objectContaining({ attemptNumber: 2, status: "completed" }),
      ]);
    expect(fixture.store.sessions[0]?.runtimeConversation).toEqual(conversation("new-thread"));
  });

  it("does not retry a failed native Turn after visible output starts", async () => {
    const calls: ExecuteInput[] = [];
    const fixture = await createFixture({
      executeAgent: async (input, onEvent) => {
        calls.push(structuredClone(input));
        if (calls.length === 1) {
          return {
            output: "first",
            durationMs: 1,
            runtimeConversation: conversation("old-thread"),
          };
        }
        onEvent?.({ type: "delta", requestId: "delta-1", content: "started" });
        throw new Error("thread not found");
      },
    });
    const target = fixture.room.agents[0]!;
    const first = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex first",
      targetMemberIds: [target.agentId],
    });
    await waitForRoot(fixture.events, first.rootMessageId);
    const second = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex second",
      targetMemberIds: [target.agentId],
    });
    await waitForRoot(fixture.events, second.rootMessageId);

    expect(calls).toHaveLength(2);
    expect(fixture.store.dispatches[1]?.status).toBe("failed");
    expect(fixture.store.attempts
      .filter((attempt) => attempt.dispatchId === fixture.store.dispatches[1]!.id))
      .toEqual([
        expect.objectContaining({ attemptNumber: 1, status: "failed" }),
      ]);
  });

  it("does not commit a Task completion declaration when the native Turn fails", async () => {
    let studioService: TeamChatService;
    const fixture = await createFixture({
      executeAgent: async (input) => {
        const token = input.agentRecallMcp?.studioToken;
        if (!token) throw new Error("missing Studio token");
        await studioService.handleMcpRequest(token, "studio/task/finish", {
          status: "completed",
          summary: "declared too early",
        });
        throw new Error("native Turn failed after completion declaration");
      },
    });
    studioService = fixture.service;

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex do risky work",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(fixture.store.dispatches[0]?.status).toBe("failed");
    expect(fixture.store.tasks[0]?.status).toBe("in_progress");
  });

  it("marks the Attempt failed when bounded event persistence fails", async () => {
    const fixture = await createFixture({
      executeAgent: async (_input, onEvent) => {
        onEvent?.({ type: "delta", requestId: "delta-1", content: "started" });
        return { output: "done", durationMs: 1 };
      },
    });
    fixture.store.insertAttemptEvent = async () => {
      throw new Error("event persistence failed");
    };

    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex record this",
      targetMemberIds: [fixture.room.agents[0]!.agentId],
    });
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(fixture.store.dispatches[0]?.status).toBe("failed");
    expect(fixture.store.attempts[0]?.status).toBe("failed");
  });

  it("serializes one employee while allowing different employees to run in parallel", async () => {
    const starts: string[] = [];
    const resolvers: Array<() => void> = [];
    const fixture = await createFixture({
      executeAgent: (input) => new Promise((resolve) => {
        starts.push(input.prompt.includes("Runtime: Codex2 (") ? "two" : "one");
        resolvers.push(() => resolve({ output: "done", durationMs: 1 }));
      }),
    });
    const [one, two] = fixture.room.agents;

    const first = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex one-a",
      targetMemberIds: [one!.agentId],
    });
    const second = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex one-b",
      targetMemberIds: [one!.agentId],
    });
    const third = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex2 two-a",
      targetMemberIds: [two!.agentId],
    });
    await vi.waitFor(() => expect(starts).toEqual(["one", "two"]));
    expect(fixture.store.dispatches).toHaveLength(3);
    expect(fixture.store.dispatches.map((dispatch) => dispatch.roomSnapshotSequence))
      .toEqual([1, 2, 3]);
    expect(fixture.store.dispatches.map((dispatch) => dispatch.status))
      .toEqual(["running", "queued", "running"]);

    resolvers.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(starts).toEqual(["one", "two", "one"]));
    resolvers.splice(0).forEach((resolve) => resolve());
    await Promise.all([
      waitForRoot(fixture.events, first.rootMessageId),
      waitForRoot(fixture.events, second.rootMessageId),
      waitForRoot(fixture.events, third.rootMessageId),
    ]);
  });

  it("drains persisted queued Turns after reconnecting", async () => {
    const original = await createFixture();
    const target = original.room.agents[0]!;
    const createdAt = "2026-07-23T09:00:00.000Z";
    const messageId = "019c0000-0000-7000-8000-000000000901";
    const persisted = await original.store.insertMessageWithActivations({
      id: messageId,
      roomId: original.room.id,
      sequence: 0,
      senderType: "human",
      senderName: "You",
      content: "@Codex recover this",
      deliveryType: "message",
      rootMessageId: messageId,
      hop: 0,
      status: "final",
      createdAt,
      updatedAt: createdAt,
    }, [{
      mention: {
        id: "019c0000-0000-7000-8000-000000000902",
        roomId: original.room.id,
        messageId,
        memberId: target.agentId,
        createdAt,
      },
      task: {
        id: "019c0000-0000-7000-8000-000000000903",
        roomId: original.room.id,
        memberId: target.agentId,
        rootMessageId: messageId,
        status: "in_progress",
        evidence: [],
        createdAt,
        updatedAt: createdAt,
      },
      dispatch: {
        id: "019c0000-0000-7000-8000-000000000904",
        roomId: original.room.id,
        mentionId: "019c0000-0000-7000-8000-000000000902",
        taskId: "019c0000-0000-7000-8000-000000000903",
        rootMessageId: messageId,
        sourceMessageId: messageId,
        targetAgentId: target.agentId,
        roomSnapshotSequence: 0,
        hop: 0,
        status: "queued",
        createdAt,
        updatedAt: createdAt,
      },
    }]);
    await original.service.disconnect();

    const calls: ExecuteInput[] = [];
    const events: TeamChatEvent[] = [];
    const recovered = new TeamChatService({
      configuredAgents: () => [configuredAgent()],
      executeAgent: async (input) => {
        calls.push(structuredClone(input));
        return { output: "recovered", durationMs: 1 };
      },
      storeFactory: () => original.store,
      emit: (event) => events.push(event),
      idFactory: () => crypto.randomUUID(),
      now: () => new Date("2026-07-23T09:01:00.000Z"),
    });

    await recovered.connect();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await waitForRoot(events, messageId);

    expect(persisted.activations[0]?.dispatch.roomSnapshotSequence).toBe(1);
    expect(original.store.dispatches[0]).toMatchObject({
      id: "019c0000-0000-7000-8000-000000000904",
      status: "completed",
      roomSnapshotSequence: 1,
    });
  });

  it("resets one employee Session without affecting its coworker", async () => {
    const fixture = await createFixture({
      executeAgent: async (input) => ({
        output: "done",
        durationMs: 1,
        runtimeConversation: conversation(
          input.prompt.includes("Runtime: Codex2 (") ? "two-thread" : "one-thread",
        ),
      }),
    });
    for (const target of fixture.room.agents) {
      const sent = await fixture.service.sendMessage({
        roomId: fixture.room.id,
        content: `@${target.displayName} remember`,
        targetMemberIds: [target.agentId],
      });
      await waitForRoot(fixture.events, sent.rootMessageId);
    }

    await fixture.service.resetAgentSession(fixture.room.id, fixture.room.agents[0]!.agentId);

    expect(fixture.store.sessions).toHaveLength(1);
    expect(fixture.store.sessions[0]?.agentId).toBe(fixture.room.agents[1]!.agentId);
  });

  it("stops all active employee dispatches in one user root", async () => {
    const fixture = await createFixture({
      executeAgent: (_input, _onEvent, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    });
    const sent = await fixture.service.sendMessage({
      roomId: fixture.room.id,
      content: "@Codex @Codex2 wait",
      targetMemberIds: fixture.room.agents.map((member) => member.agentId),
    });
    await vi.waitFor(() => expect(fixture.store.dispatches.map((dispatch) => dispatch.status))
      .toEqual(["running", "running"]));

    await fixture.service.stopTurn(sent.rootMessageId);
    await waitForRoot(fixture.events, sent.rootMessageId);

    expect(fixture.store.dispatches.map((dispatch) => dispatch.status))
      .toEqual(["interrupted", "interrupted"]);
  });

  it("does not expose connection failure details", async () => {
    const store = new MemoryTeamChatStore();
    store.initialize = async () => {
      throw new Error("postgresql://user:top-secret@private.example/db");
    };
    const events: TeamChatEvent[] = [];
    const service = new TeamChatService({
      configuredAgents: () => [configuredAgent()],
      executeAgent: async () => ({ output: "", durationMs: 0 }),
      storeFactory: () => store,
      emit: (event) => events.push(event),
    });

    await expect(service.connect()).rejects.toThrow("Unable to open Chat data");
    expect(JSON.stringify(service.getConnectionStatus())).not.toContain("top-secret");
    expect(JSON.stringify(events)).not.toContain("top-secret");
  });
});
