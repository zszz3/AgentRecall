import type { DeleteInstalledSkillResult, InstalledSkillsSnapshot } from "../../core/skill-manager";
import type { SkillAiSearchResult } from "../../core/skill-ai-search";
import type { ManagedSkill, ManagedSkillImportResult, SkillInstallTarget } from "../../core/managed-skill-library";
import type { SkillsShDetail, SkillsShPage } from "../../core/skills-sh";
import type { SkillDiffSnapshot } from "../../core/skill-diff";
import type { RemoteSkill, SkillSyncBatchResult, SkillSyncInstallResult, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../../core/skill-sync";
import type { SkillUsageRefreshStatus } from "../../core/skill-usage";
import type { SkillTriggerLink } from "../../core/session-store";
import type { SkillEvalDetail, SkillEvalOverview, SkillEvalSuite, CreateSkillEvalSuiteInput, UpdateSkillEvalSuiteInput, SkillEvalSuiteCase } from "../services/skill-service";
import type { EvaluationRun } from "../../automation/contracts";
import { SKILLS_IPC } from "../../shared/ipc/skills";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface SkillsIpcService {
  listSkills(): Promise<InstalledSkillsSnapshot>;
  listImportCandidates(forceRefresh?: boolean): Promise<InstalledSkillsSnapshot>;
  importLocalSkills(skillPaths: string[]): Promise<ManagedSkillImportResult[]>;
  updateManagedSkillTargets(managedId: string, targets: SkillInstallTarget[]): ManagedSkill;
  listDiscoveredSkills(input: { page: number; query: string }): Promise<SkillsShPage>;
  aiSearchDiscoveredSkills(input: { query: string; language: "en" | "zh" }): Promise<SkillAiSearchResult>;
  getDiscoveredSkill(id: string): Promise<SkillsShDetail>;
  importDiscoveredSkill(id: string): Promise<ManagedSkillImportResult>;
  refreshUsage(): Promise<SkillUsageRefreshStatus>;
  getSyncSnapshot(): Promise<SkillSyncSnapshot>;
  upload(skillPath: string, force: boolean): Promise<SkillSyncUploadOutcome>;
  install(remoteSkillId: string): Promise<SkillSyncInstallResult>;
  downloadMany(fingerprints: string[]): Promise<SkillSyncBatchResult>;
  deleteMany(fingerprints: string[]): Promise<SkillSyncBatchResult>;
  getVersion(remoteSkillId: string): Promise<RemoteSkill>;
  getDiff(localSkillPath: string | null, remoteSkillId: string | null): Promise<SkillDiffSnapshot>;
  copySetupSql(): void;
  copyPath(skillPath: string): Promise<void>;
  reveal(skillPath: string): Promise<void>;
  delete(skillPath: string): Promise<DeleteInstalledSkillResult>;
  getUsageHookStatus(): boolean;
  installUsageHook(): string;
  uninstallUsageHook(): string;
  listSkillTriggers(options: { skill?: string; limit?: number }): Promise<SkillTriggerLink[]>;
  getSkillEvalOverview(): Promise<SkillEvalOverview>;
  getSkillEvalDetail(skill: string): Promise<SkillEvalDetail>;
  getSkillFindings(skill: string): Promise<import("../../core/skill-eval-findings").SkillFinding[]>;
  getSkillFindingCounts(): Promise<{ skill: string; low: number; medium: number }[]>;
  getSkillEvalSuites(skill: string): Promise<SkillEvalSuite[]>;
  createSkillEvalSuite(input: CreateSkillEvalSuiteInput): Promise<SkillEvalSuite>;
  updateSkillEvalSuite(input: UpdateSkillEvalSuiteInput): Promise<SkillEvalSuite>;
  deleteSkillEvalSuite(experimentId: string): Promise<void>;
  getSkillEvalSuiteCases(experimentId: string): Promise<SkillEvalSuiteCase[]>;
  runSkillEvalSuite(experimentId: string): Promise<EvaluationRun>;
}

export function registerSkillsIpc(ipc: IpcMainRegistrar, service: SkillsIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, SKILLS_IPC.list, () => service.listSkills()),
    registerIpcHandler(ipc, SKILLS_IPC.listImportCandidates, (_event, forceRefresh) => service.listImportCandidates(forceRefresh)),
    registerIpcHandler(ipc, SKILLS_IPC.importLocal, (_event, paths) => service.importLocalSkills(paths)),
    registerIpcHandler(ipc, SKILLS_IPC.updateTargets, (_event, id, targets) => service.updateManagedSkillTargets(id, targets)),
    registerIpcHandler(ipc, SKILLS_IPC.listDiscovered, (_event, input) => service.listDiscoveredSkills(input)),
    registerIpcHandler(ipc, SKILLS_IPC.aiSearchDiscovered, (_event, input) => service.aiSearchDiscoveredSkills(input)),
    registerIpcHandler(ipc, SKILLS_IPC.getDiscovered, (_event, id) => service.getDiscoveredSkill(id)),
    registerIpcHandler(ipc, SKILLS_IPC.importDiscovered, (_event, id) => service.importDiscoveredSkill(id)),
    registerIpcHandler(ipc, SKILLS_IPC.refreshUsage, () => service.refreshUsage()),
    registerIpcHandler(ipc, SKILLS_IPC.getSyncSnapshot, () => service.getSyncSnapshot()),
    registerIpcHandler(ipc, SKILLS_IPC.upload, (_event, path, force) => service.upload(path, force)),
    registerIpcHandler(ipc, SKILLS_IPC.install, (_event, id) => service.install(id)),
    registerIpcHandler(ipc, SKILLS_IPC.downloadMany, (_event, fingerprints) => service.downloadMany(fingerprints)),
    registerIpcHandler(ipc, SKILLS_IPC.deleteMany, (_event, fingerprints) => service.deleteMany(fingerprints)),
    registerIpcHandler(ipc, SKILLS_IPC.getVersion, (_event, id) => service.getVersion(id)),
    registerIpcHandler(ipc, SKILLS_IPC.getDiff, (_event, path, id) => service.getDiff(path, id)),
    registerIpcHandler(ipc, SKILLS_IPC.copySetupSql, () => service.copySetupSql()),
    registerIpcHandler(ipc, SKILLS_IPC.copyPath, (_event, path) => service.copyPath(path)),
    registerIpcHandler(ipc, SKILLS_IPC.reveal, (_event, path) => service.reveal(path)),
    registerIpcHandler(ipc, SKILLS_IPC.delete, (_event, path) => service.delete(path)),
    registerIpcHandler(ipc, SKILLS_IPC.getUsageHookStatus, () => service.getUsageHookStatus()),
    registerIpcHandler(ipc, SKILLS_IPC.installUsageHook, () => service.installUsageHook()),
    registerIpcHandler(ipc, SKILLS_IPC.uninstallUsageHook, () => service.uninstallUsageHook()),
    registerIpcHandler(ipc, SKILLS_IPC.listTriggers, (_event, options) => service.listSkillTriggers(options)),
    registerIpcHandler(ipc, SKILLS_IPC.getEvalOverview, () => service.getSkillEvalOverview()),
    registerIpcHandler(ipc, SKILLS_IPC.getEvalDetail, (_event, skill) => service.getSkillEvalDetail(skill)),
    registerIpcHandler(ipc, SKILLS_IPC.getEvalFindings, (_event, skill) => service.getSkillFindings(skill)),
    registerIpcHandler(ipc, SKILLS_IPC.getEvalFindingCounts, () => service.getSkillFindingCounts()),
    registerIpcHandler(ipc, SKILLS_IPC.listEvalSuites, (_event, skill) => service.getSkillEvalSuites(skill)),
    registerIpcHandler(ipc, SKILLS_IPC.createEvalSuite, (_event, input) => service.createSkillEvalSuite(input)),
    registerIpcHandler(ipc, SKILLS_IPC.updateEvalSuite, (_event, input) => service.updateSkillEvalSuite(input)),
    registerIpcHandler(ipc, SKILLS_IPC.deleteEvalSuite, (_event, experimentId) => service.deleteSkillEvalSuite(experimentId)),
    registerIpcHandler(ipc, SKILLS_IPC.getEvalSuiteCases, (_event, experimentId) => service.getSkillEvalSuiteCases(experimentId)),
    registerIpcHandler(ipc, SKILLS_IPC.runEvalSuite, (_event, experimentId) => service.runSkillEvalSuite(experimentId)),
  ]);
}
