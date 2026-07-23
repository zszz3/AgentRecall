import { randomUUID } from "node:crypto";
import type { ConfiguredAgent, WorkflowAgentEvent } from "../../automation/engine/shared/types";
import type {
  CreateTeamChatRoomRequest,
  ListTeamChatMessagesRequest,
  SendTeamChatMessageRequest,
  SendTeamChatMessageResult,
  TeamChatConnectionStatus,
  TeamChatConnectionMode,
  TeamChatDispatch,
  TeamChatEvent,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomAgent,
  TeamChatRoomSummary,
  UpdateTeamChatRoomRequest,
} from "../../shared/team-chat";
import {
  PostgresTeamChatStore,
  type TeamChatDispatchUpdate,
} from "./postgres-team-chat-store";
import { buildTeamChatPrompt, resolveTeamChatRoute, resolveTeamChatTargets } from "./team-chat-routing";

const MAX_AGENT_EXECUTIONS_PER_TURN = 8;
const CONTEXT_MESSAGE_LIMIT = 40;

export interface TeamChatStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listRooms(): Promise<TeamChatRoomSummary[]>;
  getRoom(roomId: string): Promise<TeamChatRoom | undefined>;
  createRoom(room: TeamChatRoom): Promise<TeamChatRoom>;
  updateRoom(room: TeamChatRoom): Promise<TeamChatRoom>;
  archiveRoom(roomId: string, updatedAt: string): Promise<void>;
  listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage>;
  insertMessage(message: TeamChatMessage): Promise<TeamChatMessage>;
  insertDispatch(dispatch: TeamChatDispatch): Promise<TeamChatDispatch>;
  updateDispatch(dispatchId: string, patch: TeamChatDispatchUpdate): Promise<void>;
  markRunningDispatchesInterrupted(updatedAt: string): Promise<void>;
}

interface TeamChatServiceDependencies {
  readConnectionUrl: () => string;
  writeConnectionUrl: (url: string) => void;
  configuredAgents: () => ConfiguredAgent[];
  executeAgent: (
    input: { configuredAgentId: string; prompt: string; workDir?: string },
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ) => Promise<{ output: string; durationMs: number }>;
  storeFactory?: (connectionUrl: string) => TeamChatStore;
  localStoreFactory?: () => TeamChatStore;
  emit?: (event: TeamChatEvent) => void;
  idFactory?: () => string;
  now?: () => Date;
}

interface QueuedHop {
  sourceMessage: TeamChatMessage;
  targetAgentIds: string[];
  hop: number;
}

type TeamChatEventListener = (event: TeamChatEvent) => void;

export class TeamChatService {
  private readonly listeners = new Set<TeamChatEventListener>();
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly activeTurnPromises = new Set<Promise<void>>();
  private store: TeamChatStore | undefined;
  private connectedTarget = "";
  private connectionQueue: Promise<void> = Promise.resolve();
  private pendingConnection: { target: string; promise: Promise<TeamChatConnectionStatus> } | undefined;
  private status: TeamChatConnectionStatus;

  constructor(private readonly dependencies: TeamChatServiceDependencies) {
    this.status = dependencies.readConnectionUrl().trim()
      ? { state: "unconfigured", mode: "external", databaseLabel: "Configured" }
      : { state: "unconfigured", mode: "local", databaseLabel: "Local database" };
  }

