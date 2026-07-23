import type { RemoteSessionDeleteResult, RemoteSessionDetailSnapshot, RemoteSessionListItem, RemoteSessionStatus, RemoteSessionUploadResult, SessionSyncItem } from "../../core/remote-session-sync";
import type { SessionSyncHookStatus } from "../../core/session-sync-queue";
import type { MigrationAgent, SessionMigrationProgress, SessionMigrationResult } from "../../core/types";
import { REMOTE_SESSIONS_IPC } from "../../shared/ipc/remote-sessions";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface RemoteSessionsIpcService {
  getStatus(): Promise<RemoteSessionStatus>;
  copySetupSql(): void;
  getHookStatus(): SessionSyncHookStatus;
  installHooks(): SessionSyncHookStatus;
  uninstallHooks(): SessionSyncHookStatus;
  upload(sessionKey: string, force: boolean): Promise<RemoteSessionUploadResult>;
  list(query: string): Promise<RemoteSessionListItem[]>;
  listSyncItems(): Promise<SessionSyncItem[]>;
  getDetail(remoteId: string): Promise<RemoteSessionDetailSnapshot>;
  previewAttachment(
    objectKey: string,
    sha256: string,
    mimeType: string,
    previewKind: "image" | "pdf" | "text" | "file",
  ): Promise<{ kind: "image" | "text" | "unavailable"; data?: string }>;
  chooseProject(): Promise<string | null>;
  restore(remoteId: string, target: MigrationAgent, projectPath: string, onProgress: (progress: SessionMigrationProgress) => void): Promise<SessionMigrationResult>;
  restoreToSource(remoteId: string, target: MigrationAgent, onProgress: (progress: SessionMigrationProgress) => void): Promise<SessionMigrationResult>;
  delete(remoteId: string): Promise<boolean>;
  deleteMany(remoteIds: string[]): Promise<RemoteSessionDeleteResult>;
}

export function registerRemoteSessionsIpc(ipc: IpcMainRegistrar, service: RemoteSessionsIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.getStatus, () => service.getStatus()),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.copySetupSql, () => service.copySetupSql()),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.getHookStatus, () => service.getHookStatus()),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.installHooks, () => service.installHooks()),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.uninstallHooks, () => service.uninstallHooks()),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.upload, (_event, key, force) => service.upload(key, force)),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.list, (_event, query) => service.list(query)),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.listSyncItems, () => service.listSyncItems()),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.getDetail, (_event, id) => service.getDetail(id)),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.previewAttachment, (_event, objectKey, sha256, mimeType, previewKind) =>
      service.previewAttachment(objectKey, sha256, mimeType, previewKind)),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.chooseProject, () => service.chooseProject()),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.restore, (event, id, target, projectPath) =>
      service.restore(id, target, projectPath, (progress) => event.sender.send("session:migration-progress", progress))),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.restoreToSource, (event, id, target) =>
      service.restoreToSource(id, target, (progress) => event.sender.send("session:migration-progress", progress))),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.delete, (_event, id) => service.delete(id)),
    registerIpcHandler(ipc, REMOTE_SESSIONS_IPC.deleteMany, (_event, ids) => service.deleteMany(ids)),
  ]);
}
