import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createNormalizedSchema } from "./sqlite-schema";
import { SqliteChatRepository } from "./sqlite-chat-repository";
import { SqliteWorkflowRepository } from "./sqlite-workflow-repository";
import {
  asRecord,
  asString,
  parseJson,
  rowCount,
  type DatabaseSync,
  type SqliteModule,
} from "./sqlite-values";

const AUX_STATE_ID = 1;
const require = createRequire(import.meta.url);

export class SqliteAppStore {
  private db: DatabaseSync | undefined;
  private readonly chats = new SqliteChatRepository();
  private readonly workflows = new SqliteWorkflowRepository((db, key) => this.readSetting(db, key));

  constructor(private readonly dbPath: string) {}

  async load(): Promise<unknown | undefined> {
    const db = await this.open();
    const auxRow = asRecord(db.prepare("select payload from app_aux_state where id = ?").get(AUX_STATE_ID));
    if (!auxRow.payload && rowCount(db, "chats") === 0 && rowCount(db, "workflows") === 0) return undefined;

    const payload = asRecord(parseJson(auxRow.payload));
    payload.version = Number(this.readSetting(db, "payload_version") ?? "5");
    payload.activeChatId = this.readSetting(db, "active_chat_id") ?? null;
    payload.workDir = this.readSetting(db, "work_dir") ?? "";
    Object.assign(payload, this.chats.load(db));
    payload.workflowStore = this.workflows.load(db);
    return payload;
  }

  async save(payload: unknown): Promise<void> {
    const db = await this.open();
    this.saveNormalized(db, payload);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private async open(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as SqliteModule;
    const db = new DatabaseSync(this.dbPath);
    db.exec("pragma journal_mode = WAL");
    db.exec("pragma foreign_keys = ON");
    db.exec("pragma busy_timeout = 5000");
    createNormalizedSchema(db);
    this.db = db;
    return db;
  }

  private saveNormalized(db: DatabaseSync, raw: unknown): void {
    const payload = asRecord(raw);
    if (payload.version !== 5) throw new Error("SQLite persistence only supports app state version 5");
    db.exec("begin immediate");
    try {
      const now = Date.now();
      this.writeSetting(db, "payload_version", String(payload.version), now);
      this.writeSetting(db, "active_chat_id", typeof payload.activeChatId === "string" ? payload.activeChatId : null, now);
      this.writeSetting(db, "work_dir", asString(payload.workDir), now);
      const workflowStore = asRecord(payload.workflowStore);
      this.writeSetting(db, "active_workflow_id", typeof workflowStore.activeWorkflowId === "string" ? workflowStore.activeWorkflowId : null, now);
      db.prepare(
        "insert into app_aux_state (id, payload, updated_at) values (?, ?, ?) on conflict(id) do update set payload = excluded.payload, updated_at = excluded.updated_at",
      ).run(AUX_STATE_ID, JSON.stringify({ ...payload, sessions: undefined, messages: undefined, events: undefined, workflowStore: undefined }), now);
      this.chats.sync(db, payload);
      this.workflows.sync(db, workflowStore);
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  }

  private writeSetting(db: DatabaseSync, key: string, value: string | null, now: number): void {
    db.prepare(
      "insert into app_settings (key, value_text, updated_at) values (?, ?, ?) on conflict(key) do update set value_text = excluded.value_text, updated_at = excluded.updated_at",
    ).run(key, value, now);
  }

  private readSetting(db: DatabaseSync, key: string): string | undefined {
    const row = asRecord(db.prepare("select value_text from app_settings where key = ?").get(key));
    return typeof row.value_text === "string" ? row.value_text : undefined;
  }
}
