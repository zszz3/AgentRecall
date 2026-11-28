import { liveSessionPidForSession } from "./session-focus";
import { isLocalSessionEnvironment } from "./session-environment";
import type { LiveSession, SessionSearchResult } from "./types";

export type ResumeRouteResult =
  | { route: "resume" }
  | { route: "focus"; pid: number }
  | { route: "app" }
  /** A running DeepSeek Harness Desktop window was brought forward; it cannot be told which session to open. */
  | { route: "desktop-app" };

export function routeResumeSession(
  session: SessionSearchResult,
  liveSessions: LiveSession[],
  options: { platform?: NodeJS.Platform } = {},
): ResumeRouteResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") return { route: "resume" };
  if (session.source === "codex-app") {
    return isLocalSessionEnvironment(session) ? { route: "app" } : { route: "resume" };
  }
  const pid = liveSessionPidForSession(session, liveSessions);
  return pid ? { route: "focus", pid } : { route: "resume" };
}
