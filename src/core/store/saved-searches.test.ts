import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSessionStore } from "./schema";
import { SavedSearchStore } from "./saved-searches";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function createStore(): SavedSearchStore {
  const db = new DatabaseSync(":memory:");
  migrateSessionStore(db);
  return new SavedSearchStore(db);
}

describe("SavedSearchStore", () => {
  it("creates and lists saved searches", () => {
    const store = createStore();
    const created = store.createSavedSearch("My bugs", { query: "bug", source: "codex-cli" });
    expect(created.name).toBe("My bugs");
    expect(created.options).toMatchObject({ query: "bug", source: "codex-cli" });
    expect(created.useCount).toBe(0);

    const list = store.listSavedSearches();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("My bugs");
  });

  it("rejects empty names", () => {
    const store = createStore();
    expect(() => store.createSavedSearch("   ", {})).toThrow(/name is required/i);
  });

  it("rejects duplicate names", () => {
    const store = createStore();
    store.createSavedSearch("dup", {});
    expect(() => store.createSavedSearch("dup", {})).toThrow();
  });

  it("deletes a saved search", () => {
    const store = createStore();
    const created = store.createSavedSearch("to delete", {});
    expect(store.deleteSavedSearch(created.id)).toBe(true);
    expect(store.listSavedSearches()).toHaveLength(0);
    expect(store.deleteSavedSearch(created.id)).toBe(false);
  });

  it("increments use count and updates last used on touch", () => {
    const store = createStore();
    const created = store.createSavedSearch("frequent", {});
    store.touchSavedSearch(created.id);
    store.touchSavedSearch(created.id);
    const fetched = store.getSavedSearch(created.id);
    expect(fetched?.useCount).toBe(2);
    expect(fetched?.lastUsedAt).not.toBeNull();
  });

  it("orders by use count descending", () => {
    const store = createStore();
    const a = store.createSavedSearch("rare", {});
    const b = store.createSavedSearch("often", {});
    store.touchSavedSearch(b.id);
    store.touchSavedSearch(b.id);
    store.touchSavedSearch(a.id);
    const list = store.listSavedSearches();
    expect(list[0].name).toBe("often");
    expect(list[1].name).toBe("rare");
  });
});
