import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { findSessionFamily } from "./session-family";
import { migrateSessionStore } from "./store/schema";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function setupDb(): DatabaseSyncType {
  const db = new DatabaseSync(":memory:");
  migrateSessionStore(db);
  db.prepare(
    `INSERT INTO environments (
      id, kind, label, auth_mode, enabled, sync_state, created_at, updated_at
    ) VALUES ('ssh-dev', 'ssh', 'SSH dev', 'none', 1, 'idle', 1, 1)`,
  ).run();
  return db;
}

function insertSession(
  db: DatabaseSyncType,
  input: {
    sessionKey: string;
    rawId: string;
    title: string;
    parentSessionId?: string | null;
    source?: string;
    environmentId?: string;
    timestamp?: number;
    hidden?: boolean;
    messageCount?: number;
    aiSummary?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO sessions (
      session_key, raw_id, source, environment_id, project_path, file_path,
      original_title, first_question, timestamp, file_mtime_ms, file_size,
      hidden, message_count, ai_summary, is_subagent, parent_session_id
    ) VALUES (?, ?, ?, ?, '/repo', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
  ).run(
    input.sessionKey,
    input.rawId,
    input.source ?? "codex-cli",
    input.environmentId ?? "local",
    `/tmp/${input.rawId}.jsonl`,
    input.title,
    input.title,
    input.timestamp ?? 1,
    input.hidden ? 1 : 0,
    input.messageCount ?? 1,
    input.aiSummary ?? null,
    input.parentSessionId ? 1 : 0,
    input.parentSessionId ?? null,
  );
}

describe("findSessionFamily", () => {
  it("returns an empty family for an unknown session", () => {
    const db = setupDb();

    expect(findSessionFamily(db, "missing")).toEqual({
      parent: null,
      children: [],
      truncated: false,
    });
  });

  it("builds an ordered descendant tree and returns the direct parent", () => {
    const db = setupDb();
    insertSession(db, { sessionKey: "codex:root", rawId: "root", title: "Root" });
    insertSession(db, {
      sessionKey: "codex:child-b",
      rawId: "child-b",
      title: "Child B",
      parentSessionId: "root",
      timestamp: 3,
    });
    insertSession(db, {
      sessionKey: "codex:child-a",
      rawId: "child-a",
      title: "Child A",
      parentSessionId: "root",
      timestamp: 2,
      messageCount: 4,
      aiSummary: "Investigated the first task.",
    });
    insertSession(db, {
      sessionKey: "codex:grandchild",
      rawId: "grandchild",
      title: "Grandchild",
      parentSessionId: "child-a",
      timestamp: 4,
    });

    const family = findSessionFamily(db, "codex:root");
    expect(family.children.map((node) => node.sessionKey)).toEqual([
      "codex:child-a",
      "codex:child-b",
    ]);
    expect(family.children[0]).toMatchObject({
      messageCount: 4,
      aiSummary: "Investigated the first task.",
      environmentLabel: "Local",
    });
    expect(family.children[0].children[0].sessionKey).toBe("codex:grandchild");
    expect(family.truncated).toBe(false);

    expect(findSessionFamily(db, "codex:child-a").parent).toMatchObject({
      sessionKey: "codex:root",
      title: "Root",
    });
  });

  it("does not cross source or environment boundaries and excludes explicitly hidden children", () => {
    const db = setupDb();
    insertSession(db, { sessionKey: "codex:root", rawId: "root", title: "Root" });
    insertSession(db, {
      sessionKey: "codex:visible",
      rawId: "visible",
      title: "Visible",
      parentSessionId: "root",
    });
    insertSession(db, {
      sessionKey: "codex:hidden",
      rawId: "hidden",
      title: "Hidden",
      parentSessionId: "root",
      hidden: true,
    });
    insertSession(db, {
      sessionKey: "ssh:duplicate",
      rawId: "duplicate",
      title: "SSH duplicate",
      parentSessionId: "root",
      environmentId: "ssh-dev",
    });
    insertSession(db, {
      sessionKey: "claude:duplicate",
      rawId: "duplicate",
      title: "Claude duplicate",
      parentSessionId: "root",
      source: "claude-cli",
    });

    expect(findSessionFamily(db, "codex:root").children.map((node) => node.sessionKey)).toEqual([
      "codex:visible",
    ]);
  });

  it("marks cyclic relationships as truncated without repeating nodes", () => {
    const db = setupDb();
    insertSession(db, {
      sessionKey: "codex:cycle-a",
      rawId: "cycle-a",
      title: "Cycle A",
      parentSessionId: "cycle-b",
    });
    insertSession(db, {
      sessionKey: "codex:cycle-b",
      rawId: "cycle-b",
      title: "Cycle B",
      parentSessionId: "cycle-a",
    });

    const family = findSessionFamily(db, "codex:cycle-a");
    expect(family.children.map((node) => node.sessionKey)).toEqual(["codex:cycle-b"]);
    expect(family.children[0].children).toEqual([]);
    expect(family.truncated).toBe(true);
  });
});
