import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./session-store";

describe("durable message bookmarks", () => {
  it("reopens persisted bookmarks without changing saved searches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "message-bookmarks-"));
    let store: SessionStore | undefined;
    try {
      const file = join(directory, "sessions.sqlite");
      store = new SessionStore(file);
      store.createSavedSearch("Existing search", { query: "hello" });
      const bookmark = { sessionKey: "codex:fixture", messageIndex: 0, fingerprint: "a".repeat(64), title: "Fixture", excerpt: "hello", createdAt: 1 };
      store.saveMessageBookmark(bookmark);
      store.close(); store = undefined;
      store = new SessionStore(file);
      expect(store.listMessageBookmarks(bookmark.sessionKey)).toEqual([bookmark]);
      expect(store.listSavedSearches()[0].name).toBe("Existing search");
    } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
