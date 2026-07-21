import { replaceAggregateSet } from "./sqlite-aggregate-sync";
import {
  asArray,
  asNumber,
  asOptionalString,
  asRecord,
  asString,
  json,
  optional,
  parseJson,
  type DatabaseSync,
  type RecordValue,
} from "./sqlite-values";

export class SqliteChatRepository {
  load(db: DatabaseSync): Pick<RecordValue, "sessions" | "messages" | "events"> {
    return {
      sessions: this.loadChats(db),
      messages: this.loadChatMessages(db),
      events: this.loadChatEvents(db),
    };
  }

  sync(db: DatabaseSync, payload: RecordValue): void {
    const sessions = asArray(payload.sessions);
    const chatIds = new Set(sessions.map((chat) => asString(chat.id)));
    replaceAggregateSet({
      db,
      table: "chats",
      idColumn: "id",
      aggregates: sessions,
      idOf: (chat) => asString(chat.id),
      idFromRow: (row) => asString(asRecord(row).id),
      write: () => this.saveChats(db, {
        ...payload,
        sessions,
        messages: asArray(payload.messages).filter((message) => chatIds.has(asString(message.chatId))),
        events: asArray(payload.events).filter((event) => chatIds.has(asString(event.chatId))),
      }),
    });
  }

  private saveChats(db: DatabaseSync, payload: RecordValue): void {
    const sessions = asArray(payload.sessions);
    for (const chat of sessions) {
      db.prepare(
        `insert into chats
         (id, title, configured_agent_id, model_id, channel_id, last_error, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        asString(chat.id),
        asString(chat.title),
        asString(chat.configuredAgentId),
        asOptionalString(chat.modelId) ?? null,
        asOptionalString(chat.channelId) ?? null,
        asOptionalString(chat.lastError) ?? null,
        asNumber(chat.createdAt),
        asNumber(chat.updatedAt),
      );
      if (chat.runtimeState !== undefined || chat.runtimeConversation !== undefined) {
        const conversation = asRecord(chat.runtimeConversation);
        const runtimeState = asRecord(chat.runtimeState);
        db.prepare(
          `insert into runtime_sessions
           (id, chat_id, runtime_id, state, provider_session_id, runtime_state_json, conversation_json, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `${asString(chat.id)}:runtime`,
          asString(chat.id),
          asOptionalString(conversation.runtimeId) ?? null,
          asOptionalString(runtimeState.state) ?? null,
          asOptionalString(conversation.sessionId) ?? null,
          json(chat.runtimeState),
          json(chat.runtimeConversation),
          asNumber(chat.createdAt),
          asNumber(chat.updatedAt),
        );
      }
    }

    const messageSequence = new Map<string, number>();
    for (const message of asArray(payload.messages)) {
      const chatId = asString(message.chatId);
      const sequence = messageSequence.get(chatId) ?? 0;
      messageSequence.set(chatId, sequence + 1);
      db.prepare(
        `insert into chat_messages (id, chat_id, role, content, is_local, sequence, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        asString(message.id),
        chatId,
        asString(message.role),
        asString(message.content),
        message.local === true ? 1 : 0,
        sequence,
        asNumber(message.timestamp),
      );
    }

    const eventSequence = new Map<string, number>();
    for (const event of asArray(payload.events)) {
      const messageId = asString(event.messageId);
      const sequence = eventSequence.get(messageId) ?? 0;
      eventSequence.set(messageId, sequence + 1);
      db.prepare(
        `insert into chat_events
         (id, chat_id, message_id, type, content, agent_id, name, from_agent_id, to_agent_id,
          request_id, request_state, decision, metadata_json, sequence, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        asString(event.id),
        asString(event.chatId),
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
        json(event.metadata),
        sequence,
        asNumber(event.timestamp),
      );
    }
  }

  private loadChats(db: DatabaseSync): RecordValue[] {
    const runtimeRows = db.prepare("select * from runtime_sessions order by created_at, id").all().map(asRecord);
    const runtimeByChat = new Map(runtimeRows.map((row) => [asString(row.chat_id), row]));
    return db
      .prepare("select * from chats order by created_at, id")
      .all()
      .map(asRecord)
      .map((row) => {
        const chat: RecordValue = {
          id: row.id,
          title: row.title,
          configuredAgentId: row.configured_agent_id,
          modelId: row.model_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
        optional(chat, "channelId", row.channel_id);
        optional(chat, "lastError", row.last_error);
        const runtime = runtimeByChat.get(asString(row.id));
        if (runtime?.runtime_state_json) chat.runtimeState = parseJson(runtime.runtime_state_json);
        if (runtime?.conversation_json) chat.runtimeConversation = parseJson(runtime.conversation_json);
        return chat;
      });
  }

  private loadChatMessages(db: DatabaseSync): RecordValue[] {
    return db
      .prepare("select * from chat_messages order by chat_id, sequence")
      .all()
      .map(asRecord)
      .map((row) => ({
        id: row.id,
        chatId: row.chat_id,
        role: row.role,
        content: row.content,
        timestamp: row.created_at,
        ...(row.is_local === 1 ? { local: true } : {}),
      }));
  }

  private loadChatEvents(db: DatabaseSync): RecordValue[] {
    return db
      .prepare("select * from chat_events order by chat_id, message_id, sequence")
      .all()
      .map(asRecord)
      .map((row) => {
        const event: RecordValue = {
          id: row.id,
          chatId: row.chat_id,
          messageId: row.message_id,
          type: row.type,
          content: row.content,
          timestamp: row.created_at,
        };
        optional(event, "agentId", row.agent_id);
        optional(event, "name", row.name);
        optional(event, "fromAgentId", row.from_agent_id);
        optional(event, "toAgentId", row.to_agent_id);
        optional(event, "requestId", row.request_id);
        optional(event, "requestState", row.request_state);
        optional(event, "decision", row.decision);
        if (row.metadata_json) event.metadata = parseJson(row.metadata_json);
        return event;
      });
  }

}
