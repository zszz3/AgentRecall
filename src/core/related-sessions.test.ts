import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { findRelatedSessions } from "./related-sessions";
import { migrateSessionStore } from "./store/schema";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

const DAY = 24 * 60 * 60 * 1000;
const BASE_TIME = 1_720_000_000_000;

function setupDb(): DatabaseSyncType {
  const db = new DatabaseSync(":memory:");
  migrateSessionStore(db);
  return db;
}

function insertSession(
  db: DatabaseSyncType,
  sessionKey: string,
  overrides: { title?: string; source?: string; project?: string; timestamp?: number } = {},
): void {
  db.prepare(
    `INSERT INTO sessions (
       session_key, raw_id, source, environment_id, project_path, file_path,
       original_title, first_question, timestamp, file_mtime_ms, file_size
     ) VALUES (?, ?, ?, 'local', ?, ?, ?, ?, ?, 0, 0)`,
  ).run(
    sessionKey,
    sessionKey,
    overrides.source ?? "codex-cli",
    overrides.project ?? "/work/app",
    `/tmp/${sessionKey}.jsonl`,
    overrides.title ?? "Untitled",
    overrides.title ?? "Untitled",
    overrides.timestamp ?? BASE_TIME,
  );
}

function addTag(db: DatabaseSyncType, sessionKey: string, tagName: string): void {
  db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tagName);
  const tag = db.prepare("SELECT id FROM tags WHERE name = ?").get(tagName) as { id: number };
  db.prepare("INSERT OR IGNORE INTO session_tags (session_key, tag_id) VALUES (?, ?)").run(sessionKey, tag.id);
}

describe("findRelatedSessions", () => {
  it("returns empty for an unknown session", () => {
    const db = setupDb();
    expect(findRelatedSessions(db, "missing")).toEqual([]);
  });

  it("ranks same-project sessions higher", () => {
    const db = setupDb();
    insertSession(db, "target", { project: "/work/app" });
    insertSession(db, "same-project", { project: "/work/app", timestamp: BASE_TIME + 30 * DAY });
    insertSession(db, "other-project", { project: "/work/other", timestamp: BASE_TIME + 30 * DAY });

    const related = findRelatedSessions(db, "target");
    expect(related.map((r) => r.sessionKey)).toContain("same-project");
    const sameProject = related.find((r) => r.sessionKey === "same-project");
    expect(sameProject!.score).toBeGreaterThanOrEqual(30);
  });

  it("adds score for shared tags", () => {
    const db = setupDb();
    insertSession(db, "target", {});
    insertSession(db, "tagged-peer", { timestamp: BASE_TIME + 30 * DAY });
    addTag(db, "target", "auth");
    addTag(db, "tagged-peer", "auth");

    const related = findRelatedSessions(db, "target");
    const peer = related.find((r) => r.sessionKey === "tagged-peer");
    expect(peer).toBeDefined();
    expect(peer!.sharedTags).toContain("auth");
    expect(peer!.score).toBeGreaterThanOrEqual(20);
  });

  it("rewards temporal proximity within seven days", () => {
    const db = setupDb();
    insertSession(db, "target", { title: "Alpha topic" });
    insertSession(db, "recent", { title: "Beta subject", project: "/work/other", source: "claude-cli", timestamp: BASE_TIME + 2 * DAY });
    insertSession(db, "old", { title: "Gamma matter", project: "/work/other", source: "claude-cli", timestamp: BASE_TIME + 30 * DAY });

    const related = findRelatedSessions(db, "target");
    const recent = related.find((r) => r.sessionKey === "recent");
    const old = related.find((r) => r.sessionKey === "old");
    // recent gets +15 time bonus; old gets nothing (different project/source, outside window)
    expect(recent).toBeDefined();
    expect(recent!.score).toBeGreaterThanOrEqual(15);
    expect(old).toBeUndefined();
  });

  it("rewards title keyword overlap", () => {
    const db = setupDb();
    insertSession(db, "target", { title: "Fix login redirect bug" });
    insertSession(db, "keyword-peer", { title: "Debug login redirect issue", timestamp: BASE_TIME + 30 * DAY });

    const related = findRelatedSessions(db, "target");
    const peer = related.find((r) => r.sessionKey === "keyword-peer");
    expect(peer).toBeDefined();
    expect(peer!.score).toBeGreaterThanOrEqual(10);
  });

  it("excludes hidden sessions and the target itself", () => {
    const db = setupDb();
    insertSession(db, "target", {});
    insertSession(db, "hidden-peer", {});
    db.prepare("UPDATE sessions SET hidden = 1 WHERE session_key = 'hidden-peer'").run();

    const related = findRelatedSessions(db, "target");
    expect(related.every((r) => r.sessionKey !== "target")).toBe(true);
    expect(related.every((r) => r.sessionKey !== "hidden-peer")).toBe(true);
  });

  it("respects the limit and sorts by score", () => {
    const db = setupDb();
    insertSession(db, "target", {});
    for (let i = 0; i < 12; i++) {
      insertSession(db, `peer-${i}`, { timestamp: BASE_TIME + (i + 1) * DAY });
    }
    const related = findRelatedSessions(db, "target", 5);
    expect(related).toHaveLength(5);
    for (let i = 1; i < related.length; i++) {
      expect(related[i - 1].score).toBeGreaterThanOrEqual(related[i].score);
    }
  });
});
