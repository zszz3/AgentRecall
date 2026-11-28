import { migrationTargetDescriptor } from "../migration-targets";
import type { ApiProviderKeyTarget, SessionSyncBinding, SessionSyncDirection } from "../storage/types";
import type { SessionMigrationRecord } from "../types";
import type { MetadataRepository } from "../storage/repositories";
import type { SqliteDatabase } from "./database";
import { sqliteTime } from "./values";

interface SessionSyncBindingRow extends Record<string, unknown> {
  local_session_key: string;
  remote_session_id: string;
  last_local_revision: string;
  last_remote_revision: string;
  last_synced_at: number;
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
  created_at: number;
}

function syncBindingFromRow(row: SessionSyncBindingRow): SessionSyncBinding {
  return {
    localSessionKey: row.local_session_key,
    remoteSessionId: row.remote_session_id,
    lastLocalRevision: row.last_local_revision,
    lastRemoteRevision: row.last_remote_revision,
    lastSyncedAt: sqliteTime(row.last_synced_at),
    direction: row.direction,
  };
}

const SYNC_BINDING_COLUMNS = `
  local_session_key, remote_session_id, last_local_revision,
  last_remote_revision, last_synced_at, direction
`;

export class SqliteMetadataRepository implements MetadataRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async upsertSessionSyncBinding(binding: SessionSyncBinding): Promise<void> {
    const localSessionKey = binding.localSessionKey.trim();
    const remoteSessionId = binding.remoteSessionId.trim();
    if (!localSessionKey || !remoteSessionId) return;
    this.database.transactionSync((tx) => {
      tx.run(
        `
          DELETE FROM session_sync_bindings
          WHERE remote_session_id = ? AND local_session_key <> ?
        `,
        remoteSessionId,
        localSessionKey,
      );
      tx.run(
        `
          INSERT INTO session_sync_bindings (
            local_session_key, remote_session_id, last_local_revision,
            last_remote_revision, last_synced_at, direction
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (local_session_key) DO UPDATE SET
            remote_session_id = excluded.remote_session_id,
            last_local_revision = excluded.last_local_revision,
            last_remote_revision = excluded.last_remote_revision,
            last_synced_at = excluded.last_synced_at,
            direction = excluded.direction
        `,
        localSessionKey,
        remoteSessionId,
        binding.lastLocalRevision,
        binding.lastRemoteRevision,
        Math.max(0, Math.floor(binding.lastSyncedAt)),
        binding.direction,
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
    const rows = this.database.all<SessionSyncBindingRow>(
      `
        SELECT ${SYNC_BINDING_COLUMNS}
        FROM session_sync_bindings
        ORDER BY last_synced_at DESC
      `,
    );
    return rows.map(syncBindingFromRow);
  }

  async deleteSessionSyncBindingForRemoteId(remoteSessionId: string): Promise<void> {
    this.database.run(
      "DELETE FROM session_sync_bindings WHERE remote_session_id = ?",
      remoteSessionId,
    );
  }

  async getApiProviderKey(target: ApiProviderKeyTarget, providerId: string): Promise<string> {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) return "";
    const row = this.database.get<{ api_key: string }>(
      `
        SELECT api_key
        FROM api_provider_keys
        WHERE target = ? AND provider_id = ?
      `,
      target,
      normalizedProviderId,
    );
    return row?.api_key ?? "";
  }

  async setApiProviderKey(
    target: ApiProviderKeyTarget,
    providerId: string,
    apiKey: string,
  ): Promise<void> {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) return;
    this.database.run(
      `
        INSERT INTO api_provider_keys (target, provider_id, api_key, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (target, provider_id) DO UPDATE SET
          api_key = excluded.api_key,
          updated_at = excluded.updated_at
      `,
      target,
      normalizedProviderId,
      apiKey.trim(),
      Date.now(),
    );
  }

  async recordSessionMigration(record: SessionMigrationRecord): Promise<void> {
    this.database.run(
      `
        INSERT INTO session_migrations (
          id, source_session_key, source_agent, target_agent,
          target_session_id, target_file_path, strategy, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      record.sourceSessionKey,
      record.sourceAgent,
      record.targetAgent,
      record.targetSessionId,
      record.targetFilePath,
      record.strategy,
      Math.max(0, Math.floor(record.createdAt)),
    );
  }

  async listSessionMigrations(sourceSessionKey: string): Promise<SessionMigrationRecord[]> {
    const rows = this.database.all<SessionMigrationRow>(
      `
        SELECT
          id, source_session_key, source_agent, target_agent,
          target_session_id, target_file_path, strategy, created_at
        FROM session_migrations
        WHERE source_session_key = ?
        ORDER BY created_at DESC, id DESC
      `,
      sourceSessionKey,
    );
    return rows.map((row) => ({
      id: row.id,
      sourceSessionKey: row.source_session_key,
      sourceAgent: row.source_agent,
      targetAgent: migrationTargetDescriptor(row.target_agent).id,
      targetSessionId: row.target_session_id,
      targetFilePath: row.target_file_path,
      strategy: row.strategy,
      createdAt: sqliteTime(row.created_at),
    }));
  }

  private async getSyncBinding(
    column: "local_session_key" | "remote_session_id",
    value: string,
  ): Promise<SessionSyncBinding | null> {
    const row = this.database.get<SessionSyncBindingRow>(
      `
        SELECT ${SYNC_BINDING_COLUMNS}
        FROM session_sync_bindings
        WHERE ${column} = ?
      `,
      value,
    );
    return row ? syncBindingFromRow(row) : null;
  }
}
