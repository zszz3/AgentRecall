import { createHash } from "node:crypto";
import type { TeamSessionContent, TeamSessionSnapshot, TeamSessionTurnsPage, TeamSessionPage, TeamSharedSession } from "../../shared/team-sessions";
import type { SessionMessage, SessionTraceEvent, SessionTurnDetail } from "../types";
import { escapeLike } from "../session-search-query";
import { isSessionSource } from "../session-sources";
import { deriveSessionTimeline, TURN_DERIVATION_VERSION, type DerivedSessionTimeline } from "../turns/derive-turns";
import { PostgresSessionRepository } from "./session-repository";
import { PostgresSessionTurnRepository } from "./session-turn-repository";
import { postgresJsonValue } from "./session-records";
import type { PostgresDatabase } from "./database";

export const TEAM_SESSION_CACHE_VERSION = 2;
const scopedId = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const sessionKey = (key: string, record: number) => `team:${key}:${record}`;

/** Team provenance is separate; messages, events and turns use the ordinary Session tables and repositories. */
export class PostgresTeamSessionRepository {
  private readonly reader: PostgresSessionTurnRepository;
  constructor(private readonly database: PostgresDatabase) { this.reader = new PostgresSessionTurnRepository(database); }

  async replaceCatalog(scope: string, entries: Array<{ item: TeamSharedSession; key: string }>, signal: AbortSignal): Promise<void> {
    await this.database.transaction(async client => {
      signal.throwIfAborted();
      await client.query("delete from agent_recall.team_session_catalog where scope_key = $1", [scope]);
      if (entries.length) await client.query(`insert into agent_recall.team_session_catalog (scope_key, asset_id, cache_key, item)
        select $1, (entry->'item'->>'id')::bigint, entry->>'key', entry->'item'
        from jsonb_array_elements($2::jsonb) entry`, [scope, JSON.stringify(entries)]);
      signal.throwIfAborted();
    });
  }

  async list(scope: string, page: number, query = "", mode: "sessions" | "turns" = "sessions", includeTools = false): Promise<TeamSessionPage> {
    const offset = (page - 1) * 50, pattern = `%${escapeLike(query)}%`;
    if (mode === "sessions" || !query) {
      const result = await this.database.query<{ item: TeamSharedSession }>(`select item from agent_recall.team_session_catalog
        where scope_key = $1 and (item->>'title' ilike $2 escape '\\' or item->>'author' ilike $2 escape '\\')
        order by item->>'createdAt' desc, asset_id desc offset $3 limit 51`, [scope, pattern, offset]);
      return { items: result.rows.slice(0, 50).map(row => row.item), page, hasMore: result.rows.length > 50 };
    }
    // Search the persisted conversation projection; only opt-in searches touch tool output.
    const text = includeTools ? "concat_ws(E'\\n', turns.search_text, turns.tool_names::text, turns.tool_text)" : "concat_ws(E'\\n', turns.search_text, turns.tool_names::text)";
    const result = await this.database.query<{ item: TeamSharedSession; record: number; turn_id: string; turn_index: number; ordinal: number; snippet: string }>(`
      select catalog.item, split_part(sessions.session_key, ':', 3)::int as record,
        turns.id as turn_id, turns.turn_index,
        (select count(*)::int from agent_recall.session_turns earlier where earlier.session_key = turns.session_key and earlier.turn_index < turns.turn_index) as ordinal,
        substring(${text} from greatest(1, strpos(lower(${text}), lower($3)) - 60) for 240) as snippet
      from agent_recall.team_session_catalog catalog
      join agent_recall.sessions sessions on sessions.team_snapshot_key = catalog.cache_key
      join agent_recall.session_turns turns on turns.session_key = sessions.session_key
      where catalog.scope_key = $1 and (turns.search_text ilike $2 escape '\\' or turns.tool_names::text ilike $2 escape '\\' or ($5 and turns.tool_text ilike $2 escape '\\'))
      order by catalog.item->>'createdAt' desc, catalog.asset_id desc, sessions.session_key, turns.turn_index
      offset $4 limit 51`, [scope, pattern, query, offset, includeTools]);
    return { page, hasMore: result.rows.length > 50, items: result.rows.slice(0, 50).map(row => ({ ...row.item,
      match: { record: Number(row.record), turnId: row.turn_id, turnIndex: Number(row.turn_index), offset: Math.floor(Number(row.ordinal) / 50) * 50, snippet: row.snippet } })) };
  }

