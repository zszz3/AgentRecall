import type { NativeUpdateController } from "../../distribution/native-update-controller";
import {
  NATIVE_UPDATE_FAILURE_URL,
  NATIVE_UPDATE_RELEASES_URL,
  type NativeUpdateState,
} from "../../distribution/native-update-types";
import type { NativeUpdateIpcService } from "../ipc/native-update";

export interface CoreNativeUpdateServiceOptions {
  currentVersion: string;
  getController(): NativeUpdateController | null;
  copyText(text: string): void;
  openExternal(url: string): Promise<unknown>;
}

export function sanitizeNativeUpdateStateForRenderer(
  state: NativeUpdateState,
): NativeUpdateState {
  return {
    ...state,
    backupPath: state.backupPath ? "<app-data>/update-backups" : null,
  };
}

export function createCoreNativeUpdateService(
  options: CoreNativeUpdateServiceOptions,
): NativeUpdateIpcService {
  const disabledState = (): NativeUpdateState => ({
    phase: "disabled",
    currentVersion: options.currentVersion,
    targetVersion: null,
    progressPercent: null,
    backupPath: null,
    failure: null,
  });
  const controller = (): NativeUpdateController | null =>
    options.getController();

  return {
    getState: () => sanitizeNativeUpdateStateForRenderer(
      controller()?.getState() ?? disabledState(),
    ),
    async check() {
      const active = controller();
      if (!active) return disabledState();
      await active.check(true);
      return sanitizeNativeUpdateStateForRenderer(active.getState());
    },
    async download() {
      const active = controller();
      if (!active) return disabledState();
      await active.download();
      return sanitizeNativeUpdateStateForRenderer(active.getState());
    },
    async install() {
      const active = controller();
      if (!active) return disabledState();
      await active.installDownloadedUpdate();
      return sanitizeNativeUpdateStateForRenderer(active.getState());
    },
    async retry() {
      const active = controller();
      if (!active) return disabledState();
      await active.retry();
      return sanitizeNativeUpdateStateForRenderer(active.getState());
    },
    copyDiagnostics() {
      const active = controller();
      if (active) {
        active.copyFailureDiagnostics();
        return sanitizeNativeUpdateStateForRenderer(active.getState());
      }
      options.copyText(JSON.stringify({
        product: "AgentRecall",
        currentVersion: options.currentVersion,
        code: "NATIVE_UPDATE_DISABLED",
        failureUrl: NATIVE_UPDATE_FAILURE_URL,
        releaseUrl: NATIVE_UPDATE_RELEASES_URL,
      }, null, 2));
      return disabledState();
    },
    async openHelp() {
      const active = controller();
      if (active) await active.openFailureHelp();
      else await options.openExternal(NATIVE_UPDATE_FAILURE_URL);
      return sanitizeNativeUpdateStateForRenderer(
        active?.getState() ?? disabledState(),
      );
    },
    async openReleases() {
      const active = controller();
      if (active) await active.openReleases();
      else await options.openExternal(NATIVE_UPDATE_RELEASES_URL);
      return sanitizeNativeUpdateStateForRenderer(
        active?.getState() ?? disabledState(),
      );
    },
  };
}
