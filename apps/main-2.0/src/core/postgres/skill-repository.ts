import {
  skillUsageSnapshotFromEvents,
  type SkillUsageAgent,
  type SkillUsageEvent,
  type SkillUsageSnapshot,
  type SkillUsageSource,
} from "../skill-usage";
import type { PostgresDatabase } from "./database";

export type SkillSyncDirection = "upload" | "download";

// How far a recorded skill trigger could be resolved against the indexed
// sessions. Historical records without a linkage key stay "unlinked".
export type SkillTriggerLinkState = "linked-turn" | "linked-session" | "unlinked";

export interface SkillTriggerLink {
  agent: SkillUsageAgent;
  skill: string;
  occurredAt: number;
  linkState: SkillTriggerLinkState;
  sessionKey: string | null;
  sessionTitle: string | null;
  projectPath: string | null;
  turnId: string | null;
}

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

interface SkillSyncBindingRow extends Record<string, unknown> {
  local_skill_path: string;
  portable_identity: string;
  remote_skill_id: string;
  remote_updated_at: Date | string;
  remote_version: number | string;
  last_content_hash: string;
  last_synced_at: Date | string;
  direction: SkillSyncDirection;
}

function timeValue(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isoValue(value: Date | string): string {
  const timestamp = timeValue(value);
  return new Date(Math.max(0, timestamp)).toISOString();
}

function bindingFromRow(row: SkillSyncBindingRow): SkillSyncBinding {
  const remoteVersion = Number(row.remote_version);
  return {
    localSkillPath: row.local_skill_path,
    portableIdentity: row.portable_identity || "",
    remoteSkillId: row.remote_skill_id,
    remoteUpdatedAt: isoValue(row.remote_updated_at),
    remoteVersion: Number.isFinite(remoteVersion) ? remoteVersion : 1,
    lastContentHash: row.last_content_hash || "",
    lastSyncedAt: timeValue(row.last_synced_at),
    direction: row.direction,
  };
}

const BINDING_COLUMNS = `
  local_skill_path, portable_identity, remote_skill_id, remote_updated_at,
  remote_version, last_content_hash, last_synced_at, direction
`;

export class PostgresSkillRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async isSkillUsageSourceFresh(source: SkillUsageSource): Promise<boolean> {
    const result = await this.database.query<{
      mtime_ms: number | string;
      file_size: number | string;
    }>(
      `
        select mtime_ms, file_size
        from agent_recall.skill_usage_sources
        where source_path = $1
      `,
      [source.path],
    );
    const row = result.rows[0];
    return Boolean(
      row
      && Math.abs(Number(row.mtime_ms) - source.mtimeMs) < 0.001
      && Number(row.file_size) === source.fileSize,
    );
  }

  async upsertSkillUsageSource(
    source: SkillUsageSource,
    events: readonly SkillUsageEvent[],
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into agent_recall.skill_usage_sources (
            source_path, agent, kind, mtime_ms, file_size, scanned_at
          )
          values ($1, $2, $3, $4, $5, now())
          on conflict (source_path) do update set
            agent = excluded.agent,
            kind = excluded.kind,
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            scanned_at = excluded.scanned_at
        `,
        [source.path, source.agent, source.kind, source.mtimeMs, source.fileSize],
      );
      await client.query(
        "delete from agent_recall.skill_usage_events where source_path = $1",
        [source.path],
      );
      let eventIndex = 0;
      for (const event of events) {
        const skill = event.skill.trim();
        if (!skill) continue;
        await client.query(
          `
            insert into agent_recall.skill_usage_events (
              source_path, event_index, agent, skill, occurred_at, session_id, cwd
            )
            values ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            source.path,
            eventIndex,
            event.agent,
            skill,
            new Date(Math.max(0, event.timestamp)).toISOString(),
            event.sessionId?.trim() || null,
            event.cwd?.trim() || null,
          ],
        );
        eventIndex += 1;
      }
    });
  }

  async pruneSkillUsageSources(activePaths: readonly string[]): Promise<void> {
    const active = [...new Set(activePaths)];
    if (active.length === 0) {
      await this.database.query("delete from agent_recall.skill_usage_sources");
      return;
    }
    await this.database.query(
      "delete from agent_recall.skill_usage_sources where not (source_path = any($1::text[]))",
      [active],
    );
  }

  // Resolves recorded skill triggers against indexed sessions at query time:
  // claude-hook events join on the captured session_id, and events scanned
  // out of session transcripts join on the transcript path itself (the hook
  // log path never matches a session file, so that branch stays inert for
  // hook events). Records without a hit stay "unlinked" rather than being
  // attributed by time-window guessing.
  async listRecentSkillTriggers(
    options: { skill?: string; limit?: number } = {},
  ): Promise<SkillTriggerLink[]> {
    const skill = options.skill?.trim() || null;
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
    const result = await this.database.query<{
      agent: SkillUsageAgent;
      skill: string;
      occurred_at: Date | string;
      session_key: string | null;
      session_title: string | null;
      project_path: string | null;
      turn_id: string | null;
    }>(
      `
        select
          events.agent,
          events.skill,
          events.occurred_at,
          linked.session_key,
          linked.session_title,
          linked.project_path,
          turn.turn_id
        from agent_recall.skill_usage_events events
        left join lateral (
          select
            sessions.session_key,
            coalesce(
              nullif(sessions.custom_title, ''),
              nullif(sessions.original_title, ''),
              sessions.first_question
            ) as session_title,
            sessions.project_path
          from agent_recall.sessions sessions
          where
            (
              events.session_id is not null
              and sessions.raw_id = events.session_id
              and sessions.source in ('claude-cli', 'claude-app')
              and sessions.storage_environment_id = 'local'
            )
            or sessions.file_path = events.source_path
          order by sessions.file_mtime_ms desc
          limit 1
        ) linked on true
        left join lateral (
          select turns.id as turn_id
          from agent_recall.session_turns turns
          where turns.session_key = linked.session_key
            and turns.started_at is not null
            and turns.ended_at is not null
            and turns.started_at <= events.occurred_at
            and turns.ended_at >= events.occurred_at
          order by turns.turn_index
          limit 1
        ) turn on true
        where $1::text is null or lower(events.skill) = lower($1)
        order by events.occurred_at desc, events.source_path, events.event_index desc
        limit $2
      `,
      [skill, limit],
    );
    return result.rows.map((row) => ({
      agent: row.agent,
      skill: row.skill,
      occurredAt: timeValue(row.occurred_at),
      linkState: row.turn_id ? "linked-turn" : row.session_key ? "linked-session" : "unlinked",
      sessionKey: row.session_key,
      sessionTitle: row.session_key ? row.session_title || null : null,
      projectPath: row.session_key ? row.project_path || null : null,
      turnId: row.turn_id,
    }));
  }

  async getSkillUsageSnapshot(): Promise<SkillUsageSnapshot> {
    const sourceCount = await this.database.query<{ count: number | string }>(
      "select count(*) as count from agent_recall.skill_usage_sources",
    );
    const events = await this.database.query<{
      agent: SkillUsageEvent["agent"];
      skill: string;
      occurred_at: Date | string;
    }>(
      `
        select agent, skill, occurred_at
        from agent_recall.skill_usage_events
        order by source_path, event_index
      `,
    );
    const hydrated = events.rows.map<SkillUsageEvent>((event) => ({
      agent: event.agent,
      skill: event.skill,
      timestamp: timeValue(event.occurred_at),
    }));
    return skillUsageSnapshotFromEvents(
      hydrated,
      "",
      Number(sourceCount.rows[0]?.count || 0) > 0 || hydrated.length > 0,
    );
  }

  async upsertSkillSyncBinding(binding: SkillSyncBinding): Promise<void> {
    const localSkillPath = binding.localSkillPath.trim();
    const portableIdentity = binding.portableIdentity?.trim() || "";
    const remoteSkillId = binding.remoteSkillId.trim();
    if (!localSkillPath || !remoteSkillId) return;

    await this.database.transaction(async (client) => {
      await client.query(
        `
          delete from agent_recall.skill_sync_bindings
          where remote_skill_id = $1 and local_skill_path <> $2
        `,
        [remoteSkillId, localSkillPath],
      );
      if (portableIdentity) {
        await client.query(
          `
            delete from agent_recall.skill_sync_bindings
            where portable_identity = $1 and local_skill_path <> $2
          `,
          [portableIdentity, localSkillPath],
        );
      }
      await client.query(
        `
          insert into agent_recall.skill_sync_bindings (
            local_skill_path, portable_identity, remote_skill_id, remote_updated_at,
            remote_version, last_content_hash, last_synced_at, direction
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          on conflict (local_skill_path) do update set
            portable_identity = excluded.portable_identity,
            remote_skill_id = excluded.remote_skill_id,
            remote_updated_at = excluded.remote_updated_at,
            remote_version = excluded.remote_version,
            last_content_hash = excluded.last_content_hash,
            last_synced_at = excluded.last_synced_at,
            direction = excluded.direction
        `,
        [
          localSkillPath,
          portableIdentity,
          remoteSkillId,
          binding.remoteUpdatedAt,
          Math.max(0, Number(binding.remoteVersion) || 1),
          binding.lastContentHash?.trim() || "",
          new Date(Math.max(0, binding.lastSyncedAt)).toISOString(),
          binding.direction,
        ],
      );
    });
  }

  async getSkillSyncBindingForLocalPath(localSkillPath: string): Promise<SkillSyncBinding | null> {
    return this.getBinding("local_skill_path", localSkillPath);
  }

  async getSkillSyncBindingForPortableIdentity(portableIdentity: string): Promise<SkillSyncBinding | null> {
    return this.getBinding("portable_identity", portableIdentity.trim());
  }

  async getSkillSyncBindingForRemoteId(remoteSkillId: string): Promise<SkillSyncBinding | null> {
    return this.getBinding("remote_skill_id", remoteSkillId);
  }

  async listSkillSyncBindings(): Promise<SkillSyncBinding[]> {
    const result = await this.database.query<SkillSyncBindingRow>(
      `
        select ${BINDING_COLUMNS}
        from agent_recall.skill_sync_bindings
        order by last_synced_at desc, local_skill_path
      `,
    );
    return result.rows.map(bindingFromRow);
  }

  async deleteSkillSyncBindingsForRemoteIds(remoteSkillIds: readonly string[]): Promise<void> {
    const ids = [...new Set(remoteSkillIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return;
    await this.database.query(
      "delete from agent_recall.skill_sync_bindings where remote_skill_id = any($1::text[])",
      [ids],
    );
  }

  private async getBinding(
    column: "local_skill_path" | "portable_identity" | "remote_skill_id",
    value: string,
  ): Promise<SkillSyncBinding | null> {
    if (!value) return null;
    const result = await this.database.query<SkillSyncBindingRow>(
      `
        select ${BINDING_COLUMNS}
        from agent_recall.skill_sync_bindings
        where ${column} = $1
      `,
      [value],
    );
    return result.rows[0] ? bindingFromRow(result.rows[0]) : null;
  }
}
