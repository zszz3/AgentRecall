import {
  skillUsageSnapshotFromEvents,
  type SkillUsageAgent,
  type SkillUsageEvent,
  type SkillUsageSnapshot,
  type SkillUsageSource,
} from "../skill-usage";
import type {
  SkillPerformanceSignals,
  SkillSyncBinding,
  SkillSyncDirection,
  SkillToolOutcome,
  SkillTriggerLink,
  SkillUsageOverviewRow,
  SkillVersionGroup,
} from "../storage/types";
import type { SqliteDatabase } from "./database";
import { optionalTimeMs, timeValue } from "./session-records";

interface SkillSyncBindingRow extends Record<string, unknown> {
  local_skill_path: string;
  portable_identity: string;
  remote_skill_id: string;
  remote_updated_at: number | string;
  remote_version: number | string;
  last_content_hash: string;
  last_synced_at: number | string;
  direction: SkillSyncDirection;
}

function isoValue(value: number | string): string {
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

/** Exact linear-interpolated median matching PostgreSQL `percentile_cont(0.5)`. */
function percentileCont05(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

const BINDING_COLUMNS = `
  local_skill_path, portable_identity, remote_skill_id, remote_updated_at,
  remote_version, last_content_hash, last_synced_at, direction
`;

export class SqliteSkillRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async isSkillUsageSourceFresh(source: SkillUsageSource): Promise<boolean> {
    const row = this.database.get<{
      mtime_ms: number | string;
      file_size: number | string;
    }>(
      `
        select mtime_ms, file_size
        from skill_usage_sources
        where source_path = ?
      `,
      source.path,
    );
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
    const now = Date.now();
    await this.database.transaction(async (tx) => {
      tx.run(
        `
          insert into skill_usage_sources (
            source_path, agent, kind, mtime_ms, file_size, scanned_at
          )
          values (?, ?, ?, ?, ?, ?)
          on conflict (source_path) do update set
            agent = excluded.agent,
            kind = excluded.kind,
            mtime_ms = excluded.mtime_ms,
            file_size = excluded.file_size,
            scanned_at = excluded.scanned_at
        `,
        source.path,
        source.agent,
        source.kind,
        source.mtimeMs,
        source.fileSize,
        now,
      );
      tx.run("delete from skill_usage_events where source_path = ?", source.path);
      let eventIndex = 0;
      for (const event of events) {
        const skill = event.skill.trim();
        if (!skill) continue;
        tx.run(
          `
            insert into skill_usage_events (
              source_path, event_index, agent, skill, occurred_at, session_id, cwd, skill_hash
            )
            values (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          source.path,
          eventIndex,
          event.agent,
          skill,
          Math.max(0, Math.trunc(event.timestamp)),
          event.sessionId?.trim() || null,
          event.cwd?.trim() || null,
          event.skillHash?.trim() || null,
        );
        eventIndex += 1;
      }
    });
  }

  async pruneSkillUsageSources(activePaths: readonly string[]): Promise<void> {
    const active = [...new Set(activePaths)];
    if (active.length === 0) {
      this.database.run("delete from skill_usage_sources");
      return;
    }
    this.database.run(
      "delete from skill_usage_sources where source_path not in (select value from json_each(?))",
      JSON.stringify(active),
    );
  }

  async listRecentSkillTriggers(
    options: { skill?: string; limit?: number } = {},
  ): Promise<SkillTriggerLink[]> {
    const skill = options.skill?.trim() || null;
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
    const rows = this.database.all<{
      agent: SkillUsageAgent;
      skill: string;
      occurred_at: number | string;
      session_key: string | null;
      session_title: string | null;
      project_path: string | null;
      turn_id: string | null;
    }>(
      `
        with resolved_events as (
          select
            events.agent,
            events.skill,
            events.occurred_at,
            events.source_path,
            events.event_index,
            (
              select sessions.session_key
              from local_sessions sessions
              where
                (
                  events.session_id is not null
                  and sessions.raw_id = events.session_id
                  and sessions.source in ('claude-cli', 'claude-app', 'codex-cli', 'codex-app')
                  and sessions.storage_environment_id = 'local'
                )
                or sessions.file_path = events.source_path
              order by sessions.file_mtime_ms desc
              limit 1
            ) as linked_session_key
          from skill_usage_events events
          where ? is null or lower(events.skill) = lower(?)
          order by events.occurred_at desc, events.source_path, events.event_index desc
          limit ?
        )
        select
          resolved_events.agent,
          resolved_events.skill,
          resolved_events.occurred_at,
          sessions.session_key,
          coalesce(
            nullif(sessions.custom_title, ''),
            nullif(sessions.original_title, ''),
            sessions.first_question
          ) as session_title,
          sessions.project_path,
          (
            select turns.id
            from session_turns turns
            where turns.session_key = sessions.session_key
              and turns.started_at is not null
              and turns.ended_at is not null
              and turns.started_at <= resolved_events.occurred_at
              and turns.ended_at >= resolved_events.occurred_at
            order by turns.turn_index
            limit 1
          ) as turn_id
        from resolved_events
        left join local_sessions sessions on sessions.session_key = resolved_events.linked_session_key
        order by resolved_events.occurred_at desc, resolved_events.source_path, resolved_events.event_index desc
      `,
      skill,
      skill,
      limit,
    );
    return rows.map((row) => ({
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

  async listSkillTriggersForSession(sessionKey: string): Promise<string[]> {
    const rows = this.database.all<{ skill: string }>(
      `
        select distinct events.skill
        from skill_usage_events events
        join local_sessions sessions
          on (
            events.session_id is not null
            and sessions.raw_id = events.session_id
            and sessions.storage_environment_id = 'local'
          )
          or sessions.file_path = events.source_path
        where sessions.session_key = ?
        order by events.skill
      `,
      sessionKey,
    );
    return rows.map((row) => row.skill);
  }

  async listSkillUsageOverview(): Promise<SkillUsageOverviewRow[]> {
    const now = Date.now();
    const cutoff7d = now - 7 * 86_400_000;
    const cutoff30d = now - 30 * 86_400_000;
    const rows = this.database.all<{
      agent: SkillUsageAgent;
      skill: string;
      total_triggers: number | string;
      triggers_7d: number | string;
      triggers_30d: number | string;
      last_triggered_at: number | string;
      linked_triggers: number | string;
    }>(
      `
        select
          json_extract(json_group_array(events.agent order by events.occurred_at desc), '$[0]') as agent,
          json_extract(json_group_array(events.skill order by events.occurred_at desc), '$[0]') as skill,
          count(*) as total_triggers,
          count(*) filter (where events.occurred_at >= ?) as triggers_7d,
          count(*) filter (where events.occurred_at >= ?) as triggers_30d,
          max(events.occurred_at) as last_triggered_at,
          count(*) filter (
            where exists (
              select 1
              from local_sessions sessions
              where
                (
                  events.session_id is not null
                  and sessions.raw_id = events.session_id
                  and sessions.source in ('claude-cli', 'claude-app')
                  and sessions.storage_environment_id = 'local'
                )
                or sessions.file_path = events.source_path
            )
          ) as linked_triggers
        from skill_usage_events events
        group by lower(events.skill)
        order by max(events.occurred_at) desc
      `,
      cutoff7d,
      cutoff30d,
    );
    return rows.map((row) => ({
      agent: row.agent,
      skill: row.skill,
      totalTriggers: Number(row.total_triggers),
      triggers7d: Number(row.triggers_7d),
      triggers30d: Number(row.triggers_30d),
      lastTriggeredAt: timeValue(row.last_triggered_at),
      linkedTriggers: Number(row.linked_triggers),
    }));
  }

  async getSkillPerformanceSignals(skill: string): Promise<SkillPerformanceSignals> {
    const sampleTurns = this.database.all<{
      total_tokens: number;
      error_count: number;
      duration_ms: number | null;
    }>(
      `
        with matched_events as (
          select
            events.occurred_at,
            (
              select sessions.session_key
              from local_sessions sessions
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
            ) as linked_session_key
          from skill_usage_events events
          where lower(events.skill) = lower(?)
        ),
        matched_turn_ids as (
          select
            (
              select turns.id
              from session_turns turns
              where turns.session_key = matched_events.linked_session_key
                and turns.started_at is not null
                and turns.ended_at is not null
                and turns.started_at <= matched_events.occurred_at
                and turns.ended_at >= matched_events.occurred_at
              order by turns.turn_index
              limit 1
            ) as turn_id
          from matched_events
          where matched_events.linked_session_key is not null
        )
        select
          turns.total_tokens,
          turns.error_count,
          (turns.ended_at - turns.started_at) as duration_ms
        from matched_turn_ids
        join session_turns turns on turns.id = matched_turn_ids.turn_id
      `,
      skill,
    );

    const baselineTurns = this.database.all<{
      total_tokens: number;
      error_count: number;
      duration_ms: number | null;
    }>(
      `
        select
          turns.total_tokens,
          turns.error_count,
          case
            when turns.started_at is not null and turns.ended_at is not null
            then (turns.ended_at - turns.started_at)
            else null
          end as duration_ms
        from session_turns turns
        where turns.synthetic = 0
      `,
    );

    const sampleTokens = sampleTurns.map((row) => Number(row.total_tokens));
    const sampleDurations = sampleTurns
      .map((row) => (row.duration_ms === null ? null : Number(row.duration_ms)))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const sampleErrorRatio = sampleTurns.length === 0
      ? null
      : sampleTurns.filter((row) => Number(row.error_count) > 0).length / sampleTurns.length;

    const baselineTokens = baselineTurns.map((row) => Number(row.total_tokens));
    const baselineDurations = baselineTurns
      .map((row) => (row.duration_ms === null ? null : Number(row.duration_ms)))
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const baselineErrorRatio = baselineTurns.length === 0
      ? null
      : baselineTurns.filter((row) => Number(row.error_count) > 0).length / baselineTurns.length;

    return {
      sampleSize: sampleTurns.length,
      medianTotalTokens: percentileCont05(sampleTokens),
      medianDurationMs: percentileCont05(sampleDurations),
      errorTurnRatio: sampleErrorRatio,
      baselineTurnCount: baselineTurns.length,
      baselineMedianTotalTokens: percentileCont05(baselineTokens),
      baselineMedianDurationMs: percentileCont05(baselineDurations),
      baselineErrorTurnRatio: baselineErrorRatio,
    };
  }

  async listSkillVersionGroups(skill: string): Promise<SkillVersionGroup[]> {
    const rows = this.database.all<{
      skill_hash: string | null;
      trigger_count: number | string;
      first_triggered_at: number | string;
      last_triggered_at: number | string;
    }>(
      `
        select
          skill_hash,
          count(*) as trigger_count,
          min(occurred_at) as first_triggered_at,
          max(occurred_at) as last_triggered_at
        from skill_usage_events
        where lower(skill) = lower(?)
        group by skill_hash
        order by max(occurred_at) desc
      `,
      skill,
    );
    return rows.map((row) => ({
      skillHash: row.skill_hash || null,
      triggerCount: Number(row.trigger_count),
      firstTriggeredAt: timeValue(row.first_triggered_at),
      lastTriggeredAt: timeValue(row.last_triggered_at),
    }));
  }

  async listSkillToolOutcomes(skill: string): Promise<SkillToolOutcome[]> {
    const rows = this.database.all<{
      tool_name: string;
      span_id: string;
      span_status: string;
      span_error: string | null;
    }>(
      `
        with matched_events as (
          select
            events.occurred_at,
            (
              select sessions.session_key
              from local_sessions sessions
              where
                (
                  events.session_id is not null
                  and sessions.raw_id = events.session_id
                  and sessions.source in ('claude-cli', 'claude-app', 'codex-cli', 'codex-app')
                  and sessions.storage_environment_id = 'local'
                )
                or sessions.file_path = events.source_path
              order by sessions.file_mtime_ms desc
              limit 1
            ) as linked_session_key
          from skill_usage_events events
          where lower(events.skill) = lower(?)
        ),
        matched_turn_ids as (
          select
            (
              select turns.id
              from session_turns turns
              where turns.session_key = matched_events.linked_session_key
                and turns.started_at is not null
                and turns.ended_at is not null
                and turns.started_at <= matched_events.occurred_at
                and turns.ended_at >= matched_events.occurred_at
              order by turns.turn_index
              limit 1
            ) as turn_id
          from matched_events
          where matched_events.linked_session_key is not null
        )
        select
          coalesce(
            nullif(json_extract(spans.attributes, '$.tool.canonicalName'), ''),
            spans.name
          ) as tool_name,
          spans.id as span_id,
          spans.status as span_status,
          spans.error as span_error
        from matched_turn_ids
        join trace_spans spans
          on spans.turn_id = matched_turn_ids.turn_id
          and spans.kind = 'tool'
          and spans.status in ('completed', 'failed')
          and coalesce(
            nullif(json_extract(spans.attributes, '$.tool.executionEvidence'), ''),
            'legacy'
          ) <> 'static-only'
      `,
      skill,
    );

    const byTool = new Map<string, {
      callCount: number;
      failureCount: number;
      failedSpanIds: string[];
      failedErrors: Set<string>;
    }>();
    for (const row of rows) {
      const entry = byTool.get(row.tool_name) ?? {
        callCount: 0,
        failureCount: 0,
        failedSpanIds: [],
        failedErrors: new Set<string>(),
      };
      entry.callCount += 1;
      if (row.span_status === "failed") {
        entry.failureCount += 1;
        entry.failedSpanIds.push(row.span_id);
        if (row.span_error !== null) {
          entry.failedErrors.add(row.span_error.slice(0, 200));
        }
      }
      byTool.set(row.tool_name, entry);
    }

    return [...byTool.entries()]
      .map<SkillToolOutcome>(([toolName, entry]) => ({
        toolName,
        callCount: entry.callCount,
        failureCount: entry.failureCount,
        sampleSpanIds: entry.failedSpanIds.sort().slice(0, 5),
        sampleErrors: [...entry.failedErrors].sort().slice(0, 3),
      }))
      .sort((left, right) =>
        right.failureCount - left.failureCount
        || right.callCount - left.callCount
        || (left.toolName < right.toolName ? -1 : left.toolName > right.toolName ? 1 : 0));
  }

  async hasClaudeHookUsageEvents(): Promise<boolean> {
    const row = this.database.get<{ found: number }>(
      `
        select exists(
          select 1
          from skill_usage_events events
          join skill_usage_sources sources
            on sources.source_path = events.source_path
          where sources.kind = 'claude-session'
            and events.agent = 'claude'
            and events.skill_hash is not null
        ) as found
      `,
    );
    return Boolean(row?.found);
  }

  async getSkillUsageSnapshot(): Promise<SkillUsageSnapshot> {
    const sourceCountRow = this.database.get<{ count: number }>(
      "select count(*) as count from skill_usage_sources",
    );
    const events = this.database.all<{
      agent: SkillUsageEvent["agent"];
      skill: string;
      occurred_at: number | string;
    }>(
      `
        select agent, skill, occurred_at
        from skill_usage_events
        order by source_path, event_index
      `,
    );
    const hydrated = events.map<SkillUsageEvent>((event) => ({
      agent: event.agent,
      skill: event.skill,
      timestamp: timeValue(event.occurred_at),
    }));
    return skillUsageSnapshotFromEvents(
      hydrated,
      "",
      Number(sourceCountRow?.count || 0) > 0 || hydrated.length > 0,
    );
  }

  async upsertSkillSyncBinding(binding: SkillSyncBinding): Promise<void> {
    const localSkillPath = binding.localSkillPath.trim();
    const portableIdentity = binding.portableIdentity?.trim() || "";
    const remoteSkillId = binding.remoteSkillId.trim();
    if (!localSkillPath || !remoteSkillId) return;

    await this.database.transaction(async (tx) => {
      tx.run(
        `
          delete from skill_sync_bindings
          where remote_skill_id = ? and local_skill_path <> ?
        `,
        remoteSkillId,
        localSkillPath,
      );
      if (portableIdentity) {
        tx.run(
          `
            delete from skill_sync_bindings
            where portable_identity = ? and local_skill_path <> ?
          `,
          portableIdentity,
          localSkillPath,
        );
      }
      tx.run(
        `
          insert into skill_sync_bindings (
            local_skill_path, portable_identity, remote_skill_id, remote_updated_at,
            remote_version, last_content_hash, last_synced_at, direction
          )
          values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (local_skill_path) do update set
            portable_identity = excluded.portable_identity,
            remote_skill_id = excluded.remote_skill_id,
            remote_updated_at = excluded.remote_updated_at,
            remote_version = excluded.remote_version,
            last_content_hash = excluded.last_content_hash,
            last_synced_at = excluded.last_synced_at,
            direction = excluded.direction
        `,
        localSkillPath,
        portableIdentity,
        remoteSkillId,
        optionalTimeMs(binding.remoteUpdatedAt) ?? 0,
        Math.max(0, Number(binding.remoteVersion) || 1),
        binding.lastContentHash?.trim() || "",
        Math.max(0, Math.trunc(binding.lastSyncedAt)),
        binding.direction,
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
    const rows = this.database.all<SkillSyncBindingRow>(
      `
        select ${BINDING_COLUMNS}
        from skill_sync_bindings
        order by last_synced_at desc, local_skill_path
      `,
    );
    return rows.map(bindingFromRow);
  }

  async deleteSkillSyncBindingsForRemoteIds(remoteSkillIds: readonly string[]): Promise<void> {
    const ids = [...new Set(remoteSkillIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return;
    this.database.run(
      "delete from skill_sync_bindings where remote_skill_id in (select value from json_each(?))",
      JSON.stringify(ids),
    );
  }

  private async getBinding(
    column: "local_skill_path" | "portable_identity" | "remote_skill_id",
    value: string,
  ): Promise<SkillSyncBinding | null> {
    if (!value) return null;
    const row = this.database.get<SkillSyncBindingRow>(
      `
        select ${BINDING_COLUMNS}
        from skill_sync_bindings
        where ${column} = ?
      `,
      value,
    );
    return row ? bindingFromRow(row) : null;
  }
}
