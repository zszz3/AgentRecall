import path from "node:path";
import { SqliteAppStore } from "../../automation/engine/main/hub/persisted/sqlite-store";
import { SqliteEvaluationStore } from "../../automation/engine/main/sqlite-evaluation-store";
import { SqliteMcpRegistryStore } from "../../automation/engine/main/sqlite-mcp-registry-store";
import { SqliteDatabase, type SqliteDatabaseOptions } from "../../core/sqlite/database";
import { SqliteEnvironmentRepository } from "../../core/sqlite/environment-repository";
import { SqliteMemoryCardRepository } from "../../core/sqlite/memory-card-repository";
import { SqliteMetadataRepository } from "../../core/sqlite/metadata-repository";
import { SqliteRuntimeInvocationRepository } from "../../core/sqlite/runtime-invocation-repository";
import { SqliteSavedSearchStore } from "../../core/sqlite/saved-searches-store";
import { SQLITE_MIGRATIONS } from "../../core/sqlite/schema";
import { SqliteSearchHistoryStore } from "../../core/sqlite/search-history-store";
import { findSqliteSessionFamily } from "../../core/sqlite/session-family";
import { SqliteSessionRepository } from "../../core/sqlite/session-repository";
import { SqliteSessionSearchRepository } from "../../core/sqlite/session-search-repository";
import { SqliteSessionStatsRepository } from "../../core/sqlite/session-stats-repository";
import { SqliteSessionTurnRepository } from "../../core/sqlite/session-turn-repository";
import { SqliteSkillRepository } from "../../core/sqlite/skill-repository";
import { SqliteTeamSessionRepository } from "../../core/sqlite/team-session-repository";

export const SQLITE_DATABASE_FILENAME = "agent-recall.sqlite";

export function resolveSqliteDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, SQLITE_DATABASE_FILENAME);
}

/**
 * Opens the SQLite database with the unified AgentRecall schema and constructs
 * the complete set of AgentRecall 2.0 storage repositories.
 */
export async function openSqliteStorage(
  filePath: string,
  options: Omit<SqliteDatabaseOptions, "migrations"> & {
    fileStoragePath?: string;
    attachmentCacheRoot?: string | null;
  } = {},
) {
  const database = SqliteDatabase.open(filePath, {
    ...options,
    migrations: SQLITE_MIGRATIONS,
  });
  await database.initialize();
  return {
    database,
    sessions: new SqliteSessionRepository(database, options.attachmentCacheRoot ?? null),
    turns: new SqliteSessionTurnRepository(database),
    search: new SqliteSessionSearchRepository(database),
    stats: new SqliteSessionStatsRepository(database),
    findSessionFamily: (sessionKey: string) => findSqliteSessionFamily(database, sessionKey),
    skills: new SqliteSkillRepository(database),
    memoryCards: new SqliteMemoryCardRepository(database),
    teamSessions: new SqliteTeamSessionRepository(database),
    evaluation: new SqliteEvaluationStore(database),
    environments: new SqliteEnvironmentRepository(database),
    metadata: new SqliteMetadataRepository(database),
    runtimeInvocations: new SqliteRuntimeInvocationRepository(database),
    savedSearches: new SqliteSavedSearchStore(database),
    searchHistory: new SqliteSearchHistoryStore(database),
    mcpRegistry: new SqliteMcpRegistryStore(database),
    appStore: new SqliteAppStore(database, options.fileStoragePath),
  };
}
