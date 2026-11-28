import type { SavedSearch } from "../storage/types";
import type { SearchOptions } from "../types";
import type { SavedSearchRepository } from "../storage/repositories";
import type { SqliteQueryable } from "./database";
import { sqliteOptionalTime, sqliteTime } from "./values";

interface SavedSearchRow extends Record<string, unknown> {
  id: number;
  name: string;
  options: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
}

export class SqliteSavedSearchStore implements SavedSearchRepository {
  constructor(private readonly database: SqliteQueryable) {}

  async listSavedSearches(): Promise<SavedSearch[]> {
    const rows = this.database.all<SavedSearchRow>(
      `SELECT id, name, options, created_at, last_used_at, use_count
       FROM saved_searches
       ORDER BY use_count DESC, last_used_at DESC NULLS LAST, created_at DESC`,
    );
    return rows.map((row) => this.hydrate(row));
  }

  async getSavedSearch(id: number): Promise<SavedSearch | null> {
    const row = this.database.get<SavedSearchRow>(
      `SELECT id, name, options, created_at, last_used_at, use_count
       FROM saved_searches
       WHERE id = ?`,
      id,
    );
    return row ? this.hydrate(row) : null;
  }

  async createSavedSearch(name: string, options: SearchOptions): Promise<SavedSearch> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Saved search name is required.");
    const normalizedOptions = normalizeSavedSearchOptions(options);
    const row = this.database.get<SavedSearchRow>(
      `INSERT INTO saved_searches (name, options, created_at, use_count)
       VALUES (?, ?, ?, 0)
       RETURNING id, name, options, created_at, last_used_at, use_count`,
      trimmed,
      JSON.stringify(normalizedOptions),
      Date.now(),
    );
    if (!row) throw new Error("Failed to create saved search.");
    return this.hydrate(row);
  }

  async deleteSavedSearch(id: number): Promise<boolean> {
    const result = this.database.run("DELETE FROM saved_searches WHERE id = ?", id);
    return result.changes > 0;
  }

  async touchSavedSearch(id: number): Promise<void> {
    this.database.run(
      `UPDATE saved_searches
       SET last_used_at = ?, use_count = use_count + 1
       WHERE id = ?`,
      Date.now(),
      id,
    );
  }

  private hydrate(row: SavedSearchRow): SavedSearch {
    let rawOptions: unknown = {};
    try {
      rawOptions = JSON.parse(row.options) as unknown;
    } catch {
      rawOptions = {};
    }
    return {
      id: Number(row.id),
      name: row.name,
      options: normalizeSavedSearchOptions(rawOptions),
      createdAt: sqliteTime(row.created_at),
      lastUsedAt: sqliteOptionalTime(row.last_used_at),
      useCount: Number(row.use_count),
    };
  }
}

function normalizeSavedSearchOptions(value: unknown): SearchOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const options = { ...(value as Record<string, unknown>) };
  if (options.visibility === "pinned") options.visibility = "favorites";
  delete options.prioritizePinned;
  return options as SearchOptions;
}
