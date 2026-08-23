import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteZcodeSession, deleteZcodeSessions } from "./zcode-session-writer";

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

function databasePath(root: string): string {
  const dbDir = path.join(root, "cli", "db");
  fs.mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, "db.sqlite");
}

function createFixture(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT);
      CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE turn_usage (session_id TEXT NOT NULL, turn_id TEXT NOT NULL);
      CREATE TABLE tool_usage (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
      CREATE TABLE input_history (id TEXT PRIMARY KEY, session_id TEXT, text TEXT NOT NULL);
      CREATE TABLE session_target (session_id TEXT PRIMARY KEY, target TEXT NOT NULL);
    `);
    db.prepare("INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)").run("sess-delete", null, "Delete me");
    db.prepare("INSERT INTO session (id, parent_id, title) VALUES (?, ?, ?)").run("sess-keep", null, "Keep me");
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("msg-delete", "sess-delete", "{}");
    db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("msg-keep", "sess-keep", "{}");
    db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run("part-delete", "msg-delete", "sess-delete", "{}");
    db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run("part-keep", "msg-keep", "sess-keep", "{}");
    db.prepare("INSERT INTO model_usage (id, session_id) VALUES (?, ?)").run("usage-delete", "sess-delete");
    db.prepare("INSERT INTO turn_usage (session_id, turn_id) VALUES (?, ?)").run("sess-delete", "turn-delete");
    db.prepare("INSERT INTO tool_usage (id, session_id) VALUES (?, ?)").run("tool-delete", "sess-delete");
    db.prepare("INSERT INTO input_history (id, session_id, text) VALUES (?, ?, ?)").run("history-delete", "sess-delete", "Delete prompt");
    db.prepare("INSERT INTO input_history (id, session_id, text) VALUES (?, ?, ?)").run("history-keep", "sess-keep", "Keep prompt");
    db.prepare("INSERT INTO session_target (session_id, target) VALUES (?, ?), (?, ?)").run(
      "sess-delete", "delete-target", "sess-keep", "keep-target",
    );
  } finally {
    db.close();
  }
}

function createTaskIndexFixture(root: string): string {
  const taskIndexDirectory = path.join(root, "v2");
  fs.mkdirSync(taskIndexDirectory, { recursive: true });
  const taskIndexPath = path.join(taskIndexDirectory, "tasks-index.sqlite");
  const db = new DatabaseSync(taskIndexPath);
  try {
    db.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT)");
    db.prepare("INSERT INTO tasks (task_id, title) VALUES (?, ?), (?, ?)").run(
      "sess-delete", "Delete me", "sess-keep", "Keep me",
    );
  } finally {
    db.close();
  }
  return taskIndexPath;
}

describe("ZCode session writer", () => {
  it("deletes one session and all supported related records without touching other sessions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);
    const taskIndexPath = createTaskIndexFixture(root);

    expect(deleteZcodeSession(dbPath, "sess-delete")).toBe(true);

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([{ id: "sess-keep" }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM part WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM model_usage WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM turn_usage WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM tool_usage WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM input_history WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_target WHERE session_id = ?").get("sess-delete")).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get("sess-keep")).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM input_history WHERE session_id = ?").get("sess-keep")).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM session_target WHERE session_id = ?").get("sess-keep")).toEqual({ count: 1 });
    } finally {
      db.close();
    }
    const taskIndex = new DatabaseSync(taskIndexPath);
    try {
      expect(taskIndex.prepare("SELECT task_id FROM tasks ORDER BY task_id").all()).toEqual([{ task_id: "sess-keep" }]);
    } finally {
      taskIndex.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false for a missing session and refuses non-ZCode paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-missing-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);

    expect(deleteZcodeSession(dbPath, "does-not-exist")).toBe(false);
    expect(() => deleteZcodeSession(path.join(root, "other.sqlite"), "sess-delete")).toThrow(/non-ZCode database path/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("deletes multiple sessions from one shared database operation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-many-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);
    const taskIndexPath = createTaskIndexFixture(root);

    expect(deleteZcodeSessions(dbPath, ["sess-delete", "sess-keep", "sess-delete"])).toEqual(["sess-delete", "sess-keep"]);

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("SELECT id FROM session").all()).toEqual([]);
      expect(db.prepare("SELECT session_id FROM message").all()).toEqual([]);
      expect(db.prepare("SELECT session_id FROM part").all()).toEqual([]);
    } finally {
      db.close();
    }
    const taskIndex = new DatabaseSync(taskIndexPath);
    try {
      expect(taskIndex.prepare("SELECT task_id FROM tasks").all()).toEqual([]);
    } finally {
      taskIndex.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back the main database when the task index deletion fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-zcode-delete-rollback-"));
    const dbPath = databasePath(root);
    createFixture(dbPath);
    const taskIndexPath = createTaskIndexFixture(root);
    const taskIndex = new DatabaseSync(taskIndexPath);
    try {
      taskIndex.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TRIGGER reject_task_delete
        BEFORE DELETE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'task deletion rejected');
        END;
      `);
    } finally {
      taskIndex.close();
    }

    try {
      expect(() => deleteZcodeSession(dbPath, "sess-delete")).toThrow("task deletion rejected");
      const mainDatabase = new DatabaseSync(dbPath);
      try {
        expect(mainDatabase.prepare("SELECT id FROM session WHERE id = ?").get("sess-delete")).toEqual({ id: "sess-delete" });
      } finally {
        mainDatabase.close();
      }
      const remainingTaskIndex = new DatabaseSync(taskIndexPath);
      try {
        expect(remainingTaskIndex.prepare("SELECT task_id FROM tasks WHERE task_id = ?").get("sess-delete")).toEqual({ task_id: "sess-delete" });
      } finally {
        remainingTaskIndex.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
