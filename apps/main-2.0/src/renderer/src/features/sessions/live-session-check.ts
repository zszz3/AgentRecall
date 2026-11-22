import type { SessionSearchApi } from "../../../../preload";
import { liveSessionDeleteKey } from "../../../../core/session-bulk-delete";

export interface LiveSessionCheck {
  liveSessionKeys: string[];
  liveSessionCheckFailed: boolean;
}

/**
 * Reads running Sessions right before a deletion preview. A failed read is reported through `warn`
 * and returned as `liveSessionCheckFailed`, so the deletion asks for explicit confirmation instead of
 * assuming nothing is running.
 */
export async function checkLiveSessionsBeforeDelete(
  api: Pick<SessionSearchApi, "getLiveSessions">,
  warn: (message: string) => void,
  t: (en: string, zh: string) => string,
): Promise<LiveSessionCheck> {
  const warning = t(
    "Could not verify running sessions. Confirm that related sessions have stopped before deleting.",
    "无法确认正在运行的会话，请在删除前确认相关会话已经停止。",
  );
  try {
    const snapshot = await api.getLiveSessions(true);
    if (snapshot.error) warn(warning);
    return {
      liveSessionKeys: snapshot.sessions.map(liveSessionDeleteKey),
      liveSessionCheckFailed: Boolean(snapshot.error),
    };
  } catch {
    warn(warning);
    return { liveSessionKeys: [], liveSessionCheckFailed: true };
  }
}
