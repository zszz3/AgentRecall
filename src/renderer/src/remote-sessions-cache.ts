import type { RemoteSessionListItem, RemoteSessionStatus, SessionSyncItem } from "../../core/remote-session-sync";

export interface RemoteSessionsCache {
  status: RemoteSessionStatus | null;
  items: SessionSyncItem[];
  loading: boolean;
  error: string | null;
}

export const EMPTY_REMOTE_SESSIONS_CACHE: RemoteSessionsCache = {
  status: null,
  items: [],
  loading: true,
  error: null,
};

export function applyRemoteSessionUpload(
  items: SessionSyncItem[],
  localSessionKey: string,
  remote: RemoteSessionListItem,
): SessionSyncItem[] {
  return items.map((item) => {
    if (item.local?.sessionKey !== localSessionKey && item.remote?.id !== remote.id) return item;
    return {
      ...item,
      id: remote.id,
      state: "synced",
      remote,
      localRevision: remote.contentHash,
      remoteRevision: remote.contentHash,
      lastSyncedAt: remote.syncedAt,
    };
  });
}

export function applyRemoteSessionDeletion(items: SessionSyncItem[], removedRemoteIds: Iterable<string>): SessionSyncItem[] {
  const removed = new Set(removedRemoteIds);
  return items.flatMap((item) => {
    if (!item.remote || !removed.has(item.remote.id)) return [item];
    if (!item.local) return [];
    return [{
      ...item,
      id: `local:${item.local.sessionKey}`,
      state: "local-only",
      remote: null,
      remoteRevision: "",
      lastSyncedAt: null,
    }];
  });
}
