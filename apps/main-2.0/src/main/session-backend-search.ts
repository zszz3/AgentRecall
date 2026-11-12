import type { SessionStore } from "../core/session-store";
import type { SearchOptions } from "../core/types";

const CARD_RESULT_LIMIT = 5;

/**
 * Agent-facing local search: active experience cards first, then matching
 * Sessions. Both the resident backend and the desktop reach it through the same
 * database, so cards extracted by the desktop are visible to CLI and MCP.
 */
export async function searchLocalKnowledge(
  store: SessionStore,
  args: { query: string; source?: string; project?: string; limit: number },
) {
  const cards = args.query
    ? await (await store.memoryCardRepository()).searchActiveCards({ query: args.query, projectPath: args.project, limit: CARD_RESULT_LIMIT })
    : [];
  const sessions = await store.searchSessions({
    query: args.query, source: args.source as SearchOptions["source"], projectPath: args.project, limit: args.limit, excludeSubagents: true,
  });
  return {
    cards: cards.map((card) => ({
      id: card.id, kind: card.kind, problem: card.problem, solution: card.solution, failedAttempts: card.failedAttempts,
      keywords: card.keywords, project: card.projectPath, updatedAt: card.updatedAt, sources: card.sources,
    })),
    sessions: sessions.map((session) => ({
      sessionKey: session.sessionKey, title: session.displayTitle, source: session.source,
      project: session.projectPath, timestamp: session.timestamp, summary: (session.aiSummary ?? session.firstQuestion)?.slice(0, 600) ?? null,
      matchedTurns: session.turnMatchCount ?? 0,
      hits: (session.matchHits ?? []).map((hit) => ({
        turnIndex: hit.turnIndex, messageIndex: hit.messageIndex, role: hit.role, snippet: hit.snippet, matchedTerms: hit.matchedTerms,
      })),
    })),
  };
}
