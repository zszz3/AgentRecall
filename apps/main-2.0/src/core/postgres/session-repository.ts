import type {
  CodexIncrementalState,
  IndexedSession,
  IndexedSessionFileState,
  ProjectQueryOptions,
  ProjectSummary,
  ProjectTagEntry,
  SessionMessage,
  SessionMessageEvent,
  SessionSearchResult,
  SessionSource,
  SessionTraceEvent,
  TagListOptions,
  TokenUsageEvent,
} from "../types";
import { TURN_DERIVATION_VERSION } from "../turns/derive-turns";
import type { SessionBulkDeleteTarget } from "../session-bulk-delete";
import { SESSION_SOURCE_DESCRIPTORS, sessionSourceDescriptor } from "../session-sources";
import {
  materializeSessionAttachment,
  MAX_SESSION_ATTACHMENT_BYTES,
  type MaterializedAttachment,
} from "../session-attachments";
import { codexTaskWorkspaceDate } from "../project-identity";
import {
  deriveSessionTimeline,
  type DerivedRawEvent,
  type DerivedSessionTurn,
} from "../turns/derive-turns";
import type { PostgresDatabase, PostgresQueryable } from "./database";
import {
  SESSION_ACTIVITY_SQL,
  SESSION_SELECT_SQL,
  hydrateSession,
  numberValue,
  postgresJsonValue,
  postgresText,
  timeValue,
  tokenUsageFromEvents,
  type SessionRow,
} from "./session-records";

interface SessionDeletionRelationRow extends Record<string, unknown> {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  environment_id: string;
  is_subagent: boolean;
  parent_session_id: string | null;
}

function collectSessionDeletionPairs(
  rows: readonly SessionDeletionRelationRow[],
  requestedSessionKeys: readonly string[],
  includeOrphanedSubagents: boolean,
): SessionDeletionPair[] {
  const rowsBySessionKey = new Map(rows.map((row) => [row.session_key, row]));
  const rawIdsByScope = new Map<string, Set<string>>();
  const rowsByScopeAndRawId = new Map<string, Map<string, SessionDeletionRelationRow>>();
  const childrenByScopeAndParent = new Map<string, Map<string, SessionDeletionRelationRow[]>>();
  for (const row of rows) {
    const scope = sessionDeletionScope(row);
    const rawIds = rawIdsByScope.get(scope) ?? new Set<string>();
    rawIds.add(row.raw_id);
    rawIdsByScope.set(scope, rawIds);
    const rowsByRawId = rowsByScopeAndRawId.get(scope) ?? new Map<string, SessionDeletionRelationRow>();
    if (!rowsByRawId.has(row.raw_id)) rowsByRawId.set(row.raw_id, row);
    rowsByScopeAndRawId.set(scope, rowsByRawId);
    if (!row.parent_session_id) continue;
    const childrenByParent = childrenByScopeAndParent.get(scope) ?? new Map<string, SessionDeletionRelationRow[]>();
    const children = childrenByParent.get(row.parent_session_id) ?? [];
    children.push(row);
    childrenByParent.set(row.parent_session_id, children);
    childrenByScopeAndParent.set(scope, childrenByParent);
  }

  const orphanGroups = new Map<string, {
    parentSessionId: string;
    rows: SessionDeletionRelationRow[];
  }>();
  const orphanGroupBySessionKey = new Map<string, {
    parentSessionId: string;
    rows: SessionDeletionRelationRow[];
  }>();
  if (includeOrphanedSubagents) {
    const orphanRows = rows
      .filter((row) => row.is_subagent && Boolean(row.parent_session_id))
      .filter((row) => !rawIdsByScope.get(sessionDeletionScope(row))?.has(row.parent_session_id!))
      .sort((left, right) => left.session_key.localeCompare(right.session_key));
    for (const row of orphanRows) {
      const parentSessionId = row.parent_session_id!;
      const groupKey = `${sessionDeletionScope(row)}\0${parentSessionId}`;
      const group = orphanGroups.get(groupKey) ?? { parentSessionId, rows: [] };
      group.rows.push(row);
      orphanGroups.set(groupKey, group);
      orphanGroupBySessionKey.set(row.session_key, group);
    }
  }

  const roots: Array<{
    root: SessionDeletionRelationRow;
    seeds: SessionDeletionRelationRow[];
    orphanedParentSessionId: string | null;
  }> = [];
  const explicitRootKeys = new Set<string>();
  const explicitOrphanGroups = new Set<{ parentSessionId: string; rows: SessionDeletionRelationRow[] }>();
  for (const sessionKey of requestedSessionKeys) {
    const row = rowsBySessionKey.get(sessionKey);
    if (!row || explicitRootKeys.has(row.session_key)) continue;
    explicitRootKeys.add(row.session_key);
    const orphanGroup = orphanGroupBySessionKey.get(row.session_key);
    if (orphanGroup) {
      roots.push({
        root: row,
        seeds: [row, ...orphanGroup.rows.filter((candidate) => candidate.session_key !== row.session_key)],
        orphanedParentSessionId: orphanGroup.parentSessionId,
      });
      explicitOrphanGroups.add(orphanGroup);
    } else {
      roots.push({ root: row, seeds: [row], orphanedParentSessionId: null });
    }
  }
  if (includeOrphanedSubagents) {
    for (const group of [...orphanGroups.values()].sort((left, right) =>
      left.rows[0].session_key.localeCompare(right.rows[0].session_key))) {
      if (explicitOrphanGroups.has(group)) continue;
      const root = group.rows[0];
      roots.push({ root, seeds: [root, ...group.rows.filter((row) => row !== root)], orphanedParentSessionId: group.parentSessionId });
    }
  }

  const result: SessionDeletionPair[] = [];
  for (const { root, seeds, orphanedParentSessionId } of roots) {
    const ancestorRawIds: string[] = [];
    const visitedAncestorIds = new Set<string>();
    let ancestorRawId = root.parent_session_id;
    while (ancestorRawId && !visitedAncestorIds.has(ancestorRawId)) {
      visitedAncestorIds.add(ancestorRawId);
      ancestorRawIds.push(ancestorRawId);
      ancestorRawId = rowsByScopeAndRawId
        .get(sessionDeletionScope(root))
        ?.get(ancestorRawId)
        ?.parent_session_id ?? null;
    }
    const queue = [...seeds];
    const visited = new Set<string>();
    for (let index = 0; index < queue.length; index += 1) {
      const row = queue[index];
      if (visited.has(row.session_key)) continue;
      visited.add(row.session_key);
      result.push({
        cascadeRootSessionKey: root.session_key,
        sessionKey: row.session_key,
        orphanedParentSessionId,
        ancestorRawIds,
      });
      const children = childrenByScopeAndParent.get(sessionDeletionScope(row))?.get(row.raw_id) ?? [];
      for (const child of children) queue.push(child);
    }
  }
  return result;
}

function sessionDeletionScope(row: Pick<SessionDeletionRelationRow, "source" | "environment_id">): string {
  return `${sessionSourceDescriptor(row.source).family}\0${row.environment_id}`;
}

interface SessionDeletionPair {
  cascadeRootSessionKey: string;
  sessionKey: string;
  orphanedParentSessionId: string | null;
  ancestorRawIds: string[];
}

async function readSessionDeletionRelations(
  queryable: PostgresQueryable,
  requestedSessionKeys: readonly string[],
  includeOrphanedSubagents: boolean,
): Promise<SessionDeletionRelationRow[]> {
  if (includeOrphanedSubagents) {
    const result = await queryable.query<SessionDeletionRelationRow>(`
      select session_key, raw_id, source, environment_id, is_subagent, parent_session_id
      from agent_recall.sessions
    `);
    return result.rows;
  }
  const requestedResult = await queryable.query<Pick<SessionDeletionRelationRow, "source" | "environment_id">>(`
    select distinct source, environment_id
    from agent_recall.sessions
    where session_key = any($1::text[])
  `, [requestedSessionKeys]);
  const scopePairs = new Map<string, { source: SessionSource; environmentId: string }>();
  for (const requested of requestedResult.rows) {
    for (const source of sessionDeletionFamilySources(requested.source)) {
      const key = `${source}\0${requested.environment_id}`;
      scopePairs.set(key, { source, environmentId: requested.environment_id });
    }
  }
  if (scopePairs.size === 0) return [];
  const scopes = [...scopePairs.values()];
  const result = await queryable.query<SessionDeletionRelationRow>(`
    with requested_scopes(environment_id, source) as (
      select * from unnest($1::text[], $2::text[])
    )
    select sessions.session_key, sessions.raw_id, sessions.source, sessions.environment_id,
      sessions.is_subagent, sessions.parent_session_id
    from agent_recall.sessions sessions
    join requested_scopes
      on requested_scopes.source = sessions.source
      and requested_scopes.environment_id = sessions.environment_id
  `, [scopes.map((scope) => scope.environmentId), scopes.map((scope) => scope.source)]);
  return result.rows;
}

