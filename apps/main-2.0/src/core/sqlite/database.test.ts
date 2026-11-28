import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "./database";
import { SQLITE_MIGRATIONS } from "./schema";

describe("SqliteDatabase & schema", () => {
  const tempDirs: string[] = [];
  const openDbs: SqliteDatabase[] = [];

  afterEach(async () => {
    for (const db of openDbs.splice(0)) {
      await db.close().catch(() => undefined);
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDbPath(name = "agent-recall.sqlite"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-sqlite-test-"));
    tempDirs.push(dir);
    return path.join(dir, name);
  }

  it("enables WAL, foreign keys, applies migrations idempotently, and rolls back failed migrations", async () => {
    const dbPath = makeTempDbPath();
    const db = SqliteDatabase.open(dbPath, { migrations: SQLITE_MIGRATIONS });
    openDbs.push(db);
    await db.initialize();
    await db.initialize();

    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    expect(db.all<{ version: number }>("SELECT version FROM schema_migrations")).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    // Local environment is seeded automatically
    expect(db.get<{ id: string; kind: string }>("SELECT id, kind FROM environments WHERE id = 'local'"))
      .toEqual({ id: "local", kind: "local" });

    // Reopening with a failing v3 migration rolls back cleanly without recording v3.
    await db.close();
    const broken = SqliteDatabase.open(dbPath, {
      migrations: [
        ...SQLITE_MIGRATIONS,
        {
          version: 3,
          name: "broken migration",
          statements: [
            "CREATE TABLE temp_should_rollback (id INTEGER PRIMARY KEY)",
            "THIS IS INVALID SQL",
          ],
        },
      ],
    });
    openDbs.push(broken);
    await expect(broken.initialize()).rejects.toThrow();
    expect(broken.all<{ version: number }>("SELECT version FROM schema_migrations")).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    expect(
      broken.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'temp_should_rollback'",
      ),
    ).toBeUndefined();
  });

  it("invalidates existing local Codex checkpoints once when adding fork metadata", async () => {
    const dbPath = makeTempDbPath();
    const legacy = SqliteDatabase.open(dbPath, { migrations: SQLITE_MIGRATIONS.slice(0, 1) });
    openDbs.push(legacy);
    await legacy.initialize();
    const insertSession = `INSERT INTO sessions (
      session_key, raw_id, source, environment_id, project_path, file_path, original_title,
      first_question, started_at, file_mtime_ms, file_size, indexed_at, content_indexed_mtime_ms
    ) VALUES (?, 'example', ?, 'local', '', '/example.jsonl', 'Kept title', '', 100, 100, 42, 100, 100)`;
    legacy.run(insertSession, "codex:example", "codex-cli");
    legacy.run(insertSession, "claude:example", "claude-cli");
    await legacy.close();

    const db = SqliteDatabase.open(dbPath, { migrations: SQLITE_MIGRATIONS });
    openDbs.push(db);
    await db.initialize();
    expect(db.all(`SELECT session_key, original_title, forked_from_id, content_indexed_mtime_ms
      FROM local_sessions ORDER BY session_key`)).toEqual([
      { session_key: "claude:example", original_title: "Kept title", forked_from_id: null, content_indexed_mtime_ms: 100 },
      { session_key: "codex:example", original_title: "Kept title", forked_from_id: null, content_indexed_mtime_ms: 0 },
    ]);
  });

  it("supports nested savepoints and serializes concurrent async transactions cleanly", async () => {
    const db = SqliteDatabase.open(":memory:", { migrations: SQLITE_MIGRATIONS });
    openDbs.push(db);
    await db.initialize();

    // Nested savepoint rolls back inner work while preserving outer work
    db.transactionSync((outer) => {
      outer.run("INSERT INTO tags (name) VALUES (?)", "outer-tag");
      expect(() =>
        db.transactionSync((inner) => {
          inner.run("INSERT INTO tags (name) VALUES (?)", "inner-tag");
          throw new Error("boom");
        }),
      ).toThrow("boom");
    });
    expect(db.all<{ name: string }>("SELECT name FROM tags")).toEqual([{ name: "outer-tag" }]);

    // 25 concurrent async transactions on one instance serialize with zero transaction-nesting errors
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        db.transaction(async (tx) => {
          await Promise.resolve();
          tx.run("INSERT INTO tags (name) VALUES (?)", `async-tag-${index}`);
        }),
      ),
    );
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM tags")?.count).toBe(26);
  });

  it("handles concurrent multi-connection WAL writes and reads without SQLITE_BUSY", async () => {
    const dbPath = makeTempDbPath();
    const primary = SqliteDatabase.open(dbPath, { migrations: SQLITE_MIGRATIONS });
    openDbs.push(primary);
    await primary.initialize();

    const writers = [
      primary,
      SqliteDatabase.open(dbPath),
      SqliteDatabase.open(dbPath),
      SqliteDatabase.open(dbPath),
    ];
    for (const writer of writers.slice(1)) openDbs.push(writer);

    await Promise.all(
      writers.flatMap((conn, writerIndex) =>
        Array.from({ length: 20 }, (_, i) =>
          conn.transaction(async (tx) => {
            tx.run("INSERT INTO tags (name) VALUES (?)", `w${writerIndex}-t${i}`);
            const current = tx.get<{ count: number }>("SELECT count(*) AS count FROM tags");
            expect(Number(current?.count ?? 0)).toBeGreaterThan(0);
          }),
        ),
      ),
    );

    expect(primary.get<{ count: number }>("SELECT count(*) AS count FROM tags")?.count).toBe(80);
  });

  it("handles real multi-thread WAL concurrent writes across Worker threads without SQLITE_BUSY", async () => {
    const dbPath = makeTempDbPath("multi-thread.sqlite");
    const primary = SqliteDatabase.open(dbPath, { migrations: SQLITE_MIGRATIONS });
    openDbs.push(primary);
    await primary.initialize();

    const workerScript = `
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.dbPath, { timeout: 10000 });
      db.exec("PRAGMA busy_timeout = 10000");
      db.exec("PRAGMA foreign_keys = ON");
      const stmt = db.prepare("INSERT INTO tags (name) VALUES (?)");
      for (let i = 0; i < workerData.count; i += 1) {
        db.exec("BEGIN IMMEDIATE");
        try {
          stmt.run(\`mt-\${workerData.workerId}-\${i}\`);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }
      db.close();
      parentPort.postMessage("ok");
    `;

    const runWorker = (workerId: number, count: number) =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(workerScript, {
          eval: true,
          workerData: { dbPath, workerId, count },
        });
        worker.once("message", () => resolve());
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
      });

    // Run 3 real OS worker threads writing 50 rows each concurrently alongside main-thread reads/writes.
    await Promise.all([
      runWorker(1, 50),
      runWorker(2, 50),
      runWorker(3, 50),
      (async () => {
        for (let i = 0; i < 20; i += 1) {
          primary.transactionSync((tx) => {
            tx.run("INSERT INTO tags (name) VALUES (?)", `main-${i}`);
          });
          await new Promise((r) => setTimeout(r, 1));
        }
      })(),
    ]);

    expect(primary.get<{ count: number }>("SELECT count(*) AS count FROM tags")?.count).toBe(170);
  });

  it("keeps FTS5 trigram indexes synchronized across INSERT/UPDATE/DELETE and deletes orphan memory cards", async () => {
    const db = SqliteDatabase.open(":memory:", { migrations: SQLITE_MIGRATIONS });
    openDbs.push(db);
    await db.initialize();

    db.run(
      `INSERT INTO sessions (
        session_key, raw_id, source, environment_id, project_path, file_path,
        original_title, first_question, started_at, file_mtime_ms, file_size, indexed_at
      ) VALUES (?, ?, 'codex-cli', 'local', '/repo/app', '/tmp/s1.jsonl', ?, ?, 1000, 1, 10, 1000)`,
      "local:s1",
      "raw-1",
      "Fix useMcpRegistry 中文排查",
      "Why does ECONNREFUSED happen?",
    );
    db.run(
      `INSERT INTO sessions (
        session_key, raw_id, source, environment_id, project_path, file_path,
        original_title, first_question, started_at, file_mtime_ms, file_size, indexed_at
      ) VALUES (?, ?, 'codex-cli', 'local', '/repo/app', '/tmp/s2.jsonl', 'Second', 'Q2', 2000, 1, 10, 2000)`,
      "local:s2",
      "raw-2",
    );
    db.run(
      `INSERT INTO session_turns (
        id, session_key, turn_index, search_text, derivation_version
      ) VALUES ('turn-1', 'local:s1', 0, 'Stack trace: ECONNREFUSED on 127.0.0.1 中文日志', 1)`,
    );

    // FTS5 trigram substring matches (English code identifier + Chinese)
    expect(
      db.all<{ session_key: string }>(
        `SELECT s.session_key FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
         WHERE sessions_fts MATCH '"McpReg"'`,
      ),
    ).toEqual([{ session_key: "local:s1" }]);
    expect(
      db.all<{ id: string }>(
        `SELECT t.id FROM session_turns_fts f JOIN session_turns t ON t.rowid = f.rowid
         WHERE session_turns_fts MATCH '"中文日"'`,
      ),
    ).toEqual([{ id: "turn-1" }]);

    // Update triggers update FTS5
    db.run("UPDATE sessions SET custom_title = 'Renamed OAuth 授权' WHERE session_key = 'local:s1'");
    expect(
      db.all<{ session_key: string }>(
        `SELECT s.session_key FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
         WHERE sessions_fts MATCH '"OAuth"'`,
      ),
    ).toEqual([{ session_key: "local:s1" }]);

    // Memory cards + orphan deletion trigger
    db.run(
      `INSERT INTO memory_cards (
        id, project_path, kind, problem, solution, search_text, created_at, updated_at
      ) VALUES
        ('card-orphan', '/repo/app', 'experience', 'P1', 'S1', 'SQLITE_BUSY 解决经验', 1000, 1000),
        ('card-shared', '/repo/app', 'decision', 'P2', 'S2', 'WAL 模式决策', 1000, 1000)`,
    );
    db.run(
      `INSERT INTO memory_card_sources (card_id, session_key, first_turn_index, last_turn_index, created_at)
       VALUES
         ('card-orphan', 'local:s1', 0, 1, 1000),
         ('card-shared', 'local:s1', 0, 1, 1000),
         ('card-shared', 'local:s2', 0, 0, 1000)`,
    );
    expect(
      db.all<{ id: string }>(
        `SELECT c.id FROM memory_cards_fts f JOIN memory_cards c ON c.rowid = f.rowid
         WHERE memory_cards_fts MATCH '"SQLITE_BUSY"'`,
      ),
    ).toEqual([{ id: "card-orphan" }]);

    // Deleting session local:s1 cascades to memory_card_sources -> deletes card-orphan, keeps card-shared!
    db.run("DELETE FROM sessions WHERE session_key = 'local:s1'");
    expect(db.all<{ id: string }>("SELECT id FROM memory_cards")).toEqual([{ id: "card-shared" }]);

    // Verify FTS5 integrity after inserts, updates, and cascade deletes
    db.exec("INSERT INTO sessions_fts(sessions_fts) VALUES ('integrity-check')");
    db.exec("INSERT INTO session_turns_fts(session_turns_fts) VALUES ('integrity-check')");
    db.exec("INSERT INTO memory_cards_fts(memory_cards_fts) VALUES ('integrity-check')");
  });
});
