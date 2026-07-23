import type { SearchOptions } from "../types";
import type { SessionStoreDatabase } from "./database";

export interface SearchHistoryEntry {
  id: number;
  query: string;
  resultCount: number;
  searchedAt: number;
  options: SearchOptions | null;
}

interface SearchHistoryRow {
  id: number;
  query: string;
  result_count: number;
  searched_at: number;
  options_json: string | null;
}

const MAX_HISTORY_ENTRIES = 100;

export class SearchHistoryStore {
  constructor(private readonly db: SessionStoreDatabase) {}

  recordSearch(query: string, resultCount: number, options?: SearchOptions): void {
    const trimmed = query.trim();
    if (!trimmed) return;
    const now = Date.now();
    const optionsJson = options ? JSON.stringify(options) : null;
    // Deduplicate: update the existing entry for the same query, bumping it to the top.
    this.db.prepare("DELETE FROM search_history WHERE query = ?").run(trimmed);
    this.db
      .prepare("INSERT INTO search_history (query, result_count, searched_at, options_json) VALUES (?, ?, ?, ?)")
      .run(trimmed, resultCount, now, optionsJson);
    this.prune();
  }

  listRecentSearches(limit = 20): SearchHistoryEntry[] {
    const rows = this.db
      .prepare("SELECT id, query, result_count, searched_at, options_json FROM search_history ORDER BY searched_at DESC, id DESC LIMIT ?")
      .all(limit) as unknown as SearchHistoryRow[];
    return rows.map((row) => this.hydrate(row));
  }

  searchHistory(query: string, limit = 20): SearchHistoryEntry[] {
    const pattern = `%${query.trim()}%`;
    const rows = this.db
      .prepare("SELECT id, query, result_count, searched_at, options_json FROM search_history WHERE query LIKE ? ORDER BY searched_at DESC, id DESC LIMIT ?")
      .all(pattern, limit) as unknown as SearchHistoryRow[];
    return rows.map((row) => this.hydrate(row));
  }

  clearHistory(): void {
    this.db.prepare("DELETE FROM search_history").run();
  }

  deleteEntry(id: number): boolean {
    const result = this.db.prepare("DELETE FROM search_history WHERE id = ?").run(id);
    return result.changes > 0;
  }

  private prune(): void {
    this.db
      .prepare("DELETE FROM search_history WHERE id NOT IN (SELECT id FROM search_history ORDER BY searched_at DESC, id DESC LIMIT ?)")
      .run(MAX_HISTORY_ENTRIES);
  }

  private hydrate(row: SearchHistoryRow): SearchHistoryEntry {
    let options: SearchOptions | null = null;
    if (row.options_json) {
      try {
        options = JSON.parse(row.options_json) as SearchOptions;
      } catch {
        options = null;
      }
    }
    return {
      id: row.id,
      query: row.query,
      resultCount: row.result_count,
      searchedAt: row.searched_at,
      options,
    };
  }
}
