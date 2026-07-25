import type { CoreSettings, CoreSettingsUpdate } from "../shared/core-api";
import type { AppSettings } from "./platform";

export function coreSettingsFromAppSettings(settings: AppSettings): CoreSettings {
  return {
    defaultTerminal: settings.defaultTerminal,
    globalShortcut: settings.globalShortcut,
    claudeBinary: settings.claudeBinary,
    codexBinary: settings.codexBinary,
    hideSubagentSessions: settings.hideSubagentSessions,
    autoCheckUpdates: settings.autoCheckUpdates,
  };
}

export function applyCoreSettingsUpdate(
  settings: AppSettings,
  update: CoreSettingsUpdate,
): AppSettings {
  return {
    ...settings,
    ...update,
  };
}
