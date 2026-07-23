import type { PostgresDatabase, PostgresQueryable } from "../../core/postgres/database";
import type {
  ListTeamChatMessagesRequest,
  TeamChatDispatch,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomAgent,
  TeamChatRoomSummary,
} from "../../shared/team-chat";
import type {
  TeamChatAgentSession,
  TeamChatContextPage,
  TeamChatDispatchUpdate,
  TeamChatStore,
} from "./team-chat-store";

export class PostgresTeamChatStore implements TeamChatStore {
  constructor(private readonly database: PostgresDatabase) {}

  async initialize(): Promise<void> {
    try {
      await this.database.query(`UPDATE agent_recall.chat_dispatches
        SET status = 'interrupted', finished_at = NOW(), updated_at = NOW()
        WHERE status IN ('queued', 'running')`);
    } catch (error) {
      throw postgresConnectionError(error);
    }
  }

  async close(): Promise<void> {
    // The application owns the shared PostgreSQL connection pool.
  }

  async createRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO agent_recall.chat_rooms
          (id, name, work_dir, archived, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [room.id, room.name, room.workDir, room.archived, room.createdAt, room.updatedAt],
      );
      for (const agent of room.agents) {
        await this.insertRoomAgent(transaction, agent);
      }
    });
    return room;
  }

  async listRooms(): Promise<TeamChatRoomSummary[]> {
    const result = await this.database.query<RoomSummaryRow>(
      `SELECT r.id, r.name, r.work_dir, r.archived, r.created_at, r.updated_at,
              COUNT(a.agent_id)::integer AS agent_count,
              latest.content AS last_message,
              latest.created_at AS last_message_at
       FROM agent_recall.chat_rooms r
       LEFT JOIN agent_recall.chat_room_agents a ON a.room_id = r.id AND a.enabled = true
       LEFT JOIN LATERAL (
         SELECT content, created_at
         FROM agent_recall.chat_messages
         WHERE room_id = r.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) latest ON true
       WHERE r.archived = false
       GROUP BY r.id, latest.content, latest.created_at
       ORDER BY COALESCE(latest.created_at, r.updated_at) DESC, r.id DESC`,
    );
    return result.rows.map(mapRoomSummaryRow);
  }

  async getRoom(roomId: string): Promise<TeamChatRoom | undefined> {
    const roomResult = await this.database.query<RoomRow>(
      `SELECT id, name, work_dir, archived, created_at, updated_at
       FROM agent_recall.chat_rooms
       WHERE id = $1`,
      [roomId],
    );
    const row = roomResult.rows[0];
    if (!row) return undefined;
    const agentResult = await this.database.query<RoomAgentRow>(
      `SELECT room_id, agent_id, display_name, runtime_id, channel_id, model_id,
              enabled, position, joined_at
       FROM agent_recall.chat_room_agents
       WHERE room_id = $1
       ORDER BY position, agent_id`,
      [roomId],
    );
    return {
      id: String(row.id),
      name: String(row.name),
      workDir: String(row.work_dir),
      archived: Boolean(row.archived),
      agents: agentResult.rows.map(mapRoomAgentRow),
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
  }

  async updateRoom(room: TeamChatRoom): Promise<TeamChatRoom> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `UPDATE agent_recall.chat_rooms
         SET name = $2, work_dir = $3, archived = $4, updated_at = $5
         WHERE id = $1`,
        [room.id, room.name, room.workDir, room.archived, room.updatedAt],
      );
      await transaction.query("DELETE FROM agent_recall.chat_room_agents WHERE room_id = $1", [room.id]);
      for (const agent of room.agents) await this.insertRoomAgent(transaction, agent);
      await transaction.query(
        `DELETE FROM agent_recall.chat_agent_sessions
         WHERE room_id = $1 AND NOT (agent_id = ANY($2::text[]))`,
        [room.id, room.agents.map((agent) => agent.agentId)],
      );
    });
    return room;
  }

  async archiveRoom(roomId: string, updatedAt: string): Promise<void> {
    await this.database.query(
      "UPDATE agent_recall.chat_rooms SET archived = true, updated_at = $2 WHERE id = $1",
      [roomId, updatedAt],
    );
  }

  async listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage> {
    const limit = request.limit ?? 100;
    const result = await this.database.query<MessageRow>(
      `SELECT id, room_id, sender_type, sender_agent_id, sender_name, content,
              root_message_id, source_message_id, hop, status, created_at, updated_at
       FROM agent_recall.chat_messages
       WHERE room_id = $1
         AND ($2::uuid IS NULL OR (created_at, id) < (
           SELECT created_at, id FROM agent_recall.chat_messages WHERE room_id = $1 AND id = $2::uuid
         ))
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [request.roomId, request.before ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const selected = result.rows.slice(0, limit);
    return {
      messages: selected.map(mapMessageRow).reverse(),
      ...(hasMore && selected.length > 0 ? { nextBefore: String(selected.at(-1)!.id) } : {}),
    };
  }

  async listMessagesAfter(
    roomId: string,
    afterMessageId: string,
    limit: number,
  ): Promise<TeamChatContextPage> {
    const result = await this.database.query<MessageRow>(
      `SELECT id, room_id, sender_type, sender_agent_id, sender_name, content,
              root_message_id, source_message_id, hop, status, created_at, updated_at
       FROM agent_recall.chat_messages
       WHERE room_id = $1
         AND (created_at, id) > (
           SELECT created_at, id
           FROM agent_recall.chat_messages
           WHERE room_id = $1 AND id = $2::uuid
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [roomId, afterMessageId, limit + 1],
    );
    const truncated = result.rows.length > limit;
    return {
      messages: result.rows.slice(0, limit).map(mapMessageRow).reverse(),
      truncated,
    };
  }

  async insertMessage(message: TeamChatMessage): Promise<TeamChatMessage> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO agent_recall.chat_messages
          (id, room_id, sender_type, sender_agent_id, sender_name, content,
           root_message_id, source_message_id, hop, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          message.id,
          message.roomId,
          message.senderType,
          message.senderAgentId ?? null,
          message.senderName,
          message.content,
          message.rootMessageId,
          message.sourceMessageId ?? null,
          message.hop,
          message.status,
          message.createdAt,
          message.updatedAt,
        ],
      );
      await transaction.query(
        "UPDATE agent_recall.chat_rooms SET updated_at = $2 WHERE id = $1",
        [message.roomId, message.updatedAt],
      );
    });
    return message;
  }

  async insertDispatch(dispatch: TeamChatDispatch): Promise<TeamChatDispatch> {
    await this.database.query(
      `INSERT INTO agent_recall.chat_dispatches
        (id, room_id, root_message_id, source_message_id, target_agent_id, hop,
         status, error, started_at, finished_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        dispatch.id,
        dispatch.roomId,
        dispatch.rootMessageId,
        dispatch.sourceMessageId,
        dispatch.targetAgentId,
        dispatch.hop,
        dispatch.status,
        dispatch.error ?? null,
        dispatch.startedAt ?? null,
        dispatch.finishedAt ?? null,
        dispatch.createdAt,
        dispatch.updatedAt,
      ],
    );
    return dispatch;
  }

  async updateDispatch(dispatchId: string, patch: TeamChatDispatchUpdate): Promise<void> {
    await this.database.query(
      `UPDATE agent_recall.chat_dispatches
       SET status = $2, error = $3, started_at = $4, finished_at = $5, updated_at = $6
       WHERE id = $1`,
      [
        dispatchId,
        patch.status,
        patch.error ?? null,
        patch.startedAt ?? null,
        patch.finishedAt ?? null,
        patch.updatedAt,
      ],
    );
  }

  async markRunningDispatchesInterrupted(updatedAt: string): Promise<void> {
    await this.database.query(
      `UPDATE agent_recall.chat_dispatches
       SET status = 'interrupted', finished_at = $1, updated_at = $1
       WHERE status IN ('queued', 'running')`,
      [updatedAt],
    );
  }

  async listAgentSessions(roomId: string): Promise<TeamChatAgentSession[]> {
    const result = await this.database.query<AgentSessionRow>(
      `SELECT room_id, agent_id, runtime_id, channel_id, model_id,
              runtime_conversation, last_context_message_id, updated_at
       FROM agent_recall.chat_agent_sessions
       WHERE room_id = $1
       ORDER BY agent_id`,
      [roomId],
    );
    return result.rows.map(mapAgentSessionRow);
  }

  async upsertAgentSession(session: TeamChatAgentSession): Promise<void> {
    await this.database.query(
      `INSERT INTO agent_recall.chat_agent_sessions
        (room_id, agent_id, runtime_id, channel_id, model_id,
         runtime_conversation, last_context_message_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (room_id, agent_id) DO UPDATE SET
         runtime_id = EXCLUDED.runtime_id,
         channel_id = EXCLUDED.channel_id,
         model_id = EXCLUDED.model_id,
         runtime_conversation = EXCLUDED.runtime_conversation,
         last_context_message_id = EXCLUDED.last_context_message_id,
         updated_at = EXCLUDED.updated_at`,
      [
        session.roomId,
        session.agentId,
        session.runtimeId,
        session.channelId,
        session.modelId,
        JSON.stringify(session.runtimeConversation),
        session.lastContextMessageId ?? null,
        session.updatedAt,
      ],
    );
  }

  async deleteAgentSession(roomId: string, agentId: string): Promise<void> {
    await this.database.query(
      "DELETE FROM agent_recall.chat_agent_sessions WHERE room_id = $1 AND agent_id = $2",
      [roomId, agentId],
    );
  }

  private async insertRoomAgent(database: PostgresQueryable, agent: TeamChatRoomAgent): Promise<void> {
    await database.query(
      `INSERT INTO agent_recall.chat_room_agents
        (room_id, agent_id, display_name, runtime_id, channel_id, model_id, enabled, position, joined_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        agent.roomId,
        agent.agentId,
        agent.displayName,
        agent.runtimeId,
        agent.channelId,
        agent.modelId,
        agent.enabled,
        agent.position,
        agent.joinedAt,
      ],
    );
  }
}

