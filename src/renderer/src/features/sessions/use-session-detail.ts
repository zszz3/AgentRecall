import { useCallback, useRef, useState } from "react";
import type { RemoteSessionDetailSnapshot } from "../../../../core/remote-session-sync";
import type {
  SessionMatchHit,
  SessionSearchResult,
  SessionTurnSummary,
} from "../../../../core/types";

interface RemoteDetail {
  snapshot: RemoteSessionDetailSnapshot;
  query: string;
}

export function useSessionDetail(onLoadError: (error: unknown) => void) {
  const [detail, setDetail] = useState<SessionSearchResult | null>(null);
  const [remoteDetail, setRemoteDetail] = useState<RemoteDetail | null>(null);
  const [turns, setTurns] = useState<SessionTurnSummary[]>([]);
  const [matchedTurnId, setMatchedTurnId] = useState<string | null>(null);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const loadSequence = useRef(0);

  const closeLocal = useCallback((): void => {
    loadSequence.current++;
    setDetail(null);
    setTurns([]);
    setMatchedTurnId(null);
    setTurnsLoading(false);
  }, []);

  const openLocal = useCallback(async (
    session: SessionSearchResult,
    matchHit?: SessionMatchHit,
  ): Promise<void> => {
    const requestId = ++loadSequence.current;
    setRemoteDetail(null);
    setDetail(session);
    setTurns([]);
    setMatchedTurnId(matchHit?.turnId ?? session.bestTurn?.turnId ?? null);
    setTurnsLoading(true);

    try {
      const fresh = await window.sessionSearch.getSession(session.sessionKey);
      if (requestId !== loadSequence.current) return;
      if (!fresh) {
        setTurnsLoading(false);
        return;
      }

      const loadedTurns = await window.sessionSearch.listSessionTurns(session.sessionKey);
      if (requestId !== loadSequence.current) return;

      setDetail(fresh);
      setTurns(loadedTurns);
      setMatchedTurnId(matchHit?.turnId ?? fresh.bestTurn?.turnId ?? null);
      setTurnsLoading(false);
    } catch (error) {
      if (requestId !== loadSequence.current) return;
      setTurnsLoading(false);
      onLoadError(error);
    }
  }, [onLoadError]);

  const openRemote = useCallback((snapshot: RemoteSessionDetailSnapshot, query: string): void => {
    loadSequence.current++;
    setDetail(null);
    setTurns([]);
    setMatchedTurnId(null);
    setTurnsLoading(false);
    setRemoteDetail({ snapshot, query });
  }, []);

  const closeRemote = useCallback((): void => {
    setRemoteDetail(null);
  }, []);

  const refreshLocal = useCallback(async (): Promise<void> => {
    const sessionKey = detail?.sessionKey;
    if (!sessionKey) return;
    const fresh = await window.sessionSearch.getSession(sessionKey);
    if (!fresh) return;
    setDetail((current) => current?.sessionKey === sessionKey ? fresh : current);
  }, [detail?.sessionKey]);

  const applyUpdatedLocal = useCallback((updated: SessionSearchResult): void => {
    setDetail((current) => current?.sessionKey === updated.sessionKey ? updated : current);
  }, []);

  return {
    detail,
    remoteDetail,
    turns,
    turnsLoading,
    matchedTurnId,
    openLocal,
    closeLocal,
    openRemote,
    closeRemote,
    refreshLocal,
    applyUpdatedLocal,
  };
}
