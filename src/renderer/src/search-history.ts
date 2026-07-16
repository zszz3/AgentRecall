export const SEARCH_HISTORY_STORAGE_KEY = "agent-recall-recent-searches";
export const SEARCH_HISTORY_LIMIT = 10;

export interface SearchHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readSearchHistory(storage: SearchHistoryStorage): string[] {
  try {
    const raw = storage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) return [];
    const unique: string[] = [];
    for (const value of parsed) {
      const normalized = value.trim();
      if (!normalized || unique.includes(normalized)) continue;
      unique.push(normalized);
      if (unique.length === SEARCH_HISTORY_LIMIT) break;
    }
    return unique;
  } catch {
    return [];
  }
}

export function recordSearch(storage: SearchHistoryStorage, current: string[], query: string): string[] {
  const normalized = query.trim();
  if (!normalized) return current;
  const next = [normalized, ...current.filter((value) => value !== normalized)].slice(0, SEARCH_HISTORY_LIMIT);
  persist(storage, next);
  return next;
}

export function deleteSearch(storage: SearchHistoryStorage, current: string[], query: string): string[] {
  const next = current.filter((value) => value !== query);
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
