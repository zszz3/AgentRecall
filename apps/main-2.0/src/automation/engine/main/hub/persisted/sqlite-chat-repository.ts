import type { SqliteQueryable } from "../../../../../core/sqlite/database";
import {
  sqliteJson,
  sqliteJsonParameter,
  sqliteRecord,
  sqliteTime,
} from "../../../../../core/sqlite/values";
import {
  asArray,
  asNumber,
  asOptionalString,
  asRecord,
  asString,
  optional,
  type RecordValue,
} from "./persisted-values";

export class SqliteChatRepository {
  load(database: SqliteQueryable): Pick<RecordValue, "sessions" | "messages" | "events"> {
    const chatRows = database.all("SELECT * FROM automation_chats ORDER BY created_at, id");
    const runtimeRows = database.all("SELECT * FROM runtime_sessions ORDER BY created_at, id");
    const messageRows = database.all(
      "SELECT * FROM automation_chat_messages ORDER BY chat_id, sequence",
    );
    const eventRows = database.all(
      "SELECT * FROM automation_chat_events ORDER BY chat_id, message_id, sequence",
    );
    const runtimeByChat = new Map(
      runtimeRows.map((value) => {
        const row = asRecord(value);
        return [asString(row.chat_id), row] as const;
      }),
    );

    return {
      sessions: chatRows.map((value) => {
        const row = asRecord(value);
        const chat: RecordValue = {
          id: row.id,
          title: row.title,
          configuredAgentId: row.configured_agent_id,
          modelId: row.model_id,
          createdAt: sqliteTime(row.created_at),
          updatedAt: sqliteTime(row.updated_at),
        };
        optional(chat, "channelId", row.channel_id);
        optional(chat, "lastError", row.last_error);
        const runtime = runtimeByChat.get(asString(row.id));
        if (runtime?.runtime_state !== null && runtime?.runtime_state !== undefined) {
          chat.runtimeState = sqliteJson(runtime.runtime_state);
        }
        if (runtime?.conversation !== null && runtime?.conversation !== undefined) {
          chat.runtimeConversation = sqliteJson(runtime.conversation);
        }
        return chat;
      }),
      messages: messageRows.map((value) => {
        const row = asRecord(value);
        return {
          id: row.id,
          chatId: row.chat_id,
          role: row.role,
          content: row.content,
          timestamp: sqliteTime(row.created_at),
          ...(Boolean(row.is_local) ? { local: true } : {}),
        };
      }),
      events: eventRows.map((value) => {
        const row = asRecord(value);
        const event: RecordValue = {
          id: row.id,
          chatId: row.chat_id,
          messageId: row.message_id,
          type: row.type,
          content: row.content,
          timestamp: sqliteTime(row.created_at),
        };
        optional(event, "agentId", row.agent_id);
        optional(event, "name", row.name);
        optional(event, "fromAgentId", row.from_agent_id);
        optional(event, "toAgentId", row.to_agent_id);
        optional(event, "requestId", row.request_id);
        optional(event, "requestState", row.request_state);
        optional(event, "decision", row.decision);
        if (row.metadata !== null && row.metadata !== undefined) {
          event.metadata = sqliteRecord(row.metadata);
        }
        return event;
      }),
    };
  }

  replace(database: SqliteQueryable, payload: RecordValue): void {
    database.run("DELETE FROM automation_chats");
    const sessions = asArray(payload.sessions);
    const chatIds = new Set(sessions.map((chat) => asString(chat.id)));

    for (const chat of sessions) {
      const chatId = asString(chat.id);
      database.run(
        `INSERT INTO automation_chats (
          id, title, configured_agent_id, model_id, channel_id, last_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        chatId,
        asString(chat.title),
        asString(chat.configuredAgentId),
        asOptionalString(chat.modelId) ?? null,
        asOptionalString(chat.channelId) ?? null,
        asOptionalString(chat.lastError) ?? null,
        Math.floor(asNumber(chat.createdAt)),
        Math.floor(asNumber(chat.updatedAt)),
      );
      if (chat.runtimeState !== undefined || chat.runtimeConversation !== undefined) {
        const conversation = asRecord(chat.runtimeConversation);
        const runtimeState = asRecord(chat.runtimeState);
        database.run(
          `INSERT INTO runtime_sessions (
            id, chat_id, runtime_id, state, provider_session_id, runtime_state,
            conversation, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          `${chatId}:runtime`,
          chatId,
          asOptionalString(conversation.runtimeId) ?? null,
          asOptionalString(runtimeState.state) ?? null,
          asOptionalString(conversation.sessionId) ?? null,
          sqliteJsonParameter(chat.runtimeState),
          sqliteJsonParameter(chat.runtimeConversation),
          Math.floor(asNumber(chat.createdAt)),
          Math.floor(asNumber(chat.updatedAt)),
        );
      }
    }

    const messageSequence = new Map<string, number>();
    for (const message of asArray(payload.messages)) {
      const chatId = asString(message.chatId);
      if (!chatIds.has(chatId)) continue;
      const sequence = messageSequence.get(chatId) ?? 0;
      messageSequence.set(chatId, sequence + 1);
      database.run(
        `INSERT INTO automation_chat_messages (
          id, chat_id, role, content, is_local, sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        asString(message.id),
        chatId,
        asString(message.role),
        asString(message.content),
        message.local === true ? 1 : 0,
        sequence,
        Math.floor(asNumber(message.timestamp)),
      );
    }

    const eventSequence = new Map<string, number>();
    for (const event of asArray(payload.events)) {
      const chatId = asString(event.chatId);
      if (!chatIds.has(chatId)) continue;
      const messageId = asString(event.messageId);
      const sequence = eventSequence.get(messageId) ?? 0;
      eventSequence.set(messageId, sequence + 1);
      database.run(
        `INSERT INTO automation_chat_events (
          id, chat_id, message_id, type, content, agent_id, name,
          from_agent_id, to_agent_id, request_id, request_state, decision,
          metadata, sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        sqliteJsonParameter(event.metadata),
        sequence,
        Math.floor(asNumber(event.timestamp)),
      );
    }
  }
}
