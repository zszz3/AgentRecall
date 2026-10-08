import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteSessionDetailSnapshot } from "../../../../core/remote-session-sync";
import type {
  SessionMatchHit,
  SessionSearchResult,
  SessionTurnSummary,
} from "../../../../core/types";

import { sessionReadCache } from "./session-read-cache";

interface RemoteDetail {
  snapshot: RemoteSessionDetailSnapshot;
  query: string;
}

export function useSessionDetail(onLoadError: (error: unknown) => void) {
  const [detail, setDetail] = useState<SessionSearchResult | null>(null);
  const [remoteDetail, setRemoteDetail] = useState<RemoteDetail | null>(null);
  const [turns, setTurns] = useState<SessionTurnSummary[]>([]);
  const [matchedTurnId, setMatchedTurnId] = useState<string | null>(null);
  const [matchedMessageIndex, setMatchedMessageIndex] = useState<number | null>(null);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const loadSequence = useRef(0);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const cache = sessionReadCache(window.sessionSearch);
  useEffect(() => () => { loadSequence.current++; }, []);

  const closeLocal = useCallback((): void => {
    loadSequence.current++;
    setDetail(null);
    setTurns([]);
    setMatchedTurnId(null);
    setMatchedMessageIndex(null);
    setTurnsLoading(false);
  }, []);

  const readSnapshot = useCallback((sessionKey: string) => cache.details.read(sessionKey, async () => {
    const fresh = await window.sessionSearch.getSession(sessionKey);
    if (!fresh) return null;
    return { session: fresh, turns: await window.sessionSearch.listSessionTurns(sessionKey) };
  }, true), [cache]);

  const openLocal = useCallback(async (
    session: SessionSearchResult,
    matchHit?: SessionMatchHit,
  ): Promise<void> => {
    const requestId = ++loadSequence.current;
    setRemoteDetail(null);
    const previous = cache.details.peek(session.sessionKey);
    const cached = previous?.session.fileMtimeMs === session.fileMtimeMs && previous?.session.fileSize === session.fileSize ? previous : undefined;
    setDetail(cached?.session ?? session);
    setTurns(cached?.turns ?? []);
    setMatchedTurnId(matchHit?.turnId ?? session.bestTurn?.turnId ?? null);
    setMatchedMessageIndex(matchHit?.messageIndex ?? null);
    setTurnsLoading(!cached);

    const revision = cache.details.revision;
    try {
      const snapshot = await readSnapshot(session.sessionKey);
      if (requestId !== loadSequence.current || revision !== cache.details.revision) return;
      if (!snapshot) {
        setDetail(null); setTurns([]); setTurnsLoading(false);
        return;
      }
      const { session: fresh, turns: loadedTurns } = snapshot;
      setDetail(fresh);
      setTurns(loadedTurns);
      setMatchedTurnId(matchHit?.turnId ?? fresh.bestTurn?.turnId ?? null);
      setMatchedMessageIndex(matchHit?.messageIndex ?? null);
      setTurnsLoading(false);
    } catch (error) {
      if (requestId !== loadSequence.current || revision !== cache.details.revision) return;
      setTurnsLoading(false);
      onLoadError(error);
    }
  }, [cache, readSnapshot, onLoadError]);

  const openRemote = useCallback((snapshot: RemoteSessionDetailSnapshot, query: string): void => {
    loadSequence.current++;
    setDetail(null);
    setTurns([]);
    setMatchedTurnId(null);
    setMatchedMessageIndex(null);
    setTurnsLoading(false);
    setRemoteDetail({ snapshot, query });
  }, []);

  const closeRemote = useCallback((): void => {
    setRemoteDetail(null);
  }, []);

  const refreshLocal = useCallback(async (): Promise<void> => {
    cache.clear();
    const requestId = ++loadSequence.current;
    const session = detailRef.current;
    if (!session) return;
    try {
      const snapshot = await readSnapshot(session.sessionKey);
      if (requestId !== loadSequence.current) return;
      setDetail(snapshot?.session ?? null);
      setTurns(snapshot?.turns ?? []);
      setTurnsLoading(false);
    } catch (error) {
      if (requestId !== loadSequence.current) return;
      setTurnsLoading(false);
      onLoadError(error);
    }
  }, [cache, readSnapshot, onLoadError]);

  const loadTurn = useCallback((session: SessionSearchResult, turnId: string) =>
    cache.turns.read(JSON.stringify([session.sessionKey, session.fileMtimeMs, session.fileSize, turnId]),
      () => window.sessionSearch.getSessionTurn(session.sessionKey, turnId)), [cache]);

  const applyUpdatedLocal = useCallback((updated: SessionSearchResult): void => {
    loadSequence.current++;
    cache.clear();
    setTurnsLoading(false);
    setDetail((current) => current?.sessionKey === updated.sessionKey ? updated : current);
  }, [cache]);

  return {
    detail,
    remoteDetail,
    turns,
    turnsLoading,
    matchedTurnId,
    matchedMessageIndex,
    openLocal,
    closeLocal,
    openRemote,
    closeRemote,
    refreshLocal,
    applyUpdatedLocal,
    loadTurn,
  };
}