  async sources(keys: string[]): Promise<Map<string, string | null>> {
    const result = await this.database.query<{ cache_key: string; source: string | null }>(
      `select snapshots.cache_key, sessions.source from agent_recall.team_session_snapshots snapshots
       left join agent_recall.sessions sessions on sessions.session_key = 'team:' || snapshots.cache_key || ':0'
       where snapshots.cache_key = any($1::text[])`, [keys]);
    return new Map(result.rows.map(row => [row.cache_key, row.source]));
  }

  async get(key: string): Promise<TeamSessionSnapshot | null> {
    // Read source labels from normalized records, including snapshots written before labels were exposed.
    const result = await this.database.query<{ metadata: TeamSessionSnapshot; sources: Record<string, string> | null }>(
      `select metadata, (select jsonb_object_agg(session_key, source) from agent_recall.sessions
       where team_snapshot_key = $1) as sources from agent_recall.team_session_snapshots where cache_key = $1`, [key]);
    const row = result.rows[0];
    if (!row) return null;
    return { ...row.metadata, records: row.metadata.records.map((record, index) => ({ ...record,
      source: row.sources?.[sessionKey(key, index)] ?? record.source })) };
  }

  async import(key: string, content: TeamSessionContent, signal: AbortSignal, origin: { repository: string; assetId: number; digest: string }, catalog?: { scope: string; item: TeamSharedSession }): Promise<TeamSessionSnapshot> {
    const records = [content.root, ...content.children];
    const snapshot: TeamSessionSnapshot = { partial: Boolean(content.selectedTurns), bytes: content.bytes,
      files: content.files, missingAttachments: content.missingAttachments, records: [] };
    return this.database.transaction(async (client) => {
      signal.throwIfAborted();
      // Serialize identical imports, and publish metadata only with all normalized records committed.
      await client.query("insert into agent_recall.team_session_snapshots (cache_key, metadata, source, repository, asset_id, digest) values ($1, $2, $3, $4, $5, $6) on conflict (cache_key) do nothing",
        [key, JSON.stringify(snapshot), JSON.stringify(postgresJsonValue(content)), origin.repository, origin.assetId, origin.digest]);
      await client.query("select cache_key from agent_recall.team_session_snapshots where cache_key = $1 for update", [key]);
      await client.query("delete from agent_recall.sessions where team_snapshot_key = $1", [key]);
      const writer = new PostgresSessionRepository({ query: (sql, args) => client.query(sql, args), transaction: run => run(client) });
      for (const [recordIndex, record] of records.entries()) {
        signal.throwIfAborted();
        if (!isSessionSource(record.session.source)) throw new Error("Unsupported shared session source");
        const localKey = sessionKey(key, recordIndex);
        const parentIndex = typeof record.session.parentSessionId === "string"
          ? records.findIndex(candidate => candidate.session.rawId === record.session.parentSessionId) : -1;
        const parentKey = parentIndex >= 0 ? sessionKey(key, parentIndex) : null;
        // Shared paths belong to another machine. Never materialize them against this user's filesystem.
        const messages: SessionMessage[] = (content.selectedTurns?.flatMap(turn => turn.messages.map(message => ({
          ...message, index: message.sourceMessageIndex ?? message.messageIndex,
        }))) ?? record.messages).map(message => ({ ...message, attachments: message.attachments?.map(({ source: _source, ...attachment }) => ({ ...attachment, status: "missing" as const })) }));
        const traces = record.traceEvents as unknown as SessionTraceEvent[];
        let timeline: DerivedSessionTimeline | undefined;
        if (content.selectedTurns) {
          timeline = { rawEvents: deriveSessionTimeline({ sessionKey: localKey, messages }).rawEvents,
            turns: content.selectedTurns.map(turn => ({
              id: scopedId(localKey, turn.id), turnIndex: turn.turnIndex, sourceMessageIndex: turn.sourceMessageIndex,
              sourceTurnId: turn.sourceTurnId ?? null, synthetic: turn.synthetic, status: turn.status,
              startedAt: turn.startedAt, endedAt: turn.endedAt, durationMs: turn.durationMs ?? null,
              timeToFirstTokenMs: turn.timeToFirstTokenMs ?? null, abortReason: turn.abortReason ?? null,
              userText: turn.messages.filter(message => message.role === "user").map(message => message.content).join("\n"),
              assistantText: turn.messages.filter(message => message.role === "assistant").map(message => message.content).join("\n"),
              toolText: turn.spans.map(span => [span.name, JSON.stringify(span.input), JSON.stringify(span.output), span.error].filter(Boolean).join(" ")).join("\n"), searchText: turn.messages.map(message => message.content).join("\n"),
              inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, cachedInputTokens: turn.cachedInputTokens,
              cacheCreationInputTokens: turn.cacheCreationInputTokens ?? 0, reasoningOutputTokens: turn.reasoningOutputTokens,
              totalTokens: turn.totalTokens, errorCount: turn.errorCount, toolNames: turn.toolNames, derivationVersion: TURN_DERIVATION_VERSION,
              messages: turn.messages.map(message => ({ messageIndex: message.messageIndex, sourceMessageIndex: message.sourceMessageIndex,
                role: message.role, content: message.content, occurredAt: message.timestamp || null,
                metadata: { sourceTurnId: message.sourceTurnId, phase: message.phase, attachments: message.attachments?.map(({ source: _source, ...attachment }) => ({ ...attachment, status: "missing" })) } })),
              spans: turn.spans.map(span => ({ ...span, id: scopedId(localKey, turn.id, span.id), parentSpanId: span.parentSpanId ? scopedId(localKey, turn.id, span.parentSpanId) : null })),
            })) };
        }
        await writer.upsertIndexedSession({
          sessionKey: localKey, rawId: localKey, source: record.session.source, environmentId: "local",
          projectPath: typeof record.session.projectPath === "string" ? record.session.projectPath : "",
          filePath: "", originalTitle: record.session.displayTitle || record.session.originalTitle,
          firstQuestion: messages.find(message => message.role === "user")?.content ?? "",
          timestamp: record.exportedAt, fileMtimeMs: 0, fileSize: 0, prUrl: null, prNumber: null,
          isSubagent: recordIndex !== 0, parentSessionId: parentKey,
        }, messages, [], traces, undefined, timeline);
        await client.query("update agent_recall.sessions set team_snapshot_key = $2, source_available = false where session_key = $1", [localKey, key]);
        const count = await client.query<{ turn_count: number }>("select turn_count from agent_recall.sessions where session_key = $1", [localKey]);
        snapshot.records.push({ source: record.session.source, sessionKey: record.session.sessionKey, title: record.session.displayTitle || record.session.originalTitle, turnCount: Number(count.rows[0].turn_count) });
      }
      await client.query("update agent_recall.team_session_snapshots set metadata = $2 where cache_key = $1", [key, JSON.stringify(snapshot)]);
      if (catalog) await client.query(`insert into agent_recall.team_session_catalog (scope_key, asset_id, cache_key, item)
        values ($1, $2, $3, $4) on conflict (scope_key, asset_id) do update set cache_key = excluded.cache_key, item = excluded.item`,
        [catalog.scope, catalog.item.id, key, JSON.stringify(catalog.item)]);
      signal.throwIfAborted();
      return snapshot;
    });
  }

  async turns(key: string, record: number, offset: number): Promise<TeamSessionTurnsPage> {
    const turns = await this.reader.listSessionTurns(sessionKey(key, record), { offset, limit: 51 });
    return { turns: turns.slice(0, 50), offset, hasMore: turns.length > 50 };
  }
  async turn(key: string, record: number, id: string): Promise<SessionTurnDetail | null> {
    return this.reader.getSessionTurn(sessionKey(key, record), id);
  }
}
