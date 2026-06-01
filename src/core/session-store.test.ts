import { describe, expect, it } from "vitest";
import { createInMemoryStore } from "./session-store";
import type { IndexedSession, SessionMessage } from "./types";

function sampleSession(overrides: Partial<IndexedSession> = {}): IndexedSession {
  return {
    sessionKey: "codex:abc",
    rawId: "abc",
    source: "codex-cli",
    projectPath: "/repo",
    filePath: "/tmp/rollout.jsonl",
    originalTitle: "修复登录态失效",
    firstQuestion: "修复登录态失效",
    timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
    fileMtimeMs: 10,
    fileSize: 100,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
}

const messages: SessionMessage[] = [
  { role: "user", content: "修复登录态失效", timestamp: "2026-06-01T10:00:00Z", index: 0 },
  { role: "assistant", content: "refresh token expired after 30 minutes", timestamp: "2026-06-01T10:01:00Z", index: 1 },
];

describe("SessionStore", () => {
  it("indexes sessions, searches full text, and returns match snippets", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages);

    const results = store.searchSessions({ query: "refresh token" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sessionKey: "codex:abc",
      displayTitle: "修复登录态失效",
      source: "codex-cli",
    });
    expect(results[0].matchSnippet).toContain("refresh token");
  });

  it("keeps custom title, tags, favorite, pinned, and hidden state separate from reindexing", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages);
    store.setCustomTitle("codex:abc", "Auth bug");
    store.addTag("codex:abc", "backend");
    store.setFavorited("codex:abc", true);
    store.setPinned("codex:abc", true);
    store.setHidden("codex:abc", true);

    store.upsertIndexedSession(sampleSession({ originalTitle: "New extracted title" }), messages);
    const hidden = store.searchSessions({ query: "", visibility: "hidden" });

    expect(hidden[0]).toMatchObject({
      customTitle: "Auth bug",
      displayTitle: "Auth bug",
      favorited: true,
      pinned: true,
      hidden: true,
      tags: ["backend"],
    });
  });

  it("filters favorite sessions while excluding hidden sessions", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:fav", rawId: "fav" }), messages);
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:plain", rawId: "plain" }), messages);
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:hidden-fav", rawId: "hidden-fav" }), messages);

    store.setFavorited("codex:fav", true);
    store.setFavorited("codex:hidden-fav", true);
    store.setHidden("codex:hidden-fav", true);

    expect(store.searchSessions({ visibility: "favorites" }).map((session) => session.sessionKey)).toEqual(["codex:fav"]);
    expect(store.searchSessions({ visibility: "hidden" }).map((session) => session.sessionKey)).toEqual(["codex:hidden-fav"]);
  });

  it("does not search tag names from the text search box, but supports explicit tag filtering", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages);
    store.addTag("codex:abc", "backend");

    expect(store.searchSessions({ query: "backend" })).toHaveLength(0);
    expect(store.searchSessions({ query: "", tag: "backend" })).toHaveLength(1);
  });

  it("adds a branch tag from indexed Codex metadata", () => {
    const store = createInMemoryStore();

    store.upsertIndexedSession(sampleSession({ gitBranch: "feat/session-tags" }), messages);

    expect(store.listTags()).toEqual(["branch:feat/session-tags"]);
    expect(store.searchSessions({ tag: "branch:feat/session-tags" }).map((session) => session.sessionKey)).toEqual(["codex:abc"]);
  });

  it("lists projects with counts and disambiguates duplicate folder names", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codex:one", rawId: "one", projectPath: "/work/team-a/app" }),
      messages,
    );
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "claude:two", rawId: "two", source: "claude-cli", projectPath: "/work/team-a/app" }),
      messages,
    );
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "codex:three", rawId: "three", projectPath: "/work/team-b/app" }),
      messages,
    );
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:no-project", rawId: "no-project", projectPath: "" }), messages);

    expect(store.listProjects()).toEqual([
      { path: "/work/team-a/app", label: "team-a/app", sessionCount: 2 },
      { path: "/work/team-b/app", label: "team-b/app", sessionCount: 1 },
    ]);
  });

  it("filters sessions by exact project path and composes with other filters", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:app", rawId: "app", projectPath: "/work/app" }), messages);
    store.upsertIndexedSession(
      sampleSession({ sessionKey: "claude:app", rawId: "claude-app", source: "claude-cli", projectPath: "/work/app" }),
      messages,
    );
    store.upsertIndexedSession(sampleSession({ sessionKey: "codex:api", rawId: "api", projectPath: "/work/api" }), messages);
    store.addTag("claude:app", "backend");

    expect(store.searchSessions({ projectPath: "/work/app" }).map((session) => session.sessionKey).sort()).toEqual([
      "claude:app",
      "codex:app",
    ]);
    expect(store.searchSessions({ projectPath: "/work/app", source: "claude" }).map((session) => session.sessionKey)).toEqual([
      "claude:app",
    ]);
    expect(store.searchSessions({ projectPath: "/work/app", tag: "backend" }).map((session) => session.sessionKey)).toEqual([
      "claude:app",
    ]);
  });

  it("sorts default results by created time", () => {
    const store = createInMemoryStore();
    const oldButActive = sampleSession({
      sessionKey: "codex:active",
      rawId: "active",
      timestamp: new Date("2026-05-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T12:00:00Z").getTime(),
    });
    const newerButIdle = sampleSession({
      sessionKey: "codex:idle",
      rawId: "idle",
      timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T10:00:00Z").getTime(),
    });
    store.upsertIndexedSession(oldButActive, messages);
    store.upsertIndexedSession(newerButIdle, messages);

    expect(store.searchSessions({ query: "" }).map((session) => session.sessionKey)).toEqual(["codex:idle", "codex:active"]);
  });

  it("sorts by explicit activity, created, and updated time modes", () => {
    const store = createInMemoryStore();
    const oldButUpdated = sampleSession({
      sessionKey: "codex:updated",
      rawId: "updated",
      timestamp: new Date("2026-05-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T12:00:00Z").getTime(),
    });
    const newButIdle = sampleSession({
      sessionKey: "codex:created",
      rawId: "created",
      timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
      fileMtimeMs: new Date("2026-06-01T10:00:00Z").getTime(),
    });
    store.upsertIndexedSession(oldButUpdated, messages);
    store.upsertIndexedSession(newButIdle, messages);

    expect(store.searchSessions({ query: "", sortBy: "activity" }).map((session) => session.sessionKey)).toEqual([
      "codex:updated",
      "codex:created",
    ]);
    expect(store.searchSessions({ query: "", sortBy: "created" }).map((session) => session.sessionKey)).toEqual([
      "codex:created",
      "codex:updated",
    ]);
    expect(store.searchSessions({ query: "", sortBy: "updated" }).map((session) => session.sessionKey)).toEqual([
      "codex:updated",
      "codex:created",
    ]);
  });

  it("deletes tags globally and removes unused tags after unlinking", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), messages);
    store.upsertIndexedSession(sampleSession({ sessionKey: "claude:def", rawId: "def", source: "claude-cli" }), messages);
    store.addTag("codex:abc", "backend");
    store.addTag("claude:def", "backend");
    store.addTag("codex:abc", "solo");

    store.removeTag("codex:abc", "solo");
    expect(store.listTags()).toEqual(["backend"]);

    store.deleteTag("backend");
    expect(store.listTags()).toEqual([]);
    expect(store.searchSessions({ tag: "backend" })).toHaveLength(0);
    expect(store.getSession("claude:def")?.tags).toEqual([]);
  });

  it("loads messages in pages for responsive detail views", () => {
    const store = createInMemoryStore();
    store.upsertIndexedSession(sampleSession(), [
      ...messages,
      { role: "user", content: "third", timestamp: "2026-06-01T10:02:00Z", index: 2 },
    ]);

    expect(store.getMessages("codex:abc", 0, 2).map((message) => message.content)).toEqual([
      "修复登录态失效",
      "refresh token expired after 30 minutes",
    ]);
    expect(store.getMessages("codex:abc", 2, 2).map((message) => message.content)).toEqual(["third"]);
  });
});