type RoomRow = Record<string, unknown> & {
  id: unknown;
  name: unknown;
  work_dir: unknown;
  archived: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type RoomSummaryRow = RoomRow & {
  agent_count: unknown;
  last_message: unknown;
  last_message_at: unknown;
};

type RoomAgentRow = Record<string, unknown> & {
  room_id: unknown;
  agent_id: unknown;
  display_name: unknown;
  runtime_id: unknown;
  channel_id: unknown;
  model_id: unknown;
  enabled: unknown;
  position: unknown;
  joined_at: unknown;
};

type MessageRow = Record<string, unknown> & {
  id: unknown;
  room_id: unknown;
  sender_type: unknown;
  sender_agent_id: unknown;
  sender_name: unknown;
  content: unknown;
  root_message_id: unknown;
  source_message_id: unknown;
  hop: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type AgentSessionRow = Record<string, unknown> & {
  room_id: unknown;
  agent_id: unknown;
  runtime_id: unknown;
  channel_id: unknown;
  model_id: unknown;
  runtime_conversation: unknown;
  last_context_message_id: unknown;
  updated_at: unknown;
};

function mapRoomSummaryRow(row: RoomSummaryRow): TeamChatRoomSummary {
  const lastMessage = nullableString(row.last_message);
  const lastMessageAt = row.last_message_at === null || row.last_message_at === undefined
    ? undefined
    : toIsoString(row.last_message_at);
  return {
    id: String(row.id),
    name: String(row.name),
    workDir: String(row.work_dir),
    archived: Boolean(row.archived),
    agentCount: Number(row.agent_count),
    ...(lastMessage ? { lastMessage } : {}),
    ...(lastMessageAt ? { lastMessageAt } : {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapRoomAgentRow(row: RoomAgentRow): TeamChatRoomAgent {
  return {
    roomId: String(row.room_id),
    agentId: String(row.agent_id),
    displayName: String(row.display_name),
    runtimeId: String(row.runtime_id),
    channelId: String(row.channel_id),
    modelId: String(row.model_id),
    enabled: Boolean(row.enabled),
    position: Number(row.position),
    joinedAt: toIsoString(row.joined_at),
    continuationAvailable: false,
    hasActiveConversation: false,
  };
}

function mapMessageRow(row: MessageRow): TeamChatMessage {
  const senderAgentId = nullableString(row.sender_agent_id);
  const sourceMessageId = nullableString(row.source_message_id);
  return {
    id: String(row.id),
    roomId: String(row.room_id),
    senderType: row.sender_type as TeamChatMessage["senderType"],
    ...(senderAgentId ? { senderAgentId } : {}),
    senderName: String(row.sender_name),
    content: String(row.content),
    rootMessageId: String(row.root_message_id),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    hop: Number(row.hop),
    status: row.status as TeamChatMessage["status"],
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapAgentSessionRow(row: AgentSessionRow): TeamChatAgentSession {
  const runtimeConversation = parseRuntimeConversation(row.runtime_conversation);
  const lastContextMessageId = nullableString(row.last_context_message_id);
  return {
    roomId: String(row.room_id),
    agentId: String(row.agent_id),
    runtimeId: String(row.runtime_id),
    channelId: String(row.channel_id),
    modelId: String(row.model_id),
    runtimeConversation,
    ...(lastContextMessageId ? { lastContextMessageId } : {}),
    updatedAt: toIsoString(row.updated_at),
  };
}

function parseRuntimeConversation(value: unknown): TeamChatAgentSession["runtimeConversation"] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object") throw new Error("Stored Agent conversation is invalid.");
  const record = parsed as Record<string, unknown>;
  if (typeof record.runtimeId !== "string" || typeof record.codecVersion !== "string" || !("payload" in record)) {
    throw new Error("Stored Agent conversation is invalid.");
  }
  return {
    runtimeId: record.runtimeId as TeamChatAgentSession["runtimeConversation"]["runtimeId"],
    codecVersion: record.codecVersion,
    payload: structuredClone(record.payload),
  };
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : String(value);
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function postgresConnectionError(error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "28P01") return new Error("Unable to connect to PostgreSQL: authentication failed.", { cause: error });
  if (code === "3D000") return new Error("Unable to connect to PostgreSQL: database does not exist.", { cause: error });
  if (code === "ECONNREFUSED") return new Error("Unable to connect to PostgreSQL: connection was refused.", { cause: error });
  return new Error("Unable to connect to PostgreSQL.", { cause: error });
}
