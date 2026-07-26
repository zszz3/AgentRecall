import type { SearchOptions } from "../types";
import type { SessionStoreDatabase } from "./database";

export interface SavedSearch {
  id: number;
  name: string;
  options: SearchOptions;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
}

interface SavedSearchRow {
  id: number;
  name: string;
  options_json: string;
  created_at: number;
  last_used_at: number | null;
  use_count: number;
}

export class SavedSearchStore {
  constructor(private readonly db: SessionStoreDatabase) {}

  listSavedSearches(): SavedSearch[] {
    const rows = this.db
      .prepare("SELECT id, name, options_json, created_at, last_used_at, use_count FROM saved_searches ORDER BY use_count DESC, last_used_at DESC, created_at DESC")
      .all() as unknown as SavedSearchRow[];
    return rows.map((row) => this.hydrate(row));
  }

  getSavedSearch(id: number): SavedSearch | null {
    const row = this.db
      .prepare("SELECT id, name, options_json, created_at, last_used_at, use_count FROM saved_searches WHERE id = ?")
      .get(id) as SavedSearchRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  createSavedSearch(name: string, options: SearchOptions): SavedSearch {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Saved search name is required.");
    const now = Date.now();
    const result = this.db
      .prepare("INSERT INTO saved_searches (name, options_json, created_at, use_count) VALUES (?, ?, ?, 0)")
      .run(trimmed, JSON.stringify(options), now);
    const id = Number(result.lastInsertRowid);
    return this.getSavedSearch(id) as SavedSearch;
  }

  deleteSavedSearch(id: number): boolean {
    const result = this.db.prepare("DELETE FROM saved_searches WHERE id = ?").run(id);
    return result.changes > 0;
  }

  touchSavedSearch(id: number): void {
    this.db
      .prepare("UPDATE saved_searches SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?")
      .run(Date.now(), id);
  }

  private hydrate(row: SavedSearchRow): SavedSearch {
    let options: SearchOptions = {};
    try {
      options = JSON.parse(row.options_json) as SearchOptions;
    } catch {
      options = {};
    }
    return {
      id: row.id,
      name: row.name,
      options,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      useCount: row.use_count,
    };
  }
}
