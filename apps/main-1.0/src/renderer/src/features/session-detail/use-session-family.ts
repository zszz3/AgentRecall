import { useCallback, useEffect, useState } from "react";
import type { SessionFamily } from "../../../../core/session-family";

const EMPTY_SESSION_FAMILY: SessionFamily = {
  parent: null,
  children: [],
  truncated: false,
};

type SessionFamilyLoadState = {
  sessionKey: string | null;
  family: SessionFamily;
  status: "idle" | "loading" | "ready" | "error";
};

export type FamilySessionOpenResult = "opened" | "missing" | "failed";

export function useSessionFamily({
  sessionKey,
  refreshVersion,
  onOpen,
}: {
  sessionKey: string | null;
  refreshVersion: number;
  onOpen(sessionKey: string): Promise<FamilySessionOpenResult>;
}): {
  family: SessionFamily;
  loadFailed: boolean;
  retry(): void;
  open(sessionKey: string): void;
} {
  const [state, setState] = useState<SessionFamilyLoadState>({
    sessionKey: null,
    family: EMPTY_SESSION_FAMILY,
    status: "idle",
  });
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    if (!sessionKey) {
      setState({ sessionKey: null, family: EMPTY_SESSION_FAMILY, status: "idle" });
      return;
    }
    let cancelled = false;
    setState((current) => current.sessionKey === sessionKey
      ? { ...current, status: "loading" }
      : { sessionKey, family: EMPTY_SESSION_FAMILY, status: "loading" });
    void window.sessionSearch.getSessionFamily(sessionKey)
      .then((family) => {
        if (!cancelled) setState({ sessionKey, family, status: "ready" });
      })
      .catch(() => {
        if (!cancelled) {
          setState((current) => current.sessionKey === sessionKey
            ? { ...current, status: "error" }
            : current);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionKey, refreshVersion, retryVersion]);

  const retry = useCallback(() => setRetryVersion((current) => current + 1), []);
  const open = useCallback((relatedSessionKey: string) => {
    void onOpen(relatedSessionKey).then((result) => {
      if (result === "missing") retry();
    });
  }, [onOpen, retry]);

  return {
    family: state.sessionKey === sessionKey ? state.family : EMPTY_SESSION_FAMILY,
    loadFailed: Boolean(sessionKey && state.sessionKey === sessionKey && state.status === "error"),
    retry,
    open,
  };
}
