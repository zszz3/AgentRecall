import type { NativeUpdateState } from "../../distribution/native-update-types";
import { NATIVE_UPDATE_IPC } from "../../shared/ipc/native-update";
import {
  combineIpcDisposers,
  registerIpcHandler,
  type IpcMainRegistrar,
} from "./register-ipc-handler";

export interface NativeUpdateIpcService {
  getState(): Promise<NativeUpdateState> | NativeUpdateState;
  check(): Promise<NativeUpdateState>;
  download(): Promise<NativeUpdateState>;
  install(): Promise<NativeUpdateState>;
  retry(): Promise<NativeUpdateState>;
  copyDiagnostics(): Promise<NativeUpdateState> | NativeUpdateState;
  openHelp(): Promise<NativeUpdateState>;
  openReleases(): Promise<NativeUpdateState>;
}

export function registerNativeUpdateIpc(
  ipc: IpcMainRegistrar,
  service: NativeUpdateIpcService,
): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, NATIVE_UPDATE_IPC.getState, () => service.getState()),
    registerIpcHandler(ipc, NATIVE_UPDATE_IPC.check, () => service.check()),
    registerIpcHandler(ipc, NATIVE_UPDATE_IPC.download, () => service.download()),
    registerIpcHandler(ipc, NATIVE_UPDATE_IPC.install, () => service.install()),
    registerIpcHandler(ipc, NATIVE_UPDATE_IPC.retry, () => service.retry()),
    registerIpcHandler(ipc, NATIVE_UPDATE_IPC.copyDiagnostics, () => service.copyDiagnostics()),
    registerIpcHandler(ipc, NATIVE_UPDATE_IPC.openHelp, () => service.openHelp()),
    registerIpcHandler(ipc, NATIVE_UPDATE_IPC.openReleases, () => service.openReleases()),
  ]);
}
