import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteZcodeSession } from "./zcode-session-writer";

const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

describe("ZCode session writer", () => {
  it("deletes session targets without touching targets for retained sessions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-zcode-delete-"));
    const dbDirectory = path.join(root, "cli", "db");
    fs.mkdirSync(dbDirectory, { recursive: true });
    const dbPath = path.join(dbDirectory, "db.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY);
        CREATE TABLE session_target (session_id TEXT PRIMARY KEY, target TEXT NOT NULL);
        INSERT INTO session (id) VALUES ('sess-delete'), ('sess-keep');
        INSERT INTO session_target (session_id, target)
          VALUES ('sess-delete', 'delete-target'), ('sess-keep', 'keep-target');
      `);
    } finally {
      db.close();
    }

    try {
      expect(deleteZcodeSession(dbPath, "sess-delete")).toBe(true);
      const resultDatabase = new DatabaseSync(dbPath);
      try {
        expect(resultDatabase.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([
          { id: "sess-keep" },
        ]);
        expect(resultDatabase.prepare("SELECT * FROM session_target ORDER BY session_id").all()).toEqual([
          { session_id: "sess-keep", target: "keep-target" },
        ]);
      } finally {
        resultDatabase.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
