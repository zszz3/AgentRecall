import { createHash } from "node:crypto";
import type {
  TeamSessionContent,
  TeamSessionPage,
  TeamSessionSnapshot,
  TeamSessionTurnsPage,
  TeamSharedSession,
} from "../../shared/team-sessions";
import type { SessionMessage, SessionTraceEvent, SessionTurnDetail } from "../types";
import { escapeLike } from "../session-search-query";
import { isSessionSource } from "../session-sources";
import {
  deriveSessionTimeline,
  TURN_DERIVATION_VERSION,
  type DerivedSessionTimeline,
} from "../turns/derive-turns";
import type { SqliteDatabase } from "./database";
import { sanitizeSessionJsonValue } from "./session-records";
import { SqliteSessionRepository } from "./session-repository";
import { SqliteSessionTurnRepository } from "./session-turn-repository";

const scopedId = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const teamSessionKey = (key: string, record: number) => `team:${key}:${record}`;

function parseJson<T>(value: unknown): T {
  return typeof value === "string" ? JSON.parse(value) as T : value as T;
}

function buildSnippet(text: string, query: string): string {
  const pos = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = pos >= 0 ? Math.max(0, pos - 60) : 0;
  return text.slice(start, start + 240);
}

/** Team provenance is separate; messages, events and turns use the ordinary Session tables and repositories. */
export class SqliteTeamSessionRepository {
  private readonly reader: SqliteSessionTurnRepository;

  constructor(private readonly database: SqliteDatabase) {
    this.reader = new SqliteSessionTurnRepository(database);
  }

