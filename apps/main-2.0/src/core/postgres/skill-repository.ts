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

// Aggregated trigger-layer stats per recorded skill (audit side, phase two).
export interface SkillUsageOverviewRow {
  agent: SkillUsageAgent;
  skill: string;
  totalTriggers: number;
  triggers7d: number;
  triggers30d: number;
  lastTriggeredAt: number;
  linkedTriggers: number;
}

// Descriptive turn-level metrics for one skill's linked-turn triggers plus a
// library-wide baseline. Values are facts at Exercised evidence strength; no
// scoring happens here or above.
export interface SkillPerformanceSignals {
  sampleSize: number;
  medianTotalTokens: number | null;
  medianDurationMs: number | null;
  errorTurnRatio: number | null;
  baselineTurnCount: number;
  baselineMedianTotalTokens: number | null;
  baselineMedianDurationMs: number | null;
  baselineErrorTurnRatio: number | null;
}

// Trigger counts sliced by the SKILL.md hash captured at trigger time.
// A null hash groups historical events recorded before hashes existed.
export interface SkillVersionGroup {
  skillHash: string | null;
  triggerCount: number;
  firstTriggeredAt: number;
  lastTriggeredAt: number;
}

// Per-tool call outcomes for one skill's linked-turn triggers (phase three,
// tool-failure-rate rule evidence). Only kind='tool' spans are counted; both
// Claude (tool_use/tool_result) and Codex (function_call/custom_tool_call)
// produce this kind.
export interface SkillToolOutcome {
  toolName: string;
  callCount: number;
  failureCount: number; // status='failed' only, not 'aborted'
  sampleSpanIds: string[]; // first 5 failed span ids
  sampleErrors: string[]; // first 3 distinct error snippets, truncated to 200 chars
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

// Aggregate metrics arrive as numeric strings (or null on empty sets).
function metricValue(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
              source_path, event_index, agent, skill, occurred_at, session_id, cwd, skill_hash
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            source.path,
            eventIndex,
            event.agent,
            skill,
            new Date(Math.max(0, event.timestamp)).toISOString(),
            event.sessionId?.trim() || null,
            event.cwd?.trim() || null,
            event.skillHash?.trim() || null,
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
  // events that captured a session id join on it, and events scanned out of
  // session transcripts fall back to the transcript path itself (the hook log
  // path never matches a session file, so that branch stays inert for hook
  // events). The id route also survives Codex archiving a thread, which moves
  // the file out from under the path route. Records without a hit stay
  // "unlinked" rather than being attributed by time-window guessing.
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
              and sessions.source in ('claude-cli', 'claude-app', 'codex-cli', 'codex-app')
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

  // Trigger-layer stats per skill name (case-insensitive), newest first.
  // "linked" counts events that resolve to an indexed session by either
  // linkage route used in listRecentSkillTriggers.
  async listSkillUsageOverview(): Promise<SkillUsageOverviewRow[]> {
    const result = await this.database.query<{
      agent: SkillUsageAgent;
      skill: string;
      total_triggers: number | string;
      triggers_7d: number | string;
      triggers_30d: number | string;
      last_triggered_at: Date | string;
      linked_triggers: number | string;
    }>(
      `
        select
          (array_agg(events.agent order by events.occurred_at desc))[1] as agent,
          (array_agg(events.skill order by events.occurred_at desc))[1] as skill,
          count(*) as total_triggers,
          count(*) filter (where events.occurred_at >= now() - interval '7 days') as triggers_7d,
          count(*) filter (where events.occurred_at >= now() - interval '30 days') as triggers_30d,
          max(events.occurred_at) as last_triggered_at,
          count(*) filter (where linked.session_key is not null) as linked_triggers
        from agent_recall.skill_usage_events events
        left join lateral (
          select sessions.session_key
          from agent_recall.sessions sessions
          where
            (
              events.session_id is not null
              and sessions.raw_id = events.session_id
              and sessions.source in ('claude-cli', 'claude-app')
              and sessions.storage_environment_id = 'local'
            )
            or sessions.file_path = events.source_path
          limit 1
        ) linked on true
        group by lower(events.skill)
        order by max(events.occurred_at) desc
      `,
    );
    return result.rows.map((row) => ({
      agent: row.agent,
      skill: row.skill,
      totalTriggers: Number(row.total_triggers),
      triggers7d: Number(row.triggers_7d),
      triggers30d: Number(row.triggers_30d),
      lastTriggeredAt: timeValue(row.last_triggered_at),
      linkedTriggers: Number(row.linked_triggers),
    }));
  }

  // Median tokens/duration and error ratio over the skill's linked-turn
  // trigger turns, next to a library-wide baseline over non-synthetic turns.
  // Purely descriptive; evidence strength for the sample is "Exercised".
  async getSkillPerformanceSignals(skill: string): Promise<SkillPerformanceSignals> {
    const sample = await this.database.query<{
      sample_size: number | string;
      median_total_tokens: number | string | null;
      median_duration_ms: number | string | null;
      error_turn_ratio: number | string | null;
    }>(
      `
        select
          count(*) as sample_size,
          percentile_cont(0.5) within group (order by turn.total_tokens) as median_total_tokens,
          percentile_cont(0.5) within group (order by turn.duration_ms) as median_duration_ms,
          avg(case when turn.error_count > 0 then 1.0 else 0.0 end) as error_turn_ratio
        from agent_recall.skill_usage_events events
        join lateral (
          select sessions.session_key
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
        join lateral (
          select
            turns.total_tokens,
            turns.error_count,
            extract(epoch from (turns.ended_at - turns.started_at)) * 1000 as duration_ms
          from agent_recall.session_turns turns
          where turns.session_key = linked.session_key
            and turns.started_at is not null
            and turns.ended_at is not null
            and turns.started_at <= events.occurred_at
            and turns.ended_at >= events.occurred_at
          order by turns.turn_index
          limit 1
        ) turn on true
        where lower(events.skill) = lower($1)
      `,
      [skill],
    );
    const baseline = await this.database.query<{
      baseline_turn_count: number | string;
      baseline_median_total_tokens: number | string | null;
      baseline_median_duration_ms: number | string | null;
      baseline_error_turn_ratio: number | string | null;
    }>(
      `
        select
          count(*) as baseline_turn_count,
          percentile_cont(0.5) within group (order by turns.total_tokens) as baseline_median_total_tokens,
          percentile_cont(0.5) within group (order by extract(epoch from (turns.ended_at - turns.started_at)) * 1000)
            filter (where turns.started_at is not null and turns.ended_at is not null) as baseline_median_duration_ms,
          avg(case when turns.error_count > 0 then 1.0 else 0.0 end) as baseline_error_turn_ratio
        from agent_recall.session_turns turns
        where turns.synthetic = false
      `,
    );
    const sampleRow = sample.rows[0];
    const baselineRow = baseline.rows[0];
    return {
      sampleSize: Number(sampleRow?.sample_size ?? 0),
      medianTotalTokens: metricValue(sampleRow?.median_total_tokens),
      medianDurationMs: metricValue(sampleRow?.median_duration_ms),
      errorTurnRatio: metricValue(sampleRow?.error_turn_ratio),
      baselineTurnCount: Number(baselineRow?.baseline_turn_count ?? 0),
      baselineMedianTotalTokens: metricValue(baselineRow?.baseline_median_total_tokens),
      baselineMedianDurationMs: metricValue(baselineRow?.baseline_median_duration_ms),
      baselineErrorTurnRatio: metricValue(baselineRow?.baseline_error_turn_ratio),
    };
  }

  // Groups a skill's triggers by the SKILL.md hash captured at trigger time.
  // Events recorded before hash capture existed land in the null-hash group.
  async listSkillVersionGroups(skill: string): Promise<SkillVersionGroup[]> {
    const result = await this.database.query<{
      skill_hash: string | null;
      trigger_count: number | string;
      first_triggered_at: Date | string;
      last_triggered_at: Date | string;
    }>(
      `
        select
          skill_hash,
          count(*) as trigger_count,
          min(occurred_at) as first_triggered_at,
          max(occurred_at) as last_triggered_at
        from agent_recall.skill_usage_events
        where lower(skill) = lower($1)
        group by skill_hash
        order by max(occurred_at) desc
      `,
      [skill],
    );
    return result.rows.map((row) => ({
      skillHash: row.skill_hash || null,
      triggerCount: Number(row.trigger_count),
      firstTriggeredAt: timeValue(row.first_triggered_at),
      lastTriggeredAt: timeValue(row.last_triggered_at),
    }));
  }

  // Per-tool call outcomes for one skill's linked-turn triggers. Joins
  // skill_usage_events → sessions (LATERAL, session_id whitelist includes
  // codex) → session_turns (LATERAL time window) → trace_spans (kind='tool').
  // Only terminal, non-static tool evidence participates. status='failed'
  // counts as failure; running, unknown and user-aborted calls stay out.
  async listSkillToolOutcomes(skill: string): Promise<SkillToolOutcome[]> {
    const result = await this.database.query<{
      tool_name: string;
      call_count: number | string;
      failure_count: number | string;
      sample_span_ids: string[] | null;
      sample_errors: string[] | null;
    }>(
      `
        with linked_tool_spans as (
          select
            coalesce(
              nullif(spans.attributes #>> '{tool,canonicalName}', ''),
              spans.name
            ) as tool_name,
            spans.id as span_id,
            spans.status as span_status,
            spans.error as span_error
          from agent_recall.skill_usage_events events
          join lateral (
            select sessions.session_key
            from agent_recall.sessions sessions
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
          ) linked on true
          join lateral (
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
          join agent_recall.trace_spans spans
            on spans.turn_id = turn.turn_id
            and spans.kind = 'tool'
            and spans.status in ('completed', 'failed')
            and coalesce(
              nullif(spans.attributes #>> '{tool,executionEvidence}', ''),
              'legacy'
            ) <> 'static-only'
          where lower(events.skill) = lower($1)
        )
        select
          tool_name,
          count(*) as call_count,
          count(*) filter (where span_status = 'failed') as failure_count,
          array_agg(span_id order by span_id) filter (where span_status = 'failed') as sample_span_ids,
          array_agg(distinct left(span_error, 200) order by left(span_error, 200)) filter (where span_status = 'failed' and span_error is not null) as sample_errors
        from linked_tool_spans
        group by tool_name
        order by failure_count desc, call_count desc, tool_name
      `,
      [skill],
    );
    return result.rows.map((row) => ({
      toolName: row.tool_name,
      callCount: Number(row.call_count),
      failureCount: Number(row.failure_count),
      sampleSpanIds: (row.sample_span_ids ?? []).slice(0, 5),
      sampleErrors: (row.sample_errors ?? []).slice(0, 3),
    }));
  }

  // Observability floor for claude skills: the hook pipeline has demonstrably
  // contributed version data to at least one indexed session event. The hook
  // source no longer emits independent events (its skill_hash is merged into
  // claude-session events at read time), so we check whether any claude session
  // event carries a non-null skill_hash. Until then "no triggers" must be
  // reported as Unobserved rather than never-used.
  async hasClaudeHookUsageEvents(): Promise<boolean> {
    const result = await this.database.query<{ found: boolean }>(
      `
        select exists(
          select 1
          from agent_recall.skill_usage_events events
          join agent_recall.skill_usage_sources sources
            on sources.source_path = events.source_path
          where sources.kind = 'claude-session'
            and events.agent = 'claude'
            and events.skill_hash is not null
        ) as found
      `,
    );
    return Boolean(result.rows[0]?.found);
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
