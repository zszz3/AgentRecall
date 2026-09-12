import { useEffect, useRef } from "react";
import type { SessionMatchHit, SessionSearchResult } from "../../core/types";

export function useMessageLinks(open: (session: SessionSearchResult, hit: SessionMatchHit) => Promise<void>,
  onError: (error: unknown) => void): void {
  const callbacks = useRef({ open, onError });
  callbacks.current = { open, onError };
  useEffect(() => {
    const api = window.sessionSearch.messageTools;
    if (!api) return;
    let sequence = 0;
    let disposed = false;
    const receive = async (): Promise<void> => {
      let request = sequence;
      try {
        const locator = await api.takePending();
        if (!locator || disposed) return;
        request = ++sequence;
        const { sessionKey, hit } = await api.resolve(locator);
        const session = await window.sessionSearch.getSession(sessionKey);
        if (disposed || request !== sequence) return;
        if (!session) throw new Error("This session is unavailable on this device.");
        await callbacks.current.open(session, hit);
      } catch (error) {
        if (!disposed && request === sequence) callbacks.current.onError(error);
      }
    };
    const unsubscribe = api.onOpen(() => void receive());
    void receive();
    return () => { disposed = true; sequence++; unsubscribe(); };
  }, []);
}
