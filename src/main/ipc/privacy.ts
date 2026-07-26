import type {
  CoreLegacyCleanupPreview,
  CoreLegacyCleanupResult,
  CoreLegacyIntegrationInspection,
} from "../../shared/core-api";
import type { PrivacyDiagnosticReport } from "../../privacy/diagnostics";
import { PRIVACY_IPC } from "../../shared/ipc/privacy";
import {
  combineIpcDisposers,
  registerIpcHandler,
  type IpcMainRegistrar,
} from "./register-ipc-handler";

export interface PrivacyIpcService {
  diagnostics(): Promise<PrivacyDiagnosticReport>;
  inspectLegacy(): Promise<CoreLegacyIntegrationInspection>;
  previewLegacyCleanup(): Promise<CoreLegacyCleanupPreview>;
  applyLegacyCleanup(
    planId: string,
    confirmed: true,
  ): Promise<CoreLegacyCleanupResult>;
}

export function registerPrivacyIpc(
  ipc: IpcMainRegistrar,
  service: PrivacyIpcService,
): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, PRIVACY_IPC.diagnostics, () => service.diagnostics()),
    registerIpcHandler(ipc, PRIVACY_IPC.inspectLegacy, () => service.inspectLegacy()),
    registerIpcHandler(ipc, PRIVACY_IPC.previewLegacyCleanup, () =>
      service.previewLegacyCleanup()),
    registerIpcHandler(ipc, PRIVACY_IPC.applyLegacyCleanup, (_event, planId, confirmed) =>
      service.applyLegacyCleanup(planId, confirmed)),
  ]);
}
