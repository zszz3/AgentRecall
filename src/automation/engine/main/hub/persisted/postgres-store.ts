import { asRecord, asString } from "./sqlite-values";
import type { PostgresDatabase, PostgresQueryable } from "../../../../../core/postgres/database";
import type { PersistedAppStateV5 } from "./agent-hub-persistence";
import type { AgentHubPersistedStore } from "./persisted-store";
import { PostgresChatRepository } from "./postgres-chat-repository";
import { PostgresWorkflowRepository } from "./postgres-workflow-repository";
import { jsonParameter, postgresRecord } from "./postgres-values";

const AUX_STATE_ID = 1;

export class PostgresAppStore implements AgentHubPersistedStore {
  readonly label = "PostgreSQL";
  private readonly chats = new PostgresChatRepository();
  private readonly workflows = new PostgresWorkflowRepository();

  constructor(
    private readonly database: PostgresDatabase,
    readonly fileStoragePath?: string,
  ) {}

  async load(): Promise<unknown | undefined> {
    const [auxResult, countResult, settingsResult] = await Promise.all([
      this.database.query<{ payload: unknown }>(
        "select payload from agent_recall.app_aux_state where id = $1",
        [AUX_STATE_ID],
      ),
      this.database.query<{
        chat_count: number;
        workflow_count: number;
      }>(`
        select
          (select count(*)::integer from agent_recall.automation_chats) as chat_count,
          (select count(*)::integer from agent_recall.workflows) as workflow_count
      `),
      this.database.query<{ key: string; value_text: string | null }>(
        "select key, value_text from agent_recall.app_settings",
      ),
    ]);
    const aux = auxResult.rows[0]?.payload;
    const counts = countResult.rows[0];
    if (
      aux === undefined &&
      Number(counts?.chat_count ?? 0) === 0 &&
      Number(counts?.workflow_count ?? 0) === 0
    ) {
      return undefined;
    }

    const settings = new Map(
      settingsResult.rows.map((row) => [row.key, row.value_text] as const),
    );
    const payload = postgresRecord(aux);
    payload.version = Number(settings.get("payload_version") ?? "5");
    payload.activeChatId = settings.get("active_chat_id") ?? null;
    payload.workDir = settings.get("work_dir") ?? "";
    Object.assign(payload, await this.chats.load(this.database));
    payload.workflowStore = await this.workflows.load(
      this.database,
      settings.get("active_workflow_id") ?? undefined,
    );
    return payload;
  }

  async save(payload: PersistedAppStateV5): Promise<void> {
    if (payload.version !== 5) {
      throw new Error("PostgreSQL persistence only supports app state version 5");
    }
    await this.database.transaction(async (transaction) => {
      const now = new Date();
      await this.writeSetting(transaction, "payload_version", String(payload.version), now);
      await this.writeSetting(transaction, "active_chat_id", payload.activeChatId, now);
      await this.writeSetting(transaction, "work_dir", asString(payload.workDir), now);
      const workflowStore = asRecord(payload.workflowStore);
      await this.writeSetting(
        transaction,
        "active_workflow_id",
        typeof workflowStore.activeWorkflowId === "string"
          ? workflowStore.activeWorkflowId
          : null,
        now,
      );
      await transaction.query(
        `insert into agent_recall.app_aux_state (id, payload, updated_at)
         values ($1, $2::jsonb, $3)
         on conflict (id) do update set
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
        [
          AUX_STATE_ID,
          jsonParameter({
            ...payload,
            sessions: undefined,
            messages: undefined,
            events: undefined,
            workflowStore: undefined,
          }),
          now,
        ],
      );
      await this.chats.replace(transaction, asRecord(payload));
      await this.workflows.replace(transaction, workflowStore);
    });
  }

  close(): void {
    // The application owns the shared PostgreSQL connection pool.
  }

  private async writeSetting(
    database: PostgresQueryable,
    key: string,
    value: string | null,
    now: Date,
  ): Promise<void> {
    await database.query(
      `insert into agent_recall.app_settings (key, value_text, updated_at)
       values ($1, $2, $3)
       on conflict (key) do update set
         value_text = excluded.value_text,
         updated_at = excluded.updated_at`,
      [key, value, now],
    );
  }
}
