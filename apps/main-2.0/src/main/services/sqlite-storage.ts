import path from "node:path";
import {
  parseSqliteConnectionUrl,
  SqliteDatabase,
  type SqliteDatabaseOptions,
} from "../../core/sqlite/database";
import { SQLITE_MIGRATIONS } from "../../core/sqlite/schema";
import { SqliteTeamSessionRepository } from "../../core/sqlite/team-session-repository";
import type { TeamSessionRepository } from "../../core/storage/repositories";

export const SQLITE_DATABASE_FILENAME = "agent-recall.sqlite";

export function resolveSqliteDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, SQLITE_DATABASE_FILENAME);
}

/** Connects a SQLite database handle from a `sqlite:<path>` connection URL. */
export function connectSqliteDatabase(
  connectionUrl: string,
  options: { applyMigrations?: boolean } = {},
): SqliteDatabase {
  const filePath = parseSqliteConnectionUrl(connectionUrl);
  return SqliteDatabase.open(filePath, {
    migrations: options.applyMigrations ? SQLITE_MIGRATIONS : [],
  });
}

/** Opens and initializes a SQLite database handle with the unified AgentRecall schema. */
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

/** Creates the team-session cache repository for the active SQLite database handle. */
export function createTeamSessionRepository(database: SqliteDatabase): TeamSessionRepository {
  return new SqliteTeamSessionRepository(database);
}
