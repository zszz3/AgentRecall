import type {
  IndexedSession,
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
  postgresText,
  timeValue,
  tokenUsageFromEvents,
  type SessionRow,
} from "./session-records";

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

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function codexTaskWorkspaceDate(projectPath: string): string | null {
  const parts = projectParts(projectPath);
  if (parts.length < 3) return null;
  const codexSegment = parts.at(-3) || "";
  const dateSegment = parts.at(-2) || "";
  const taskSegment = parts.at(-1) || "";
  return codexSegment.toLocaleLowerCase() === "codex"
    && taskSegment
    && validIsoDate(dateSegment)
    ? dateSegment
    : null;
}

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

async function insertRawEvent(
  client: PostgresQueryable,
  sessionKey: string,
  event: DerivedRawEvent,
): Promise<void> {
  await client.query(
    `
      insert into agent_recall.session_raw_events (
        session_key, event_index, event_id, kind, role, occurred_at, payload
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      sessionKey,
      event.eventIndex,
      event.eventId,
      event.kind,
      event.role,
      event.occurredAt,
      JSON.stringify(event.payload),
    ],
  );
}

async function insertTurn(
  client: PostgresQueryable,
  sessionKey: string,
  turn: DerivedSessionTurn,
): Promise<void> {
  await client.query(
    `
      insert into agent_recall.session_turns (
        id, session_key, turn_index, source_message_index, synthetic, status,
        started_at, ended_at, user_text, assistant_text, tool_text, search_text,
        input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens,
        total_tokens, error_count, tool_names, derivation_version
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20
      )
    `,
    [
      turn.id,
      sessionKey,
      turn.turnIndex,
      turn.sourceMessageIndex,
      turn.synthetic,
      turn.status,
      turn.startedAt,
      turn.endedAt,
      turn.userText,
      turn.assistantText,
      turn.toolText,
      turn.searchText,
      turn.inputTokens,
      turn.outputTokens,
      turn.cachedInputTokens,
      turn.reasoningOutputTokens,
      turn.totalTokens,
      turn.errorCount,
      turn.toolNames,
      turn.derivationVersion,
    ],
  );

  for (const message of turn.messages) {
    await client.query(
      `
        insert into agent_recall.turn_messages (
          turn_id, message_index, source_message_index, role, content, occurred_at, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `,
      [
        turn.id,
        message.messageIndex,
        message.sourceMessageIndex,
        message.role,
        message.content,
        message.occurredAt,
        JSON.stringify(message.metadata),
      ],
    );
  }

  for (const span of turn.spans) {
    await client.query(
      `
        insert into agent_recall.trace_spans (
          id, turn_id, parent_span_id, span_index, kind, name, status,
          started_at, ended_at, call_id, input, output, error, attributes
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::jsonb
        )
      `,
      [
        span.id,
        turn.id,
        span.parentSpanId,
        span.spanIndex,
        span.kind,
        span.name,
        span.status,
        span.startedAt,
        span.endedAt,
        span.callId,
        span.input ? JSON.stringify(span.input) : null,
        span.output ? JSON.stringify(span.output) : null,
        span.error,
        JSON.stringify(span.attributes),
      ],
    );
  }
}

export class PostgresSessionRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async upsertIndexedSession(
    session: IndexedSession,
    messages: readonly SessionMessage[],
    tokenEvents: readonly TokenUsageEvent[] = [],
    traceEvents: readonly SessionTraceEvent[] = [],
  ): Promise<void> {
    const persistedMessages = messages.map((message) => ({
      ...message,
      content: postgresText(message.content),
    }));
    const persistedTokenEvents = tokenEvents.map((event) => ({
      ...event,
      dedupeKey: postgresText(event.dedupeKey),
    }));
    const persistedTraceEvents = traceEvents.map((event) => ({
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
            session_key, raw_id, source, environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            pr_url, pr_number, message_count, turn_count, input_tokens, output_tokens,
            cached_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
            is_subagent, parent_session_id
          )
          values (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, $15, $16, $17,
            $18, $19, $20, now(), $21, $22
          )
          on conflict (session_key) do update set
            raw_id = excluded.raw_id,
            source = excluded.source,
            environment_id = excluded.environment_id,
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
            reasoning_output_tokens = excluded.reasoning_output_tokens,
            total_tokens = excluded.total_tokens,
            indexed_at = excluded.indexed_at,
            is_subagent = excluded.is_subagent,
            parent_session_id = excluded.parent_session_id
        `,
        [
          session.sessionKey,
          session.rawId,
          session.source,
          environmentId,
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
          tokenUsage.reasoningOutputTokens,
          tokenUsage.totalTokens,
          Boolean(session.isSubagent),
          session.parentSessionId ?? null,
        ],
      );

      await client.query("delete from agent_recall.session_raw_events where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.session_message_events where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.session_turns where session_key = $1", [session.sessionKey]);
      await client.query("delete from agent_recall.token_events where session_key = $1", [session.sessionKey]);

      for (const event of timeline.rawEvents) await insertRawEvent(client, session.sessionKey, event);
      for (const message of persistedMessages) {
        const occurredAt = Date.parse(message.timestamp);
        await client.query(
          `
            insert into agent_recall.session_message_events (
              session_key, message_index, occurred_at
            )
            values ($1, $2, $3)
          `,
          [
            session.sessionKey,
            message.index,
            new Date(Number.isFinite(occurredAt) && occurredAt >= 0 ? occurredAt : 0).toISOString(),
          ],
        );
      }
      for (const turn of timeline.turns) await insertTurn(client, session.sessionKey, turn);
      for (const event of persistedTokenEvents) {
        await client.query(
          `
            insert into agent_recall.token_events (
              session_key, dedupe_key, occurred_at, input_tokens, output_tokens,
              cached_input_tokens, reasoning_output_tokens, total_tokens
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            session.sessionKey,
            event.dedupeKey,
            new Date(Math.max(0, event.timestamp)).toISOString(),
            event.inputTokens,
            event.outputTokens,
            event.cachedInputTokens,
            event.reasoningOutputTokens,
            event.totalTokens,
          ],
        );
      }

      const branchTag = branchTagName(session.gitBranch);
      if (branchTag) await this.addTagWithClient(client, session.sessionKey, branchTag);
    });
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
            session_key, raw_id, source, environment_id, project_path, file_path,
            original_title, first_question, started_at, file_mtime_ms, file_size,
            pr_url, pr_number, message_count, turn_count, input_tokens, output_tokens,
            cached_input_tokens, reasoning_output_tokens, total_tokens, indexed_at,
            is_subagent, parent_session_id
          )
          values (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, 0, $15, $16,
            $17, $18, $19, now(), $20, $21
          )
          on conflict (session_key) do update set
            raw_id = excluded.raw_id,
            source = excluded.source,
            environment_id = excluded.environment_id,
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
            reasoning_output_tokens = excluded.reasoning_output_tokens,
            total_tokens = excluded.total_tokens,
            indexed_at = excluded.indexed_at,
            is_subagent = excluded.is_subagent,
            parent_session_id = excluded.parent_session_id
        `,
        [
          session.sessionKey,
          session.rawId,
          session.source,
          environmentId,
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
                cached_input_tokens, reasoning_output_tokens, total_tokens
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
              session.sessionKey,
              event.dedupeKey,
              new Date(Math.max(0, event.timestamp)).toISOString(),
              event.inputTokens,
              event.outputTokens,
              event.cachedInputTokens,
              event.reasoningOutputTokens,
              event.totalTokens,
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
      pr_url: string | null;
      pr_number: number | string | null;
      is_subagent: boolean;
      parent_session_id: string | null;
    }>(
      `
        select raw_id, source, environment_id, project_path, file_path,
          original_title, first_question, started_at, file_mtime_ms, file_size,
          pr_url, pr_number, is_subagent, parent_session_id
        from agent_recall.sessions
        where session_key = $1
      `,
      [session.sessionKey],
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
      && (row.pr_url ?? null) === (session.prUrl ?? null)
      && (row.pr_number === null ? null : numberValue(row.pr_number)) === (session.prNumber ?? null)
      && Boolean(row.is_subagent) === Boolean(session.isSubagent)
      && (row.parent_session_id ?? null) === (session.parentSessionId ?? null),
    );
  }

  async touchIndexedAtIfMissing(sessionKey: string): Promise<void> {
    await this.database.query(
      `
        update agent_recall.sessions
        set indexed_at = now()
        where session_key = $1 and indexed_at <= to_timestamp(0)
      `,
      [sessionKey],
    );
  }

  async listIndexedSessionFiles(
    environmentId = "local",
  ): Promise<Array<{ filePath: string; fileMtimeMs: number; fileSize: number; indexedAt: number }>> {
    const result = await this.database.query<{
      file_path: string;
      file_mtime_ms: number | string;
      file_size: number | string;
      indexed_at: Date | string;
    }>(
      `
        select file_path, file_mtime_ms, file_size, indexed_at
        from agent_recall.sessions
        where environment_id = $1 and file_path <> ''
        order by file_path
      `,
      [environmentId],
    );
    return result.rows.map((row) => ({
      filePath: row.file_path,
      fileMtimeMs: numberValue(row.file_mtime_ms),
      fileSize: numberValue(row.file_size),
      indexedAt: timeValue(row.indexed_at),
    }));
  }

  async setCustomTitle(sessionKey: string, title: string | null): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set custom_title = $2 where session_key = $1",
      [sessionKey, title?.trim() || null],
    );
  }

  async setPinned(sessionKey: string, pinned: boolean): Promise<void> {
    await this.database.query(
      "update agent_recall.sessions set pinned = $2 where session_key = $1",
      [sessionKey, pinned],
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

  async migrateSessionKeyPreservingUserState(
    legacyKey: string,
    targetKey: string,
  ): Promise<boolean> {
    if (!legacyKey || !targetKey || legacyKey === targetKey) return false;
    return this.database.transaction(async (client) => {
      const legacyResult = await client.query<{
        custom_title: string | null;
        favorited: boolean;
        pinned: boolean;
        hidden: boolean;
        last_opened_at: Date | string | null;
        last_resumed_at: Date | string | null;
        ai_summary: string | null;
        ai_summary_model: string | null;
        ai_summary_at: Date | string | null;
        ai_summary_basis: number | string | null;
      }>(
        `
          select custom_title, favorited, pinned, hidden, last_opened_at, last_resumed_at,
            ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis
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
              session_key, raw_id, source, environment_id, project_path, file_path,
              original_title, first_question, started_at, file_mtime_ms, file_size,
              pr_url, pr_number, custom_title, favorited, pinned, hidden,
              last_opened_at, last_resumed_at, message_count, turn_count,
              input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens,
              total_tokens, indexed_at, is_subagent, parent_session_id,
              ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis
            )
            select
              $2, raw_id, source, environment_id, project_path, file_path,
              original_title, first_question, started_at, file_mtime_ms, file_size,
              pr_url, pr_number, custom_title, favorited, pinned, hidden,
              last_opened_at, last_resumed_at, message_count, turn_count,
              input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens,
              total_tokens, indexed_at, is_subagent, parent_session_id,
              ai_summary, ai_summary_model, ai_summary_at, ai_summary_basis
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
              pinned = pinned or $4,
              hidden = hidden or $5,
              last_opened_at = greatest(last_opened_at, $6),
              last_resumed_at = greatest(last_resumed_at, $7),
              ai_summary = coalesce(ai_summary, $8),
              ai_summary_model = case when ai_summary is null then $9 else ai_summary_model end,
              ai_summary_at = case when ai_summary is null then $10 else ai_summary_at end,
              ai_summary_basis = case when ai_summary is null then $11 else ai_summary_basis end
            where session_key = $1
          `,
          [
            targetKey,
            legacy.custom_title,
            legacy.favorited,
            legacy.pinned,
            legacy.hidden,
            legacy.last_opened_at,
            legacy.last_resumed_at,
            legacy.ai_summary,
            legacy.ai_summary_model,
            legacy.ai_summary_at,
            legacy.ai_summary_basis,
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
      await client.query("delete from agent_recall.sessions where session_key = $1", [legacyKey]);
      return true;
    });
  }

  async listSessionKeysByFilePath(
    environmentId: string,
    filePaths: ReadonlySet<string>,
  ): Promise<string[]> {
    const result = await this.database.query<{ session_key: string; file_path: string }>(
      `
        select session_key, file_path
        from agent_recall.sessions
        where environment_id = $1 and file_path <> ''
      `,
      [environmentId],
    );
    return result.rows
      .filter((row) => !filePaths.has(row.file_path))
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
          message_count = 0,
          turn_count = 0,
          input_tokens = 0,
          output_tokens = 0,
          cached_input_tokens = 0,
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

  async getSessionDeletionTarget(
    sessionKey: string,
  ): Promise<{ source: SessionSource; filePath: string } | null> {
    const result = await this.database.query<{ source: SessionSource; file_path: string }>(
      "select source, file_path from agent_recall.sessions where session_key = $1",
      [sessionKey],
    );
    return result.rows[0]
      ? { source: result.rows[0].source, filePath: result.rows[0].file_path }
      : null;
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
