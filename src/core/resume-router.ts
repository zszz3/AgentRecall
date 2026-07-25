import { liveSessionPidForSession } from "./session-focus";
import { isLocalSessionEnvironment } from "./session-environment";
import type { LiveSession, SessionSearchResult } from "./types";

export type ResumeRouteResult = { route: "resume" } | { route: "focus"; pid: number } | { route: "app" };

export function routeResumeSession(
  session: SessionSearchResult | null | undefined,
  liveSessions: LiveSession[],
  options: { platform?: NodeJS.Platform } = {},
): ResumeRouteResult {
  if (!session) {
    throw new Error("This session is no longer available. Refresh the session list, then try Resume again.");
  }
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return { route: "resume" };
  if (session.source === "codex-app") {
    return isLocalSessionEnvironment(session) ? { route: "app" } : { route: "resume" };
  }
  const pid = liveSessionPidForSession(session, liveSessions);
  return pid ? { route: "focus", pid } : { route: "resume" };
}
