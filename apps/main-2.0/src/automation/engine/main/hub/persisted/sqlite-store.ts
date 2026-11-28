import type { SqliteDatabase, SqliteQueryable } from "../../../../../core/sqlite/database";
import { sqliteJsonParameter, sqliteRecord } from "../../../../../core/sqlite/values";
import type { PersistedAppStateV5 } from "./agent-hub-persistence";
import type { AgentHubPersistedStore } from "./persisted-store";
import { asRecord, asString } from "./persisted-values";
import { SqliteChatRepository } from "./sqlite-chat-repository";

const AUX_STATE_ID = 1;

export class SqliteAppStore implements AgentHubPersistedStore {
  readonly label = "SQLite";
  private readonly chats = new SqliteChatRepository();

  constructor(
    private readonly database: SqliteDatabase,
    readonly fileStoragePath?: string,
  ) {}

  async load(): Promise<unknown | undefined> {
    const auxRow = this.database.get<{ payload: string }>(
      "SELECT payload FROM app_aux_state WHERE id = ?",
      AUX_STATE_ID,
    );
    const countRow = this.database.get<{ chat_count: number }>(
      "SELECT count(*) AS chat_count FROM automation_chats",
    );
    const settingsRows = this.database.all<{ key: string; value_text: string | null }>(
      "SELECT key, value_text FROM app_settings",
    );
    const aux = auxRow?.payload;
    if (aux === undefined && Number(countRow?.chat_count ?? 0) === 0) return undefined;

    const settings = new Map(
      settingsRows.map((row) => [row.key, row.value_text] as const),
    );
    const payload = sqliteRecord(aux);
    payload.version = Number(settings.get("payload_version") ?? "5");
    payload.activeChatId = settings.get("active_chat_id") ?? null;
    payload.workDir = settings.get("work_dir") ?? "";
    Object.assign(payload, this.chats.load(this.database));
    return payload;
  }

  async save(payload: PersistedAppStateV5): Promise<void> {
    if (payload.version !== 5) {
      throw new Error("SQLite persistence only supports app state version 5");
    }
    this.database.transactionSync((tx) => {
      const now = Date.now();
      this.writeSetting(tx, "payload_version", String(payload.version), now);
      this.writeSetting(tx, "active_chat_id", payload.activeChatId, now);
      this.writeSetting(tx, "work_dir", asString(payload.workDir), now);
      tx.run(
        `INSERT INTO app_aux_state (id, payload, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        AUX_STATE_ID,
        sqliteJsonParameter({
          ...payload,
          sessions: undefined,
          messages: undefined,
          events: undefined,
        }) ?? "{}",
        now,
      );
      this.chats.replace(tx, asRecord(payload));
    });
  }

  close(): void {
    // The application owns the shared SQLite database handle.
  }

  isShutdownError(error: unknown): boolean {
    return this.database.isClosedError(error);
  }

  private writeSetting(
    database: SqliteQueryable,
    key: string,
    value: string | null,
    now: number,
  ): void {
    database.run(
      `INSERT INTO app_settings (key, value_text, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value_text = excluded.value_text,
         updated_at = excluded.updated_at`,
      key,
      value,
      now,
    );
  }
}
