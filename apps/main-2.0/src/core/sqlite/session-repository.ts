import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { isCodexSqliteSession } from "../session-environment";
import type {
  CodexIncrementalState,
  IndexedSession,
  IndexedSessionFileState,
  LoadedSession,
  ProjectQueryOptions,
  ProjectSummary,
  ProjectTagEntry,
  RuntimeInvocationLookup,
  RuntimeInvocationSessionResolution,
  RuntimeInvocationSummary,
  SessionMessage,
  SessionMessageEvent,
  SessionSearchResult,
  SessionSource,
  SessionSourceMetadata,
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
  type DerivedSessionTimeline,
  type DerivedSessionTurn,
} from "../turns/derive-turns";
import type { SqliteDatabase, SqliteQueryable } from "./database";
import {
  SQLITE_RUNTIME_SESSION_BINDING_MATCH_SQL,
  SQLITE_SESSION_ACTIVITY_SQL,
  SQLITE_SESSION_DETAIL_SELECT_SQL,
  SQLITE_SESSION_SELECT_SQL,
  hydrateSqliteSession,
  normalizeProjectPath,
  normalizedProjectPathSql,
  numberValue,
  optionalTimeMs,
  projectPathMatchVariants,
  sanitizeSessionJsonValue,
  sanitizeSessionText,
  sqliteSessionOriginPredicate,
  timeValue,
  tokenUsageFromEvents,
  type SqliteSessionRow,
} from "./session-records";

export type SqliteSessionDatabase = Pick<SqliteDatabase, "all" | "get" | "run" | "transaction">;

interface SessionDeletionRelationRow extends Record<string, unknown> {
  session_key: string;
  raw_id: string;
  source: SessionSource;
  environment_id: string;
  is_subagent: number | boolean;
  parent_session_id: string | null;
}

interface SessionDeletionPair {
  cascadeRootSessionKey: string;
  sessionKey: string;
  orphanedParentSessionId: string | null;
  ancestorRawIds: string[];
}

function sessionDeletionScope(row: Pick<SessionDeletionRelationRow, "source" | "environment_id">): string {
  return `${sessionSourceDescriptor(row.source).family}\0${row.environment_id}`;
}

