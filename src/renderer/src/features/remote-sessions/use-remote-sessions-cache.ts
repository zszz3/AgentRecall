import { useCallback, useRef, useState } from "react";
import type { RemoteSessionListItem } from "../../../../core/remote-session-sync";
import {
  applyRemoteSessionDeletion,
  applyRemoteSessionUpload,
  EMPTY_REMOTE_SESSIONS_CACHE,
  type RemoteSessionsCache,
} from "../../remote-sessions-cache";

/**
 * Keeps one in-flight remote-list request and applies upload/delete deltas to
 * the same cache used by the dialog.
 */
export function useRemoteSessionsCache(): {
  cache: RemoteSessionsCache;
  load(): Promise<void>;
  recordUpload(localSessionKey: string, remote: RemoteSessionListItem): void;
  recordDeletion(remoteIds: string[]): void;
} {
  const [cache, setCache] = useState(EMPTY_REMOTE_SESSIONS_CACHE);
  const loadSequenceRef = useRef(0);
  const loadPromiseRef = useRef<Promise<void> | null>(null);

  const load = useCallback((): Promise<void> => {
    if (loadPromiseRef.current) return loadPromiseRef.current;
    const requestId = ++loadSequenceRef.current;
    const request = (async () => {
      setCache((current) => ({ ...current, loading: true, error: null }));
      try {
        const status = await window.sessionSearch.getRemoteSessionStatus();
        const items = status.kind === "ready"
          ? await window.sessionSearch.listSessionSyncItems()
          : [];
        if (requestId !== loadSequenceRef.current) return;
        setCache({ status, items, loading: false, error: null });
      } catch (error) {
        if (requestId !== loadSequenceRef.current) return;
        setCache((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
    loadPromiseRef.current = request;
    void request.finally(() => {
      if (loadPromiseRef.current === request) loadPromiseRef.current = null;
    });
    return request;
  }, []);

  const recordUpload = useCallback((
    localSessionKey: string,
    remote: RemoteSessionListItem,
  ): void => {
    setCache((current) => ({
      ...current,
      items: applyRemoteSessionUpload(current.items, localSessionKey, remote),
    }));
  }, []);

  const recordDeletion = useCallback((remoteIds: string[]): void => {
    setCache((current) => ({
      ...current,
      items: applyRemoteSessionDeletion(current.items, remoteIds),
    }));
  }, []);

  return { cache, load, recordUpload, recordDeletion };
}
