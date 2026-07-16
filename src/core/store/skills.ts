import {
  skillUsageSnapshotFromEvents,
  type SkillUsageEvent,
  type SkillUsageSnapshot,
  type SkillUsageSource,
} from "../skill-usage";
import type { SessionStoreDatabase } from "./database";

export type SkillSyncDirection = "upload" | "download";

export interface SkillSyncBinding {
  localSkillPath: string;
  portableIdentity?: string;
  remoteSkillId: string;
  remoteUpdatedAt: string;
  remoteVersion: number;
  lastContentHash?: string;
  lastSyncedAt: number;
  direction: SkillSyncDirection;
}

interface SkillUsageEventRow {
  agent: SkillUsageEvent["agent"];
  skill: string;
  timestamp: number;
}

interface SkillSyncBindingRow {
  local_skill_path: string;
  portable_identity: string;
  remote_skill_id: string;
  remote_updated_at: string;
  remote_version: number;
  last_content_hash: string;
  last_synced_at: number;
  direction: SkillSyncDirection;
}

export class SkillStore {
  constructor(private readonly db: SessionStoreDatabase) {}

  isSkillUsageSourceFresh(source: SkillUsageSource): boolean {
    const row = this.db
      .prepare("SELECT mtime_ms, file_size FROM skill_usage_sources WHERE source_path = ?")
      .get(source.path) as { mtime_ms: number; file_size: number } | undefined;
    return Boolean(row && Math.abs(row.mtime_ms - source.mtimeMs) < 0.001 && row.file_size === source.fileSize);
  }

