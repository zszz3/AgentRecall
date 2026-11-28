import fs from "node:fs";
import path from "node:path";
import { PostgresDatabase } from "../../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../../core/postgres/schema";
import { PostgresTeamSessionRepository } from "../../core/postgres/team-session-repository";
import {
  isSqliteConnectionUrl,
  parseSqliteConnectionUrl,
  SqliteDatabase,
  type SqliteDatabaseOptions,
} from "../../core/sqlite/database";
import {
  migratePostgresDatabaseToSqlite,
  type PostgresToSqliteMigrationResult,
} from "../../core/sqlite/pg-to-sqlite-migrator";
import { SQLITE_MIGRATIONS } from "../../core/sqlite/schema";
import { SqliteTeamSessionRepository } from "../../core/sqlite/team-session-repository";
import type { TeamSessionRepository } from "../../core/storage/repositories";
import { startPostgresRuntime } from "../postgres/managed-postgres";

export const SQLITE_DATABASE_FILENAME = "agent-recall.sqlite";

export type AppDatabase = PostgresDatabase | SqliteDatabase;

export function resolveSqliteDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, SQLITE_DATABASE_FILENAME);
}

/** Connects either a SQLite or PostgreSQL handle based on the backend connection URL. */
export function connectAppDatabase(
  connectionUrl: string,
  options: { applyMigrations?: boolean } = {},
): AppDatabase {
  if (isSqliteConnectionUrl(connectionUrl)) {
    const filePath = parseSqliteConnectionUrl(connectionUrl);
    return SqliteDatabase.open(filePath, {
      migrations: options.applyMigrations ? SQLITE_MIGRATIONS : [],
    });
  }
  return PostgresDatabase.connect(connectionUrl, {
    migrations: options.applyMigrations ? POSTGRES_MIGRATIONS : [],
  });
}

/** Creates the matching team-session cache repository for the active database handle. */
export function createTeamSessionRepository(database: AppDatabase): TeamSessionRepository {
  return database instanceof SqliteDatabase
    ? new SqliteTeamSessionRepository(database)
    : new PostgresTeamSessionRepository(database);
}

/**
 * Ensures the SQLite database file exists and, on first upgrade from a legacy
 * embedded PostgreSQL cluster, atomically migrates all active tables once while
 * leaving `<userDataPath>/postgres` untouched as a read-only backup.
 */
export async function ensureSqliteDatabaseReady(options: {
  userDataPath: string;
  sqlitePath?: string;
}): Promise<{
  sqlitePath: string;
  migratedFromPostgres: boolean;
  migrationResult?: PostgresToSqliteMigrationResult;
}> {
  const sqlitePath = path.resolve(options.sqlitePath ?? resolveSqliteDatabasePath(options.userDataPath));
  if (fs.existsSync(sqlitePath)) {
    return { sqlitePath, migratedFromPostgres: false };
  }

  const legacyPgVersion = path.join(options.userDataPath, "postgres", "data", "PG_VERSION");
  if (!fs.existsSync(legacyPgVersion)) {
    return { sqlitePath, migratedFromPostgres: false };
  }

  const runtime = await startPostgresRuntime({
    userDataPath: options.userDataPath,
    adoptExisting: true,
  });
  let pg: PostgresDatabase | null = null;
  try {
    pg = PostgresDatabase.connect(runtime.connectionUrl, {
      migrations: POSTGRES_MIGRATIONS,
    });
    await pg.initialize();
    const migrationResult = await migratePostgresDatabaseToSqlite(pg, sqlitePath);
    return { sqlitePath, migratedFromPostgres: true, migrationResult };
  } finally {
    await pg?.close().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
  }
}

/** Opens and initializes a SQLite database handle directly. */
export async function openInitializedSqliteDatabase(
  filePath: string,
  options: Omit<SqliteDatabaseOptions, "migrations"> = {},
): Promise<SqliteDatabase> {
  const database = SqliteDatabase.open(filePath, {
    ...options,
    migrations: SQLITE_MIGRATIONS,
  });
  await database.initialize();
  return database;
}
