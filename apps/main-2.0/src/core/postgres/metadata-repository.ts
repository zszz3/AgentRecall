import { migrationTargetDescriptor } from "../migration-targets";
import type { SessionMigrationRecord } from "../types";
import type { PostgresDatabase } from "./database";

/** `agent` keys belong to the AgentRecall model and are stored per pi-ai provider id. */
export type ApiProviderKeyTarget = "codex" | "claude" | "summary" | "agent" | "gateway";
export type SessionSyncDirection = "upload" | "restore";

export interface SessionSyncBinding {
  localSessionKey: string;
  remoteSessionId: string;
  lastLocalRevision: string;
  lastRemoteRevision: string;
  lastSyncedAt: number;
  direction: SessionSyncDirection;
}

interface SessionSyncBindingRow extends Record<string, unknown> {
  local_session_key: string;
  remote_session_id: string;
  last_local_revision: string;
  last_remote_revision: string;
  last_synced_at: Date | string;
  direction: SessionSyncDirection;
}

interface SessionMigrationRow extends Record<string, unknown> {
  id: string;
  source_session_key: string;
  source_agent: SessionMigrationRecord["sourceAgent"];
  target_agent: string;
  target_session_id: string;
  target_file_path: string;
  strategy: SessionMigrationRecord["strategy"];
  created_at: Date | string;
}

function timeValue(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function syncBindingFromRow(row: SessionSyncBindingRow): SessionSyncBinding {
  return {
    localSessionKey: row.local_session_key,
    remoteSessionId: row.remote_session_id,
    lastLocalRevision: row.last_local_revision,
    lastRemoteRevision: row.last_remote_revision,
    lastSyncedAt: timeValue(row.last_synced_at),
    direction: row.direction,
  };
}

const SYNC_BINDING_COLUMNS = `
  local_session_key, remote_session_id, last_local_revision,
  last_remote_revision, last_synced_at, direction
`;

export class PostgresMetadataRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async upsertSessionSyncBinding(binding: SessionSyncBinding): Promise<void> {
    const localSessionKey = binding.localSessionKey.trim();
    const remoteSessionId = binding.remoteSessionId.trim();
    if (!localSessionKey || !remoteSessionId) return;
    await this.database.transaction(async (client) => {
      await client.query(
        `
          delete from agent_recall.session_sync_bindings
          where remote_session_id = $1 and local_session_key <> $2
        `,
        [remoteSessionId, localSessionKey],
      );
      await client.query(
        `
          insert into agent_recall.session_sync_bindings (
            local_session_key, remote_session_id, last_local_revision,
            last_remote_revision, last_synced_at, direction
          )
          values ($1, $2, $3, $4, $5, $6)
          on conflict (local_session_key) do update set
            remote_session_id = excluded.remote_session_id,
            last_local_revision = excluded.last_local_revision,
            last_remote_revision = excluded.last_remote_revision,
            last_synced_at = excluded.last_synced_at,
            direction = excluded.direction
        `,
        [
          localSessionKey,
          remoteSessionId,
          binding.lastLocalRevision,
          binding.lastRemoteRevision,
          new Date(Math.max(0, binding.lastSyncedAt)).toISOString(),
          binding.direction,
        ],
      );
    });
  }

  async getSessionSyncBindingForLocalKey(localSessionKey: string): Promise<SessionSyncBinding | null> {
    return this.getSyncBinding("local_session_key", localSessionKey);
  }

  async getSessionSyncBindingForRemoteId(remoteSessionId: string): Promise<SessionSyncBinding | null> {
    return this.getSyncBinding("remote_session_id", remoteSessionId);
  }

  async listSessionSyncBindings(): Promise<SessionSyncBinding[]> {
    const result = await this.database.query<SessionSyncBindingRow>(
      `
        select ${SYNC_BINDING_COLUMNS}
        from agent_recall.session_sync_bindings
        order by last_synced_at desc
      `,
    );
    return result.rows.map(syncBindingFromRow);
  }

  async deleteSessionSyncBindingForRemoteId(remoteSessionId: string): Promise<void> {
    await this.database.query(
      "delete from agent_recall.session_sync_bindings where remote_session_id = $1",
      [remoteSessionId],
    );
  }

  async getApiProviderKey(target: ApiProviderKeyTarget, providerId: string): Promise<string> {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) return "";
    const result = await this.database.query<{ api_key: string }>(
      `
        select api_key
        from agent_recall.api_provider_keys
        where target = $1 and provider_id = $2
      `,
      [target, normalizedProviderId],
    );
    return result.rows[0]?.api_key ?? "";
  }

  async setApiProviderKey(
    target: ApiProviderKeyTarget,
    providerId: string,
    apiKey: string,
  ): Promise<void> {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) return;
    await this.database.query(
      `
        insert into agent_recall.api_provider_keys (target, provider_id, api_key, updated_at)
        values ($1, $2, $3, now())
        on conflict (target, provider_id) do update set
          api_key = excluded.api_key,
          updated_at = excluded.updated_at
      `,
      [target, normalizedProviderId, apiKey.trim()],
    );
  }

  async recordSessionMigration(record: SessionMigrationRecord): Promise<void> {
    await this.database.query(
      `
        insert into agent_recall.session_migrations (
          id, source_session_key, source_agent, target_agent,
          target_session_id, target_file_path, strategy, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        record.id,
        record.sourceSessionKey,
        record.sourceAgent,
        record.targetAgent,
        record.targetSessionId,
        record.targetFilePath,
        record.strategy,
        new Date(Math.max(0, record.createdAt)).toISOString(),
      ],
    );
  }

  async listSessionMigrations(sourceSessionKey: string): Promise<SessionMigrationRecord[]> {
    const result = await this.database.query<SessionMigrationRow>(
      `
        select
          id, source_session_key, source_agent, target_agent,
          target_session_id, target_file_path, strategy, created_at
        from agent_recall.session_migrations
        where source_session_key = $1
        order by created_at desc, id desc
      `,
      [sourceSessionKey],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sourceSessionKey: row.source_session_key,
      sourceAgent: row.source_agent,
      targetAgent: migrationTargetDescriptor(row.target_agent).id,
      targetSessionId: row.target_session_id,
      targetFilePath: row.target_file_path,
      strategy: row.strategy,
      createdAt: timeValue(row.created_at),
    }));
  }

  private async getSyncBinding(
    column: "local_session_key" | "remote_session_id",
    value: string,
  ): Promise<SessionSyncBinding | null> {
    const result = await this.database.query<SessionSyncBindingRow>(
      `
        select ${SYNC_BINDING_COLUMNS}
        from agent_recall.session_sync_bindings
        where ${column} = $1
      `,
      [value],
    );
    return result.rows[0] ? syncBindingFromRow(result.rows[0]) : null;
  }
}
