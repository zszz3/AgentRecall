import { liveSessionPidForSession } from "./session-focus";
import type { LiveSessionSnapshot, SessionSearchResult } from "./types";

export interface SessionTitleSyncDependencies {
  getSession(sessionKey: string): Promise<SessionSearchResult | null>;
  setCustomTitle(sessionKey: string, title: string | null): Promise<void>;
  loadLiveSessions(): Promise<LiveSessionSnapshot>;
  setLiveTerminalTitle(pid: number, title: string): Promise<boolean>;
  onSyncError?(error: unknown): void;
}

export async function setSessionCustomTitleAndSyncTerminal(
  sessionKey: string,
  title: string | null,
  dependencies: SessionTitleSyncDependencies,
): Promise<void> {
  if (!await dependencies.getSession(sessionKey)) return;

  await dependencies.setCustomTitle(sessionKey, title);

  const updated = await dependencies.getSession(sessionKey);
  if (!updated || updated.environmentKind !== "local") return;

  try {
    const snapshot = await dependencies.loadLiveSessions();
    if (snapshot.error) {
      dependencies.onSyncError?.(new Error(snapshot.error));
      return;
    }

    const pid = liveSessionPidForSession(updated, snapshot.sessions);
    if (pid) await dependencies.setLiveTerminalTitle(pid, updated.displayTitle);
  } catch (error) {
    dependencies.onSyncError?.(error);
  }
}