  async replaceCatalog(
    scope: string,
    entries: Array<{ item: TeamSharedSession; key: string }>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      signal.throwIfAborted();
      tx.run("delete from team_session_catalog where scope_key = ? and asset_id > 0", scope);
      for (const entry of entries) {
        tx.run(
          "insert into team_session_catalog (scope_key, asset_id, cache_key, item) values (?, ?, ?, ?)",
          scope,
          entry.item.id,
          entry.key,
          JSON.stringify(entry.item),
        );
      }
      tx.run(
        `
          delete from team_session_catalog
          where scope_key = ?
            and exists (
              select 1 from team_session_drafts draft
              where draft.scope_key = team_session_catalog.scope_key
                and draft.asset_id = team_session_catalog.asset_id
                and draft.published is not null
                and exists (
                  select 1 from team_session_catalog remote
                  where remote.scope_key = ?
                    and remote.asset_id = cast(json_extract(draft.published, '$.id') as integer)
                )
            )
        `,
        scope,
        scope,
      );
      tx.run(
        `
          delete from team_session_drafts
          where scope_key = ?
            and published is not null
            and exists (
              select 1 from team_session_catalog remote
              where remote.scope_key = ?
                and remote.asset_id = cast(json_extract(team_session_drafts.published, '$.id') as integer)
            )
        `,
        scope,
        scope,
      );
      signal.throwIfAborted();
    });
  }

  async drafts(scope: string): Promise<TeamSharedSession[]> {
    const rows = this.database.all<{ item: string }>(
      "select item from team_session_drafts where scope_key = ? and published is null order by asset_id",
      scope,
    );
    return rows.map((row) => parseJson<TeamSharedSession>(row.item));
  }

  async draft(scope: string, id: number): Promise<{ packet: Buffer; item: TeamSharedSession; published: TeamSharedSession | null } | null> {
    const row = this.database.get<{ packet: Uint8Array; item: string; published: string | null }>(
      "select packet, item, published from team_session_drafts where scope_key = ? and asset_id = ?",
      scope,
      id,
    );
    if (!row) return null;
    return {
      packet: Buffer.from(row.packet),
      item: parseJson<TeamSharedSession>(row.item),
      published: row.published ? parseJson<TeamSharedSession>(row.published) : null,
    };
  }

  async receipt(scope: string, id: number, digest: string, published: TeamSharedSession): Promise<void> {
    this.database.run(
      "update team_session_drafts set published = ? where scope_key = ? and asset_id = ? and json_extract(item, '$.digest') = ?",
      JSON.stringify(published),
      scope,
      id,
      digest,
    );
  }

  async list(
    scope: string,
    page: number,
    query = "",
    mode: "sessions" | "turns" = "sessions",
    includeTools = false,
  ): Promise<TeamSessionPage> {
    const offset = (page - 1) * 50;
    const pattern = `%${escapeLike(query)}%`;
    if (mode === "sessions" || !query) {
      const rows = this.database.all<{ item: string }>(
        `
          select item from team_session_catalog
          where scope_key = ?
            and (
              json_extract(item, '$.title') like ? escape '\\'
              or json_extract(item, '$.author') like ? escape '\\'
            )
          order by json_extract(item, '$.createdAt') desc, asset_id desc
          limit 51 offset ?
        `,
        scope,
        pattern,
        pattern,
        offset,
      );
      return {
        items: rows.slice(0, 50).map((row) => parseJson<TeamSharedSession>(row.item)),
        page,
        hasMore: rows.length > 50,
      };
    }

    const rows = this.database.all<{
      item: string;
      matched_turn_id: string | null;
      matched_session_key: string | null;
      turn_index: number | null;
      ordinal: number | null;
      search_text: string | null;
      tool_names: string | null;
      tool_text: string | null;
    }>(
      `
        with catalog_hits as (
          select
            catalog.asset_id,
            catalog.item,
            (
              select turns.id
              from sessions
              join session_turns turns on turns.session_key = sessions.session_key
              where sessions.team_snapshot_key = catalog.cache_key
                and (
                  turns.search_text like ? escape '\\'
                  or turns.tool_names like ? escape '\\'
                  or (? = 1 and turns.tool_text like ? escape '\\')
                )
              order by sessions.session_key, turns.turn_index
              limit 1
            ) as matched_turn_id
          from team_session_catalog catalog
          where catalog.scope_key = ?
        )
        select
          catalog_hits.item,
          catalog_hits.matched_turn_id,
          turns.session_key as matched_session_key,
          turns.turn_index,
          (
            select count(*)
            from session_turns earlier
            where earlier.session_key = turns.session_key
              and earlier.turn_index < turns.turn_index
          ) as ordinal,
          turns.search_text,
          turns.tool_names,
          turns.tool_text
        from catalog_hits
        left join session_turns turns on turns.id = catalog_hits.matched_turn_id
        where json_extract(catalog_hits.item, '$.title') like ? escape '\\'
          or json_extract(catalog_hits.item, '$.author') like ? escape '\\'
          or catalog_hits.matched_turn_id is not null
        order by json_extract(catalog_hits.item, '$.createdAt') desc, catalog_hits.asset_id desc
        limit 51 offset ?
      `,
      pattern,
      pattern,
      includeTools ? 1 : 0,
      pattern,
      scope,
      pattern,
      pattern,
      offset,
    );

    return {
      page,
      hasMore: rows.length > 50,
      items: rows.slice(0, 50).map((row) => {
        const item = parseJson<TeamSharedSession>(row.item);
        if (row.matched_turn_id === null || row.matched_session_key === null) return item;
        const textParts = includeTools
          ? [row.search_text, row.tool_names, row.tool_text]
          : [row.search_text, row.tool_names];
        const combined = textParts.filter((part): part is string => part !== null).join("\n");
        const record = Number(row.matched_session_key.split(":")[2]);
        return {
          ...item,
          match: {
            record,
            turnId: row.matched_turn_id,
            turnIndex: Number(row.turn_index),
            offset: Math.floor(Number(row.ordinal) / 50) * 50,
            snippet: buildSnippet(combined, query),
          },
        };
      }),
    };
  }

  async sources(keys: string[]): Promise<Map<string, string | null>> {
    if (keys.length === 0) return new Map();
    const rows = this.database.all<{ cache_key: string; source: string | null }>(
      `
        select snapshots.cache_key, sessions.source
        from team_session_snapshots snapshots
        left join sessions on sessions.session_key = 'team:' || snapshots.cache_key || ':0'
        where snapshots.cache_key in (select value from json_each(?))
      `,
      JSON.stringify(keys),
    );
    return new Map(rows.map((row) => [row.cache_key, row.source]));
  }

  async get(key: string): Promise<TeamSessionSnapshot | null> {
    const row = this.database.get<{ metadata: string }>(
      "select metadata from team_session_snapshots where cache_key = ?",
      key,
    );
    if (!row) return null;
    const sourceRows = this.database.all<{ session_key: string; source: string }>(
      "select session_key, source from sessions where team_snapshot_key = ?",
      key,
    );
    const sourcesByKey = new Map(sourceRows.map((entry) => [entry.session_key, entry.source]));
    const metadata = parseJson<TeamSessionSnapshot>(row.metadata);
    return {
      ...metadata,
      records: metadata.records.map((record, index) => ({
        ...record,
        source: sourcesByKey.get(teamSessionKey(key, index)) ?? record.source,
      })),
    };
  }

  async import(
    key: string,
    content: TeamSessionContent,
    signal: AbortSignal,
    origin: { repository: string; assetId: number; digest: string },
    catalog?: { scope: string; item: TeamSharedSession; packet?: Buffer; replaces?: { id: number; digest: string } },
  ): Promise<TeamSessionSnapshot> {
    const records = [content.root, ...content.children];
    const snapshot: TeamSessionSnapshot = {
      partial: Boolean(content.selectedTurns),
      bytes: content.bytes,
      files: content.files,
      missingAttachments: content.missingAttachments,
      records: [],
    };
    return this.database.transaction(async (tx) => {
      signal.throwIfAborted();
      tx.run(
        `
          insert or ignore into team_session_snapshots (cache_key, metadata, source, repository, asset_id, digest)
          values (?, ?, ?, ?, ?, ?)
        `,
        key,
        JSON.stringify(snapshot),
        JSON.stringify(sanitizeSessionJsonValue(content)),
        origin.repository,
        origin.assetId,
        origin.digest,
      );
      tx.run("delete from sessions where team_snapshot_key = ?", key);
      const writer = new SqliteSessionRepository({
        all: tx.all.bind(tx),
        get: tx.get.bind(tx),
        run: tx.run.bind(tx),
        transaction: (run) => run(tx),
      });
      for (const [recordIndex, record] of records.entries()) {
        signal.throwIfAborted();
        if (!isSessionSource(record.session.source)) throw new Error("Unsupported shared session source");
        const localKey = teamSessionKey(key, recordIndex);
        const parentIndex = typeof record.session.parentSessionId === "string"
          ? records.findIndex((candidate) => candidate.session.rawId === record.session.parentSessionId)
          : -1;
        const parentKey = parentIndex >= 0 ? teamSessionKey(key, parentIndex) : null;
        const messages: SessionMessage[] = (
          content.selectedTurns?.flatMap((turn) => turn.messages.map((message) => ({
            ...message,
            index: message.sourceMessageIndex ?? message.messageIndex,
          }))) ?? record.messages
        ).map((message) => ({
          ...message,
          attachments: message.attachments?.map(({ source: _source, ...attachment }) => ({
            ...attachment,
            status: "missing" as const,
          })),
        }));
        const traces = record.traceEvents as unknown as SessionTraceEvent[];
        let timeline: DerivedSessionTimeline | undefined;
        if (content.selectedTurns) {
          timeline = {
            rawEvents: deriveSessionTimeline({ sessionKey: localKey, messages }).rawEvents,
            turns: content.selectedTurns.map((turn) => ({
              id: scopedId(localKey, turn.id),
              turnIndex: turn.turnIndex,
              sourceMessageIndex: turn.sourceMessageIndex,
              sourceTurnId: turn.sourceTurnId ?? null,
              synthetic: turn.synthetic,
              status: turn.status,
              startedAt: turn.startedAt,
              endedAt: turn.endedAt,
              durationMs: turn.durationMs ?? null,
              timeToFirstTokenMs: turn.timeToFirstTokenMs ?? null,
              abortReason: turn.abortReason ?? null,
              userText: turn.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n"),
              assistantText: turn.messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n"),
              toolText: turn.spans.map((span) => [span.name, JSON.stringify(span.input), JSON.stringify(span.output), span.error].filter(Boolean).join(" ")).join("\n"),
              searchText: turn.messages.map((message) => message.content).join("\n"),
              inputTokens: turn.inputTokens,
              outputTokens: turn.outputTokens,
              cachedInputTokens: turn.cachedInputTokens,
              cacheCreationInputTokens: turn.cacheCreationInputTokens ?? 0,
              reasoningOutputTokens: turn.reasoningOutputTokens,
              totalTokens: turn.totalTokens,
              errorCount: turn.errorCount,
              toolNames: turn.toolNames,
              derivationVersion: TURN_DERIVATION_VERSION,
              messages: turn.messages.map((message) => ({
                messageIndex: message.messageIndex,
                sourceMessageIndex: message.sourceMessageIndex,
                role: message.role,
                content: message.content,
                occurredAt: message.timestamp || null,
                metadata: {
                  sourceTurnId: message.sourceTurnId,
                  phase: message.phase,
                  attachments: message.attachments?.map(({ source: _source, ...attachment }) => ({
                    ...attachment,
                    status: "missing",
                  })),
                },
              })),
              spans: turn.spans.map((span) => ({
                ...span,
                id: scopedId(localKey, turn.id, span.id),
                parentSpanId: span.parentSpanId ? scopedId(localKey, turn.id, span.parentSpanId) : null,
              })),
            })),
          };
        }
        await writer.upsertIndexedSession(
          {
            sessionKey: localKey,
            rawId: localKey,
            source: record.session.source,
            environmentId: "local",
            projectPath: typeof record.session.projectPath === "string" ? record.session.projectPath : "",
            filePath: "",
            originalTitle: record.session.displayTitle || record.session.originalTitle,
            firstQuestion: messages.find((message) => message.role === "user")?.content ?? "",
            timestamp: record.exportedAt,
            fileMtimeMs: 0,
            fileSize: 0,
            prUrl: null,
            prNumber: null,
            isSubagent: recordIndex !== 0,
            parentSessionId: parentKey,
          },
          messages,
          [],
          traces,
          undefined,
          timeline,
        );
        tx.run(
          "update sessions set team_snapshot_key = ?, source_available = 0 where session_key = ?",
          key,
          localKey,
        );
        const count = tx.get<{ turn_count: number }>(
          "select turn_count from sessions where session_key = ?",
          localKey,
        );
        snapshot.records.push({
          source: record.session.source,
          sessionKey: record.session.sessionKey,
          title: record.session.displayTitle || record.session.originalTitle,
          turnCount: Number(count?.turn_count ?? 0),
        });
      }
      tx.run(
        "update team_session_snapshots set metadata = ? where cache_key = ?",
        JSON.stringify(snapshot),
        key,
      );
      if (catalog) {
        tx.run(
          `
            insert into team_session_catalog (scope_key, asset_id, cache_key, item)
            values (?, ?, ?, ?)
            on conflict (scope_key, asset_id) do update set
              cache_key = excluded.cache_key,
              item = excluded.item
          `,
          catalog.scope,
          catalog.item.id,
          key,
          JSON.stringify(catalog.item),
        );
      }
      signal.throwIfAborted();
      if (catalog?.packet) {
        tx.run(
          `
            insert into team_session_drafts (scope_key, asset_id, packet, item)
            values (?, ?, ?, ?)
            on conflict (scope_key, asset_id) do update set
              packet = excluded.packet,
              item = excluded.item,
              published = null
          `,
          catalog.scope,
          catalog.item.id,
          catalog.packet,
          JSON.stringify(catalog.item),
        );
      }
      if (catalog?.replaces) {
        tx.run(
          "delete from team_session_catalog where scope_key = ? and asset_id = ? and json_extract(item, '$.digest') = ?",
          catalog.scope,
          catalog.replaces.id,
          catalog.replaces.digest,
        );
        tx.run(
          "delete from team_session_drafts where scope_key = ? and asset_id = ? and json_extract(item, '$.digest') = ?",
          catalog.scope,
          catalog.replaces.id,
          catalog.replaces.digest,
        );
      }
      signal.throwIfAborted();
      return snapshot;
    });
  }

  async turns(key: string, record: number, offset: number): Promise<TeamSessionTurnsPage> {
    const turns = await this.reader.listSessionTurns(teamSessionKey(key, record), { offset, limit: 51 });
    return { turns: turns.slice(0, 50), offset, hasMore: turns.length > 50 };
  }

  async turn(key: string, record: number, id: string): Promise<SessionTurnDetail | null> {
    return this.reader.getSessionTurn(teamSessionKey(key, record), id);
  }
}
