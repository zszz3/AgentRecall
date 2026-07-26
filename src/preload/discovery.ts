import type { IpcRenderer } from "electron";
import type { SessionFamily } from "../core/session-family";
import type { SavedSearch } from "../core/store/saved-searches";
import type { SearchHistoryEntry } from "../core/store/search-history-store";
import type { SearchOptions } from "../core/types";
import { DISCOVERY_IPC } from "../shared/ipc/discovery";

export type DiscoveryIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createDiscoveryApi(ipc: DiscoveryIpcRenderer) {
  return {
    listSavedSearches: (): Promise<SavedSearch[]> => ipc.invoke(DISCOVERY_IPC.listSavedSearches.channel),
    createSavedSearch: (name: string, options: SearchOptions): Promise<SavedSearch> =>
      ipc.invoke(DISCOVERY_IPC.createSavedSearch.channel, name, options),
    deleteSavedSearch: (id: number): Promise<boolean> => ipc.invoke(DISCOVERY_IPC.deleteSavedSearch.channel, id),
    touchSavedSearch: (id: number): Promise<void> => ipc.invoke(DISCOVERY_IPC.touchSavedSearch.channel, id),
    listRecentSearches: (limit?: number): Promise<SearchHistoryEntry[]> =>
      ipc.invoke(DISCOVERY_IPC.listRecentSearches.channel, limit ?? 20),
    searchHistory: (query: string, limit?: number): Promise<SearchHistoryEntry[]> =>
      ipc.invoke(DISCOVERY_IPC.searchHistory.channel, query, limit ?? 20),
    clearSearchHistory: (): Promise<void> => ipc.invoke(DISCOVERY_IPC.clearSearchHistory.channel),
    recordSearch: (query: string, resultCount: number, options?: SearchOptions): Promise<void> =>
      ipc.invoke(DISCOVERY_IPC.recordSearch.channel, query, resultCount, options ?? null),
    getSessionFamily: (sessionKey: string): Promise<SessionFamily> =>
      ipc.invoke(DISCOVERY_IPC.getSessionFamily.channel, sessionKey),
  };
}

export type DiscoveryApi = ReturnType<typeof createDiscoveryApi>;
