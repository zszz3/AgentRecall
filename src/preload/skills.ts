import type { IpcRenderer } from "electron";
import type { DeleteInstalledSkillResult, InstalledSkillsSnapshot } from "../core/skill-manager";
import type { ManagedSkill, ManagedSkillImportResult, SkillInstallTarget } from "../core/managed-skill-library";
import type { SkillsShDetail, SkillsShPage } from "../core/skills-sh";
import type { SkillDiffSnapshot } from "../core/skill-diff";
import type { RemoteSkill, SkillSyncBatchResult, SkillSyncInstallResult, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../core/skill-sync";
import type { SkillUsageRefreshStatus } from "../core/skill-usage";
import { SKILLS_IPC } from "../shared/ipc/skills";

export type SkillsIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createSkillsApi(ipc: SkillsIpcRenderer) {
  return {
    listSkills: (): Promise<InstalledSkillsSnapshot> => ipc.invoke(SKILLS_IPC.list.channel),
    listSkillImportCandidates: (): Promise<InstalledSkillsSnapshot> => ipc.invoke(SKILLS_IPC.listImportCandidates.channel),
    importLocalSkills: (skillPaths: string[]): Promise<ManagedSkillImportResult[]> =>
      ipc.invoke(SKILLS_IPC.importLocal.channel, skillPaths),
    updateManagedSkillTargets: (managedId: string, targets: SkillInstallTarget[]): Promise<ManagedSkill> =>
      ipc.invoke(SKILLS_IPC.updateTargets.channel, managedId, targets),
    listDiscoveredSkills: (input: { page: number; query: string }): Promise<SkillsShPage> =>
      ipc.invoke(SKILLS_IPC.listDiscovered.channel, input),
    getDiscoveredSkill: (id: string): Promise<SkillsShDetail> => ipc.invoke(SKILLS_IPC.getDiscovered.channel, id),
    importDiscoveredSkill: (id: string): Promise<ManagedSkillImportResult> =>
      ipc.invoke(SKILLS_IPC.importDiscovered.channel, id),
    refreshSkillUsage: (): Promise<SkillUsageRefreshStatus> => ipc.invoke(SKILLS_IPC.refreshUsage.channel),
    getSkillSyncSnapshot: (): Promise<SkillSyncSnapshot> => ipc.invoke(SKILLS_IPC.getSyncSnapshot.channel),
    uploadSkillToSync: (skillPath: string, force?: boolean): Promise<SkillSyncUploadOutcome> =>
      ipc.invoke(SKILLS_IPC.upload.channel, skillPath, force),
    installSyncedSkill: (remoteSkillId: string): Promise<SkillSyncInstallResult> =>
      ipc.invoke(SKILLS_IPC.install.channel, remoteSkillId),
    downloadSyncedSkills: (fingerprints: string[]): Promise<SkillSyncBatchResult> =>
      ipc.invoke(SKILLS_IPC.downloadMany.channel, fingerprints),
    deleteSyncedSkills: (fingerprints: string[]): Promise<SkillSyncBatchResult> =>
      ipc.invoke(SKILLS_IPC.deleteMany.channel, fingerprints),
    getSyncedSkillVersion: (remoteSkillId: string): Promise<RemoteSkill> =>
      ipc.invoke(SKILLS_IPC.getVersion.channel, remoteSkillId),
    getSyncedSkillDiff: (localSkillPath: string | null, remoteSkillId: string | null): Promise<SkillDiffSnapshot> =>
      ipc.invoke(SKILLS_IPC.getDiff.channel, localSkillPath, remoteSkillId),
    copySkillSyncSetupSql: (): Promise<void> => ipc.invoke(SKILLS_IPC.copySetupSql.channel),
    copySkillPath: (skillPath: string): Promise<void> => ipc.invoke(SKILLS_IPC.copyPath.channel, skillPath),
    revealSkill: (targetPath: string): Promise<void> => ipc.invoke(SKILLS_IPC.reveal.channel, targetPath),
    deleteSkill: (skillPath: string): Promise<DeleteInstalledSkillResult> => ipc.invoke(SKILLS_IPC.delete.channel, skillPath),
    getSkillUsageHookStatus: (): Promise<boolean> => ipc.invoke(SKILLS_IPC.getUsageHookStatus.channel),
    installSkillUsageHook: (): Promise<string> => ipc.invoke(SKILLS_IPC.installUsageHook.channel),
    uninstallSkillUsageHook: (): Promise<string> => ipc.invoke(SKILLS_IPC.uninstallUsageHook.channel),
  };
}

export type SkillsApi = ReturnType<typeof createSkillsApi>;
