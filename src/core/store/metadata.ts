import { migrationTargetDescriptor } from "../migration-targets";
import type { SessionMigrationRecord } from "../types";
import type { SessionStoreDatabase } from "./database";

export type ApiProviderKeyTarget = "codex" | "claude" | "summary";
export type SessionSyncDirection = "upload" | "restore";

export interface SessionSyncBinding {
  localSessionKey: string;
  remoteSessionId: string;
  lastLocalRevision: string;
  lastRemoteRevision: string;
  lastSyncedAt: number;
  direction: SessionSyncDirection;
}

interface SessionSyncBindingRow {
  local_session_key: string;
  remote_session_id: string;
  last_local_revision: string;
  last_remote_revision: string;
  last_synced_at: number;
  direction: SessionSyncDirection;
}

interface SessionMigrationRow {
  id: string;
  source_session_key: string;
  source_agent: SessionMigrationRecord["sourceAgent"];
  target_agent: string;
  target_session_id: string;
  target_file_path: string;
  strategy: SessionMigrationRecord["strategy"];
  created_at: number;
}

export class MetadataStore {
  constructor(private readonly db: SessionStoreDatabase) {}

  upsertSessionSyncBinding(binding: SessionSyncBinding): void {
    const localSessionKey = binding.localSessionKey.trim();
    const remoteSessionId = binding.remoteSessionId.trim();
    if (!localSessionKey || !remoteSessionId) return;
    this.transaction(() => {
      this.db.prepare("DELETE FROM session_sync_bindings WHERE remote_session_id = ? AND local_session_key <> ?").run(remoteSessionId, localSessionKey);
      this.db
        .prepare(
          `INSERT INTO session_sync_bindings (
             local_session_key, remote_session_id, last_local_revision, last_remote_revision, last_synced_at, direction
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(local_session_key) DO UPDATE SET
             remote_session_id = excluded.remote_session_id,
             last_local_revision = excluded.last_local_revision,
             last_remote_revision = excluded.last_remote_revision,
             last_synced_at = excluded.last_synced_at,
             direction = excluded.direction`,
        )
        .run(
          localSessionKey,
          remoteSessionId,
          binding.lastLocalRevision,
          binding.lastRemoteRevision,
          binding.lastSyncedAt,
          binding.direction,
        );
    });
  }

  getSessionSyncBindingForLocalKey(localSessionKey: string): SessionSyncBinding | null {
    const row = this.db
      .prepare(
        `SELECT local_session_key, remote_session_id, last_local_revision, last_remote_revision, last_synced_at, direction
         FROM session_sync_bindings WHERE local_session_key = ?`,
      )
      .get(localSessionKey) as SessionSyncBindingRow | undefined;
    return row ? sessionSyncBindingFromRow(row) : null;
  }

  getSessionSyncBindingForRemoteId(remoteSessionId: string): SessionSyncBinding | null {
    const row = this.db
      .prepare(
        `SELECT local_session_key, remote_session_id, last_local_revision, last_remote_revision, last_synced_at, direction
         FROM session_sync_bindings WHERE remote_session_id = ?`,
      )
      .get(remoteSessionId) as SessionSyncBindingRow | undefined;
    return row ? sessionSyncBindingFromRow(row) : null;
  }

  listSessionSyncBindings(): SessionSyncBinding[] {
    const rows = this.db
      .prepare(
        `SELECT local_session_key, remote_session_id, last_local_revision, last_remote_revision, last_synced_at, direction
         FROM session_sync_bindings ORDER BY last_synced_at DESC`,
      )
      .all() as unknown as SessionSyncBindingRow[];
    return rows.map(sessionSyncBindingFromRow);
  }

  deleteSessionSyncBindingForRemoteId(remoteSessionId: string): void {
    this.db.prepare("DELETE FROM session_sync_bindings WHERE remote_session_id = ?").run(remoteSessionId);
  }

  getApiProviderKey(target: ApiProviderKeyTarget, providerId: string): string {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) return "";
    const row = this.db
      .prepare("SELECT api_key FROM api_provider_keys WHERE target = ? AND provider_id = ?")
      .get(target, normalizedProviderId) as { api_key: string } | undefined;
    return row?.api_key ?? "";
  }

  setApiProviderKey(target: ApiProviderKeyTarget, providerId: string, apiKey: string): void {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) return;
    this.db
      .prepare(
        `
        INSERT INTO api_provider_keys (target, provider_id, api_key, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(target, provider_id) DO UPDATE SET
          api_key = excluded.api_key,
          updated_at = excluded.updated_at
      `,
      )
      .run(target, normalizedProviderId, apiKey.trim(), Date.now());
  }

  recordSessionMigration(record: SessionMigrationRecord): void {
    this.db
      .prepare(
        `
        INSERT INTO session_migrations (
          id, source_session_key, source_agent, target_agent, target_session_id, target_file_path, strategy, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.id,
        record.sourceSessionKey,
        record.sourceAgent,
        record.targetAgent,
        record.targetSessionId,
        record.targetFilePath,
        record.strategy,
        record.createdAt,
      );
  }

  listSessionMigrations(sourceSessionKey: string): SessionMigrationRecord[] {
    return (
      this.db
        .prepare(
          `
          SELECT id, source_session_key, source_agent, target_agent, target_session_id, target_file_path, strategy, created_at
          FROM session_migrations
          WHERE source_session_key = ?
          ORDER BY created_at DESC, id DESC
        `,
        )
        .all(sourceSessionKey) as unknown as SessionMigrationRow[]
    ).map((row) => ({
      id: row.id,
      sourceSessionKey: row.source_session_key,
      sourceAgent: row.source_agent,
      targetAgent: migrationTargetDescriptor(row.target_agent).id,
      targetSessionId: row.target_session_id,
      targetFilePath: row.target_file_path,
      strategy: row.strategy,
      createdAt: row.created_at,
    }));
  }

  private transaction(run: () => void): void {
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function sessionSyncBindingFromRow(row: SessionSyncBindingRow): SessionSyncBinding {
  return {
    localSessionKey: row.local_session_key,
    remoteSessionId: row.remote_session_id,
    lastLocalRevision: row.last_local_revision,
    lastRemoteRevision: row.last_remote_revision,
    lastSyncedAt: row.last_synced_at,
    direction: row.direction,
  };
}

