import { loadDefaultSessions } from "./session-loader";
import type { SessionStore } from "./session-store";

export interface IndexStatus {
  running: boolean;
  indexed: number;
  total: number;
  lastIndexedAt: number | null;
  error: string | null;
}

export function syncDefaultSessions(store: SessionStore): IndexStatus {
  const loaded = loadDefaultSessions();
  let indexed = 0;
  for (const item of loaded) {
    store.upsertIndexedSession(item.session, item.messages);
    indexed++;
  }
  return {
    running: false,
    indexed,
    total: loaded.length,
    lastIndexedAt: Date.now(),
    error: null,
  };
}
