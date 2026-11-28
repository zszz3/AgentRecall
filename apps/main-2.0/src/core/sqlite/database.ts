import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  DatabaseSync as NodeDatabaseSync,
  SQLInputValue,
  StatementSync,
} from "node:sqlite";

const moduleRequire = createRequire(import.meta.url);
const { DatabaseSync } = moduleRequire("node:sqlite") as {
  DatabaseSync: new (
    location: string,
    options?: {
      open?: boolean;
      readOnly?: boolean;
      enableForeignKeyConstraints?: boolean;
      allowExtension?: boolean;
      timeout?: number;
    },
  ) => NodeDatabaseSync;
};

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteQueryable {
  all<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: SQLInputValue[]
  ): Row[];
  get<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: SQLInputValue[]
  ): Row | undefined;
  run(sql: string, ...params: SQLInputValue[]): SqliteRunResult;
  exec(sql: string): void;
}

export interface SqliteMigration {
  version: number;
  name: string;
  statements: readonly string[];
}

export interface SqliteDatabaseOptions {
  migrations?: readonly SqliteMigration[];
  readOnly?: boolean;
  allowExtension?: boolean;
  busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 10_000;

export const SQLITE_URL_PREFIX = "sqlite:";

export type DatabaseEngine = "sqlite" | "postgres";

/** Resolves the active local database engine, defaulting to SQLite unless Postgres is explicitly requested. */
export function resolveDbEngine(
  env: Record<string, string | undefined> = process.env,
): DatabaseEngine {
  const explicit = env.AGENT_RECALL_DB_ENGINE?.trim().toLowerCase();
  if (explicit === "postgres" || explicit === "postgresql") return "postgres";
  if (explicit === "sqlite") return "sqlite";
  const externalUrl = env.AGENT_RECALL_DATABASE_URL?.trim();
  if (externalUrl && /^postgres(?:ql)?:\/\//iu.test(externalUrl)) return "postgres";
  return "sqlite";
}

export function isSqliteConnectionUrl(connectionUrl: string): boolean {
  return connectionUrl.trim().toLowerCase().startsWith(SQLITE_URL_PREFIX);
}

export function toSqliteConnectionUrl(filePath: string): string {
  if (filePath === ":memory:") return `${SQLITE_URL_PREFIX}:memory:`;
  return `${SQLITE_URL_PREFIX}${path.resolve(filePath)}`;
}

export function parseSqliteConnectionUrl(connectionUrl: string): string {
  const trimmed = connectionUrl.trim();
  if (!isSqliteConnectionUrl(trimmed)) {
    throw new Error(`Expected sqlite: connection URL, received: ${trimmed.slice(0, 32)}`);
  }
  const target = trimmed.slice(SQLITE_URL_PREFIX.length);
  if (!target) {
    throw new Error("SQLite connection URL is missing a database path.");
  }
  return target;
}

/**
 * Per-thread async write-transaction serialization keyed by resolved file path.
 *
 * `DatabaseSync` calls are synchronous C calls; if two handles to the same SQLite
 * file on the *same* JS thread interleave `async transaction()` callbacks, the second
 * handle's `BEGIN IMMEDIATE` would synchronously block the single event-loop thread
 * inside `busy_timeout`, starving the first handle's `COMMIT` microtask. Serializing
 * async transactions per file path within a JS thread prevents same-thread deadlock,
 * while WAL + `BEGIN IMMEDIATE` + `busy_timeout` handle cross-thread and cross-process
 * concurrency cleanly.
 */
const sameThreadTxQueues = new Map<string, Promise<void>>();

/**
 * Single-file SQLite database wrapper built on Node/Electron's built-in `node:sqlite`.
 *
 * Concurrency guarantees:
 * - Cross-process / multi-worker: WAL mode + `busy_timeout` + `BEGIN IMMEDIATE` write transactions
 *   so readers never block writers and writers wait cleanly instead of failing on deferred upgrades.
 * - Within a single instance: async transactions are serialized through an internal mutex queue,
 *   while re-entrant calls inside an active transaction use SQLite `SAVEPOINT`s.
 */
export class SqliteDatabase implements SqliteQueryable {
  private readonly db: NodeDatabaseSync;
  private readonly migrations: readonly SqliteMigration[];
  private readonly readOnly: boolean;
  private readonly queueKey: string;
  private readonly statementCache = new Map<string, StatementSync>();
  private initializePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private txTail: Promise<void> = Promise.resolve();
  private txDepth = 0;
  private savepointCounter = 0;
  private closed = false;

  private constructor(
    readonly filePath: string,
    db: NodeDatabaseSync,
    options: SqliteDatabaseOptions,
  ) {
    this.db = db;
    this.migrations = [...(options.migrations ?? [])].sort((left, right) => left.version - right.version);
    this.readOnly = options.readOnly ?? false;
    this.queueKey = filePath === ":memory:" ? "" : path.resolve(filePath);
  }

  static open(filePath: string, options: SqliteDatabaseOptions = {}): SqliteDatabase {
    const isMemory = filePath === ":memory:";
    const readOnly = options.readOnly ?? false;
    if (!isMemory && !readOnly) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    }
    const busyTimeoutMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS));
    const db = new DatabaseSync(filePath, {
      readOnly,
      enableForeignKeyConstraints: true,
      ...(options.allowExtension ? { allowExtension: true } : {}),
      timeout: busyTimeoutMs,
    });
    try {
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA temp_store = MEMORY");
      db.exec("PRAGMA cache_size = -32000");
      if (!isMemory && !readOnly) {
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
      }
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the original initialization error.
      }
      throw error;
    }
    return new SqliteDatabase(filePath, db, options);
  }

  initialize(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("SQLite database is closed"));
    if (this.readOnly) return Promise.resolve();
    this.initializePromise ??= this.applyMigrations();
    return this.initializePromise;
  }

  all<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: SQLInputValue[]
  ): Row[] {
    this.assertOpen();
    return this.prepare(sql).all(...params) as Row[];
  }

  get<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    ...params: SQLInputValue[]
  ): Row | undefined {
    this.assertOpen();
    return this.prepare(sql).get(...params) as Row | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): SqliteRunResult {
    this.assertOpen();
    const result = this.prepare(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  exec(sql: string): void {
    this.assertOpen();
    this.db.exec(sql);
  }

  transactionSync<T>(run: (tx: SqliteQueryable) => T): T {
    this.assertOpen();
    const nested = this.txDepth > 0;
    const savepoint = nested ? `sp_${(this.savepointCounter += 1)}` : null;
    this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.txDepth += 1;
    try {
      const result = run(this);
      this.db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      try {
        if (savepoint) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          this.db.exec("ROLLBACK");
        }
      } catch {
        // Preserve the original operation error if rollback fails on a broken handle.
      }
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  async transaction<T>(run: (tx: SqliteQueryable) => Promise<T>): Promise<T> {
    this.assertOpen();
    const previousInstance = this.txTail;
    const previousShared = this.queueKey ? (sameThreadTxQueues.get(this.queueKey) ?? Promise.resolve()) : Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.txTail = gate;
    if (this.queueKey) sameThreadTxQueues.set(this.queueKey, gate);
    await previousInstance;
    await previousShared;
    try {
      this.assertOpen();
      const nested = this.txDepth > 0;
      const savepoint = nested ? `sp_${(this.savepointCounter += 1)}` : null;
      this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      this.txDepth += 1;
      try {
        const result = await run(this);
        this.db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        try {
          if (savepoint) {
            this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } else {
            this.db.exec("ROLLBACK");
          }
        } catch {
          // Preserve the original operation error if rollback fails on a closed handle.
        }
        throw error;
      } finally {
        this.txDepth -= 1;
      }
    } finally {
      if (this.queueKey && sameThreadTxQueues.get(this.queueKey) === gate) {
        sameThreadTxQueues.delete(this.queueKey);
      }
      release();
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.txTail.catch(() => undefined);
      this.statementCache.clear();
      this.db.close();
    })();
    return this.closePromise;
  }

  isClosedError(error: unknown): boolean {
    if (!this.closed || !(error instanceof Error)) return false;
    return error.message === "SQLite database is closed"
      || /database is not open|database connection is not open/iu.test(error.message);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite database is closed");
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      if (this.statementCache.size >= 512) {
        const oldest = this.statementCache.keys().next().value;
        if (oldest !== undefined) this.statementCache.delete(oldest);
      }
      this.statementCache.set(sql, statement);
    }
    return statement;
  }

  private async applyMigrations(): Promise<void> {
    await this.transaction(async (tx) => {
      tx.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        )
      `);
      const applied = tx.all<{ version: number }>("SELECT version FROM schema_migrations");
      const appliedVersions = new Set(applied.map((row) => Number(row.version)));
      for (const migration of this.migrations) {
        if (appliedVersions.has(migration.version)) continue;
        for (const statement of migration.statements) {
          tx.exec(statement);
        }
        tx.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          migration.version,
          migration.name,
          Date.now(),
        );
      }
    });
  }
}
