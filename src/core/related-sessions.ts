import type { SessionStoreDatabase } from "./store/database";

export interface RelatedSession {
  sessionKey: string;
  title: string;
  source: string;
  projectPath: string;
  timestamp: number;
  score: number;
  sharedTags: string[];
}

interface CandidateRow {
  session_key: string;
  original_title: string;
  custom_title: string | null;
  first_question: string;
  source: string;
  project_path: string;
  timestamp: number;
}

const RELATED_LIMIT_DEFAULT = 8;
const TIME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Finds sessions related to the given one, scored by:
 *   same project +30, shared tag +20 each, same agent +10,
 *   temporal proximity (within 7 days) +15, title keyword overlap +5 each.
 */
export function findRelatedSessions(
  db: SessionStoreDatabase,
  sessionKey: string,
  limit = RELATED_LIMIT_DEFAULT,
): RelatedSession[] {
  const target = db
    .prepare("SELECT session_key, original_title, custom_title, first_question, source, project_path, timestamp FROM sessions WHERE session_key = ?")
    .get(sessionKey) as CandidateRow | undefined;
  if (!target) return [];

  const targetTags = getTagsForSession(db, sessionKey);
  const targetKeywords = extractKeywords(displayTitle(target));

  const candidates = db
    .prepare(
      `SELECT session_key, original_title, custom_title, first_question, source, project_path, timestamp
       FROM sessions
       WHERE session_key <> ? AND hidden = 0
       ORDER BY timestamp DESC
       LIMIT 500`,
    )
    .all(sessionKey) as unknown as CandidateRow[];

  const scored: RelatedSession[] = [];
  for (const candidate of candidates) {
    let score = 0;
    if (candidate.project_path && candidate.project_path === target.project_path) score += 30;
    if (candidate.source === target.source) score += 10;
    if (Math.abs(candidate.timestamp - target.timestamp) <= TIME_WINDOW_MS) score += 15;

    const candidateTags = getTagsForSession(db, candidate.session_key);
    const sharedTags = targetTags.filter((tag) => candidateTags.includes(tag));
    score += sharedTags.length * 20;

    const candidateKeywords = extractKeywords(displayTitle(candidate));
    const overlap = targetKeywords.filter((word) => candidateKeywords.includes(word)).length;
    score += overlap * 5;

    if (score <= 0) continue;
    scored.push({
      sessionKey: candidate.session_key,
      title: displayTitle(candidate),
      source: candidate.source,
      projectPath: candidate.project_path,
      timestamp: candidate.timestamp,
      score,
      sharedTags,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
  return scored.slice(0, limit);
}

function displayTitle(row: CandidateRow): string {
  return row.custom_title || row.original_title || row.first_question || "Untitled Session";
}

function getTagsForSession(db: SessionStoreDatabase, sessionKey: string): string[] {
  const rows = db
    .prepare("SELECT tags.name FROM session_tags JOIN tags ON tags.id = session_tags.tag_id WHERE session_tags.session_key = ?")
    .all(sessionKey) as Array<{ name: string }>;
  return rows.map((row) => row.name.toLowerCase());
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
  "is", "are", "was", "were", "be", "been", "do", "does", "did", "will", "would", "can",
  "could", "should", "may", "might", "this", "that", "these", "those", "it", "its", "as",
  "from", "about", "into", "over", "under", "up", "down", "out", "off", "then", "than",
  "so", "such", "no", "not", "only", "own", "same", "too", "very", "just", "also", "how",
  "what", "when", "where", "which", "who", "why", "帮我", "请", "怎么", "如何", "什么", "一下",
]);

function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
}