function sessionDeletionFamilySources(source: SessionSource): SessionSource[] {
  const family = sessionSourceDescriptor(source).family;
  return SESSION_SOURCE_DESCRIPTORS
    .filter((descriptor) => descriptor.family === family)
    .map((descriptor) => descriptor.id);
}

function branchTagName(branch: string | null | undefined): string | null {
  const normalized = branch?.trim();
  return normalized ? `branch:${normalized}` : null;
}

function projectParts(projectPath: string): string[] {
  return projectPath.split(/[\\/]+/u).filter(Boolean);
}

function projectBasename(projectPath: string): string {
  return projectParts(projectPath).at(-1) || projectPath;
}

function projectParentLabel(projectPath: string): string {
  const parts = projectParts(projectPath);
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : projectBasename(projectPath);
}

type ProjectSummaryDraft = ProjectSummary & {
  taskWorkspaceDate: string | null;
  rootStartedAt: number;
  taskBasenameApplied: boolean;
};

function rootProjectTitle(row: {
  root_custom_title: string | null;
  root_original_title: string | null;
  root_first_question: string | null;
}): string | null {
  const customTitle = row.root_custom_title?.trim();
  if (customTitle) return customTitle;
  const originalTitle = row.root_original_title?.trim();
  if (originalTitle && originalTitle !== "Untitled Session") return originalTitle;
  return row.root_first_question?.trim() || null;
}

function appendLabelSuffix(current: string | null, next: string | null): string | null {
  if (!next) return current;
  return current ? `${current} · ${next}` : next;
}

function formatMonthDayTime(timestamp: number | null): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatClock(timestamp: number): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function compareProjectText(left: string, right: string): number {
  const localized = left.localeCompare(right);
  if (localized !== 0 || left === right) return localized;
  return left < right ? -1 : 1;
}

function visibleTaskLabelVariants(summary: ProjectSummaryDraft): string[] {
  const suffix = summary.labelSuffix ? ` · ${summary.labelSuffix}` : "";
  const bases = summary.labelKind === "codex-task-untitled"
    ? ["Untitled session", "未命名会话"]
    : [summary.label];
  return bases.map((base) => `${base}${suffix}`);
}

function compareTaskIdentity(
  left: ProjectSummaryDraft,
  right: ProjectSummaryDraft,
): number {
  return compareProjectText(left.environmentId, right.environmentId)
    || compareProjectText(left.path, right.path);
}

function visibleTaskCollisionGroups(
  summaries: ProjectSummaryDraft[],
): ProjectSummaryDraft[][] {
  const parents = new Map<ProjectSummaryDraft, ProjectSummaryDraft>();
  const collided = new Set<ProjectSummaryDraft>();
  const owners = new Map<string, ProjectSummaryDraft>();
  const findRoot = (summary: ProjectSummaryDraft): ProjectSummaryDraft => {
    const parent = parents.get(summary) ?? summary;
    if (parent === summary) return summary;
    const root = findRoot(parent);
    parents.set(summary, root);
    return root;
  };
  const union = (left: ProjectSummaryDraft, right: ProjectSummaryDraft): void => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
  };

  for (const summary of summaries) {
    if (!summary.labelKind.startsWith("codex-task")) continue;
    parents.set(summary, summary);
    for (const visibleLabel of visibleTaskLabelVariants(summary)) {
      const key = `${summary.environmentId}\0${visibleLabel}`;
      const owner = owners.get(key);
      if (owner) {
        union(owner, summary);
        collided.add(owner);
        collided.add(summary);
      } else {
        owners.set(key, summary);
      }
    }
  }

  const groupsByRoot = new Map<ProjectSummaryDraft, ProjectSummaryDraft[]>();
  for (const summary of collided) {
    const root = findRoot(summary);
    const group = groupsByRoot.get(root) ?? [];
    group.push(summary);
    groupsByRoot.set(root, group);
  }
  const groups = [...groupsByRoot.values()];
  for (const group of groups) group.sort(compareTaskIdentity);
  return groups.sort((left, right) => compareTaskIdentity(left[0], right[0]));
}

