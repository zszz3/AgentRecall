import type { McpServerDefinition, McpToolDefinition } from "../../automation/engine/shared/mcp/types";
import type { ApiProviderKeyTarget, SessionSyncBinding } from "../postgres/metadata-repository";
import type { SavedSearch } from "../store/saved-searches";
import type { SearchHistoryEntry } from "../store/search-history-store";
import type {
  EnvironmentSyncState,
  EnvironmentUpsertInput,
  SearchOptions,
  SessionEnvironment,
  SessionMigrationRecord,
} from "../types";

export interface EnvironmentRepository {
  listEnvironments(): Promise<SessionEnvironment[]>;
  getEnvironment(id: string): Promise<SessionEnvironment | null>;
  upsertEnvironment(input: EnvironmentUpsertInput): Promise<SessionEnvironment>;
  updateEnvironmentSyncState(
    id: string,
    state: EnvironmentSyncState,
    options?: { lastSyncedAt?: number | null; lastError?: string | null },
  ): Promise<void>;
  deleteEnvironmentSessions(environmentId: string): Promise<void>;
  deleteEnvironment(environmentId: string): Promise<void>;
}

export interface MetadataRepository {
  upsertSessionSyncBinding(binding: SessionSyncBinding): Promise<void>;
  getSessionSyncBindingForLocalKey(localSessionKey: string): Promise<SessionSyncBinding | null>;
  getSessionSyncBindingForRemoteId(remoteSessionId: string): Promise<SessionSyncBinding | null>;
  listSessionSyncBindings(): Promise<SessionSyncBinding[]>;
  deleteSessionSyncBindingForRemoteId(remoteSessionId: string): Promise<void>;
  getApiProviderKey(target: ApiProviderKeyTarget, providerId: string): Promise<string>;
  setApiProviderKey(target: ApiProviderKeyTarget, providerId: string, apiKey: string): Promise<void>;
  recordSessionMigration(record: SessionMigrationRecord): Promise<void>;
  listSessionMigrations(sourceSessionKey: string): Promise<SessionMigrationRecord[]>;
}

export interface SavedSearchRepository {
  listSavedSearches(): Promise<SavedSearch[]>;
  getSavedSearch(id: number): Promise<SavedSearch | null>;
  createSavedSearch(name: string, options: SearchOptions): Promise<SavedSearch>;
  deleteSavedSearch(id: number): Promise<boolean>;
  touchSavedSearch(id: number): Promise<void>;
}

export interface SearchHistoryRepository {
  recordSearch(query: string, resultCount: number, options?: SearchOptions): Promise<void>;
  listRecentSearches(limit?: number): Promise<SearchHistoryEntry[]>;
  searchHistory(query: string, limit?: number): Promise<SearchHistoryEntry[]>;
  clearHistory(): Promise<void>;
  deleteEntry(id: number): Promise<boolean>;
}

export interface McpRegistryRepository {
  list(): Promise<McpServerDefinition[]>;
  upsert(server: McpServerDefinition): Promise<McpServerDefinition>;
  recordTest(
    server: McpServerDefinition,
    tools: McpToolDefinition[],
    error?: string,
  ): Promise<McpServerDefinition>;
  delete(id: string): Promise<boolean>;
  close(): void;
}
