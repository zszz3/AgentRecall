import { describe, expect, it } from "vitest";
import {
  clearSearchHistory,
  deleteSearch,
  readSearchHistory,
  recordSearch,
  SEARCH_HISTORY_LIMIT,
  SEARCH_HISTORY_STORAGE_KEY,
  type SearchHistoryStorage,
} from "./search-history";

function memoryStorage(initial: string | null = null): SearchHistoryStorage & { value: string | null } {
  return {
    value: initial,
    getItem() {
      return this.value;
    },
    setItem(_key, value) {
      this.value = value;
    },
    removeItem() {
      this.value = null;
    },
  };
}

describe("recent search history", () => {
  it("recovers from malformed and structurally invalid stored values", () => {
    expect(readSearchHistory(memoryStorage("{"))).toEqual([]);
    expect(readSearchHistory(memoryStorage(JSON.stringify({ query: "login" })))).toEqual([]);
    expect(readSearchHistory(memoryStorage(JSON.stringify(["login", 42])))).toEqual([]);
  });

  it("trims, deduplicates, moves repeats to the front, and keeps ten entries", () => {
    const storage = memoryStorage();
    let history: string[] = [];
    history = recordSearch(storage, history, "   ");
    expect(history).toEqual([]);
    for (let index = 0; index < SEARCH_HISTORY_LIMIT + 2; index += 1) {
      history = recordSearch(storage, history, ` query ${index} `);
    }
    expect(history).toHaveLength(SEARCH_HISTORY_LIMIT);
    expect(history[0]).toBe("query 11");
    history = recordSearch(storage, history, "query 5");
    expect(history[0]).toBe("query 5");
    expect(readSearchHistory(storage)).toEqual(history);
  });

  it("normalizes internal whitespace and deduplicates case-insensitively", () => {
    const storage = memoryStorage();
    let history: string[] = [];
    history = recordSearch(storage, history, "  Find   Login  Flow  ");
    expect(history).toEqual(["Find Login Flow"]);
    history = recordSearch(storage, history, "find login flow");
    expect(history).toEqual(["find login flow"]);
    expect(readSearchHistory(memoryStorage(JSON.stringify(["Find   Login Flow", "find login flow", "other"])))).toEqual([
      "Find Login Flow",
      "other",
    ]);
  });

  it("deletes one entry and clears persisted history", () => {
    const storage = memoryStorage();
    let history = recordSearch(storage, [], "first");
    history = recordSearch(storage, history, "second");
    history = deleteSearch(storage, history, "first");
    expect(history).toEqual(["second"]);
    expect(storage.value).toBe(JSON.stringify(["second"]));
    expect(clearSearchHistory(storage)).toEqual([]);
    expect(storage.value).toBeNull();
  });

  it("does not throw when storage reads or writes fail", () => {
    const storage: SearchHistoryStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    expect(readSearchHistory(storage)).toEqual([]);
    expect(recordSearch(storage, [], "login")).toEqual(["login"]);
    expect(deleteSearch(storage, ["login"], "login")).toEqual([]);
    expect(clearSearchHistory(storage)).toEqual([]);
  });

  it("uses the project-specific storage key", () => {
    expect(SEARCH_HISTORY_STORAGE_KEY).toBe("agent-recall-recent-searches");
  });
});
