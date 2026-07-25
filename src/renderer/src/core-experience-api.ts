import type { SessionSearchApi } from "../../preload";

/**
 * Renderer-facing subset of the Core API used by the 1.0 experience.
 * Parent Core Boundary integrations only need to provide this surface.
 */
export type CoreExperienceApi = Pick<
  SessionSearchApi,
  | "getMessages"
  | "getSession"
  | "getSettings"
  | "listProjects"
  | "onFocusSearch"
  | "onOpenSettings"
  | "platform"
  | "resumeSession"
  | "searchSessionPage"
  | "setCustomTitle"
  | "setFavorited"
  | "setSettings"
>;

export function browserCoreExperienceApi(): CoreExperienceApi {
  return window.sessionSearch;
}
