import { createHash } from "node:crypto";
import type { TeamSessionContent, TeamSessionSnapshot, TeamSessionTurnsPage } from "../../shared/team-sessions";
import type { SessionMessage, SessionTraceEvent, SessionTurnDetail } from "../types";
import { isSessionSource } from "../session-sources";
import { deriveSessionTimeline, TURN_DERIVATION_VERSION, type DerivedSessionTimeline } from "../turns/derive-turns";
import { PostgresSessionRepository } from "./session-repository";
import { PostgresSessionTurnRepository } from "./session-turn-repository";
import { postgresJsonValue } from "./session-records";
import type { PostgresDatabase } from "./database";

export const TEAM_SESSION_CACHE_VERSION = 1;
const scopedId = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const sessionKey = (key: string, record: number) => `team:${key}:${record}`;

/** Team provenance is separate; messages, events and turns use the ordinary Session tables and repositories. */
export class PostgresTeamSessionRepository {
  private readonly reader: PostgresSessionTurnRepository;
  constructor(private readonly database: PostgresDatabase) { this.reader = new PostgresSessionTurnRepository(database); }

  async get(key: string): Promise<TeamSessionSnapshot | null> {
    const result = await this.database.query<{ metadata: TeamSessionSnapshot }>(
      "select metadata from agent_recall.team_session_snapshots where cache_key = $1", [key]);
    return result.rows[0]?.metadata ?? null;
  }

  async import(key: string, content: TeamSessionContent, signal: AbortSignal, origin: { repository: string; assetId: number; digest: string }): Promise<TeamSessionSnapshot> {
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
              toolText: turn.toolNames.join(" "), searchText: turn.messages.map(message => message.content).join("\n"),
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
        snapshot.records.push({ sessionKey: record.session.sessionKey, title: record.session.displayTitle || record.session.originalTitle, turnCount: Number(count.rows[0].turn_count) });
      }
      await client.query("update agent_recall.team_session_snapshots set metadata = $2 where cache_key = $1", [key, JSON.stringify(snapshot)]);
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