function stableTaskIdentityDiscriminator(summary: ProjectSummaryDraft): string {
  const identity = `${summary.environmentId}\0${summary.path}`;
  let encoded = "";
  for (let index = 0; index < identity.length; index += 1) {
    encoded += identity.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return `id:${encoded}`;
}

function disambiguateTaskLabels(
  summaries: ProjectSummaryDraft[],
): ProjectSummaryDraft[] {
  const titleGroups = new Map<string, ProjectSummaryDraft[]>();
  for (const summary of summaries) {
    if (summary.labelKind !== "codex-task-title") continue;
    const key = `${summary.environmentId}\0${summary.label.trim().toLocaleLowerCase()}`;
    const group = titleGroups.get(key) ?? [];
    group.push(summary);
    titleGroups.set(key, group);
  }

  const resolved = summaries.map((summary) => ({ ...summary }));
  const byIdentity = new Map(
    resolved.map((summary) => [`${summary.environmentId}\0${summary.path}`, summary]),
  );
  for (const group of titleGroups.values()) {
    if (group.length < 2) continue;
    const dateCounts = new Map<string, number>();
    for (const summary of group) {
      const date = summary.taskWorkspaceDate || "";
      dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
    }
    for (const summary of group) {
      const target = byIdentity.get(`${summary.environmentId}\0${summary.path}`)!;
      const date = summary.taskWorkspaceDate;
      const clock = formatClock(summary.rootStartedAt);
      const suffix = date
        ? (dateCounts.get(date) ?? 0) > 1 && clock
          ? `${date.slice(5)} ${clock}`
          : date.slice(5)
        : projectBasename(summary.path);
      target.labelSuffix = appendLabelSuffix(target.labelSuffix, suffix);
    }
  }

  for (const group of visibleTaskCollisionGroups(resolved)) {
    for (const summary of group) {
      if (summary.taskBasenameApplied) continue;
      summary.labelSuffix = appendLabelSuffix(
        summary.labelSuffix,
        projectBasename(summary.path),
      );
      summary.taskBasenameApplied = true;
    }
  }

  for (const group of visibleTaskCollisionGroups(resolved)) {
    const partsBySummary = group.map((summary) => projectParts(summary.path));
    const maxParentDepth = Math.max(...partsBySummary.map((parts) => parts.length - 1));
    let uniqueFragments: string[] | null = null;
    for (let depth = 1; depth <= maxParentDepth; depth += 1) {
      const fragments = partsBySummary.map((parts) => parts.at(-1 - depth) || "");
      if (fragments.every(Boolean) && new Set(fragments).size === group.length) {
        uniqueFragments = fragments;
        break;
      }
    }
    group.forEach((summary, index) => {
      summary.labelSuffix = appendLabelSuffix(
        summary.labelSuffix,
        uniqueFragments?.[index] || summary.path,
      );
    });
  }

  for (const group of visibleTaskCollisionGroups(resolved)) {
    for (const summary of group) {
      summary.labelSuffix = appendLabelSuffix(
        summary.labelSuffix,
        stableTaskIdentityDiscriminator(summary),
      );
    }
  }
  return resolved;
}

function publicProjectSummary(draft: ProjectSummaryDraft): ProjectSummary {
  return {
    path: draft.path,
    label: draft.label,
    labelKind: draft.labelKind,
    labelSuffix: draft.labelSuffix,
    sessionCount: draft.sessionCount,
    environmentId: draft.environmentId,
    environmentLabel: draft.environmentLabel,
    createdAt: draft.createdAt,
    lastActivityAt: draft.lastActivityAt,
  };
}

const INDEX_INSERT_BATCH_SIZE = 1_000;

async function insertRawEvents(
  client: PostgresQueryable,
  sessionKey: string,
  events: readonly DerivedRawEvent[],
): Promise<void> {
  for (let offset = 0; offset < events.length; offset += INDEX_INSERT_BATCH_SIZE) {
    const batch = events.slice(offset, offset + INDEX_INSERT_BATCH_SIZE);
    await client.query(
      `
        insert into agent_recall.session_raw_events (
          session_key, event_index, event_id, kind, role, occurred_at, payload
        )
        select $1, event_index, event_id, kind, role, occurred_at, payload
        from jsonb_to_recordset($2::jsonb) as records(
          event_index integer,
          event_id text,
          kind text,
          role text,
          occurred_at timestamptz,
          payload jsonb
        )
      `,
      [sessionKey, JSON.stringify(batch.map((event) => postgresJsonValue({
        event_index: event.eventIndex,
        event_id: event.eventId,
        kind: event.kind,
        role: event.role,
        occurred_at: event.occurredAt,
        payload: event.payload,
      })))],
    );
  }
}

async function insertTurns(
  client: PostgresQueryable,
  sessionKey: string,
  turns: readonly DerivedSessionTurn[],
): Promise<void> {
  for (let offset = 0; offset < turns.length; offset += INDEX_INSERT_BATCH_SIZE) {
    const batch = turns.slice(offset, offset + INDEX_INSERT_BATCH_SIZE);
    await client.query(
      `
        insert into agent_recall.session_turns (
          id, session_key, turn_index, source_message_index, source_turn_id, synthetic, status,
          started_at, ended_at, duration_ms, time_to_first_token_ms, abort_reason,
          user_text, assistant_text, tool_text, search_text,
          input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens,
          total_tokens, error_count, tool_names, derivation_version
        )
        select
          id, $1, turn_index, source_message_index, source_turn_id, synthetic, status,
          started_at, ended_at, duration_ms, time_to_first_token_ms, abort_reason,
          user_text, assistant_text, tool_text, search_text,
          input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens,
          total_tokens, error_count, tool_names, derivation_version
        from jsonb_to_recordset($2::jsonb) as records(
          id text,
          turn_index integer,
          source_message_index integer,
          source_turn_id text,
          synthetic boolean,
          status text,
          started_at timestamptz,
          ended_at timestamptz,
          duration_ms bigint,
          time_to_first_token_ms bigint,
          abort_reason text,
          user_text text,
          assistant_text text,
          tool_text text,
          search_text text,
          input_tokens integer,
          output_tokens integer,
          cached_input_tokens integer,
          cache_creation_input_tokens integer,
          reasoning_output_tokens integer,
          total_tokens integer,
          error_count integer,
          tool_names text[],
          derivation_version integer
        )
      `,
      [sessionKey, JSON.stringify(batch.map((turn) => ({
        id: turn.id,
        turn_index: turn.turnIndex,
        source_message_index: turn.sourceMessageIndex,
        source_turn_id: turn.sourceTurnId,
        synthetic: turn.synthetic,
        status: turn.status,
        started_at: turn.startedAt,
        ended_at: turn.endedAt,
        duration_ms: turn.durationMs,
        time_to_first_token_ms: turn.timeToFirstTokenMs,
        abort_reason: turn.abortReason,
        user_text: turn.userText,
        assistant_text: turn.assistantText,
        tool_text: turn.toolText,
        search_text: turn.searchText,
        input_tokens: turn.inputTokens,
        output_tokens: turn.outputTokens,
        cached_input_tokens: turn.cachedInputTokens,
        cache_creation_input_tokens: turn.cacheCreationInputTokens ?? 0,
        reasoning_output_tokens: turn.reasoningOutputTokens,
        total_tokens: turn.totalTokens,
        error_count: turn.errorCount,
        tool_names: turn.toolNames,
        derivation_version: turn.derivationVersion,
      })))],
    );
  }

  const messages = turns.flatMap((turn) => turn.messages.map((message) => ({
    turn_id: turn.id,
    message_index: message.messageIndex,
    source_message_index: message.sourceMessageIndex,
    role: message.role,
    content: message.content,
    occurred_at: message.occurredAt,
    metadata: message.metadata,
  })));
  for (let offset = 0; offset < messages.length; offset += INDEX_INSERT_BATCH_SIZE) {
    await client.query(
      `
        insert into agent_recall.turn_messages (
          turn_id, message_index, source_message_index, role, content, occurred_at, metadata
        )
        select turn_id, message_index, source_message_index, role, content, occurred_at, metadata
        from jsonb_to_recordset($1::jsonb) as records(
          turn_id text,
          message_index integer,
          source_message_index integer,
          role text,
          content text,
          occurred_at timestamptz,
          metadata jsonb
        )
      `,
      [JSON.stringify(messages.slice(offset, offset + INDEX_INSERT_BATCH_SIZE))],
    );
  }

  const spanParents: Array<{ id: string; parent_span_id: string }> = [];
  const spans = turns.flatMap((turn) => turn.spans.map((span) => {
    if (span.parentSpanId) {
      spanParents.push({ id: span.id, parent_span_id: span.parentSpanId });
    }
    return {
      id: span.id,
      turn_id: turn.id,
      parent_span_id: null,
      span_index: span.spanIndex,
      kind: span.kind,
      name: span.name,
      status: span.status,
      started_at: span.startedAt,
      ended_at: span.endedAt,
      call_id: span.callId,
      input: span.input,
      output: span.output,
      error: span.error,
      attributes: span.attributes,
    };
  }));
  for (let offset = 0; offset < spans.length; offset += INDEX_INSERT_BATCH_SIZE) {
    await client.query(
      `
        insert into agent_recall.trace_spans (
          id, turn_id, parent_span_id, span_index, kind, name, status,
          started_at, ended_at, call_id, input, output, error, attributes
        )
        select
          id, turn_id, parent_span_id, span_index, kind, name, status,
          started_at, ended_at, call_id, input, output, error, attributes
        from jsonb_to_recordset($1::jsonb) as records(
          id text,
          turn_id text,
          parent_span_id text,
          span_index integer,
          kind text,
          name text,
          status text,
          started_at timestamptz,
          ended_at timestamptz,
          call_id text,
          input jsonb,
          output jsonb,
          error text,
          attributes jsonb
        )
      `,
      [JSON.stringify(spans.slice(offset, offset + INDEX_INSERT_BATCH_SIZE))],
    );
  }
  for (let offset = 0; offset < spanParents.length; offset += INDEX_INSERT_BATCH_SIZE) {
    await client.query(
      `
        update agent_recall.trace_spans spans
        set parent_span_id = records.parent_span_id
        from jsonb_to_recordset($1::jsonb) as records(
          id text,
          parent_span_id text
        )
        where spans.id = records.id
      `,
      [JSON.stringify(spanParents.slice(offset, offset + INDEX_INSERT_BATCH_SIZE))],
    );
  }
}

export class PostgresSessionRepository {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly attachmentCacheRoot: string | null = null,
  ) {}

  async upsertIndexedSession(
    session: IndexedSession,
    messages: readonly SessionMessage[],
    tokenEvents: readonly TokenUsageEvent[] = [],
    traceEvents: readonly SessionTraceEvent[] = [],
    codexIncrementalState?: CodexIncrementalState,
  ): Promise<void> {
    let remainingAttachmentBytes = MAX_SESSION_ATTACHMENT_BYTES;
    const attachmentRows: Array<MaterializedAttachment & { messageIndex: number }> = [];
    const persistedMessages = messages.map((message) => {
      const attachments = message.attachments?.map((attachment, attachmentIndex) => {
        const attachmentId = `${message.index}-${attachmentIndex}-${attachment.id}`;
        const materialized = materializeSessionAttachment(attachment, {
          cacheRoot: this.attachmentCacheRoot,
          sessionFilePath: session.filePath,
          attachmentId,
          remainingSessionBytes: remainingAttachmentBytes,
        });
        if (materialized.status === "available") {
          remainingAttachmentBytes = Math.max(
            0,
            remainingAttachmentBytes - (materialized.sizeBytes ?? 0),
          );
        }
        attachmentRows.push(postgresJsonValue({ ...materialized, messageIndex: message.index }));
        const { cachePath: _cachePath, ...publicAttachment } = materialized;
        return publicAttachment;
      });
      return postgresJsonValue({
        ...message,
        content: postgresText(message.content),
        ...(attachments?.length ? { attachments } : {}),
      });
    });
    const persistedTokenEvents = tokenEvents.map((event) => postgresJsonValue({
      ...event,
      dedupeKey: postgresText(event.dedupeKey),
      sourceTurnId: event.sourceTurnId ? postgresText(event.sourceTurnId).trim() || null : null,
    }));
    const persistedTraceEvents = traceEvents.map((event) => postgresJsonValue({
      ...event,
      title: postgresText(event.title),
      detail: postgresText(event.detail),
      ...(event.callId ? { callId: postgresText(event.callId) } : {}),
      ...(event.eventType ? { eventType: postgresText(event.eventType) } : {}),
    }));
    const timeline = deriveSessionTimeline({
      sessionKey: session.sessionKey,
      messages: persistedMessages,
      tokenEvents: persistedTokenEvents,
      traceEvents: persistedTraceEvents,
      codexIncrementalState,
    });
    const tokenUsage = tokenUsageFromEvents(persistedTokenEvents, session.tokenUsage);
    const environmentId = session.environmentId || "local";
    const startedAt = new Date(Math.max(0, numberValue(session.timestamp))).toISOString();

    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into agent_recall.environments (
            id, kind, label, auth_mode, enabled, sync_state, created_at, updated_at
          )
          values ($1, $2, $3, 'none', true, 'idle', now(), now())
          on conflict (id) do nothing
        `,
        [
          environmentId,
          session.environmentKind || (environmentId === "local" ? "local" : "ssh"),
          postgresText(session.environmentLabel || (environmentId === "local" ? "This Mac" : environmentId)),
        ],
      );
      await client.query(
        `
          insert into agent_recall.sessions (
            session_key, raw_id, source, environment_id, storage_environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            pr_url, pr_number, message_count, turn_count, input_tokens, output_tokens,
            cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
            content_indexed_mtime_ms, content_indexed_size, is_subagent, parent_session_id,
            codex_history_mode, codex_tool_call_state
          )
          values (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, now(), $23, $24, $25, $26, $27, $28::jsonb
          )
          on conflict (session_key) do update set
            raw_id = excluded.raw_id,
            source = excluded.source,
            environment_id = excluded.environment_id,
            storage_environment_id = excluded.storage_environment_id,
            project_path = excluded.project_path,
            file_path = excluded.file_path,
            original_title = excluded.original_title,
            first_question = excluded.first_question,
            started_at = excluded.started_at,
            file_mtime_ms = excluded.file_mtime_ms,
            file_size = excluded.file_size,
            pr_url = excluded.pr_url,
            pr_number = excluded.pr_number,
            message_count = excluded.message_count,
            turn_count = excluded.turn_count,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cached_input_tokens = excluded.cached_input_tokens,
            cache_creation_input_tokens = excluded.cache_creation_input_tokens,
            reasoning_output_tokens = excluded.reasoning_output_tokens,
            total_tokens = excluded.total_tokens,
            indexed_at = excluded.indexed_at,
            content_indexed_mtime_ms = excluded.content_indexed_mtime_ms,
            content_indexed_size = excluded.content_indexed_size,
            is_subagent = excluded.is_subagent,
            parent_session_id = excluded.parent_session_id,
            codex_history_mode = excluded.codex_history_mode,
            codex_tool_call_state = excluded.codex_tool_call_state,
            source_available = true
        `,
        [
          session.sessionKey,
          session.rawId,
          session.source,
          environmentId,
          session.storageEnvironmentId || environmentId,
          session.projectPath,
          session.filePath,
          postgresText(session.originalTitle),
          postgresText(session.firstQuestion),
          startedAt,
          session.fileMtimeMs,
          session.fileSize,
          session.prUrl,
          session.prNumber,
          persistedMessages.length,
          timeline.turns.length,
          tokenUsage.inputTokens,
          tokenUsage.outputTokens,
          tokenUsage.cachedInputTokens,
          tokenUsage.cacheCreationInputTokens ?? 0,
          tokenUsage.reasoningOutputTokens,
          tokenUsage.totalTokens,
          session.fileMtimeMs,
          session.fileSize,
          Boolean(session.isSubagent),
          session.parentSessionId ?? null,
          codexIncrementalState?.historyMode ?? null,
          codexIncrementalState?.toolCallState
            ? JSON.stringify(postgresJsonValue(codexIncrementalState.toolCallState))
            : null,
        ],
      );

      await client.query("delete from agent_recall.session_raw_events where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.session_message_events where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.session_attachments where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.session_turns where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.token_events where session_key = $1", [session.sessionKey]);

      await insertRawEvents(client, session.sessionKey, timeline.rawEvents);
      const messageEvents = persistedMessages.map((message) => {
        const occurredAt = Date.parse(message.timestamp);
        return {
          message_index: message.index,
          occurred_at: new Date(Number.isFinite(occurredAt) && occurredAt >= 0 ? occurredAt : 0).toISOString(),
        };
      });
      for (let offset = 0; offset < messageEvents.length; offset += INDEX_INSERT_BATCH_SIZE) {
        await client.query(
          `
            insert into agent_recall.session_message_events (
              session_key, message_index, occurred_at
            )
            select $1, message_index, occurred_at
            from jsonb_to_recordset($2::jsonb) as records(
              message_index integer,
              occurred_at timestamptz
            )
          `,
          [
            session.sessionKey,
            JSON.stringify(messageEvents.slice(offset, offset + INDEX_INSERT_BATCH_SIZE)),
          ],
        );
      }
      await insertTurns(client, session.sessionKey, timeline.turns);
      for (let offset = 0; offset < attachmentRows.length; offset += INDEX_INSERT_BATCH_SIZE) {
        const batch = attachmentRows.slice(offset, offset + INDEX_INSERT_BATCH_SIZE);
        await client.query(
          `
            insert into agent_recall.session_attachments (
              session_key, attachment_id, message_index, file_name, mime_type,
              preview_kind, status, size_bytes, cache_path
            )
            select
              $1, attachment_id, message_index, file_name, mime_type,
              preview_kind, status, size_bytes, cache_path
            from jsonb_to_recordset($2::jsonb) as records(
              attachment_id text,
              message_index integer,
              file_name text,
              mime_type text,
              preview_kind text,
              status text,
              size_bytes bigint,
              cache_path text
            )
          `,
          [
            session.sessionKey,
            JSON.stringify(batch.map((attachment) => ({
              attachment_id: attachment.id,
              message_index: attachment.messageIndex,
              file_name: attachment.fileName,
              mime_type: attachment.mimeType,
              preview_kind: attachment.previewKind,
              status: attachment.status,
              size_bytes: attachment.sizeBytes ?? null,
              cache_path: attachment.cachePath,
            }))),
          ],
        );
      }
      for (let offset = 0; offset < persistedTokenEvents.length; offset += INDEX_INSERT_BATCH_SIZE) {
        const batch = persistedTokenEvents.slice(offset, offset + INDEX_INSERT_BATCH_SIZE);
        await client.query(
          `
            insert into agent_recall.token_events (
              session_key, dedupe_key, occurred_at, input_tokens, output_tokens,
              cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, source_turn_id
            )
            select
              $1, dedupe_key, occurred_at, input_tokens, output_tokens,
              cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, source_turn_id
            from jsonb_to_recordset($2::jsonb) as records(
              dedupe_key text,
              occurred_at timestamptz,
              input_tokens bigint,
              output_tokens bigint,
              cached_input_tokens bigint,
              cache_creation_input_tokens bigint,
              reasoning_output_tokens bigint,
              total_tokens bigint,
              source_turn_id text
            )
          `,
          [
            session.sessionKey,
            JSON.stringify(batch.map((event) => ({
              dedupe_key: event.dedupeKey,
              occurred_at: new Date(Math.max(0, event.timestamp)).toISOString(),
              input_tokens: event.inputTokens,
              output_tokens: event.outputTokens,
              cached_input_tokens: event.cachedInputTokens,
              cache_creation_input_tokens: event.cacheCreationInputTokens ?? 0,
              reasoning_output_tokens: event.reasoningOutputTokens,
              total_tokens: event.totalTokens,
              source_turn_id: event.sourceTurnId ?? null,
            }))),
          ],
        );
      }

      const branchTag = branchTagName(session.gitBranch);
      if (branchTag) await this.addTagWithClient(client, session.sessionKey, branchTag);
    });
  }

  async getAttachmentFile(
    sessionKey: string,
    attachmentId: string,
  ): Promise<(MaterializedAttachment & { cachePath: string }) | null> {
    const result = await this.database.query<{
      attachment_id: string;
      file_name: string;
      mime_type: string;
      preview_kind: MaterializedAttachment["previewKind"];
      status: MaterializedAttachment["status"];
      size_bytes: number | string | null;
      cache_path: string | null;
    }>(
      `
        select
          attachment_id, file_name, mime_type, preview_kind,
          status, size_bytes, cache_path
        from agent_recall.session_attachments
        where session_key = $1 and attachment_id = $2
      `,
      [sessionKey, attachmentId],
    );
    const row = result.rows[0];
    if (!row?.cache_path || row.status !== "available") return null;
    return {
      id: row.attachment_id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      previewKind: row.preview_kind,
      status: row.status,
      ...(row.size_bytes === null ? {} : { sizeBytes: numberValue(row.size_bytes) }),
      cachePath: row.cache_path,
    };
  }

  async upsertIndexedSessionSummary(
    session: IndexedSession,
    messageCount: number,
    tokenEvents?: readonly TokenUsageEvent[],
    messageEvents?: readonly SessionMessageEvent[],
  ): Promise<void> {
    const tokenUsage = tokenUsageFromEvents(tokenEvents ?? [], session.tokenUsage);
    const environmentId = session.environmentId || "local";
    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into agent_recall.environments (
            id, kind, label, auth_mode, enabled, sync_state, created_at, updated_at
          )
          values ($1, $2, $3, 'none', true, 'idle', now(), now())
          on conflict (id) do nothing
        `,
        [
          environmentId,
          session.environmentKind || (environmentId === "local" ? "local" : "ssh"),
          session.environmentLabel || (environmentId === "local" ? "Local" : environmentId),
        ],
      );
      await client.query(
        `
          insert into agent_recall.sessions (
            session_key, raw_id, source, environment_id, storage_environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            pr_url, pr_number, message_count, turn_count, input_tokens, output_tokens,
            cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
            content_indexed_mtime_ms, content_indexed_size, is_subagent, parent_session_id
          )
          values (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12,
            $13, $14, $15, 0, $16, $17,
            $18, $19, $20, $21, now(), 0, 0, $22, $23
          )
          on conflict (session_key) do update set
            raw_id = excluded.raw_id,
            source = excluded.source,
            environment_id = excluded.environment_id,
            storage_environment_id = excluded.storage_environment_id,
            project_path = excluded.project_path,
            file_path = excluded.file_path,
            original_title = excluded.original_title,
            first_question = excluded.first_question,
            started_at = excluded.started_at,
            file_mtime_ms = excluded.file_mtime_ms,
            file_size = excluded.file_size,
            pr_url = excluded.pr_url,
            pr_number = excluded.pr_number,
            message_count = excluded.message_count,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cached_input_tokens = excluded.cached_input_tokens,
            cache_creation_input_tokens = excluded.cache_creation_input_tokens,
            reasoning_output_tokens = excluded.reasoning_output_tokens,
            total_tokens = excluded.total_tokens,
            indexed_at = excluded.indexed_at,
            is_subagent = excluded.is_subagent,
            parent_session_id = excluded.parent_session_id,
            source_available = true
        `,
        [
          session.sessionKey,
          session.rawId,
          session.source,
          environmentId,
          session.storageEnvironmentId || environmentId,
          session.projectPath,
          session.filePath,
          session.originalTitle,
          session.firstQuestion,
          new Date(Math.max(0, session.timestamp)).toISOString(),
          session.fileMtimeMs,
          session.fileSize,
          session.prUrl,
          session.prNumber,
          Math.max(0, Math.floor(messageCount)),
          tokenUsage.inputTokens,
          tokenUsage.outputTokens,
          tokenUsage.cachedInputTokens,
          tokenUsage.cacheCreationInputTokens ?? 0,
          tokenUsage.reasoningOutputTokens,
          tokenUsage.totalTokens,
          Boolean(session.isSubagent),
          session.parentSessionId ?? null,
        ],
      );

      if (tokenEvents !== undefined) {
        await client.query("delete from agent_recall.token_events where session_key = $1", [session.sessionKey]);
        for (const event of tokenEvents) {
          await client.query(
            `
              insert into agent_recall.token_events (
                session_key, dedupe_key, occurred_at, input_tokens, output_tokens,
                cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, source_turn_id
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `,
            [
              session.sessionKey,
              event.dedupeKey,
              new Date(Math.max(0, event.timestamp)).toISOString(),
              event.inputTokens,
              event.outputTokens,
              event.cachedInputTokens,
              event.cacheCreationInputTokens ?? 0,
              event.reasoningOutputTokens,
              event.totalTokens,
              event.sourceTurnId ? postgresText(event.sourceTurnId).trim() || null : null,
            ],
          );
        }
      }
      if (messageEvents !== undefined) {
        await client.query("delete from agent_recall.session_message_events where session_key = $1", [session.sessionKey]);
        for (const event of messageEvents) {
          await client.query(
            `
              insert into agent_recall.session_message_events (
                session_key, message_index, occurred_at
              )
              values ($1, $2, $3)
            `,
            [
              session.sessionKey,
              event.index,
              new Date(Math.max(0, event.timestamp)).toISOString(),
            ],
          );
        }
      }
      const branchTag = branchTagName(session.gitBranch);
      if (branchTag) await this.addTagWithClient(client, session.sessionKey, branchTag);
    });
  }

  async isIndexedSessionFresh(session: IndexedSession): Promise<boolean> {
    if (session.fileMtimeMs <= 0 && session.fileSize <= 0) return false;
    const result = await this.database.query<{
      raw_id: string;
      source: SessionSource;
      environment_id: string;
      project_path: string;
      file_path: string;
      original_title: string;
      first_question: string;
      started_at: Date | string;
      file_mtime_ms: number | string;
      file_size: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
      turn_derivation_current: boolean;
      pr_url: string | null;
      pr_number: number | string | null;
      is_subagent: boolean;
      parent_session_id: string | null;
    }>(
      `
        select
          sessions.raw_id,
          sessions.source,
          sessions.environment_id,
          sessions.project_path,
          sessions.file_path,
          sessions.original_title,
          sessions.first_question,
          sessions.started_at,
          sessions.file_mtime_ms,
          sessions.file_size,
          sessions.content_indexed_mtime_ms,
          sessions.content_indexed_size,
          not exists (
            select 1
            from agent_recall.session_turns turns
            where turns.session_key = sessions.session_key
              and turns.derivation_version < $2
          ) as turn_derivation_current,
          sessions.pr_url,
          sessions.pr_number,
          sessions.is_subagent,
          sessions.parent_session_id
        from agent_recall.sessions sessions
        where sessions.session_key = $1
      `,
      [session.sessionKey, TURN_DERIVATION_VERSION],
    );
    const row = result.rows[0];
    return Boolean(
      row
      && row.raw_id === session.rawId
      && row.source === session.source
      && row.environment_id === (session.environmentId || "local")
      && row.project_path === session.projectPath
      && row.file_path === session.filePath
      && row.original_title === session.originalTitle
      && row.first_question === session.firstQuestion
      && timeValue(row.started_at) === session.timestamp
      && Math.abs(numberValue(row.file_mtime_ms) - session.fileMtimeMs) < 0.001
      && numberValue(row.file_size) === session.fileSize
      && Math.abs(numberValue(row.content_indexed_mtime_ms) - session.fileMtimeMs) < 0.001
      && numberValue(row.content_indexed_size) === session.fileSize
      && Boolean(row.turn_derivation_current)
      && (row.pr_url ?? null) === (session.prUrl ?? null)
      && (row.pr_number === null ? null : numberValue(row.pr_number)) === (session.prNumber ?? null)
      && Boolean(row.is_subagent) === Boolean(session.isSubagent)
      && (row.parent_session_id ?? null) === (session.parentSessionId ?? null),
    );
  }

  async isSessionContentFresh(
    sessionKey: string,
    fileMtimeMs: number,
    fileSize: number,
  ): Promise<boolean> {
    if (fileMtimeMs <= 0 && fileSize <= 0) return false;
    const result = await this.database.query<{
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
    }>(
      `
        select content_indexed_mtime_ms, content_indexed_size
        from agent_recall.sessions
        where session_key = $1
      `,
      [sessionKey],
    );
    const row = result.rows[0];
    return Boolean(
      row
      && Math.abs(numberValue(row.content_indexed_mtime_ms) - fileMtimeMs) < 0.001
      && numberValue(row.content_indexed_size) === fileSize,
    );
  }

  async touchIndexedAtIfMissing(sessionKey: string): Promise<void> {
    await this.database.query(
      `
        update agent_recall.sessions
        set indexed_at = case
              when indexed_at <= to_timestamp(0) then now()
              else indexed_at
            end,
            source_available = true
        where session_key = $1
      `,
      [sessionKey],
    );
  }

  async setSessionSourceAvailable(sessionKey: string, available: boolean): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set source_available = $2 where session_key = $1",
      [sessionKey, available],
    );
  }

  async listIndexedSessionFiles(
    environmentId = "local",
  ): Promise<IndexedSessionFileState[]> {
    const result = await this.database.query<{
      session_key: string;
      source: SessionSource;
      file_path: string;
      file_mtime_ms: number | string;
      file_size: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
      turn_derivation_current: boolean;
      indexed_at: Date | string;
    }>(
      `
        select
          sessions.session_key,
          sessions.source,
          sessions.file_path,
          sessions.file_mtime_ms,
          sessions.file_size,
          sessions.content_indexed_mtime_ms,
          sessions.content_indexed_size,
          not exists (
            select 1
            from agent_recall.session_turns turns
            where turns.session_key = sessions.session_key
              and turns.derivation_version < $2
          ) as turn_derivation_current,
          sessions.indexed_at
        from agent_recall.sessions sessions
        where sessions.environment_id = $1 and sessions.file_path <> ''
        order by sessions.file_path
      `,
      [environmentId, TURN_DERIVATION_VERSION],
    );
    return result.rows.map((row) => ({
      sessionKey: row.session_key,
      source: row.source,
      filePath: row.file_path,
      fileMtimeMs: numberValue(row.file_mtime_ms),
      fileSize: numberValue(row.file_size),
      contentIndexedMtimeMs: numberValue(row.content_indexed_mtime_ms),
      contentIndexedSize: numberValue(row.content_indexed_size),
      turnDerivationCurrent: Boolean(row.turn_derivation_current),
      indexedAt: timeValue(row.indexed_at),
    }));
  }

  async getTokenEvents(sessionKey: string): Promise<TokenUsageEvent[]> {
    const result = await this.database.query<{
      occurred_at: Date | string;
      dedupe_key: string;
      input_tokens: number | string;
      output_tokens: number | string;
      cached_input_tokens: number | string;
      cache_creation_input_tokens: number | string;
      reasoning_output_tokens: number | string;
      total_tokens: number | string;
      source_turn_id: string | null;
    }>(`
      select occurred_at, dedupe_key, input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens,
             reasoning_output_tokens, total_tokens, source_turn_id
      from agent_recall.token_events
      where session_key = $1
      order by occurred_at, dedupe_key
    `, [sessionKey]);
    return result.rows.map((row) => ({
      timestamp: timeValue(row.occurred_at),
      dedupeKey: row.dedupe_key,
      inputTokens: numberValue(row.input_tokens),
      outputTokens: numberValue(row.output_tokens),
      cachedInputTokens: numberValue(row.cached_input_tokens),
      ...(numberValue(row.cache_creation_input_tokens) > 0
        ? { cacheCreationInputTokens: numberValue(row.cache_creation_input_tokens) }
        : {}),
      reasoningOutputTokens: numberValue(row.reasoning_output_tokens),
      totalTokens: numberValue(row.total_tokens),
      sourceTurnId: row.source_turn_id,
    }));
  }

  async setCustomTitle(sessionKey: string, title: string | null): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set custom_title = $2 where session_key = $1",
      [sessionKey, title?.trim() || null],
    );
  }

  async setFavorited(sessionKey: string, favorited: boolean): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set favorited = $2 where session_key = $1",
      [sessionKey, favorited],
    );
  }

  async setHidden(sessionKey: string, hidden: boolean): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set hidden = $2 where session_key = $1",
      [sessionKey, hidden],
    );
  }

  async markOpened(sessionKey: string): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set last_opened_at = now() where session_key = $1",
      [sessionKey],
    );
  }

  async markResumed(sessionKey: string): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set last_resumed_at = now() where session_key = $1",
      [sessionKey],
    );
  }

  async addTag(sessionKey: string, tagName: string): Promise<void> {
    const normalized = tagName.trim();
    if (!normalized) return;
    await this.database.transaction((client) => this.addTagWithClient(client, sessionKey, normalized));
  }

  async removeTag(sessionKey: string, tagName: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `
          delete from agent_recall.session_tags
          where session_key = $1
            and tag_id = (select id from agent_recall.tags where name = $2)
        `,
        [sessionKey, tagName],
      );
      await client.query(
        `
          delete from agent_recall.tags
          where name = $1
            and not exists (
              select 1 from agent_recall.session_tags where session_tags.tag_id = tags.id
            )
        `,
        [tagName],
      );
    });
  }

  async deleteTag(tagName: string): Promise<void> {
    await this.database.query(
      "delete from agent_recall.tags where name = $1",
      [tagName.trim()],
    );
  }

  async listTags(options: TagListOptions = {}): Promise<string[]> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (options.environmentId && options.environmentId !== "all") {
      conditions.push(`sessions.environment_id = ${bind(options.environmentId)}`);
    }
    if (options.projectPath) conditions.push(`sessions.project_path = ${bind(options.projectPath)}`);
    if (options.projectEnvironmentId) {
      conditions.push(`sessions.environment_id = ${bind(options.projectEnvironmentId)}`);
    }
    if (options.excludeSubagents) conditions.push("sessions.is_subagent = false");
    const result = await this.database.query<{ name: string }>(
      `
        select name
        from (
          select distinct tags.name
          from agent_recall.tags
          join agent_recall.session_tags on session_tags.tag_id = tags.id
          join agent_recall.sessions sessions on sessions.session_key = session_tags.session_key
          ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
        ) distinct_tags
        order by lower(name), name
      `,
      values,
    );
    return result.rows.map((row) => row.name);
  }

  async listTagsByProject(
    options: { excludeSubagents?: boolean } = {},
  ): Promise<ProjectTagEntry[]> {
    const result = await this.database.query<{
      environment_id: string;
      project_path: string;
      tag_name: string;
    }>(
      `
        select
          sessions.environment_id,
          sessions.project_path,
          tags.name as tag_name
        from agent_recall.tags
        join agent_recall.session_tags on session_tags.tag_id = tags.id
        join agent_recall.sessions sessions on sessions.session_key = session_tags.session_key
        where trim(sessions.project_path) <> ''
          ${options.excludeSubagents ? "and sessions.is_subagent = false" : ""}
        order by sessions.environment_id, sessions.project_path, lower(tags.name)
      `,
    );
    const entries = new Map<string, ProjectTagEntry>();
    for (const row of result.rows) {
      const key = `${row.environment_id}\0${row.project_path}`;
      const entry = entries.get(key) ?? {
        environmentId: row.environment_id,
        projectPath: row.project_path,
        tags: [],
      };
      if (!entry.tags.includes(row.tag_name)) entry.tags.push(row.tag_name);
      entries.set(key, entry);
    }
    return [...entries.values()];
  }

  async listProjects(options: ProjectQueryOptions = {}): Promise<ProjectSummary[]> {
    const values: unknown[] = [];
    const conditions = ["trim(sessions.project_path) <> ''"];
    if (options.excludeSubagents) conditions.push("sessions.is_subagent = false");
    if (options.environmentId && options.environmentId !== "all") {
      values.push(options.environmentId);
      conditions.push(`sessions.environment_id = $${values.length}`);
    }
    const result = await this.database.query<{
      project_path: string;
      environment_id: string;
      environment_label: string;
      session_count: number | string;
      created_at: Date | string;
      last_activity_at: Date | string;
      root_count: number | string;
      root_source: SessionSource | null;
      root_custom_title: string | null;
      root_original_title: string | null;
      root_first_question: string | null;
      root_started_at: Date | string | null;
    }>(
      `
        select
          sessions.project_path,
          sessions.environment_id,
          environments.label as environment_label,
          count(*) as session_count,
          max(sessions.started_at) as created_at,
          max(${SESSION_ACTIVITY_SQL}) as last_activity_at,
          sum(case when sessions.is_subagent = false then 1 else 0 end) as root_count,
          max(case when sessions.is_subagent = false then sessions.source end) as root_source,
          max(case when sessions.is_subagent = false then sessions.custom_title end) as root_custom_title,
          max(case when sessions.is_subagent = false then sessions.original_title end) as root_original_title,
          max(case when sessions.is_subagent = false then sessions.first_question end) as root_first_question,
          max(
            case when sessions.is_subagent = false then (
              select min(events.occurred_at)
              from agent_recall.session_message_events events
              where events.session_key = sessions.session_key
            ) end
          ) as root_started_at
        from agent_recall.sessions sessions
        join agent_recall.environments environments on environments.id = sessions.environment_id
        where ${conditions.join(" and ")}
        group by sessions.project_path, sessions.environment_id, environments.label
      `,
      values,
    );
    const summaries = result.rows.map<ProjectSummaryDraft>((row) => {
      const taskDate = numberValue(row.root_count) === 1 && row.root_source === "codex-app"
        ? codexTaskWorkspaceDate(row.project_path)
        : null;
      const rootTitle = rootProjectTitle(row);
      const taskWorkspace = taskDate !== null;
      return {
        path: row.project_path,
        label: taskWorkspace ? (rootTitle || "Untitled session") : projectBasename(row.project_path),
        labelKind: taskWorkspace
          ? rootTitle
            ? "codex-task-title"
            : "codex-task-untitled"
          : "path",
        labelSuffix: null,
        sessionCount: numberValue(row.session_count),
        environmentId: row.environment_id,
        environmentLabel: row.environment_label,
        createdAt: timeValue(row.created_at),
        lastActivityAt: timeValue(row.last_activity_at),
        taskWorkspaceDate: taskDate,
        rootStartedAt: row.root_started_at ? timeValue(row.root_started_at) : 0,
        taskBasenameApplied: false,
      };
    });
    const basenameCounts = new Map<string, number>();
    const environmentsByPath = new Map<string, Set<string>>();
    for (const summary of summaries) {
      if (summary.labelKind === "path") {
        const basename = projectBasename(summary.path);
        basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
      }
      const environments = environmentsByPath.get(summary.path) ?? new Set<string>();
      environments.add(summary.environmentId);
      environmentsByPath.set(summary.path, environments);
    }
    return disambiguateTaskLabels(summaries
      .map((summary) => {
        const repeatedAcrossEnvironments =
          (environmentsByPath.get(summary.path)?.size ?? 0) > 1;
        return {
          ...summary,
          label:
            summary.labelKind === "path"
              && !repeatedAcrossEnvironments
              && (basenameCounts.get(projectBasename(summary.path)) ?? 0) > 1
              ? projectParentLabel(summary.path)
              : summary.label,
          labelSuffix: repeatedAcrossEnvironments
            ? appendLabelSuffix(summary.labelSuffix, summary.environmentLabel)
            : summary.labelSuffix,
        };
      })
      .map((summary) => {
        if (summary.labelKind !== "codex-task-untitled") return summary;
        const startedAtSuffix = formatMonthDayTime(summary.rootStartedAt);
        return {
          ...summary,
          labelSuffix: appendLabelSuffix(
            summary.labelSuffix,
            startedAtSuffix || projectBasename(summary.path),
          ),
          taskBasenameApplied: summary.taskBasenameApplied || !startedAtSuffix,
        };
      }))
      .map(publicProjectSummary)
      .sort(
        (left, right) =>
          (left.environmentId === "local" ? 0 : 1) - (right.environmentId === "local" ? 0 : 1)
          || right.lastActivityAt - left.lastActivityAt
          || compareProjectText(left.label, right.label)
          || compareProjectText(left.labelSuffix ?? "", right.labelSuffix ?? "")
          || compareProjectText(left.path, right.path)
          || compareProjectText(left.environmentId, right.environmentId),
      );
  }

  async deleteSessionRecord(sessionKey: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<{ session_key: string }>(
        "select session_key from agent_recall.sessions where session_key = $1",
        [sessionKey],
      );
      if (existing.rows.length === 0) return false;
      await client.query("delete from agent_recall.sessions where session_key = $1", [sessionKey]);
      await client.query(`
        delete from agent_recall.tags
        where not exists (
          select 1 from agent_recall.session_tags where session_tags.tag_id = tags.id
        )
      `);
      return true;
    });
  }

  async getSessionDeletionTargets(
    sessionKeys: readonly string[],
    includeOrphanedSubagents = false,
  ): Promise<SessionBulkDeleteTarget[]> {
    const uniqueKeys = [...new Set(sessionKeys.filter(Boolean))];
    if (uniqueKeys.length === 0 && !includeOrphanedSubagents) return [];
    const relations = await readSessionDeletionRelations(this.database, uniqueKeys, includeOrphanedSubagents);
    const deletionPairs = collectSessionDeletionPairs(
      relations,
      uniqueKeys,
      includeOrphanedSubagents,
    );
    const targetKeys = [...new Set(deletionPairs.map((pair) => pair.sessionKey))];
    if (targetKeys.length === 0) return [];
    const result = await this.database.query<{
      session_key: string;
      raw_id: string;
      source: SessionSource;
      file_path: string;
      is_subagent: boolean;
      parent_session_id: string | null;
      source_available: boolean;
      favorited: boolean;
      last_activity_at: Date | string;
      environment_id: string;
      environment_kind: SessionBulkDeleteTarget["environmentKind"];
    }>(`
      select sessions.session_key, sessions.raw_id, sessions.source, sessions.file_path,
        sessions.is_subagent, sessions.parent_session_id,
        sessions.source_available, sessions.favorited, ${SESSION_ACTIVITY_SQL} as last_activity_at,
        sessions.environment_id, environments.kind as environment_kind
      from agent_recall.sessions sessions
      join agent_recall.environments environments on environments.id = sessions.environment_id
      where sessions.session_key = any($1::text[])
    `, [targetKeys]);
    const byKey = new Map(result.rows.map((row) => [row.session_key, row]));
    return deletionPairs.flatMap((pair) => {
      const row = byKey.get(pair.sessionKey);
      return row ? [{
        cascadeRootSessionKey: pair.cascadeRootSessionKey,
        orphanedParentSessionId: pair.orphanedParentSessionId,
        sessionKey: row.session_key,
        rawId: row.raw_id,
        source: row.source,
        filePath: row.file_path,
        isSubagent: Boolean(row.is_subagent),
        parentSessionId: row.parent_session_id,
        ancestorRawIds: pair.ancestorRawIds,
        sourceAvailable: Boolean(row.source_available),
        favorited: Boolean(row.favorited),
        lastActivityAt: timeValue(row.last_activity_at) ?? 0,
        environmentId: row.environment_id,
        environmentKind: row.environment_kind,
      }] : [];
    });
  }

  async deleteSessionRecords(sessionKeys: readonly string[], expandDescendants = true): Promise<string[]> {
    const uniqueKeys = [...new Set(sessionKeys.filter(Boolean))];
    if (uniqueKeys.length === 0) return [];
    let expandedKeys: string[] = [];
    const deleted = await this.database.transaction(async (client) => {
      if (expandDescendants) {
        const relations = await readSessionDeletionRelations(client, uniqueKeys, false);
        expandedKeys = [...new Set(
          collectSessionDeletionPairs(relations, uniqueKeys, false).map((pair) => pair.sessionKey),
        )];
      } else {
        expandedKeys = uniqueKeys;
      }
      if (expandedKeys.length === 0) return [];
      const result = await client.query<{ session_key: string }>(
        "delete from agent_recall.sessions where session_key = any($1::text[]) returning session_key",
        [expandedKeys],
      );
      await client.query(`
        delete from agent_recall.tags
        where not exists (
          select 1 from agent_recall.session_tags where session_tags.tag_id = tags.id
        )
      `);
      return result.rows.map((row) => row.session_key);
    });
    const deletedSet = new Set(deleted);
    return expandedKeys.filter((sessionKey) => deletedSet.has(sessionKey));
  }

  async migrateSessionKeyPreservingUserState(
    legacyKey: string,
    targetKey: string,
  ): Promise<boolean> {
    if (!legacyKey || !targetKey || legacyKey === targetKey) return false;
    return this.database.transaction(async (client) => {
      const legacyResult = await client.query<{
        custom_title: string | null;
        favorited: boolean;
        hidden: boolean;
        last_opened_at: Date | string | null;
        last_resumed_at: Date | string | null;
        ai_summary: string | null;
        ai_summary_model: string | null;
        ai_summary_at: Date | string | null;
        ai_summary_basis: number | string | null;
        codex_history_mode: string | null;
        codex_tool_call_state: Record<string, unknown> | string | null;
      }>(
        `
          select custom_title, favorited, hidden, last_opened_at, last_resumed_at,
            ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis,
            codex_history_mode, codex_tool_call_state
          from agent_recall.sessions
          where session_key = $1
        `,
        [legacyKey],
      );
      const legacy = legacyResult.rows[0];
      if (!legacy) return false;
      const targetResult = await client.query<{ session_key: string }>(
        "select session_key from agent_recall.sessions where session_key = $1",
        [targetKey],
      );

      if (targetResult.rows.length === 0) {
        await client.query(
          `
            insert into agent_recall.sessions (
              session_key, raw_id, source, environment_id, storage_environment_id, project_path, file_path,
              original_title, first_question, started_at, file_mtime_ms, file_size,
              pr_url, pr_number, custom_title, favorited, hidden,
              last_opened_at, last_resumed_at, message_count, turn_count,
              input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens,
              total_tokens, indexed_at, is_subagent, parent_session_id,
              ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis,
              codex_history_mode, codex_tool_call_state
            )
            select
              $2, raw_id, source, environment_id, storage_environment_id, project_path, file_path,
              original_title, first_question, started_at, file_mtime_ms, file_size,
              pr_url, pr_number, custom_title, favorited, hidden,
              last_opened_at, last_resumed_at, message_count, turn_count,
              input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens,
              total_tokens, indexed_at, is_subagent, parent_session_id,
              ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis,
              codex_history_mode, codex_tool_call_state
            from agent_recall.sessions
            where session_key = $1
          `,
          [legacyKey, targetKey],
        );
        for (const table of [
          "session_raw_events",
          "session_message_events",
          "session_turns",
          "token_events",
          "session_tags",
        ]) {
          await client.query(
            `update agent_recall.${table} set session_key = $2 where session_key = $1`,
            [legacyKey, targetKey],
          );
        }
      } else {
        await client.query(
          `
            update agent_recall.sessions
            set
              custom_title = coalesce(custom_title, $2),
              favorited = favorited or $3,
              hidden = hidden or $4,
              last_opened_at = greatest(last_opened_at, $5),
              last_resumed_at = greatest(last_resumed_at, $6),
              ai_summary = coalesce(ai_summary, $7),
              ai_summary_model = case when ai_summary is null then $8 else ai_summary_model end,
              ai_summary_at = case when ai_summary is null then $9 else ai_summary_at end,
              ai_summary_basis = case when ai_summary is null then $10 else ai_summary_basis end,
              codex_history_mode = coalesce(codex_history_mode, $11),
              codex_tool_call_state = coalesce(codex_tool_call_state, $12::jsonb)
            where session_key = $1
          `,
          [
            targetKey,
            legacy.custom_title,
            legacy.favorited,
            legacy.hidden,
            legacy.last_opened_at,
            legacy.last_resumed_at,
            legacy.ai_summary,
            legacy.ai_summary_model,
            legacy.ai_summary_at,
            legacy.ai_summary_basis,
            legacy.codex_history_mode,
            legacy.codex_tool_call_state === null
              ? null
              : typeof legacy.codex_tool_call_state === "string"
                ? legacy.codex_tool_call_state
                : JSON.stringify(legacy.codex_tool_call_state),
          ],
        );
        await client.query(
          `
            insert into agent_recall.session_tags (session_key, tag_id)
            select $2, tag_id
            from agent_recall.session_tags
            where session_key = $1
            on conflict (session_key, tag_id) do nothing
          `,
          [legacyKey, targetKey],
        );
      }
      await client.query(
        `
          update agent_recall.session_migrations
          set source_session_key = $2
          where source_session_key = $1
        `,
        [legacyKey, targetKey],
      );
      await client.query(
        `
          update agent_recall.session_sync_bindings as legacy_binding
          set local_session_key = $2
          where legacy_binding.local_session_key = $1
            and not exists (
              select 1
              from agent_recall.session_sync_bindings as target_binding
              where target_binding.local_session_key = $2
            )
        `,
        [legacyKey, targetKey],
      );
      await client.query(
        "delete from agent_recall.session_sync_bindings where local_session_key = $1",
        [legacyKey],
      );
      await client.query("delete from agent_recall.sessions where session_key = $1", [legacyKey]);
      return true;
    });
  }

  async listSessionIdentitiesBySource(source: SessionSource): Promise<Array<{
    sessionKey: string;
    rawId: string;
    storageEnvironmentId: string;
  }>> {
    const result = await this.database.query<{
      session_key: string;
      raw_id: string;
      storage_environment_id: string;
    }>(
      `
        select session_key, raw_id, storage_environment_id
        from agent_recall.sessions
        where source = $1
        order by session_key
      `,
      [source],
    );
    return result.rows.map((row) => ({
      sessionKey: row.session_key,
      rawId: row.raw_id,
      storageEnvironmentId: row.storage_environment_id,
    }));
  }

  async listSessionKeysByFilePath(
    environmentId: string,
    filePaths: ReadonlySet<string>,
    sessionKeys: ReadonlySet<string> = new Set(),
  ): Promise<string[]> {
    const result = await this.database.query<{
      session_key: string;
      source: SessionSource;
      file_path: string;
      message_count: number | string;
    }>(
      `
        select session_key, source, file_path, message_count
        from agent_recall.sessions
        where storage_environment_id = $1 and file_path <> ''
      `,
      [environmentId],
    );
    return result.rows
      .filter((row) =>
        !filePaths.has(row.file_path)
        || (
          row.source === "cursor-agent"
          && /(^|[\\/])state\.vscdb$/iu.test(row.file_path)
          && (numberValue(row.message_count) === 0 || !sessionKeys.has(row.session_key))
        ))
      .map((row) => row.session_key);
  }

  async getSession(sessionKey: string): Promise<SessionSearchResult | null> {
    const result = await this.database.query<SessionRow>(
      `
        select ${SESSION_SELECT_SQL}
        from agent_recall.sessions sessions
        join agent_recall.environments environments on environments.id = sessions.environment_id
        where sessions.session_key = $1
      `,
      [sessionKey],
    );
    return result.rows[0] ? hydrateSession(result.rows[0]) : null;
  }

  async findByRawId(rawId: string): Promise<SessionSearchResult | null> {
    const result = await this.database.query<SessionRow>(
      `
        select ${SESSION_SELECT_SQL}
        from agent_recall.sessions sessions
        join agent_recall.environments environments on environments.id = sessions.environment_id
        where sessions.raw_id = $1
        order by sessions.file_mtime_ms desc
        limit 1
      `,
      [rawId],
    );
    return result.rows[0] ? hydrateSession(result.rows[0]) : null;
  }

  async setAiSummary(sessionKey: string, summary: string, model: string): Promise<boolean> {
    const result = await this.database.query<{ file_mtime_ms: number | string }>(
      "select file_mtime_ms from agent_recall.sessions where session_key = $1",
      [sessionKey],
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.database.query(
      `
        update agent_recall.sessions
        set ai_summary = $2,
          ai_summary_model = $3,
          ai_summary_at = now(),
          ai_summary_basis = $4
        where session_key = $1
      `,
      [sessionKey, summary.trim(), model.trim(), numberValue(row.file_mtime_ms)],
    );
    return true;
  }

  async listSessionsNeedingSummary(
    now: number,
    maxAgeMs: number,
    limit: number,
  ): Promise<SessionSearchResult[]> {
    const result = await this.database.query<SessionRow>(
      `
        select ${SESSION_SELECT_SQL}
        from agent_recall.sessions sessions
        join agent_recall.environments environments on environments.id = sessions.environment_id
        where sessions.file_mtime_ms >= $1
          and (
            sessions.ai_summary is null
            or sessions.file_mtime_ms > coalesce(sessions.ai_summary_basis, 0)
          )
        order by sessions.file_mtime_ms desc
        limit $2
      `,
      [now - maxAgeMs, Math.max(0, limit)],
    );
    return result.rows.map((row) => hydrateSession(row));
  }

  async clearSearchIndex(): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query("delete from agent_recall.session_raw_events");
      await client.query("delete from agent_recall.session_message_events");
      await client.query("delete from agent_recall.session_turns");
      await client.query("delete from agent_recall.token_events");
      await client.query(`
        update agent_recall.sessions
        set file_mtime_ms = 0,
          file_size = 0,
          content_indexed_mtime_ms = 0,
          content_indexed_size = 0,
          message_count = 0,
          turn_count = 0,
          input_tokens = 0,
          output_tokens = 0,
          cached_input_tokens = 0,
          cache_creation_input_tokens = 0,
          reasoning_output_tokens = 0,
          total_tokens = 0,
          original_title = '',
          first_question = ''
      `);
    });
  }

  async deleteSessionsBySource(sources: readonly SessionSource[]): Promise<void> {
    if (sources.length === 0) return;
    await this.database.transaction(async (client) => {
      await client.query(
        "delete from agent_recall.sessions where source = any($1::text[])",
        [[...sources]],
      );
      await client.query(`
        delete from agent_recall.tags
        where not exists (
          select 1 from agent_recall.session_tags where session_tags.tag_id = tags.id
        )
      `);
    });
  }

  private async addTagWithClient(
    client: PostgresQueryable,
    sessionKey: string,
    tagName: string,
  ): Promise<void> {
    await client.query(
      "insert into agent_recall.tags (name) values ($1) on conflict (name) do nothing",
      [tagName],
    );
    await client.query(
      `
        insert into agent_recall.session_tags (session_key, tag_id)
        select $1, id from agent_recall.tags where name = $2
        on conflict (session_key, tag_id) do nothing
      `,
      [sessionKey, tagName],
    );
  }

}
