import type { SavedSearch, SearchHistoryEntry, SessionFamily } from "../../core/storage/types";
import type { SearchOptions } from "../../core/types";
import { DISCOVERY_IPC } from "../../shared/ipc/discovery";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface DiscoveryIpcService {
  listSavedSearches(): Promise<SavedSearch[]>;
  createSavedSearch(name: string, options: SearchOptions): Promise<SavedSearch>;
  deleteSavedSearch(id: number): Promise<boolean>;
  touchSavedSearch(id: number): Promise<void>;
  listRecentSearches(limit?: number): Promise<SearchHistoryEntry[]>;
  searchHistory(query: string, limit?: number): Promise<SearchHistoryEntry[]>;
  clearSearchHistory(): Promise<void>;
  recordSearch(
    query: string,
    resultCount: number,
    options?: SearchOptions,
  ): Promise<void>;
  getSessionFamily(sessionKey: string): Promise<SessionFamily>;
}

export function registerDiscoveryIpc(ipc: IpcMainRegistrar, service: DiscoveryIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, DISCOVERY_IPC.listSavedSearches, () => service.listSavedSearches()),
    registerIpcHandler(ipc, DISCOVERY_IPC.createSavedSearch, (_event, name, options) =>
      service.createSavedSearch(name, options as SearchOptions),
    ),
    registerIpcHandler(ipc, DISCOVERY_IPC.deleteSavedSearch, (_event, id) => service.deleteSavedSearch(id)),
    registerIpcHandler(ipc, DISCOVERY_IPC.touchSavedSearch, (_event, id) => service.touchSavedSearch(id)),
    registerIpcHandler(ipc, DISCOVERY_IPC.listRecentSearches, (_event, limit) => service.listRecentSearches(limit)),
    registerIpcHandler(ipc, DISCOVERY_IPC.searchHistory, (_event, query, limit) => service.searchHistory(query, limit)),
    registerIpcHandler(ipc, DISCOVERY_IPC.clearSearchHistory, () => service.clearSearchHistory()),
    registerIpcHandler(ipc, DISCOVERY_IPC.recordSearch, (_event, query, resultCount, options) =>
      service.recordSearch(query, resultCount, options ?? undefined),
    ),
    registerIpcHandler(ipc, DISCOVERY_IPC.getSessionFamily, (_event, sessionKey) =>
      service.getSessionFamily(sessionKey),
    ),
  ]);
}
