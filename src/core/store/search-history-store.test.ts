import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSessionStore } from "./schema";
import { SearchHistoryStore } from "./search-history-store";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function createStore(): SearchHistoryStore {
  const db = new DatabaseSync(":memory:");
  migrateSessionStore(db);
  return new SearchHistoryStore(db);
}

describe("SearchHistoryStore", () => {
  it("records and lists recent searches", () => {
    const store = createStore();
    store.recordSearch("login bug", 3);
    store.recordSearch("token refresh", 5);
    const recent = store.listRecentSearches();
    expect(recent).toHaveLength(2);
    expect(recent[0].query).toBe("token refresh");
    expect(recent[0].resultCount).toBe(5);
  });

  it("ignores empty queries", () => {
    const store = createStore();
    store.recordSearch("   ", 0);
    expect(store.listRecentSearches()).toHaveLength(0);
  });

  it("deduplicates identical queries, keeping the latest", () => {
    const store = createStore();
    store.recordSearch("same query", 1);
    store.recordSearch("same query", 9);
    const recent = store.listRecentSearches();
    expect(recent).toHaveLength(1);
    expect(recent[0].resultCount).toBe(9);
  });

  it("filters history by substring", () => {
    const store = createStore();
    store.recordSearch("fix login", 2);
    store.recordSearch("refactor auth", 4);
    store.recordSearch("login page css", 1);
    const matches = store.searchHistory("login");
    expect(matches).toHaveLength(2);
    expect(matches.every((entry) => entry.query.includes("login"))).toBe(true);
  });

  it("clears all history", () => {
    const store = createStore();
    store.recordSearch("a", 1);
    store.recordSearch("b", 2);
    store.clearHistory();
    expect(store.listRecentSearches()).toHaveLength(0);
  });

  it("deletes a single entry", () => {
    const store = createStore();
    store.recordSearch("keep", 1);
    store.recordSearch("remove", 2);
    const entry = store.listRecentSearches().find((item) => item.query === "remove");
    expect(store.deleteEntry(entry!.id)).toBe(true);
    expect(store.listRecentSearches().map((item) => item.query)).toEqual(["keep"]);
  });

  it("stores options alongside the query", () => {
    const store = createStore();
    store.recordSearch("scoped", 3, { source: "qoder", tag: "urgent" });
    const [entry] = store.listRecentSearches();
    expect(entry.options).toMatchObject({ source: "qoder", tag: "urgent" });
  });
});