  upsertSkillUsageSource(source: SkillUsageSource, events: SkillUsageEvent[]): void {
    this.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO skill_usage_sources (source_path, agent, kind, mtime_ms, file_size, scanned_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_path) DO UPDATE SET
            agent = excluded.agent,
            kind = excluded.kind,
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            scanned_at = excluded.scanned_at
        `,
        )
        .run(source.path, source.agent, source.kind, source.mtimeMs, source.fileSize, Date.now());

      this.db.prepare("DELETE FROM skill_usage_events WHERE source_path = ?").run(source.path);
      const insertEvent = this.db.prepare(
        `
        INSERT INTO skill_usage_events (source_path, event_index, agent, skill, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `,
      );
      events.forEach((event, index) => {
        const skill = event.skill.trim();
        if (!skill) return;
        insertEvent.run(source.path, index, event.agent, skill, event.timestamp);
      });
    });
  }

  pruneSkillUsageSources(activePaths: string[]): void {
    const active = new Set(activePaths);
    const rows = this.db.prepare("SELECT source_path FROM skill_usage_sources").all() as Array<{ source_path: string }>;
    this.transaction(() => {
      for (const row of rows) {
        if (!active.has(row.source_path)) this.db.prepare("DELETE FROM skill_usage_sources WHERE source_path = ?").run(row.source_path);
      }
    });
  }

  getSkillUsageSnapshot(): SkillUsageSnapshot {
    const sourceCountRow = this.db.prepare("SELECT COUNT(*) AS count FROM skill_usage_sources").get() as { count: number };
    const rows = this.db
      .prepare(
        `
        SELECT agent, skill, timestamp
        FROM skill_usage_events
        ORDER BY source_path, event_index
      `,
      )
      .all() as unknown as SkillUsageEventRow[];
    return skillUsageSnapshotFromEvents(rows, "", sourceCountRow.count > 0 || rows.length > 0);
  }

  upsertSkillSyncBinding(binding: SkillSyncBinding): void {
    const localSkillPath = binding.localSkillPath.trim();
    const portableIdentity = binding.portableIdentity?.trim() ?? "";
    const remoteSkillId = binding.remoteSkillId.trim();
    if (!localSkillPath || !remoteSkillId) return;
    // A remote skill maps to exactly one local path. Two local skills that share an agent+name
    // resolve to the same remote fingerprint/id, so re-binding must move the remote pointer to the
    // latest local path rather than violating the UNIQUE(remote_skill_id) constraint.
    this.transaction(() => {
      this.db
        .prepare(`DELETE FROM skill_sync_bindings WHERE remote_skill_id = ? AND local_skill_path <> ?`)
        .run(remoteSkillId, localSkillPath);
      if (portableIdentity) {
        this.db
          .prepare(`DELETE FROM skill_sync_bindings WHERE portable_identity = ? AND local_skill_path <> ?`)
          .run(portableIdentity, localSkillPath);
      }
      this.db
        .prepare(
          `
        INSERT INTO skill_sync_bindings (local_skill_path, portable_identity, remote_skill_id, remote_updated_at, remote_version, last_content_hash, last_synced_at, direction)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_skill_path) DO UPDATE SET
          portable_identity = excluded.portable_identity,
          remote_skill_id = excluded.remote_skill_id,
          remote_updated_at = excluded.remote_updated_at,
          remote_version = excluded.remote_version,
          last_content_hash = excluded.last_content_hash,
          last_synced_at = excluded.last_synced_at,
          direction = excluded.direction
      `,
        )
        .run(
          localSkillPath,
          portableIdentity,
          remoteSkillId,
          binding.remoteUpdatedAt,
          nonNegativeNumber(binding.remoteVersion) || 1,
          binding.lastContentHash?.trim() ?? "",
          binding.lastSyncedAt,
          binding.direction,
        );
    });
  }

  getSkillSyncBindingForLocalPath(localSkillPath: string): SkillSyncBinding | null {
    const row = this.db
      .prepare(
        `
        SELECT local_skill_path, portable_identity, remote_skill_id, remote_updated_at, remote_version, last_content_hash, last_synced_at, direction
        FROM skill_sync_bindings
        WHERE local_skill_path = ?
      `,
      )
      .get(localSkillPath) as SkillSyncBindingRow | undefined;
    return row ? skillSyncBindingFromRow(row) : null;
  }

  getSkillSyncBindingForPortableIdentity(portableIdentity: string): SkillSyncBinding | null {
    const row = this.db
      .prepare(
        `SELECT local_skill_path, portable_identity, remote_skill_id, remote_updated_at, remote_version, last_content_hash, last_synced_at, direction
         FROM skill_sync_bindings
         WHERE portable_identity = ?`,
      )
      .get(portableIdentity.trim()) as SkillSyncBindingRow | undefined;
    return row ? skillSyncBindingFromRow(row) : null;
  }

  getSkillSyncBindingForRemoteId(remoteSkillId: string): SkillSyncBinding | null {
    const row = this.db
      .prepare(
        `
        SELECT local_skill_path, portable_identity, remote_skill_id, remote_updated_at, remote_version, last_content_hash, last_synced_at, direction
        FROM skill_sync_bindings
        WHERE remote_skill_id = ?
      `,
      )
      .get(remoteSkillId) as SkillSyncBindingRow | undefined;
    return row ? skillSyncBindingFromRow(row) : null;
  }

  listSkillSyncBindings(): SkillSyncBinding[] {
    const rows = this.db
      .prepare(
        `
        SELECT local_skill_path, portable_identity, remote_skill_id, remote_updated_at, remote_version, last_content_hash, last_synced_at, direction
        FROM skill_sync_bindings
        ORDER BY last_synced_at DESC, local_skill_path
      `,
      )
      .all() as unknown as SkillSyncBindingRow[];
    return rows.map(skillSyncBindingFromRow);
  }

  deleteSkillSyncBindingsForRemoteIds(remoteSkillIds: string[]): void {
    const ids = [...new Set(remoteSkillIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM skill_sync_bindings WHERE remote_skill_id IN (${placeholders})`).run(...ids);
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

function skillSyncBindingFromRow(row: SkillSyncBindingRow): SkillSyncBinding {
  return {
    localSkillPath: row.local_skill_path,
    portableIdentity: row.portable_identity || "",
    remoteSkillId: row.remote_skill_id,
    remoteUpdatedAt: row.remote_updated_at,
    remoteVersion: typeof row.remote_version === "number" && Number.isFinite(row.remote_version) ? row.remote_version : 1,
    lastContentHash: row.last_content_hash || "",
    lastSyncedAt: row.last_synced_at,
    direction: row.direction,
  };
}

function nonNegativeNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

