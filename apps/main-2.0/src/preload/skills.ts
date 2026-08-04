import type { IpcRenderer } from "electron";
import type { DeleteInstalledSkillResult, InstalledSkillsSnapshot } from "../core/skill-manager";
import type { SkillAiSearchResult } from "../core/skill-ai-search";
import type { ManagedSkill, ManagedSkillImportResult, SkillInstallTarget } from "../core/managed-skill-library";
import type { SkillsShDetail, SkillsShPage } from "../core/skills-sh";
import type { SkillDiffSnapshot } from "../core/skill-diff";
import type { RemoteSkill, SkillSyncBatchResult, SkillSyncInstallResult, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../core/skill-sync";
import type { SkillUsageRefreshStatus } from "../core/skill-usage";
import type { SkillTriggerLink } from "../core/session-store";
import type { SkillEvalDetail, SkillEvalOverview, SkillEvalSuite, CreateSkillEvalSuiteInput, UpdateSkillEvalSuiteInput, SkillEvalSuiteCase } from "../main/services/skill-service";
import type { SkillFinding } from "../core/skill-eval-findings";
import type { EvaluationRun } from "../automation/contracts";
import { SKILLS_IPC } from "../shared/ipc/skills";

export type SkillsIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createSkillsApi(ipc: SkillsIpcRenderer) {
  return {
    listSkills: (): Promise<InstalledSkillsSnapshot> => ipc.invoke(SKILLS_IPC.list.channel),
    listSkillImportCandidates: (forceRefresh = false): Promise<InstalledSkillsSnapshot> => forceRefresh
      ? ipc.invoke(SKILLS_IPC.listImportCandidates.channel, true)
      : ipc.invoke(SKILLS_IPC.listImportCandidates.channel),
    importLocalSkills: (skillPaths: string[]): Promise<ManagedSkillImportResult[]> =>
      ipc.invoke(SKILLS_IPC.importLocal.channel, skillPaths),
    updateManagedSkillTargets: (managedId: string, targets: SkillInstallTarget[]): Promise<ManagedSkill> =>
      ipc.invoke(SKILLS_IPC.updateTargets.channel, managedId, targets),
    listDiscoveredSkills: (input: { page: number; query: string }): Promise<SkillsShPage> =>
      ipc.invoke(SKILLS_IPC.listDiscovered.channel, input),
    aiSearchDiscoveredSkills: (input: { query: string; language: "en" | "zh" }): Promise<SkillAiSearchResult> =>
      ipc.invoke(SKILLS_IPC.aiSearchDiscovered.channel, input),
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
    listSkillTriggers: (options?: { skill?: string; limit?: number }): Promise<SkillTriggerLink[]> =>
      options ? ipc.invoke(SKILLS_IPC.listTriggers.channel, options) : ipc.invoke(SKILLS_IPC.listTriggers.channel),
    getSkillEvalOverview: (): Promise<SkillEvalOverview> => ipc.invoke(SKILLS_IPC.getEvalOverview.channel),
    getSkillEvalDetail: (skill: string): Promise<SkillEvalDetail> => ipc.invoke(SKILLS_IPC.getEvalDetail.channel, skill),
    getSkillEvalFindings: (skill: string): Promise<SkillFinding[]> => ipc.invoke(SKILLS_IPC.getEvalFindings.channel, skill),
    getSkillEvalFindingCounts: (): Promise<{ skill: string; low: number; medium: number }[]> => ipc.invoke(SKILLS_IPC.getEvalFindingCounts.channel),
    listSkillEvalSuites: (skill: string): Promise<SkillEvalSuite[]> => ipc.invoke(SKILLS_IPC.listEvalSuites.channel, skill),
    createSkillEvalSuite: (input: CreateSkillEvalSuiteInput): Promise<SkillEvalSuite> => ipc.invoke(SKILLS_IPC.createEvalSuite.channel, input),
    updateSkillEvalSuite: (input: UpdateSkillEvalSuiteInput): Promise<SkillEvalSuite> => ipc.invoke(SKILLS_IPC.updateEvalSuite.channel, input),
    deleteSkillEvalSuite: (experimentId: string): Promise<void> => ipc.invoke(SKILLS_IPC.deleteEvalSuite.channel, experimentId),
    getSkillEvalSuiteCases: (experimentId: string): Promise<SkillEvalSuiteCase[]> => ipc.invoke(SKILLS_IPC.getEvalSuiteCases.channel, experimentId),
    runSkillEvalSuite: (experimentId: string): Promise<EvaluationRun> => ipc.invoke(SKILLS_IPC.runEvalSuite.channel, experimentId),
  };
}

export type SkillsApi = ReturnType<typeof createSkillsApi>;
