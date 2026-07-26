export const SEARCH_HISTORY_STORAGE_KEY = "agent-recall-recent-searches";
export const SEARCH_HISTORY_LIMIT = 10;

export interface SearchHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

export function readSearchHistory(storage: SearchHistoryStorage): string[] {
  try {
    const raw = storage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) return [];
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const value of parsed) {
      const normalized = normalizeSearchQuery(value);
      const key = searchHistoryKey(normalized);
      if (!normalized || seen.has(key)) continue;
      unique.push(normalized);
      seen.add(key);
      if (unique.length === SEARCH_HISTORY_LIMIT) break;
    }
    return unique;
  } catch {
    return [];
  }
}

export function recordSearch(storage: SearchHistoryStorage, current: string[], query: string): string[] {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return current;
  const key = searchHistoryKey(normalized);
  const next = [
    normalized,
    ...current.filter((value) => searchHistoryKey(normalizeSearchQuery(value)) !== key),
  ].slice(0, SEARCH_HISTORY_LIMIT);
  persist(storage, next);
  return next;
}

export function deleteSearch(storage: SearchHistoryStorage, current: string[], query: string): string[] {
  const key = searchHistoryKey(normalizeSearchQuery(query));
  const next = current.filter((value) => searchHistoryKey(normalizeSearchQuery(value)) !== key);
  persist(storage, next);
  return next;
}

export function clearSearchHistory(storage: SearchHistoryStorage): string[] {
  try {
    storage.removeItem(SEARCH_HISTORY_STORAGE_KEY);
  } catch {
    // Searching must keep working when localStorage is unavailable.
  }
  return [];
}

function persist(storage: SearchHistoryStorage, history: string[]): void {
  try {
    storage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Keep the returned in-memory state even if persistence is unavailable.
  }
}

function searchHistoryKey(query: string): string {
  return query.toLocaleLowerCase();
}
