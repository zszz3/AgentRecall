import { autoUpdater } from "electron-updater";
import { NativeUpdateController, type NativeUpdateControllerOptions } from "./native-update-controller";
import type { NativeAutoUpdater } from "./native-update-types";

export type ElectronUpdaterRegistrationOptions = Omit<NativeUpdateControllerOptions, "updater">;

/**
 * Core Boundary: call this once from the main process, then call
 * `firstUsableWindowReady()` from the first BrowserWindow `ready-to-show`.
 * Do not register this alongside the legacy npm AppUpdateService.
 */
export function registerElectronUpdater(
  options: ElectronUpdaterRegistrationOptions,
): NativeUpdateController {
  return new NativeUpdateController({
    ...options,
    updater: autoUpdater as unknown as NativeAutoUpdater,
  });
}
