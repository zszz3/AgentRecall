import type { CoreApi } from "../../shared/core-api";

/**
 * Renderer-facing subset of the Core API used by the 1.0 experience.
 * Parent Core Boundary integrations only need to provide this surface.
 */
export type CoreExperienceApi = Pick<
  CoreApi,
  | "getMessages"
  | "getNativeUpdateState"
  | "getPrivacyDiagnostics"
  | "getSession"
  | "getSettings"
  | "applyLegacyCleanup"
  | "checkNativeUpdate"
  | "copyNativeUpdateDiagnostics"
  | "downloadNativeUpdate"
  | "installNativeUpdate"
  | "inspectLegacyIntegrations"
  | "listProjects"
  | "onFocusSearch"
  | "onNativeUpdateState"
  | "onOpenSettings"
  | "openNativeUpdateHelp"
  | "openNativeUpdateReleases"
  | "platform"
  | "previewLegacyCleanup"
  | "resumeSession"
  | "retryNativeUpdate"
  | "searchSessionPage"
  | "setCustomTitle"
  | "setFavorited"
  | "setSettings"
>;

export function browserCoreExperienceApi(): CoreExperienceApi {
  return window.sessionSearch as unknown as CoreExperienceApi;
}
