import type { IpcRenderer } from "electron";
import type { RemoteSessionDeleteResult, RemoteSessionDetailSnapshot, RemoteSessionListItem, RemoteSessionStatus, RemoteSessionUploadResult, SessionSyncItem } from "../core/remote-session-sync";
import type { SessionSyncHookStatus } from "../core/session-sync-queue";
import type { MigrationAgent, SessionMigrationResult } from "../core/types";
import { REMOTE_SESSIONS_IPC } from "../shared/ipc/remote-sessions";

export type RemoteSessionsIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createRemoteSessionsApi(ipc: RemoteSessionsIpcRenderer) {
  return {
    getRemoteSessionStatus: (): Promise<RemoteSessionStatus> => ipc.invoke(REMOTE_SESSIONS_IPC.getStatus.channel),
    copyRemoteSessionSetupSql: (): Promise<void> => ipc.invoke(REMOTE_SESSIONS_IPC.copySetupSql.channel),
    getSessionSyncHookStatus: (): Promise<SessionSyncHookStatus> => ipc.invoke(REMOTE_SESSIONS_IPC.getHookStatus.channel),
    installSessionSyncHooks: (): Promise<SessionSyncHookStatus> => ipc.invoke(REMOTE_SESSIONS_IPC.installHooks.channel),
    uninstallSessionSyncHooks: (): Promise<SessionSyncHookStatus> => ipc.invoke(REMOTE_SESSIONS_IPC.uninstallHooks.channel),
    uploadRemoteSession: (sessionKey: string, force?: boolean): Promise<RemoteSessionUploadResult> =>
      ipc.invoke(REMOTE_SESSIONS_IPC.upload.channel, sessionKey, force),
    listRemoteSessions: (query?: string): Promise<RemoteSessionListItem[]> => ipc.invoke(REMOTE_SESSIONS_IPC.list.channel, query),
    listSessionSyncItems: (): Promise<SessionSyncItem[]> => ipc.invoke(REMOTE_SESSIONS_IPC.listSyncItems.channel),
    getRemoteSessionDetail: (remoteId: string): Promise<RemoteSessionDetailSnapshot> =>
      ipc.invoke(REMOTE_SESSIONS_IPC.getDetail.channel, remoteId),
    previewRemoteSessionAttachment: (
      objectKey: string,
      sha256: string,
      mimeType: string,
      previewKind: "image" | "pdf" | "text" | "file",
    ): Promise<{ kind: "image" | "text" | "unavailable"; data?: string }> =>
      ipc.invoke(REMOTE_SESSIONS_IPC.previewAttachment.channel, objectKey, sha256, mimeType, previewKind),
    chooseRemoteRestoreProject: (): Promise<string | null> => ipc.invoke(REMOTE_SESSIONS_IPC.chooseProject.channel),
    restoreRemoteSession: (remoteId: string, target: MigrationAgent, localProjectPath: string): Promise<SessionMigrationResult> =>
      ipc.invoke(REMOTE_SESSIONS_IPC.restore.channel, remoteId, target, localProjectPath),
    restoreRemoteSessionToSourceEnvironment: (remoteId: string, target: MigrationAgent): Promise<SessionMigrationResult> =>
      ipc.invoke(REMOTE_SESSIONS_IPC.restoreToSource.channel, remoteId, target),
    deleteRemoteSession: (remoteId: string): Promise<boolean> => ipc.invoke(REMOTE_SESSIONS_IPC.delete.channel, remoteId),
    deleteRemoteSessions: (remoteIds: string[]): Promise<RemoteSessionDeleteResult> =>
      ipc.invoke(REMOTE_SESSIONS_IPC.deleteMany.channel, remoteIds),
  };
}

export type RemoteSessionsApi = ReturnType<typeof createRemoteSessionsApi>;
