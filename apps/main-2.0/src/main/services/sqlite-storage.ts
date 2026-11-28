import path from "node:path";
import { SqliteAppStore } from "../../automation/engine/main/hub/persisted/sqlite-store";
import { SqliteMcpRegistryStore } from "../../automation/engine/main/sqlite-mcp-registry-store";
import { SqliteDatabase, type SqliteDatabaseOptions } from "../../core/sqlite/database";
import { SqliteEnvironmentRepository } from "../../core/sqlite/environment-repository";
import { SqliteMetadataRepository } from "../../core/sqlite/metadata-repository";
import { SqliteRuntimeInvocationRepository } from "../../core/sqlite/runtime-invocation-repository";
import { SqliteSavedSearchStore } from "../../core/sqlite/saved-searches-store";
import { SQLITE_MIGRATIONS } from "../../core/sqlite/schema";
import { SqliteSearchHistoryStore } from "../../core/sqlite/search-history-store";

export const SQLITE_DATABASE_FILENAME = "agent-recall.sqlite";

export function resolveSqliteDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, SQLITE_DATABASE_FILENAME);
}

/**
 * Opens the SQLite database with the unified AgentRecall schema and constructs
 * the Phase 1 storage repositories. Full session/search/eval repositories will
 * join this factory in Phase 2 before Phase 3 switches the desktop entrypoint.
 */
export async function openSqliteStorage(
  filePath: string,
  options: Omit<SqliteDatabaseOptions, "migrations"> & { fileStoragePath?: string } = {},
) {
  const database = SqliteDatabase.open(filePath, {
    ...options,
    migrations: SQLITE_MIGRATIONS,
  });
  await database.initialize();
  return {
    database,
    environments: new SqliteEnvironmentRepository(database),
    metadata: new SqliteMetadataRepository(database),
    runtimeInvocations: new SqliteRuntimeInvocationRepository(database),
    savedSearches: new SqliteSavedSearchStore(database),
    searchHistory: new SqliteSearchHistoryStore(database),
    mcpRegistry: new SqliteMcpRegistryStore(database),
    appStore: new SqliteAppStore(database, options.fileStoragePath),
  };
}
