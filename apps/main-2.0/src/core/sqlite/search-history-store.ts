import type { SearchHistoryEntry } from "../store/search-history-store";
import type { SearchOptions } from "../types";
import type { SearchHistoryRepository } from "../storage/repositories";
import type { SqliteDatabase, SqliteQueryable } from "./database";
import { sqliteTime } from "./values";

interface SearchHistoryRow extends Record<string, unknown> {
  id: number;
  query: string;
  result_count: number;
  searched_at: number;
  options: string | null;
}

const MAX_HISTORY_ENTRIES = 100;

export class SqliteSearchHistoryStore implements SearchHistoryRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async recordSearch(query: string, resultCount: number, options?: SearchOptions): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) return;
    this.database.transactionSync((tx) => {
      tx.run("DELETE FROM search_history WHERE query = ?", trimmed);
      tx.run(
        `INSERT INTO search_history (query, result_count, searched_at, options)
         VALUES (?, ?, ?, ?)`,
        trimmed,
        resultCount,
        Date.now(),
        options ? JSON.stringify(options) : null,
      );
      this.prune(tx);
    });
  }

  async listRecentSearches(limit = 20): Promise<SearchHistoryEntry[]> {
    const rows = this.database.all<SearchHistoryRow>(
      `SELECT id, query, result_count, searched_at, options
       FROM search_history
       ORDER BY searched_at DESC, id DESC
       LIMIT ?`,
      boundedLimit(limit),
    );
    return rows.map((row) => this.hydrate(row));
  }

  async searchHistory(query: string, limit = 20): Promise<SearchHistoryEntry[]> {
    const pattern = `%${query.trim().toLowerCase()}%`;
    const rows = this.database.all<SearchHistoryRow>(
      `SELECT id, query, result_count, searched_at, options
       FROM search_history
       WHERE lower(query) LIKE ?
       ORDER BY searched_at DESC, id DESC
       LIMIT ?`,
      pattern,
      boundedLimit(limit),
    );
    return rows.map((row) => this.hydrate(row));
  }

  async clearHistory(): Promise<void> {
    this.database.run("DELETE FROM search_history");
  }

  async deleteEntry(id: number): Promise<boolean> {
    const result = this.database.run("DELETE FROM search_history WHERE id = ?", id);
    return result.changes > 0;
  }

  private prune(database: SqliteQueryable): void {
    database.run(
      `DELETE FROM search_history
       WHERE id NOT IN (
         SELECT id
         FROM search_history
         ORDER BY searched_at DESC, id DESC
         LIMIT ?
       )`,
      MAX_HISTORY_ENTRIES,
    );
  }

  private hydrate(row: SearchHistoryRow): SearchHistoryEntry {
    let options: SearchOptions | null = null;
    if (row.options) {
      try {
        options = JSON.parse(row.options) as SearchOptions;
      } catch {
        options = null;
      }
    }
    return {
      id: Number(row.id),
      query: row.query,
      resultCount: Number(row.result_count),
      searchedAt: sqliteTime(row.searched_at),
      options,
    };
  }
}

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(100, Math.floor(limit)));
}