function sessionDeletionFamilySources(source: SessionSource): SessionSource[] {
  const family = sessionSourceDescriptor(source).family;
  return SESSION_SOURCE_DESCRIPTORS
    .filter((descriptor) => descriptor.family === family)
    .map((descriptor) => descriptor.id);
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
      .filter((row) => Boolean(row.is_subagent) && Boolean(row.parent_session_id))
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

function readSessionDeletionRelations(
  queryable: Pick<SqliteQueryable, "all">,
  requestedSessionKeys: readonly string[],
  includeOrphanedSubagents: boolean,
): SessionDeletionRelationRow[] {
  if (includeOrphanedSubagents) {
    return queryable.all<SessionDeletionRelationRow>(`
      select session_key, raw_id, source, environment_id, is_subagent, parent_session_id
      from local_sessions
    `);
  }
  if (requestedSessionKeys.length === 0) return [];
  const requestedRows = queryable.all<Pick<SessionDeletionRelationRow, "source" | "environment_id">>(
    `
      select distinct source, environment_id
      from local_sessions
      where session_key in (select value from json_each(?))
    `,
    JSON.stringify(requestedSessionKeys),
  );
  const scopePairs = new Map<string, { source: SessionSource; environmentId: string }>();
  for (const requested of requestedRows) {
    for (const source of sessionDeletionFamilySources(requested.source)) {
      const key = `${source}\0${requested.environment_id}`;
      scopePairs.set(key, { source, environmentId: requested.environment_id });
    }
  }
  if (scopePairs.size === 0) return [];
  const scopes = [...scopePairs.values()].map((scope) => [scope.environmentId, scope.source]);
  return queryable.all<SessionDeletionRelationRow>(
    `
      with requested_scopes as (
        select
          json_extract(value, '$[0]') as environment_id,
          json_extract(value, '$[1]') as source
        from json_each(?)
      )
      select sessions.session_key, sessions.raw_id, sessions.source, sessions.environment_id,
        sessions.is_subagent, sessions.parent_session_id
      from local_sessions sessions
      join requested_scopes
        on requested_scopes.source = sessions.source
        and requested_scopes.environment_id = sessions.environment_id
    `,
    JSON.stringify(scopes),
  );
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

function insertRawEvents(
  tx: SqliteQueryable,
  sessionKey: string,
  events: readonly (DerivedRawEvent & { indexFingerprint: string })[],
): void {
  const sql = `
    insert into session_raw_events (
      session_key, event_index, event_id, kind, role, occurred_at, payload, index_fingerprint
    )
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (session_key, event_index) do update set
      event_id = excluded.event_id,
      kind = excluded.kind,
      role = excluded.role,
      occurred_at = excluded.occurred_at,
      payload = excluded.payload,
      index_fingerprint = excluded.index_fingerprint
    where session_raw_events.event_id is not excluded.event_id
      or session_raw_events.kind is not excluded.kind
      or session_raw_events.role is not excluded.role
      or session_raw_events.occurred_at is not excluded.occurred_at
      or session_raw_events.payload is not excluded.payload
      or session_raw_events.index_fingerprint is not excluded.index_fingerprint
  `;
  for (const rawEvent of events) {
    const event = sanitizeSessionJsonValue(rawEvent);
    tx.run(
      sql,
      sessionKey,
      event.eventIndex,
      event.eventId ?? null,
      event.kind,
      event.role ?? null,
      optionalTimeMs(event.occurredAt),
      JSON.stringify(event.payload),
      event.indexFingerprint,
    );
  }
}

function insertTurns(
  tx: SqliteQueryable,
  sessionKey: string,
  turns: readonly (DerivedSessionTurn & { indexFingerprint: string })[],
): void {
  const turnSql = `
    insert into session_turns (
      id, session_key, turn_index, source_message_index, source_turn_id, synthetic, status,
      started_at, ended_at, duration_ms, time_to_first_token_ms, abort_reason,
      user_text, assistant_text, tool_text, search_text,
      input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens,
      total_tokens, error_count, tool_names, derivation_version, index_fingerprint
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const messageSql = `
    insert into turn_messages (
      turn_id, message_index, source_message_index, role, content, occurred_at, metadata
    )
    values (?, ?, ?, ?, ?, ?, ?)
  `;
  const spanSql = `
    insert into trace_spans (
      id, turn_id, parent_span_id, span_index, kind, name, status,
      started_at, ended_at, call_id, input, output, error, attributes
    )
    values (?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const spanParentSql = "update trace_spans set parent_span_id = ? where id = ?";
  const spanParents: Array<{ id: string; parentSpanId: string }> = [];

  for (const turn of turns) {
    tx.run(
      turnSql,
      turn.id,
      sessionKey,
      turn.turnIndex,
      turn.sourceMessageIndex ?? null,
      turn.sourceTurnId ?? null,
      turn.synthetic ? 1 : 0,
      turn.status,
      optionalTimeMs(turn.startedAt),
      optionalTimeMs(turn.endedAt),
      turn.durationMs ?? null,
      turn.timeToFirstTokenMs ?? null,
      turn.abortReason ?? null,
      turn.userText,
      turn.assistantText,
      turn.toolText,
      turn.searchText,
      turn.inputTokens,
      turn.outputTokens,
      turn.cachedInputTokens,
      turn.cacheCreationInputTokens ?? 0,
      turn.reasoningOutputTokens,
      turn.totalTokens,
      turn.errorCount,
      JSON.stringify(turn.toolNames),
      turn.derivationVersion,
      turn.indexFingerprint,
    );
    for (const message of turn.messages) {
      tx.run(
        messageSql,
        turn.id,
        message.messageIndex,
        message.sourceMessageIndex ?? null,
        message.role,
        message.content,
        optionalTimeMs(message.occurredAt),
        JSON.stringify(message.metadata),
      );
    }
    for (const span of turn.spans) {
      if (span.parentSpanId) {
        spanParents.push({ id: span.id, parentSpanId: span.parentSpanId });
      }
      tx.run(
        spanSql,
        span.id,
        turn.id,
        span.spanIndex,
        span.kind,
        span.name,
        span.status,
        optionalTimeMs(span.startedAt),
        optionalTimeMs(span.endedAt),
        span.callId ?? null,
        span.input === null || span.input === undefined ? null : JSON.stringify(span.input),
        span.output === null || span.output === undefined ? null : JSON.stringify(span.output),
        span.error ?? null,
        JSON.stringify(span.attributes),
      );
    }
  }
  for (const link of spanParents) {
    tx.run(spanParentSql, link.parentSpanId, link.id);
  }
}

function ownerReferenceJsonPath(key: string): string {
  return `$."${key.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export class SqliteSessionRepository {
  constructor(
    private readonly database: SqliteSessionDatabase,
    private readonly attachmentCacheRoot: string | null = null,
  ) {}

  async appendIndexedMessages(loaded: LoadedSession): Promise<void> {
    const { session, messageAppend, codexIncrementalState } = loaded;
    if (!messageAppend || !loaded.messages.length) throw new Error("Missing message append checkpoint");
    const messages = loaded.messages.map((message) => sanitizeSessionJsonValue({
      ...message,
      content: sanitizeSessionText(message.content),
    }));
    const timeline = deriveSessionTimeline({ sessionKey: session.sessionKey, messages, codexIncrementalState });
    const turns = timeline.turns.map((turn) => {
      const indexed = { ...turn, turnIndex: turn.turnIndex + messageAppend.turnIndex };
      return { ...indexed, indexFingerprint: createHash("sha256").update(JSON.stringify(indexed)).digest("hex") };
    });
    const events = timeline.rawEvents.map((event) => {
      const indexed = { ...event, eventIndex: event.eventIndex + messageAppend.rawEventIndex };
      return { ...indexed, indexFingerprint: createHash("sha256").update(JSON.stringify(indexed)).digest("hex") };
    });
    const now = Date.now();
    await this.database.transaction(async (tx) => {
      const previous = tx.get<{ content_indexed_size: number | string; content_indexed_mtime_ms: number | string }>(
        "select content_indexed_size, content_indexed_mtime_ms from local_sessions where session_key = ?",
        session.sessionKey,
      );
      if (
        !previous
        || numberValue(previous.content_indexed_size) !== messageAppend.expectedSize
        || numberValue(previous.content_indexed_mtime_ms) !== messageAppend.expectedMtimeMs
      ) {
        throw new Error("Session changed while indexing; retry the update");
      }
      tx.run(
        "delete from session_turns where session_key = ? and turn_index >= ?",
        session.sessionKey,
        messageAppend.turnIndex,
      );
      insertTurns(tx, session.sessionKey, turns);
      insertRawEvents(tx, session.sessionKey, events);
      const messageEventSql = `
        insert into session_message_events (session_key, message_index, occurred_at)
        values (?, ?, ?)
        on conflict (session_key, message_index) do update set
          occurred_at = excluded.occurred_at
        where session_message_events.occurred_at is not excluded.occurred_at
      `;
      for (const message of messages) {
        const occurredAt = Date.parse(message.timestamp);
        tx.run(
          messageEventSql,
          session.sessionKey,
          message.index,
          Number.isFinite(occurredAt) && occurredAt >= 0 ? occurredAt : 0,
        );
      }
      tx.run(
        `
          update sessions set
            file_mtime_ms = ?, file_size = ?, content_indexed_mtime_ms = ?, content_indexed_size = ?,
            message_count = ?, turn_count = ?, original_title = ?, started_at = ?,
            indexed_at = ?, source_available = 1
          where session_key = ? and team_snapshot_key is null
        `,
        session.fileMtimeMs,
        session.fileSize,
        session.fileMtimeMs,
        session.fileSize,
        messages.at(-1)!.index + 1,
        messageAppend.turnIndex + turns.length,
        sanitizeSessionText(session.originalTitle),
        Math.max(0, Math.trunc(numberValue(session.timestamp))),
        now,
        session.sessionKey,
      );
    });
  }

  async upsertIndexedSession(
    session: IndexedSession,
    messages: readonly SessionMessage[],
    tokenEvents: readonly TokenUsageEvent[] = [],
    traceEvents: readonly SessionTraceEvent[] = [],
    codexIncrementalState?: CodexIncrementalState,
    importedTimeline?: DerivedSessionTimeline,
  ): Promise<void> {
    if (!session.sessionKey || session.sessionKey.includes("\0")) {
      throw new Error("Invalid session key: empty or contains NUL byte (0x00).");
    }
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
        attachmentRows.push(sanitizeSessionJsonValue({ ...materialized, messageIndex: message.index }));
        const { cachePath: _cachePath, ...publicAttachment } = materialized;
        return publicAttachment;
      });
      return sanitizeSessionJsonValue({
        ...message,
        content: sanitizeSessionText(message.content),
        ...(attachments?.length ? { attachments } : {}),
      });
    });
    const persistedTokenEvents = tokenEvents.map((event) => sanitizeSessionJsonValue({
      ...event,
      dedupeKey: sanitizeSessionText(event.dedupeKey),
      sourceTurnId: event.sourceTurnId ? sanitizeSessionText(event.sourceTurnId).trim() || null : null,
    }));
    const persistedTraceEvents = traceEvents.map((event) => sanitizeSessionJsonValue({
      ...event,
      title: sanitizeSessionText(event.title),
      detail: sanitizeSessionText(event.detail),
      ...(event.callId ? { callId: sanitizeSessionText(event.callId) } : {}),
      ...(event.eventType ? { eventType: sanitizeSessionText(event.eventType) } : {}),
    }));
    const timeline = importedTimeline ? sanitizeSessionJsonValue(importedTimeline) : deriveSessionTimeline({
      sessionKey: session.sessionKey,
      messages: persistedMessages,
      tokenEvents: persistedTokenEvents,
      traceEvents: persistedTraceEvents,
      codexIncrementalState,
    });
    const tokenUsage = tokenUsageFromEvents(persistedTokenEvents, session.tokenUsage);
    const environmentId = session.environmentId || "local";
    const startedAt = Math.max(0, Math.trunc(numberValue(session.timestamp)));
    const now = Date.now();

    await this.database.transaction(async (tx) => {
      tx.run(
        `
          insert or ignore into environments (
            id, kind, label, auth_mode, enabled, sync_state, created_at, updated_at
          )
          values (?, ?, ?, 'none', 1, 'idle', ?, ?)
        `,
        environmentId,
        session.environmentKind || (environmentId === "local" ? "local" : "ssh"),
        sanitizeSessionText(session.environmentLabel || (environmentId === "local" ? "This Mac" : environmentId)),
        now,
        now,
      );
      tx.run(
        `
          insert into sessions (
            session_key, raw_id, source, environment_id, storage_environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            pr_url, pr_number, message_count, turn_count, input_tokens, output_tokens,
            cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
            content_indexed_mtime_ms, content_indexed_size, is_subagent, parent_session_id,
            codex_history_mode, codex_tool_call_state
          )
          values (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
            source_available = 1
        `,
        session.sessionKey,
        session.rawId,
        session.source,
        environmentId,
        session.storageEnvironmentId || environmentId,
        normalizeProjectPath(session.projectPath),
        session.filePath,
        sanitizeSessionText(session.originalTitle),
        sanitizeSessionText(session.firstQuestion),
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
        now,
        session.fileMtimeMs,
        session.fileSize,
        session.isSubagent ? 1 : 0,
        session.parentSessionId ?? null,
        codexIncrementalState?.historyMode ?? null,
        codexIncrementalState?.toolCallState
          ? JSON.stringify(sanitizeSessionJsonValue(codexIncrementalState.toolCallState))
          : null,
      );

      const previousTurns = tx.all<{ id: string; index_fingerprint: string | null }>(
        "select id, index_fingerprint from session_turns where session_key = ?",
        session.sessionKey,
      );
      const previousFingerprints = new Map(previousTurns.map((turn) => [turn.id, turn.index_fingerprint]));
      const nextTurns = timeline.turns.map((turn) => ({
        ...turn,
        indexFingerprint: createHash("sha256").update(JSON.stringify(turn)).digest("hex"),
      }));
      const changedTurns = nextTurns.filter((turn) => previousFingerprints.get(turn.id) !== turn.indexFingerprint);
      const retainedTurnIds = new Set(nextTurns
        .filter((turn) => previousFingerprints.get(turn.id) === turn.indexFingerprint)
        .map((turn) => turn.id));
      const replacedTurnIds = previousTurns.filter((turn) => !retainedTurnIds.has(turn.id)).map((turn) => turn.id);
      if (replacedTurnIds.length > 0) {
        tx.run(
          "delete from session_turns where session_key = ? and id in (select value from json_each(?))",
          session.sessionKey,
          JSON.stringify(replacedTurnIds),
        );
      }
      tx.run(
        "delete from session_raw_events where session_key = ? and event_index not in (select value from json_each(?))",
        session.sessionKey,
        JSON.stringify(timeline.rawEvents.map((event) => event.eventIndex)),
      );
      tx.run(
        "delete from session_message_events where session_key = ? and message_index not in (select value from json_each(?))",
        session.sessionKey,
        JSON.stringify(persistedMessages.map((message) => message.index)),
      );
      tx.run(
        "delete from session_attachments where session_key = ? and attachment_id not in (select value from json_each(?))",
        session.sessionKey,
        JSON.stringify(attachmentRows.map((attachment) => attachment.id)),
      );
      tx.run(
        "delete from token_events where session_key = ? and dedupe_key not in (select value from json_each(?))",
        session.sessionKey,
        JSON.stringify(persistedTokenEvents.map((event) => event.dedupeKey)),
      );

      const previousEvents = tx.all<{ event_index: number; index_fingerprint: string | null }>(
        "select event_index, index_fingerprint from session_raw_events where session_key = ?",
        session.sessionKey,
      );
      const eventFingerprints = new Map(previousEvents.map((event) => [Number(event.event_index), event.index_fingerprint]));
      const changedEvents = timeline.rawEvents
        .map((event) => ({
          ...event,
          indexFingerprint: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
        }))
        .filter((event) => eventFingerprints.get(event.eventIndex) !== event.indexFingerprint);
      insertRawEvents(tx, session.sessionKey, changedEvents);

      const messageEventSql = `
        insert into session_message_events (session_key, message_index, occurred_at)
        values (?, ?, ?)
        on conflict (session_key, message_index) do update set
          occurred_at = excluded.occurred_at
        where session_message_events.occurred_at is not excluded.occurred_at
      `;
      for (const message of persistedMessages) {
        const occurredAt = Date.parse(message.timestamp);
        tx.run(
          messageEventSql,
          session.sessionKey,
          message.index,
          Number.isFinite(occurredAt) && occurredAt >= 0 ? occurredAt : 0,
        );
      }

      insertTurns(tx, session.sessionKey, changedTurns);

      const attachmentSql = `
        insert into session_attachments (
          session_key, attachment_id, message_index, file_name, mime_type,
          preview_kind, status, size_bytes, cache_path
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (session_key, attachment_id) do update set
          message_index = excluded.message_index,
          file_name = excluded.file_name,
          mime_type = excluded.mime_type,
          preview_kind = excluded.preview_kind,
          status = excluded.status,
          size_bytes = excluded.size_bytes,
          cache_path = excluded.cache_path
        where session_attachments.message_index is not excluded.message_index
          or session_attachments.file_name is not excluded.file_name
          or session_attachments.mime_type is not excluded.mime_type
          or session_attachments.preview_kind is not excluded.preview_kind
          or session_attachments.status is not excluded.status
          or session_attachments.size_bytes is not excluded.size_bytes
          or session_attachments.cache_path is not excluded.cache_path
      `;
      for (const attachment of attachmentRows) {
        tx.run(
          attachmentSql,
          session.sessionKey,
          attachment.id,
          attachment.messageIndex,
          attachment.fileName,
          attachment.mimeType,
          attachment.previewKind,
          attachment.status,
          attachment.sizeBytes ?? null,
          attachment.cachePath,
        );
      }

      const tokenEventSql = `
        insert into token_events (
          session_key, dedupe_key, occurred_at, input_tokens, output_tokens,
          cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, source_turn_id
        )
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (session_key, dedupe_key) do update set
          occurred_at = excluded.occurred_at,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          cache_creation_input_tokens = excluded.cache_creation_input_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          total_tokens = excluded.total_tokens,
          source_turn_id = excluded.source_turn_id
        where token_events.occurred_at is not excluded.occurred_at
          or token_events.input_tokens is not excluded.input_tokens
          or token_events.output_tokens is not excluded.output_tokens
          or token_events.cached_input_tokens is not excluded.cached_input_tokens
          or token_events.cache_creation_input_tokens is not excluded.cache_creation_input_tokens
          or token_events.reasoning_output_tokens is not excluded.reasoning_output_tokens
          or token_events.total_tokens is not excluded.total_tokens
          or token_events.source_turn_id is not excluded.source_turn_id
      `;
      for (const event of persistedTokenEvents) {
        tx.run(
          tokenEventSql,
          session.sessionKey,
          event.dedupeKey,
          Math.max(0, Math.trunc(event.timestamp)),
          event.inputTokens,
          event.outputTokens,
          event.cachedInputTokens,
          event.cacheCreationInputTokens ?? 0,
          event.reasoningOutputTokens,
          event.totalTokens,
          event.sourceTurnId ?? null,
        );
      }

      const branchTag = branchTagName(session.gitBranch);
      if (branchTag) this.addTagWithTx(tx, session.sessionKey, branchTag);
    });
  }

  async getAttachmentFile(
    sessionKey: string,
    attachmentId: string,
  ): Promise<(MaterializedAttachment & { cachePath: string }) | null> {
    const row = this.database.get<{
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
        from session_attachments
        where session_key = ? and attachment_id = ?
      `,
      sessionKey,
      attachmentId,
    );
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
    const now = Date.now();
    await this.database.transaction(async (tx) => {
      tx.run(
        `
          insert or ignore into environments (
            id, kind, label, auth_mode, enabled, sync_state, created_at, updated_at
          )
          values (?, ?, ?, 'none', 1, 'idle', ?, ?)
        `,
        environmentId,
        session.environmentKind || (environmentId === "local" ? "local" : "ssh"),
        session.environmentLabel || (environmentId === "local" ? "Local" : environmentId),
        now,
        now,
      );
      tx.run(
        `
          insert into sessions (
            session_key, raw_id, source, environment_id, storage_environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            pr_url, pr_number, message_count, turn_count, input_tokens, output_tokens,
            cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
            content_indexed_mtime_ms, content_indexed_size, is_subagent, parent_session_id
          )
          values (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, 0, ?, ?,
            ?, ?, ?, ?, ?, 0, 0, ?, ?
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
            source_available = 1
        `,
        session.sessionKey,
        session.rawId,
        session.source,
        environmentId,
        session.storageEnvironmentId || environmentId,
        normalizeProjectPath(session.projectPath),
        session.filePath,
        session.originalTitle,
        session.firstQuestion,
        Math.max(0, Math.trunc(session.timestamp)),
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
        now,
        session.isSubagent ? 1 : 0,
        session.parentSessionId ?? null,
      );

      if (tokenEvents !== undefined) {
        tx.run("delete from token_events where session_key = ?", session.sessionKey);
        for (const event of tokenEvents) {
          tx.run(
            `
              insert into token_events (
                session_key, dedupe_key, occurred_at, input_tokens, output_tokens,
                cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens, total_tokens, source_turn_id
              )
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            session.sessionKey,
            event.dedupeKey,
            Math.max(0, Math.trunc(event.timestamp)),
            event.inputTokens,
            event.outputTokens,
            event.cachedInputTokens,
            event.cacheCreationInputTokens ?? 0,
            event.reasoningOutputTokens,
            event.totalTokens,
            event.sourceTurnId ? sanitizeSessionText(event.sourceTurnId).trim() || null : null,
          );
        }
      }
      if (messageEvents !== undefined) {
        tx.run("delete from session_message_events where session_key = ?", session.sessionKey);
        for (const event of messageEvents) {
          tx.run(
            `
              insert into session_message_events (
                session_key, message_index, occurred_at
              )
              values (?, ?, ?)
            `,
            session.sessionKey,
            event.index,
            Math.max(0, Math.trunc(event.timestamp)),
          );
        }
      }
      const branchTag = branchTagName(session.gitBranch);
      if (branchTag) this.addTagWithTx(tx, session.sessionKey, branchTag);
    });
  }

  async isIndexedSessionFresh(session: IndexedSession): Promise<boolean> {
    if (session.fileMtimeMs <= 0 && session.fileSize <= 0) return false;
    const row = this.database.get<{
      raw_id: string;
      source: SessionSource;
      environment_id: string;
      project_path: string;
      file_path: string;
      original_title: string;
      first_question: string;
      started_at: number | string;
      file_mtime_ms: number | string;
      file_size: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
      turn_derivation_current: number | boolean;
      pr_url: string | null;
      pr_number: number | string | null;
      is_subagent: number | boolean;
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
            from session_turns turns
            where turns.session_key = sessions.session_key
              and turns.derivation_version < ?
          ) as turn_derivation_current,
          sessions.pr_url,
          sessions.pr_number,
          sessions.is_subagent,
          sessions.parent_session_id
        from local_sessions sessions
        where sessions.session_key = ?
      `,
      TURN_DERIVATION_VERSION,
      session.sessionKey,
    );
    return Boolean(
      row
      && row.raw_id === session.rawId
      && row.source === session.source
      && row.environment_id === (session.environmentId || "local")
      && row.project_path === normalizeProjectPath(session.projectPath)
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
    const row = this.database.get<{
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
    }>(
      `
        select content_indexed_mtime_ms, content_indexed_size
        from local_sessions
        where session_key = ?
      `,
      sessionKey,
    );
    return Boolean(
      row
      && Math.abs(numberValue(row.content_indexed_mtime_ms) - fileMtimeMs) < 0.001
      && numberValue(row.content_indexed_size) === fileSize,
    );
  }

  async refreshSessionSourceMetadata(updates: readonly SessionSourceMetadata[]): Promise<void> {
    if (updates.length === 0) return;
    await this.database.transaction(async (tx) => {
      const sql = `
        update sessions
        set
          original_title = coalesce(?, nullif(first_question, ''), 'Untitled Session'),
          started_at = ?
        where file_path = ?
          and raw_id = ?
          and source = ?
          and storage_environment_id = 'local'
          and team_snapshot_key is null
          and (
            original_title is not coalesce(?, nullif(first_question, ''), 'Untitled Session')
            or started_at is not ?
          )
      `;
      for (const metadata of updates) {
        const title = metadata.originalTitle === null ? null : sanitizeSessionText(metadata.originalTitle);
        const startedAt = Math.max(0, Math.trunc(numberValue(metadata.timestamp)));
        tx.run(
          sql,
          title,
          startedAt,
          metadata.filePath,
          metadata.rawId,
          metadata.source,
          title,
          startedAt,
        );
      }
    });
  }

  async touchIndexedAtIfMissing(sessionKey: string): Promise<void> {
    const now = Date.now();
    this.database.run(
      `
        update sessions
        set indexed_at = case
              when indexed_at <= 0 then ?
              else indexed_at
            end,
            source_available = 1
        where session_key = ? and team_snapshot_key is null
      `,
      now,
      sessionKey,
    );
  }

  async setSessionSourceAvailable(sessionKey: string, available: boolean): Promise<void> {
    this.database.run(
      "update sessions set source_available = ? where session_key = ? and team_snapshot_key is null",
      available ? 1 : 0,
      sessionKey,
    );
  }

  async listIndexedSessionFiles(
    environmentId = "local",
  ): Promise<IndexedSessionFileState[]> {
    const rows = this.database.all<{
      session_key: string;
      source: SessionSource;
      file_path: string;
      file_mtime_ms: number | string;
      file_size: number | string;
      content_indexed_mtime_ms: number | string;
      content_indexed_size: number | string;
      turn_derivation_current: number | boolean;
      indexed_at: number | string;
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
            from session_turns turns
            where turns.session_key = sessions.session_key
              and turns.derivation_version < ?
          ) as turn_derivation_current,
          sessions.indexed_at
        from local_sessions sessions
        where sessions.environment_id = ? and sessions.file_path <> ''
        order by sessions.file_path
      `,
      TURN_DERIVATION_VERSION,
      environmentId,
    );
    return rows.map((row) => ({
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
    const rows = this.database.all<{
      occurred_at: number | string;
      dedupe_key: string;
      input_tokens: number | string;
      output_tokens: number | string;
      cached_input_tokens: number | string;
      cache_creation_input_tokens: number | string;
      reasoning_output_tokens: number | string;
      total_tokens: number | string;
      source_turn_id: string | null;
    }>(
      `
        select occurred_at, dedupe_key, input_tokens, output_tokens, cached_input_tokens,
               cache_creation_input_tokens, reasoning_output_tokens, total_tokens, source_turn_id
        from token_events
        where session_key = ?
        order by occurred_at, dedupe_key
      `,
      sessionKey,
    );
    return rows.map((row) => ({
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
    this.database.run(
      "update sessions set custom_title = ? where session_key = ? and team_snapshot_key is null",
      title?.trim() || null,
      sessionKey,
    );
  }

  async setFavorited(sessionKey: string, favorited: boolean): Promise<void> {
    this.database.run(
      "update sessions set favorited = ? where session_key = ? and team_snapshot_key is null",
      favorited ? 1 : 0,
      sessionKey,
    );
  }

  async setHidden(sessionKey: string, hidden: boolean): Promise<void> {
    this.database.run(
      "update sessions set hidden = ? where session_key = ? and team_snapshot_key is null",
      hidden ? 1 : 0,
      sessionKey,
    );
  }

  async markOpened(sessionKey: string): Promise<void> {
    this.database.run(
      "update sessions set last_opened_at = ? where session_key = ? and team_snapshot_key is null",
      Date.now(),
      sessionKey,
    );
  }

  async markResumed(sessionKey: string): Promise<void> {
    this.database.run(
      "update sessions set last_resumed_at = ? where session_key = ? and team_snapshot_key is null",
      Date.now(),
      sessionKey,
    );
  }

  async addTag(sessionKey: string, tagName: string): Promise<void> {
    const normalized = tagName.trim();
    if (!normalized) return;
    await this.database.transaction(async (tx) => {
      this.addTagWithTx(tx, sessionKey, normalized);
    });
  }

  async removeTag(sessionKey: string, tagName: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      tx.run(
        `
          delete from session_tags
          where session_key = ?
            and tag_id = (select id from tags where name = ?)
        `,
        sessionKey,
        tagName,
      );
      tx.run(
        `
          delete from tags
          where name = ?
            and not exists (
              select 1 from session_tags where session_tags.tag_id = tags.id
            )
        `,
        tagName,
      );
    });
  }

  async deleteTag(tagName: string): Promise<void> {
    this.database.run("delete from tags where name = ?", tagName.trim());
  }

  async listTags(options: TagListOptions = {}): Promise<string[]> {
    const values: SQLInputValue[] = [];
    const conditions: string[] = [];
    if (options.environmentId && options.environmentId !== "all") {
      values.push(options.environmentId);
      conditions.push("sessions.environment_id = ?");
    }
    if (options.projectPath) {
      const variants = projectPathMatchVariants(options.projectPath);
      if (variants.length === 1) {
        values.push(variants[0]);
        conditions.push("sessions.project_path = ?");
      } else {
        values.push(JSON.stringify(variants));
        conditions.push("sessions.project_path in (select value from json_each(?))");
      }
    }
    if (options.projectEnvironmentId) {
      values.push(options.projectEnvironmentId);
      conditions.push("sessions.environment_id = ?");
    }
    if (options.excludeSubagents) conditions.push("sessions.is_subagent = 0");
    const rows = this.database.all<{ name: string }>(
      `
        select name
        from (
          select distinct tags.name
          from tags
          join session_tags on session_tags.tag_id = tags.id
          join local_sessions sessions on sessions.session_key = session_tags.session_key
          ${conditions.length > 0 ? `where ${conditions.join(" and ")}` : ""}
        ) distinct_tags
        order by lower(name), name
      `,
      ...values,
    );
    return rows.map((row) => row.name);
  }

  async listTagsByProject(
    options: { excludeSubagents?: boolean } = {},
  ): Promise<ProjectTagEntry[]> {
    const normalizedPathSql = normalizedProjectPathSql("sessions.project_path");
    const rows = this.database.all<{
      environment_id: string;
      project_path: string;
      tag_name: string;
    }>(
      `
        select
          sessions.environment_id,
          ${normalizedPathSql} as project_path,
          tags.name as tag_name
        from tags
        join session_tags on session_tags.tag_id = tags.id
        join local_sessions sessions on sessions.session_key = session_tags.session_key
        where trim(sessions.project_path) <> ''
          ${options.excludeSubagents ? "and sessions.is_subagent = 0" : ""}
        order by sessions.environment_id, ${normalizedPathSql}, lower(tags.name)
      `,
    );
    const entries = new Map<string, ProjectTagEntry>();
    for (const row of rows) {
      const projectPath = normalizeProjectPath(row.project_path);
      const key = `${row.environment_id}\0${projectPath}`;
      const entry = entries.get(key) ?? {
        environmentId: row.environment_id,
        projectPath,
        tags: [],
      };
      if (!entry.tags.includes(row.tag_name)) entry.tags.push(row.tag_name);
      entries.set(key, entry);
    }
    return [...entries.values()];
  }

  async listProjects(options: ProjectQueryOptions = {}): Promise<ProjectSummary[]> {
    const values: SQLInputValue[] = [];
    const conditions = ["trim(sessions.project_path) <> ''"];
    if (options.excludeSubagents) conditions.push("sessions.is_subagent = 0");
    const originPredicate = sqliteSessionOriginPredicate(options.origin);
    if (originPredicate) conditions.push(originPredicate);
    if (options.environmentId && options.environmentId !== "all") {
      values.push(options.environmentId);
      conditions.push("sessions.environment_id = ?");
    }
    const normalizedPathSql = normalizedProjectPathSql("sessions.project_path");
    const rows = this.database.all<{
      project_path: string;
      environment_id: string;
      environment_label: string;
      session_count: number | string;
      created_at: number | string;
      last_activity_at: number | string;
      root_count: number | string;
      root_source: SessionSource | null;
      root_custom_title: string | null;
      root_original_title: string | null;
      root_first_question: string | null;
      root_started_at: number | string | null;
    }>(
      `
        select
          ${normalizedPathSql} as project_path,
          sessions.environment_id,
          environments.label as environment_label,
          count(*) as session_count,
          max(sessions.started_at) as created_at,
          max(${SQLITE_SESSION_ACTIVITY_SQL}) as last_activity_at,
          sum(case when sessions.is_subagent = 0 then 1 else 0 end) as root_count,
          max(case when sessions.is_subagent = 0 then sessions.source end) as root_source,
          max(case when sessions.is_subagent = 0 then sessions.custom_title end) as root_custom_title,
          max(case when sessions.is_subagent = 0 then sessions.original_title end) as root_original_title,
          max(case when sessions.is_subagent = 0 then sessions.first_question end) as root_first_question,
          max(
            case when sessions.is_subagent = 0 then (
              select min(events.occurred_at)
              from session_message_events events
              where events.session_key = sessions.session_key
            ) end
          ) as root_started_at
        from local_sessions sessions
        join environments on environments.id = sessions.environment_id
        where ${conditions.join(" and ")}
        group by ${normalizedPathSql}, sessions.environment_id, environments.label
      `,
      ...values,
    );
    const summaries = rows.map<ProjectSummaryDraft>((row) => {
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
    return this.database.transaction(async (tx) => {
      const existing = tx.get<{ session_key: string }>(
        "select session_key from local_sessions where session_key = ?",
        sessionKey,
      );
      if (!existing) return false;
      tx.run("delete from sessions where session_key = ? and team_snapshot_key is null", sessionKey);
      tx.run(`
        delete from tags
        where not exists (
          select 1 from session_tags where session_tags.tag_id = tags.id
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
    const relations = readSessionDeletionRelations(this.database, uniqueKeys, includeOrphanedSubagents);
    const deletionPairs = collectSessionDeletionPairs(
      relations,
      uniqueKeys,
      includeOrphanedSubagents,
    );
    const targetKeys = [...new Set(deletionPairs.map((pair) => pair.sessionKey))];
    if (targetKeys.length === 0) return [];
    const rows = this.database.all<{
      session_key: string;
      raw_id: string;
      source: SessionSource;
      file_path: string;
      is_subagent: number | boolean;
      parent_session_id: string | null;
      source_available: number | boolean;
      favorited: number | boolean;
      last_activity_at: number | string;
      environment_id: string;
      environment_kind: SessionBulkDeleteTarget["environmentKind"];
    }>(
      `
        select sessions.session_key, sessions.raw_id, sessions.source, sessions.file_path,
          sessions.is_subagent, sessions.parent_session_id,
          sessions.source_available, sessions.favorited, ${SQLITE_SESSION_ACTIVITY_SQL} as last_activity_at,
          sessions.environment_id, environments.kind as environment_kind
        from local_sessions sessions
        join environments on environments.id = sessions.environment_id
        where sessions.session_key in (select value from json_each(?))
      `,
      JSON.stringify(targetKeys),
    );
    const byKey = new Map(rows.map((row) => [row.session_key, row]));
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
        lastActivityAt: timeValue(row.last_activity_at),
        environmentId: row.environment_id,
        environmentKind: row.environment_kind,
      }] : [];
    });
  }

  async deleteSessionRecords(sessionKeys: readonly string[], expandDescendants = true): Promise<string[]> {
    const uniqueKeys = [...new Set(sessionKeys.filter(Boolean))];
    if (uniqueKeys.length === 0) return [];
    let expandedKeys: string[] = [];
    const deleted = await this.database.transaction(async (tx) => {
      if (expandDescendants) {
        const relations = readSessionDeletionRelations(tx, uniqueKeys, false);
        expandedKeys = [...new Set(
          collectSessionDeletionPairs(relations, uniqueKeys, false).map((pair) => pair.sessionKey),
        )];
      } else {
        expandedKeys = uniqueKeys;
      }
      if (expandedKeys.length === 0) return [];
      const rows = tx.all<{ session_key: string }>(
        "delete from sessions where team_snapshot_key is null and session_key in (select value from json_each(?)) returning session_key",
        JSON.stringify(expandedKeys),
      );
      tx.run(`
        delete from tags
        where not exists (
          select 1 from session_tags where session_tags.tag_id = tags.id
        )
      `);
      return rows.map((row) => row.session_key);
    });
    const deletedSet = new Set(deleted);
    return expandedKeys.filter((sessionKey) => deletedSet.has(sessionKey));
  }

  async migrateSessionKeyPreservingUserState(
    legacyKey: string,
    targetKey: string,
  ): Promise<boolean> {
    if (!legacyKey || !targetKey || legacyKey === targetKey) return false;
    return this.database.transaction(async (tx) => {
      const legacy = tx.get<{
        custom_title: string | null;
        favorited: number | boolean;
        hidden: number | boolean;
        last_opened_at: number | null;
        last_resumed_at: number | null;
        ai_summary: string | null;
        ai_summary_model: string | null;
        ai_summary_at: number | null;
        ai_summary_basis: number | string | null;
        codex_history_mode: string | null;
        codex_tool_call_state: string | null;
      }>(
        `
          select custom_title, favorited, hidden, last_opened_at, last_resumed_at,
            ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis,
            codex_history_mode, codex_tool_call_state
          from local_sessions
          where session_key = ?
        `,
        legacyKey,
      );
      if (!legacy) return false;
      const target = tx.get<{ session_key: string }>(
        "select session_key from local_sessions where session_key = ?",
        targetKey,
      );

      if (!target) {
        tx.run(
          `
            insert into sessions (
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
              ?, raw_id, source, environment_id, storage_environment_id, ${normalizedProjectPathSql("sessions.project_path")}, file_path,
              original_title, first_question, started_at, file_mtime_ms, file_size,
              pr_url, pr_number, custom_title, favorited, hidden,
              last_opened_at, last_resumed_at, message_count, turn_count,
              input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens,
              total_tokens, indexed_at, is_subagent, parent_session_id,
              ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis,
              codex_history_mode, codex_tool_call_state
            from local_sessions sessions
            where session_key = ?
          `,
          targetKey,
          legacyKey,
        );
        for (const table of [
          "session_raw_events",
          "session_message_events",
          "session_turns",
          "token_events",
          "session_tags",
        ]) {
          tx.run(
            `update ${table} set session_key = ? where session_key = ?`,
            targetKey,
            legacyKey,
          );
        }
      } else {
        const legacyOpened = legacy.last_opened_at;
        const legacyResumed = legacy.last_resumed_at;
        tx.run(
          `
            update sessions
            set
              custom_title = coalesce(custom_title, ?),
              favorited = case when favorited = 1 or ? = 1 then 1 else 0 end,
              hidden = case when hidden = 1 or ? = 1 then 1 else 0 end,
              last_opened_at = case
                when last_opened_at is null then ?
                when ? is null then last_opened_at
                when last_opened_at >= ? then last_opened_at
                else ?
              end,
              last_resumed_at = case
                when last_resumed_at is null then ?
                when ? is null then last_resumed_at
                when last_resumed_at >= ? then last_resumed_at
                else ?
              end,
              ai_summary = coalesce(ai_summary, ?),
              ai_summary_model = case when ai_summary is null then ? else ai_summary_model end,
              ai_summary_at = case when ai_summary is null then ? else ai_summary_at end,
              ai_summary_basis = case when ai_summary is null then ? else ai_summary_basis end,
              codex_history_mode = coalesce(codex_history_mode, ?),
              codex_tool_call_state = coalesce(codex_tool_call_state, ?)
            where session_key = ? and team_snapshot_key is null
          `,
          legacy.custom_title,
          legacy.favorited ? 1 : 0,
          legacy.hidden ? 1 : 0,
          legacyOpened,
          legacyOpened,
          legacyOpened,
          legacyOpened,
          legacyResumed,
          legacyResumed,
          legacyResumed,
          legacyResumed,
          legacy.ai_summary,
          legacy.ai_summary_model,
          legacy.ai_summary_at,
          legacy.ai_summary_basis === null ? null : numberValue(legacy.ai_summary_basis),
          legacy.codex_history_mode,
          legacy.codex_tool_call_state,
          targetKey,
        );
        tx.run(
          `
            insert or ignore into session_tags (session_key, tag_id)
            select ?, tag_id
            from session_tags
            where session_key = ?
          `,
          targetKey,
          legacyKey,
        );
      }
      tx.run(
        `
          update session_migrations
          set source_session_key = ?
          where source_session_key = ?
        `,
        targetKey,
        legacyKey,
      );
      tx.run(
        `
          update session_sync_bindings
          set local_session_key = ?
          where local_session_key = ?
            and not exists (
              select 1
              from session_sync_bindings as target_binding
              where target_binding.local_session_key = ?
            )
        `,
        targetKey,
        legacyKey,
        targetKey,
      );
      tx.run("delete from session_sync_bindings where local_session_key = ?", legacyKey);
      tx.run("delete from sessions where session_key = ? and team_snapshot_key is null", legacyKey);
      return true;
    });
  }

  async listSessionIdentitiesBySource(source: SessionSource): Promise<Array<{
    sessionKey: string;
    rawId: string;
    storageEnvironmentId: string;
  }>> {
    const rows = this.database.all<{
      session_key: string;
      raw_id: string;
      storage_environment_id: string;
    }>(
      `
        select session_key, raw_id, storage_environment_id
        from local_sessions
        where source = ?
        order by session_key
      `,
      source,
    );
    return rows.map((row) => ({
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
    const rows = this.database.all<{
      session_key: string;
      source: SessionSource;
      file_path: string;
      message_count: number | string;
    }>(
      `
        select session_key, source, file_path, message_count
        from local_sessions
        where storage_environment_id = ? and file_path <> ''
      `,
      environmentId,
    );
    return rows
      .filter((row) =>
        !filePaths.has(row.file_path)
        || (isCodexSqliteSession({ source: row.source, filePath: row.file_path }) && !sessionKeys.has(row.session_key))
        || (
          row.source === "cursor-agent"
          && /(^|[\\/])state\.vscdb$/iu.test(row.file_path)
          && (numberValue(row.message_count) === 0 || !sessionKeys.has(row.session_key))
        ))
      .map((row) => row.session_key);
  }

  async getSession(sessionKey: string): Promise<SessionSearchResult | null> {
    const row = this.database.get<SqliteSessionRow>(
      `
        select ${SQLITE_SESSION_DETAIL_SELECT_SQL}
        from local_sessions sessions
        join environments on environments.id = sessions.environment_id
        where sessions.session_key = ?
      `,
      sessionKey,
    );
    return row ? hydrateSqliteSession(row) : null;
  }

  async findByRawId(rawId: string): Promise<SessionSearchResult | null> {
    const row = this.database.get<SqliteSessionRow>(
      `
        select ${SQLITE_SESSION_SELECT_SQL}
        from local_sessions sessions
        join environments on environments.id = sessions.environment_id
        where sessions.raw_id = ?
        order by sessions.file_mtime_ms desc
        limit 1
      `,
      rawId,
    );
    return row ? hydrateSqliteSession(row) : null;
  }

  async resolveRuntimeInvocationSession(
    lookup: RuntimeInvocationLookup,
  ): Promise<RuntimeInvocationSessionResolution> {
    if (!lookup.invocationId && Object.keys(lookup.ownerReference ?? {}).length === 0) {
      return { status: "not_recorded" };
    }
    const conditions = ["runtime_invocations.initiator = 'agentrecall'"];
    const parameters: SQLInputValue[] = [];
    if (lookup.invocationId) {
      conditions.push("runtime_invocations.id = ?");
      parameters.push(sanitizeSessionText(lookup.invocationId));
    }
    if (lookup.surface) {
      conditions.push("runtime_invocations.surface = ?");
      parameters.push(lookup.surface);
    }
    if (lookup.role) {
      conditions.push("runtime_invocations.role = ?");
      parameters.push(sanitizeSessionText(lookup.role));
    }
    if (lookup.ownerReference && Object.keys(lookup.ownerReference).length > 0) {
      const sanitizedOwner = sanitizeSessionJsonValue(lookup.ownerReference);
      for (const [key, value] of Object.entries(sanitizedOwner)) {
        const jsonPath = ownerReferenceJsonPath(key);
        if (typeof value === "string" || typeof value === "number") {
          conditions.push("json_extract(runtime_invocations.owner_reference, ?) = ?");
          parameters.push(jsonPath, value);
        } else if (typeof value === "boolean") {
          conditions.push("json_extract(runtime_invocations.owner_reference, ?) = ?");
          parameters.push(jsonPath, value ? 1 : 0);
        } else if (value === null) {
          conditions.push("json_type(runtime_invocations.owner_reference, ?) = 'null'");
          parameters.push(jsonPath);
        } else {
          conditions.push("json(json_extract(runtime_invocations.owner_reference, ?)) = json(?)");
          parameters.push(jsonPath, JSON.stringify(value));
        }
      }
    }
    const invocation = this.database.get<{
      id: string;
      status: RuntimeInvocationSummary["status"];
    }>(
      `
        select runtime_invocations.id, runtime_invocations.status
        from runtime_invocations
        where ${conditions.join("\n          and ")}
        order by ${lookup.invocationId
          ? "runtime_invocations.started_at desc, runtime_invocations.id desc"
          : `
            case when exists (
              select 1
              from runtime_session_bindings candidate_bindings
              where candidate_bindings.invocation_id = runtime_invocations.id
            ) then 0 else 1 end,
            runtime_invocations.started_at desc,
            runtime_invocations.id desc`
        }
        limit 1
      `,
      ...parameters,
    );
    if (!invocation) return { status: "not_recorded" };
    const sessionRow = this.database.get<SqliteSessionRow>(
      `
        select ${SQLITE_SESSION_SELECT_SQL}
        from local_sessions sessions
        join environments on environments.id = sessions.environment_id
        where exists (
          select 1
          from runtime_session_bindings bindings
          join runtime_invocations invocations
            on invocations.id = bindings.invocation_id
          where ${SQLITE_RUNTIME_SESSION_BINDING_MATCH_SQL}
            and invocations.initiator = 'agentrecall'
            and invocations.id = ?
        )
        order by ${SQLITE_SESSION_ACTIVITY_SQL} desc, sessions.session_key
        limit 1
      `,
      invocation.id,
    );
    if (sessionRow) {
      return { status: "found", session: hydrateSqliteSession(sessionRow) };
    }
    const bindingExists = Boolean(this.database.get<{ found: number }>(
      `
        select exists (
          select 1
          from runtime_session_bindings
          where invocation_id = ?
        ) as found
      `,
      invocation.id,
    )?.found);
    if (bindingExists) return { status: "not_indexed", invocationId: invocation.id };
    return {
      status: "no_session_reference",
      invocationId: invocation.id,
      invocationStatus: invocation.status,
    };
  }

  async setAiSummary(sessionKey: string, summary: string, model: string): Promise<boolean> {
    const row = this.database.get<{ file_mtime_ms: number | string }>(
      "select file_mtime_ms from local_sessions where session_key = ?",
      sessionKey,
    );
    if (!row) return false;
    this.database.run(
      `
        update sessions
        set ai_summary = ?,
          ai_summary_model = ?,
          ai_summary_at = ?,
          ai_summary_basis = ?
        where session_key = ? and team_snapshot_key is null
      `,
      summary.trim(),
      model.trim(),
      Date.now(),
      numberValue(row.file_mtime_ms),
      sessionKey,
    );
    return true;
  }

  async listSessionsNeedingSummary(
    now: number,
    maxAgeMs: number,
    limit: number,
  ): Promise<SessionSearchResult[]> {
    const rows = this.database.all<SqliteSessionRow>(
      `
        select ${SQLITE_SESSION_SELECT_SQL}
        from local_sessions sessions
        join environments on environments.id = sessions.environment_id
        where sessions.file_mtime_ms >= ?
          and sessions.source <> 'codewiz-cli'
          and (
            sessions.ai_summary is null
            or sessions.file_mtime_ms > coalesce(sessions.ai_summary_basis, 0)
          )
        order by sessions.file_mtime_ms desc
        limit ?
      `,
      now - maxAgeMs,
      Math.max(0, limit),
    );
    return rows.map((row) => hydrateSqliteSession(row));
  }

  async clearSearchIndex(): Promise<void> {
    await this.database.transaction(async (tx) => {
      tx.run("delete from session_raw_events where session_key in (select session_key from local_sessions)");
      tx.run("delete from session_message_events where session_key in (select session_key from local_sessions)");
      tx.run("delete from session_turns where session_key in (select session_key from local_sessions)");
      tx.run("delete from token_events where session_key in (select session_key from local_sessions)");
      tx.run(`
        update sessions
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
        where team_snapshot_key is null
      `);
    });
  }

  async deleteSessionsBySource(sources: readonly SessionSource[]): Promise<void> {
    if (sources.length === 0) return;
    await this.database.transaction(async (tx) => {
      tx.run(
        "delete from sessions where team_snapshot_key is null and source in (select value from json_each(?))",
        JSON.stringify([...sources]),
      );
      tx.run(`
        delete from tags
        where not exists (
          select 1 from session_tags where session_tags.tag_id = tags.id
        )
      `);
    });
  }

  private addTagWithTx(
    tx: SqliteQueryable,
    sessionKey: string,
    tagName: string,
  ): void {
    tx.run("insert or ignore into tags (name) values (?)", tagName);
    tx.run(
      `
        insert or ignore into session_tags (session_key, tag_id)
        select ?, id from tags where name = ?
      `,
      sessionKey,
      tagName,
    );
  }
}
