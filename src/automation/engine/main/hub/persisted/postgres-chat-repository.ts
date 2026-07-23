import type { PostgresQueryable } from "../../../../../core/postgres/database";
import {
  asArray,
  asNumber,
  asOptionalString,
  asRecord,
  asString,
  optional,
  type RecordValue,
} from "./sqlite-values";
import {
  jsonParameter,
  postgresJson,
  postgresRecord,
  postgresTime,
} from "./postgres-values";

export class PostgresChatRepository {
  async load(
    database: PostgresQueryable,
  ): Promise<Pick<RecordValue, "sessions" | "messages" | "events">> {
    const [chatRows, runtimeRows, messageRows, eventRows] = await Promise.all([
      database.query("select * from agent_recall.automation_chats order by created_at, id"),
      database.query("select * from agent_recall.runtime_sessions order by created_at, id"),
      database.query(
        "select * from agent_recall.automation_chat_messages order by chat_id, sequence",
      ),
      database.query(
        "select * from agent_recall.automation_chat_events order by chat_id, message_id, sequence",
      ),
    ]);
    const runtimeByChat = new Map(
      runtimeRows.rows.map((value) => {
        const row = asRecord(value);
        return [asString(row.chat_id), row] as const;
      }),
    );

    return {
      sessions: chatRows.rows.map((value) => {
        const row = asRecord(value);
        const chat: RecordValue = {
          id: row.id,
          title: row.title,
          configuredAgentId: row.configured_agent_id,
          modelId: row.model_id,
          createdAt: postgresTime(row.created_at),
          updatedAt: postgresTime(row.updated_at),
        };
        optional(chat, "channelId", row.channel_id);
        optional(chat, "lastError", row.last_error);
        const runtime = runtimeByChat.get(asString(row.id));
        if (runtime?.runtime_state !== null && runtime?.runtime_state !== undefined) {
          chat.runtimeState = postgresJson(runtime.runtime_state);
        }
        if (runtime?.conversation !== null && runtime?.conversation !== undefined) {
          chat.runtimeConversation = postgresJson(runtime.conversation);
        }
        return chat;
      }),
      messages: messageRows.rows.map((value) => {
        const row = asRecord(value);
        return {
          id: row.id,
          chatId: row.chat_id,
          role: row.role,
          content: row.content,
          timestamp: postgresTime(row.created_at),
          ...(row.is_local === true ? { local: true } : {}),
        };
      }),
      events: eventRows.rows.map((value) => {
        const row = asRecord(value);
        const event: RecordValue = {
          id: row.id,
          chatId: row.chat_id,
          messageId: row.message_id,
          type: row.type,
          content: row.content,
          timestamp: postgresTime(row.created_at),
        };
        optional(event, "agentId", row.agent_id);
        optional(event, "name", row.name);
        optional(event, "fromAgentId", row.from_agent_id);
        optional(event, "toAgentId", row.to_agent_id);
        optional(event, "requestId", row.request_id);
        optional(event, "requestState", row.request_state);
        optional(event, "decision", row.decision);
        if (row.metadata !== null && row.metadata !== undefined) {
          event.metadata = postgresRecord(row.metadata);
        }
        return event;
      }),
    };
  }

  async replace(database: PostgresQueryable, payload: RecordValue): Promise<void> {
    await database.query("delete from agent_recall.automation_chats");
    const sessions = asArray(payload.sessions);
    const chatIds = new Set(sessions.map((chat) => asString(chat.id)));

    for (const chat of sessions) {
      const chatId = asString(chat.id);
      await database.query(
        `insert into agent_recall.automation_chats (
          id, title, configured_agent_id, model_id, channel_id, last_error,
          created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          chatId,
          asString(chat.title),
          asString(chat.configuredAgentId),
          asOptionalString(chat.modelId) ?? null,
          asOptionalString(chat.channelId) ?? null,
          asOptionalString(chat.lastError) ?? null,
          new Date(asNumber(chat.createdAt)),
          new Date(asNumber(chat.updatedAt)),
        ],
      );
      if (chat.runtimeState !== undefined || chat.runtimeConversation !== undefined) {
        const conversation = asRecord(chat.runtimeConversation);
        const runtimeState = asRecord(chat.runtimeState);
        await database.query(
          `insert into agent_recall.runtime_sessions (
            id, chat_id, runtime_id, state, provider_session_id, runtime_state,
            conversation, created_at, updated_at
          ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
          [
            `${chatId}:runtime`,
            chatId,
            asOptionalString(conversation.runtimeId) ?? null,
            asOptionalString(runtimeState.state) ?? null,
            asOptionalString(conversation.sessionId) ?? null,
            jsonParameter(chat.runtimeState),
            jsonParameter(chat.runtimeConversation),
            new Date(asNumber(chat.createdAt)),
            new Date(asNumber(chat.updatedAt)),
          ],
        );
      }
    }

    const messageSequence = new Map<string, number>();
    for (const message of asArray(payload.messages)) {
      const chatId = asString(message.chatId);
      if (!chatIds.has(chatId)) continue;
      const sequence = messageSequence.get(chatId) ?? 0;
      messageSequence.set(chatId, sequence + 1);
      await database.query(
        `insert into agent_recall.automation_chat_messages (
          id, chat_id, role, content, is_local, sequence, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          asString(message.id),
          chatId,
          asString(message.role),
          asString(message.content),
          message.local === true,
          sequence,
          new Date(asNumber(message.timestamp)),
        ],
      );
    }

    const eventSequence = new Map<string, number>();
    for (const event of asArray(payload.events)) {
      const chatId = asString(event.chatId);
      if (!chatIds.has(chatId)) continue;
      const messageId = asString(event.messageId);
      const sequence = eventSequence.get(messageId) ?? 0;
      eventSequence.set(messageId, sequence + 1);
      await database.query(
        `insert into agent_recall.automation_chat_events (
          id, chat_id, message_id, type, content, agent_id, name,
          from_agent_id, to_agent_id, request_id, request_state, decision,
          metadata, sequence, created_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13::jsonb, $14, $15
        )`,
        [
          asString(event.id),
          chatId,
          messageId,
          asString(event.type),
          asString(event.content),
          asOptionalString(event.agentId) ?? null,
          asOptionalString(event.name) ?? null,
          asOptionalString(event.fromAgentId) ?? null,
          asOptionalString(event.toAgentId) ?? null,
          asOptionalString(event.requestId) ?? null,
          asOptionalString(event.requestState) ?? null,
          asOptionalString(event.decision) ?? null,
          jsonParameter(event.metadata),
          sequence,
          new Date(asNumber(event.timestamp)),
        ],
      );
    }
  }
}