  subscribe(listener: TeamChatEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getConnectionStatus(): TeamChatConnectionStatus {
    return { ...this.status };
  }

  async connect(connectionUrl?: string): Promise<TeamChatConnectionStatus> {
    const rawUrl = connectionUrl ?? this.dependencies.readConnectionUrl();
    if (!rawUrl.trim()) return this.connectLocal(false);
    const candidate = normalizePostgresUrl(rawUrl);
    if (!candidate) throw new Error("Enter a valid PostgreSQL connection URL.");
    return this.connectTarget({
      target: `external:${candidate}`,
      mode: "external",
      label: postgresDatabaseLabel(candidate),
      createStore: () => (this.dependencies.storeFactory ?? ((url) => new PostgresTeamChatStore(url)))(candidate),
      onReady: () => this.dependencies.writeConnectionUrl(candidate),
    });
  }

  async useLocalDatabase(): Promise<TeamChatConnectionStatus> {
    return this.connectLocal(true);
  }

  async disconnect(): Promise<TeamChatConnectionStatus> {
    return this.enqueueConnection(async () => {
      await this.closeCurrentStore();
      this.dependencies.writeConnectionUrl("");
      this.setStatus({ state: "unconfigured", mode: "local", databaseLabel: "Local database" });
      return this.getConnectionStatus();
    });
  }

  async close(): Promise<void> {
    await this.enqueueConnection(async () => {
      await this.closeCurrentStore();
      return this.getConnectionStatus();
    });
    this.listeners.clear();
  }

  async listRooms(): Promise<TeamChatRoomSummary[]> {
    return this.requireStore().listRooms();
  }

  async getRoom(roomId: string): Promise<TeamChatRoom | undefined> {
    return this.requireStore().getRoom(roomId);
  }

  async createRoom(request: CreateTeamChatRoomRequest): Promise<TeamChatRoom> {
    const agents = this.resolveConfiguredAgents(request.agentIds);
    const createdAt = this.timestamp();
    const roomId = this.id();
    const room: TeamChatRoom = {
      id: roomId,
      name: request.name.trim(),
      workDir: request.workDir.trim(),
      archived: false,
      agents: agents.map((agent, position) => roomAgentSnapshot(roomId, agent, position, createdAt)),
      createdAt,
      updatedAt: createdAt,
    };
    const created = await this.requireStore().createRoom(room);
    this.emit({ type: "rooms-changed" });
    return created;
  }

  async updateRoom(request: UpdateTeamChatRoomRequest): Promise<TeamChatRoom> {
    const store = this.requireStore();
    const current = await store.getRoom(request.roomId);
    if (!current) throw new Error("Team Chat room was not found.");
    const updatedAt = this.timestamp();
    const members = request.agentIds
      ? this.resolveConfiguredAgents(request.agentIds).map((agent, position) =>
          roomAgentSnapshot(current.id, agent, position, updatedAt))
      : current.agents;
    const updated: TeamChatRoom = {
      ...current,
      name: request.name === undefined ? current.name : request.name.trim(),
      workDir: request.workDir === undefined ? current.workDir : request.workDir.trim(),
      agents: members,
      updatedAt,
    };
    await store.updateRoom(updated);
    this.emit({ type: "rooms-changed" });
    return updated;
  }

  async archiveRoom(roomId: string): Promise<void> {
    await this.requireStore().archiveRoom(roomId, this.timestamp());
    this.emit({ type: "rooms-changed" });
  }

  async listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage> {
    return this.requireStore().listMessages(request);
  }

  async sendMessage(request: SendTeamChatMessageRequest): Promise<SendTeamChatMessageResult> {
    const store = this.requireStore();
    const room = await store.getRoom(request.roomId);
    if (!room || room.archived) throw new Error("Team Chat room is unavailable.");
    const content = request.content.trim();
    if (!content) throw new Error("Enter a message before sending.");

    const messageId = this.id();
    const createdAt = this.timestamp();
    const message: TeamChatMessage = {
      id: messageId,
      roomId: room.id,
      senderType: "human",
      senderName: "You",
      content,
      rootMessageId: messageId,
      hop: 0,
      status: "final",
      createdAt,
      updatedAt: createdAt,
    };
    await store.insertMessage(message);
    this.emit({ type: "message-created", roomId: room.id, rootMessageId: messageId, message });
    this.emit({ type: "rooms-changed" });

    const controller = new AbortController();
    this.activeTurns.set(messageId, controller);
    const route = resolveTeamChatRoute(content, this.routableRoomMembers(room), "human");
    const promise = this.runRootTurn(room, message, route.targetAgentIds, controller, route.mentionedNames)
      .finally(() => this.activeTurnPromises.delete(promise));
    this.activeTurnPromises.add(promise);
    void promise;
    return { message, rootMessageId: messageId };
  }

  async stopTurn(rootMessageId: string): Promise<boolean> {
    const controller = this.activeTurns.get(rootMessageId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async runRootTurn(
    room: TeamChatRoom,
    rootMessage: TeamChatMessage,
    initialTargets: string[],
    controller: AbortController,
    mentionedNames: string[],
  ): Promise<void> {
    const executedAgentIds = new Set<string>();
    const queue: QueuedHop[] = [{ sourceMessage: rootMessage, targetAgentIds: initialTargets, hop: 0 }];
    let reachedLimit = false;

    try {
      if (initialTargets.length === 0) {
        const mention = mentionedNames.length > 0
          ? mentionedNames.map((name) => `@${name}`).join(", ")
          : undefined;
        await this.insertSystemMessage(
          room.id,
          rootMessage.id,
          rootMessage.id,
          0,
          mention
            ? `No available Agent matched ${mention}. Choose an available room member.`
            : "No available Agent can respond in this room. Add or enable a room member first.",
          "error",
        );
        return;
      }
      while (queue.length > 0 && !controller.signal.aborted) {
        const next = queue.shift()!;
        const candidates = next.targetAgentIds.filter((id) => !executedAgentIds.has(id));
        const remaining = MAX_AGENT_EXECUTIONS_PER_TURN - executedAgentIds.size;
        if (candidates.length > remaining) reachedLimit = true;
        const batchIds = candidates.slice(0, remaining);
        if (batchIds.length === 0) continue;
        for (const agentId of batchIds) executedAgentIds.add(agentId);

        const context = await this.requireStore().listMessages({ roomId: room.id, limit: CONTEXT_MESSAGE_LIMIT });
        const completed = await Promise.all(batchIds.map((agentId) => this.runAgent({
          room,
          targetAgentId: agentId,
          sourceMessage: next.sourceMessage,
          rootMessage,
          hop: next.hop,
          contextMessages: context.messages,
          executedAgentIds: [...executedAgentIds],
          controller,
        })));

        for (const message of completed) {
          if (!message || controller.signal.aborted) continue;
          const nextTargets = resolveTeamChatTargets(message.content, this.routableRoomMembers(room), "agent")
            .filter((agentId) => !executedAgentIds.has(agentId));
          if (nextTargets.length > 0) {
            queue.push({ sourceMessage: message, targetAgentIds: nextTargets, hop: next.hop + 1 });
          }
        }
        if (executedAgentIds.size >= MAX_AGENT_EXECUTIONS_PER_TURN && queue.length > 0) reachedLimit = true;
      }

      if (reachedLimit && !controller.signal.aborted) {
        await this.insertSystemMessage(
          room.id,
          rootMessage.id,
          rootMessage.id,
          MAX_AGENT_EXECUTIONS_PER_TURN,
          `This turn stopped after ${MAX_AGENT_EXECUTIONS_PER_TURN} Agent executions to prevent an endless loop.`,
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        await this.insertSystemMessage(
          room.id,
          rootMessage.id,
          rootMessage.id,
          0,
          `Team Chat stopped: ${sanitizeTeamChatError(error)}`,
          "error",
        ).catch(() => undefined);
      }
    } finally {
      if (this.activeTurns.get(rootMessage.id) === controller) this.activeTurns.delete(rootMessage.id);
      this.emit({ type: "turn-finished", roomId: room.id, rootMessageId: rootMessage.id });
    }
  }

  private async runAgent(input: {
    room: TeamChatRoom;
    targetAgentId: string;
    sourceMessage: TeamChatMessage;
    rootMessage: TeamChatMessage;
    hop: number;
    contextMessages: TeamChatMessage[];
    executedAgentIds: string[];
    controller: AbortController;
  }): Promise<TeamChatMessage | undefined> {
    const target = input.room.agents.find((agent) => agent.agentId === input.targetAgentId && agent.enabled);
    if (!target) return undefined;
    const store = this.requireStore();
    const dispatchId = this.id();
    const createdAt = this.timestamp();
    const dispatch: TeamChatDispatch = {
      id: dispatchId,
      roomId: input.room.id,
      rootMessageId: input.rootMessage.id,
      sourceMessageId: input.sourceMessage.id,
      targetAgentId: target.agentId,
      hop: input.hop,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
    };
    await store.insertDispatch(dispatch);
    const startedAt = this.timestamp();
    await store.updateDispatch(dispatchId, { status: "running", startedAt, updatedAt: startedAt });
    this.emit({
      type: "dispatch-started",
      roomId: input.room.id,
      rootMessageId: input.rootMessage.id,
      dispatchId,
      agentId: target.agentId,
      agentName: target.displayName,
    });

    try {
      const result = await this.dependencies.executeAgent(
        {
          configuredAgentId: target.agentId,
          prompt: buildTeamChatPrompt({
            room: input.room,
            target,
            messages: input.contextMessages,
            triggerMessage: input.sourceMessage,
            executedAgentIds: input.executedAgentIds,
            remainingExecutions: MAX_AGENT_EXECUTIONS_PER_TURN - input.executedAgentIds.length,
          }),
          workDir: input.room.workDir || undefined,
        },
        (event) => {
          if (event.type !== "delta" || input.controller.signal.aborted) return;
          this.emit({
            type: "dispatch-delta",
            roomId: input.room.id,
            rootMessageId: input.rootMessage.id,
            dispatchId,
            agentId: target.agentId,
            content: event.content,
          });
        },
        input.controller.signal,
      );
      if (input.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const content = result.output.trim() || "Agent completed without a text response.";
      const messageAt = this.timestamp();
      const message: TeamChatMessage = {
        id: this.id(),
        roomId: input.room.id,
        senderType: "agent",
        senderAgentId: target.agentId,
        senderName: target.displayName,
        content,
        rootMessageId: input.rootMessage.id,
        sourceMessageId: input.sourceMessage.id,
        hop: input.hop + 1,
        status: "final",
        createdAt: messageAt,
        updatedAt: messageAt,
      };
      await store.insertMessage(message);
      const finishedAt = this.timestamp();
      await store.updateDispatch(dispatchId, {
        status: "completed",
        startedAt,
        finishedAt,
        updatedAt: finishedAt,
      });
      this.emit({ type: "message-created", roomId: input.room.id, rootMessageId: input.rootMessage.id, message });
      this.emit({ type: "rooms-changed" });
      this.emit({
        type: "dispatch-finished",
        roomId: input.room.id,
        rootMessageId: input.rootMessage.id,
        dispatchId,
        agentId: target.agentId,
        status: "completed",
      });
      return message;
    } catch (error) {
      const interrupted = input.controller.signal.aborted || isAbortError(error);
      const status = interrupted ? "interrupted" : "failed";
      const safeError = interrupted ? "Stopped" : sanitizeTeamChatError(error);
      const finishedAt = this.timestamp();
      await store.updateDispatch(dispatchId, {
        status,
        error: safeError,
        startedAt,
        finishedAt,
        updatedAt: finishedAt,
      });
      if (!interrupted) {
        await this.insertSystemMessage(
          input.room.id,
          input.rootMessage.id,
          input.sourceMessage.id,
          input.hop + 1,
          `${target.displayName} failed: ${safeError}`,
          "error",
        );
      }
      this.emit({
        type: "dispatch-finished",
        roomId: input.room.id,
        rootMessageId: input.rootMessage.id,
        dispatchId,
        agentId: target.agentId,
        status,
        ...(interrupted ? {} : { error: safeError }),
      });
      return undefined;
    }
  }

  private async insertSystemMessage(
    roomId: string,
    rootMessageId: string,
    sourceMessageId: string,
    hop: number,
    content: string,
    status: TeamChatMessage["status"] = "final",
  ): Promise<TeamChatMessage> {
    const createdAt = this.timestamp();
    const message: TeamChatMessage = {
      id: this.id(),
      roomId,
      senderType: "system",
      senderName: "AgentRecall",
      content,
      rootMessageId,
      sourceMessageId,
      hop,
      status,
      createdAt,
      updatedAt: createdAt,
    };
    await this.requireStore().insertMessage(message);
    this.emit({ type: "message-created", roomId, rootMessageId, message });
    this.emit({ type: "rooms-changed" });
    return message;
  }

  private resolveConfiguredAgents(agentIds: string[]): ConfiguredAgent[] {
    const uniqueIds = [...new Set(agentIds)];
    if (uniqueIds.length === 0) throw new Error("Select at least one Agent for the room.");
    const byId = new Map(this.dependencies.configuredAgents().map((agent) => [agent.id, agent]));
    return uniqueIds.map((id) => {
      const agent = byId.get(id);
      if (!agent) throw new Error(`Configured Agent is unavailable: ${id}`);
      return agent;
    });
  }

  private routableRoomMembers(room: TeamChatRoom): TeamChatRoomAgent[] {
    const availableAgentIds = new Set(this.dependencies.configuredAgents().map((agent) => agent.id));
    return room.agents.map((member) => availableAgentIds.has(member.agentId)
      ? member
      : { ...member, enabled: false });
  }

  private requireStore(): TeamChatStore {
    if (!this.store || this.status.state !== "ready") {
      throw new Error("The Chat database is not ready yet.");
    }
    return this.store;
  }

  private async closeCurrentStore(): Promise<void> {
    for (const controller of this.activeTurns.values()) controller.abort();
    if (this.activeTurnPromises.size > 0) await Promise.allSettled([...this.activeTurnPromises]);
    this.activeTurns.clear();
    const current = this.store;
    this.store = undefined;
    this.connectedTarget = "";
    if (current) await current.close();
  }

  private connectLocal(clearSavedExternalUrl: boolean): Promise<TeamChatConnectionStatus> {
    return this.connectTarget({
      target: "local",
      mode: "local",
      label: "Local database",
      createStore: () => {
        if (!this.dependencies.localStoreFactory) throw new Error("The managed local database is unavailable.");
        return this.dependencies.localStoreFactory();
      },
      onReady: () => {
        if (clearSavedExternalUrl) this.dependencies.writeConnectionUrl("");
      },
    });
  }

  private connectTarget(target: {
    target: string;
    mode: TeamChatConnectionMode;
    label: string;
    createStore: () => TeamChatStore;
    onReady: () => void;
  }): Promise<TeamChatConnectionStatus> {
    if (this.store && this.connectedTarget === target.target && this.status.state === "ready") {
      return Promise.resolve(this.getConnectionStatus());
    }
    if (this.pendingConnection?.target === target.target) return this.pendingConnection.promise;

    const promise = this.enqueueConnection(async () => {
      if (this.store && this.connectedTarget === target.target && this.status.state === "ready") {
        return this.getConnectionStatus();
      }
      await this.closeCurrentStore();
      this.setStatus({ state: "connecting", mode: target.mode, databaseLabel: target.label });
      let nextStore: TeamChatStore | undefined;
      try {
        nextStore = target.createStore();
        await nextStore.initialize();
        this.store = nextStore;
        this.connectedTarget = target.target;
        target.onReady();
        this.setStatus({ state: "ready", mode: target.mode, databaseLabel: target.label });
        return this.getConnectionStatus();
      } catch (error) {
        await nextStore?.close().catch(() => undefined);
        this.store = undefined;
        this.connectedTarget = "";
        const message = target.mode === "local"
          ? "Unable to start the local Chat database. Retry or connect an external PostgreSQL database."
          : "Unable to connect to PostgreSQL. Check the address, credentials, and database.";
        this.setStatus({ state: "error", mode: target.mode, databaseLabel: target.label, error: message });
        throw new Error(message, { cause: error });
      }
    });
    this.pendingConnection = { target: target.target, promise };
    void promise.finally(() => {
      if (this.pendingConnection?.promise === promise) this.pendingConnection = undefined;
    }).catch(() => undefined);
    return promise;
  }

  private enqueueConnection(operation: () => Promise<TeamChatConnectionStatus>): Promise<TeamChatConnectionStatus> {
    const promise = this.connectionQueue.then(operation, operation);
    this.connectionQueue = promise.then(() => undefined, () => undefined);
    return promise;
  }

  private emit(event: TeamChatEvent): void {
    this.dependencies.emit?.(event);
    for (const listener of this.listeners) listener(event);
  }

  private setStatus(status: TeamChatConnectionStatus): void {
    this.status = status;
    this.emit({ type: "connection-changed", status: this.getConnectionStatus() });
  }

  private id(): string {
    return (this.dependencies.idFactory ?? randomUUID)();
  }

  private timestamp(): string {
    return (this.dependencies.now ?? (() => new Date()))().toISOString();
  }
}

function roomAgentSnapshot(
  roomId: string,
  agent: ConfiguredAgent,
  position: number,
  joinedAt: string,
): TeamChatRoomAgent {
  return {
    roomId,
    agentId: agent.id,
    displayName: agent.name,
    runtimeId: agent.runtimeAgentId,
    channelId: agent.channelId,
    modelId: agent.modelId,
    enabled: true,
    position,
    joinedAt,
  };
}

function normalizePostgresUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a valid PostgreSQL connection URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("Team Chat requires a postgres:// or postgresql:// connection URL.");
  }
  if (!parsed.hostname || parsed.pathname.length <= 1) {
    throw new Error("The PostgreSQL URL must include a host and database name.");
  }
  return trimmed;
}

function postgresDatabaseLabel(connectionUrl: string): string {
  const parsed = new URL(connectionUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, "")) || "database";
  return `${parsed.host}/${database}`;
}

function sanitizeTeamChatError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(?:postgres|postgresql|https?):\/\/\S+/giu, "[redacted URL]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "Unknown Agent error";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
