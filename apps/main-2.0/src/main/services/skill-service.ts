import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { AppSettings } from "../../core/platform";
import type {
  SkillPerformanceSignals,
  SkillSyncBinding,
  SkillToolOutcome,
  SkillTriggerLink,
  SkillUsageOverviewRow,
  SkillVersionGroup,
} from "../../core/session-store";
import { runSkillAiSearch, type SkillAiSearchResult } from "../../core/skill-ai-search";
import {
  ManagedSkillLibrary,
  type ManagedSkillFileImport,
  type ManagedSkillImportResult,
  type ManagedSkillsSnapshot,
  type ManagedSkillTargetUpdateResult,
  type SkillInstallTarget,
} from "../../core/managed-skill-library";
import {
  SkillsShClient,
  type SkillsShDetail,
  type SkillsShEntry,
  type SkillsShPage,
} from "../../core/skills-sh";
import { AGENT_SKILL_REGISTRY } from "../../core/agent-skill-registry";
import {
  deleteInstalledSkill,
  installRemoteSkillLocally,
  isSyncableSkill,
  listInstalledSkills,
  portableSkillLocation,
  skillProjectDirsFromIndexedProjects,
  type DeleteInstalledSkillResult,
  type InstalledSkill,
  type InstalledSkillsSnapshot,
  type SkillAgent,
} from "../../core/skill-manager";
import { buildSkillDiffSnapshot, type SkillContentSnapshot, type SkillDiffSnapshot } from "../../core/skill-diff";
import {
  buildSkillSyncSetupSql,
  buildSkillVersionBasePayload,
  groupRemoteSkillVersions,
  skillSyncFilesFromMetadata,
  skillSyncFingerprint,
  skillSyncLocalContentHash,
  SupabaseSkillSyncClient,
  type RemoteSkill,
  type RemoteSkillVersion,
  type SkillSyncBatchResult,
  type SkillSyncInstallResult,
  type SkillSyncRelation,
  type SkillSyncSnapshot,
  type SkillSyncStatus,
  type SkillSyncUploadOutcome,
  type SkillVersionBasePayload,
} from "../../core/skill-sync";
import {
  listSkillUsageSourcesAsync,
  readSkillUsageSourceEventsAsync,
  usageForSkill,
  type SkillUsageEvent,
  type SkillUsageAgent,
  type SkillUsageRefreshStatus,
  type SkillUsageSnapshot,
  type SkillUsageSource,
} from "../../core/skill-usage";
import {
  AUTO_SKILL_USAGE_REFRESH_INTERVAL_MS,
  INITIAL_SKILL_USAGE_REFRESH_DELAY_MS,
} from "../../core/refresh-policy";
import type { ProjectSummary } from "../../core/types";
import type { EvaluationRun, EvaluationRunSummary } from "../../automation/contracts";
import { evaluateSkillFindings, type SkillFinding } from "../../core/skill-eval-findings";
import type { EvaluationService } from "./evaluation-service";

export interface SkillUsageHookSetup {
  installSkillUsageHook(options?: Record<string, unknown>): { status: string; detail?: string };
  uninstallSkillUsageHook(options?: Record<string, unknown>): { status: string; detail?: string };
  skillUsageHookStatus(options?: Record<string, unknown>): { installed: boolean };
}

// Skill regression evaluation (phase four): user-defined cases bound to a skill
// version. Cases are the specification ("given this input, expect this output");
// runs collected through the automation engine are the evidence.

export interface SkillEvalSuiteCase {
  input: string;
  expectedOutput?: string;
}

export interface CreateSkillEvalSuiteInput {
  skill: string;
  name: string;
  agentId: string;
  evaluatorIds: string[];
  // When true the service provisions (or reuses) the built-in LLM judge bound
  // to the execution agent's channel, so users never need to configure a
  // judge runtime before their first run.
  useBuiltinJudge: boolean;
  repetitions: number;
  cases: SkillEvalSuiteCase[];
}

export interface UpdateSkillEvalSuiteInput {
  id: string;
  name: string;
  agentId: string;
  evaluatorIds: string[];
  useBuiltinJudge: boolean;
  repetitions: number;
  cases: SkillEvalSuiteCase[];
}

export interface SkillEvalSuiteLastRun {
  id: string;
  startedAt: number;
  status: string;
  passRate: number | null;
  averageScore: number | null;
}

export interface SkillEvalSuite {
  id: string;
  name: string;
  skill: string;
  // SKILL.md hash captured at the most recent run; null before the first run.
  skillHash: string | null;
  // Current installed SKILL.md hash; null when the skill is no longer readable.
  currentHash: string | null;
  drifted: boolean;
  agentId: string;
  evaluatorIds: string[];
  repetitions: number;
  caseCount: number;
  createdAt: number;
  updatedAt: number;
  lastRun: SkillEvalSuiteLastRun | null;
}

// Evidence-ladder state for a skill in the Eval overview. "unobserved" means
// the collection pipeline cannot see this skill yet, which must never be
// presented as "never used".
export type SkillEvalObservation = "exercised" | "never-used" | "unobserved";

export interface SkillEvalOverviewItem {
  skill: string;
  // Agent of the most recent trigger; null when the skill has none yet.
  agent: SkillUsageAgent | null;
  installed: boolean;
  totalTriggers: number;
  triggers7d: number;
  triggers30d: number;
  lastTriggeredAt: number | null;
  linkedTriggers: number;
  observation: SkillEvalObservation;
}

export interface SkillEvalOverview {
  hookInstalled: boolean;
  // Whether the claude hook pipeline has demonstrably produced records.
  claudeHookObservable: boolean;
  skills: SkillEvalOverviewItem[];
}

export interface SkillEvalVersionGroup extends SkillVersionGroup {
  current: boolean;
}

export interface SkillEvalDetail {
  skill: string;
  signals: SkillPerformanceSignals;
  versions: SkillEvalVersionGroup[];
  currentHash: string | null;
  remoteVersion: number | null;
}

export interface SkillStorePort {
  listProjects(): Promise<ProjectSummary[]>;
  getSkillUsageSnapshot(): Promise<SkillUsageSnapshot>;
  isSkillUsageSourceFresh(source: SkillUsageSource): Promise<boolean>;
  upsertSkillUsageSource(source: SkillUsageSource, events: SkillUsageEvent[]): Promise<void>;
  pruneSkillUsageSources(activePaths: string[]): Promise<void>;
  listRecentSkillTriggers(options: { skill?: string; limit?: number }): Promise<SkillTriggerLink[]>;
  listSkillUsageOverview(): Promise<SkillUsageOverviewRow[]>;
  getSkillPerformanceSignals(skill: string): Promise<SkillPerformanceSignals>;
  listSkillVersionGroups(skill: string): Promise<SkillVersionGroup[]>;
  listSkillToolOutcomes(skill: string): Promise<SkillToolOutcome[]>;
  hasClaudeHookUsageEvents(): Promise<boolean>;
  listSkillSyncBindings(): Promise<SkillSyncBinding[]>;
  getSkillSyncBindingForPortableIdentity(identity: string): Promise<SkillSyncBinding | null>;
  upsertSkillSyncBinding(binding: SkillSyncBinding): Promise<void>;
  deleteSkillSyncBindingsForRemoteIds(remoteIds: string[]): Promise<void>;
}

export interface SkillSyncClientPort {
  checkStatus(): Promise<SkillSyncStatus>;
  listRemoteSkillVersions(): Promise<RemoteSkillVersion[]>;
  uploadSkillVersion(base: SkillVersionBasePayload, version: number): Promise<RemoteSkill>;
  getRemoteSkill(remoteId: string): Promise<RemoteSkill>;
  deleteRemoteSkillVersions(remoteIds: string[]): Promise<string[]>;
}

export interface ManagedSkillLibraryPort {
  list(): ManagedSkillsSnapshot;
  listImportCandidates(projectDirs: string[]): InstalledSkillsSnapshot;
  importLocalSkill(skillPath: string, projectDirs?: string[]): ManagedSkillImportResult;
  ensureBuiltinSkills(bundledSkillsPath: string): void;
  importFiles(input: ManagedSkillFileImport): ManagedSkillImportResult;
  replaceFiles(input: ManagedSkillFileImport): ManagedSkillImportResult;
  updateTargets(
    managedId: string,
    targets: SkillInstallTarget[],
    forceTargets?: SkillInstallTarget[],
  ): ManagedSkillTargetUpdateResult;
  delete(managedId: string): DeleteInstalledSkillResult;
}

export interface SkillsShClientPort {
  list(input: { page: number; query: string }): Promise<SkillsShPage>;
  getDetail(entry: SkillsShEntry): Promise<SkillsShDetail>;
}

export interface SkillServiceOperations {
  listInstalledSkills: typeof listInstalledSkills;
  skillProjectDirsFromIndexedProjects: typeof skillProjectDirsFromIndexedProjects;
  usageForSkill: typeof usageForSkill;
  listSkillUsageSources: typeof listSkillUsageSourcesAsync;
  readSkillUsageSourceEvents: typeof readSkillUsageSourceEventsAsync;
  isSyncableSkill: typeof isSyncableSkill;
  portableSkillLocation: typeof portableSkillLocation;
  skillSyncLocalContentHash: typeof skillSyncLocalContentHash;
  skillSyncFingerprint: typeof skillSyncFingerprint;
  buildSkillVersionBasePayload: typeof buildSkillVersionBasePayload;
  groupRemoteSkillVersions: typeof groupRemoteSkillVersions;
  installRemoteSkillLocally: typeof installRemoteSkillLocally;
  skillSyncFilesFromMetadata: typeof skillSyncFilesFromMetadata;
  buildSkillDiffSnapshot: typeof buildSkillDiffSnapshot;
  deleteInstalledSkill: typeof deleteInstalledSkill;
  buildSkillSyncSetupSql: typeof buildSkillSyncSetupSql;
}

export interface SkillServiceDependencies {
  getStore(): SkillStorePort;
  getSettings(): AppSettings;
  getHookSetup(): SkillUsageHookSetup;
  // Phase four: skill regression suites execute through the automation engine's
  // evaluation service. Absent when the runtime is not up yet.
  getEvaluationService?: () => EvaluationService;
  createSyncClient?(options: { url: string; anonKey: string }): SkillSyncClientPort;
  copyText(text: string): void;
  revealPath(path: string): Promise<void>;
  now(): number;
  logError(message: string): void;
  managedLibrary?: ManagedSkillLibraryPort;
  skillsShClient?: SkillsShClientPort;
  executeAiSearch?(runtimeChannelId: string, prompt: string): Promise<string>;
  libraryRoot?: string;
  skillsShCachePath?: string;
  homeDir?: string;
  codexHome?: string;
  operations?: Partial<SkillServiceOperations>;
  timers?: {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
    setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
    clearInterval(timer: ReturnType<typeof setInterval>): void;
  };
}

const defaultOperations: SkillServiceOperations = {
  listInstalledSkills,
  skillProjectDirsFromIndexedProjects,
  usageForSkill,
  listSkillUsageSources: listSkillUsageSourcesAsync,
  readSkillUsageSourceEvents: readSkillUsageSourceEventsAsync,
  isSyncableSkill,
  portableSkillLocation,
  skillSyncLocalContentHash,
  skillSyncFingerprint,
  buildSkillVersionBasePayload,
  groupRemoteSkillVersions,
  installRemoteSkillLocally,
  skillSyncFilesFromMetadata,
  buildSkillDiffSnapshot,
  deleteInstalledSkill,
  buildSkillSyncSetupSql,
};

const defaultTimers = {
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
  clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
};

function isSkillUsageAgent(agent: SkillAgent): agent is SkillUsageAgent {
  return AGENT_SKILL_REGISTRY.some((entry) => entry.id === agent && entry.hasSkillUsage);
}

export class SkillService {
  private readonly operations: SkillServiceOperations;
  private readonly timers: NonNullable<SkillServiceDependencies["timers"]>;
  private readonly managedLibrary: ManagedSkillLibraryPort | null;
  private readonly skillsShClient: SkillsShClientPort | null;
  private readonly discoveredSkills = new Map<string, SkillsShEntry>();
  private importCandidatesCache: InstalledSkillsSnapshot | null = null;
  private initialUsageTimer: ReturnType<typeof setTimeout> | null = null;
  private autoUsageTimer: ReturnType<typeof setInterval> | null = null;
  private usageRefreshPromise: Promise<SkillUsageRefreshStatus> | null = null;

  constructor(private readonly dependencies: SkillServiceDependencies) {
    this.operations = { ...defaultOperations, ...dependencies.operations };
    this.timers = dependencies.timers ?? defaultTimers;
    const homeDir = dependencies.homeDir ?? os.homedir();
    this.managedLibrary = dependencies.managedLibrary ?? (dependencies.libraryRoot
      ? new ManagedSkillLibrary({
        libraryRoot: dependencies.libraryRoot,
        homeDir,
        codexHome: dependencies.codexHome,
      })
      : null);
    this.skillsShClient = dependencies.skillsShClient ?? (dependencies.skillsShCachePath
      ? new SkillsShClient({ cachePath: dependencies.skillsShCachePath })
      : null);
  }

  async listSkills(): Promise<InstalledSkillsSnapshot> {
    const store = this.dependencies.getStore();
    const snapshot = this.managedLibrary
      ? this.managedLibrary.list()
      : this.operations.listInstalledSkills({ projectDirs: await this.projectDirs() });
    const usage = await store.getSkillUsageSnapshot();
    const skills = snapshot.skills.map((skill) => {
      const stat = this.managedLibrary || !isSkillUsageAgent(skill.agent)
        ? this.operations.usageForSkill(usage, skill.name)
        : this.operations.usageForSkill(usage, skill.name, skill.agent);
      return { ...skill, usageCount: stat?.count ?? 0, lastUsedAt: stat?.lastUsedAt ?? null };
    });
    return {
      ...snapshot,
      skills,
      usage: {
        hookInstalled: this.getUsageHookStatus(),
        logExists: usage.exists,
        totalEvents: usage.totalEvents,
      },
    };
  }

  async listImportCandidates(forceRefresh = false): Promise<InstalledSkillsSnapshot> {
    if (!this.managedLibrary) throw new Error("The managed Skill library is unavailable.");
    if (forceRefresh || !this.importCandidatesCache) {
      this.importCandidatesCache = this.managedLibrary.listImportCandidates(await this.projectDirs());
    }
    const snapshot = this.importCandidatesCache;
    const usage = await this.dependencies.getStore().getSkillUsageSnapshot();
    return {
      ...snapshot,
      skills: snapshot.skills.map((skill) => {
        // Local candidates are deduped by skill name, so a skill installed for
        // several agents collapses to one row. Count usage by name (total across
        // agents) rather than per-agent — otherwise a StepCode/Claude invocation
        // of a skill whose surviving row is its Codex copy would read as zero.
        const stat = this.operations.usageForSkill(usage, skill.name);
        return { ...skill, usageCount: stat?.count ?? 0, lastUsedAt: stat?.lastUsedAt ?? null };
      }),
    };
  }

  async importLocalSkills(skillPaths: string[]): Promise<ManagedSkillImportResult[]> {
    if (!this.managedLibrary) throw new Error("The managed Skill library is unavailable.");
    const projectDirs = await this.projectDirs();
    return this.uniqueValues(skillPaths).map((skillPath) => this.managedLibrary!.importLocalSkill(skillPath, projectDirs));
  }

  updateManagedSkillTargets(
    managedId: string,
    targets: SkillInstallTarget[],
    forceTargets: SkillInstallTarget[] = [],
  ): ManagedSkillTargetUpdateResult {
    if (!this.managedLibrary) throw new Error("The managed Skill library is unavailable.");
    return this.managedLibrary.updateTargets(managedId, targets, forceTargets);
  }

  async listDiscoveredSkills(input: { page: number; query: string }): Promise<SkillsShPage> {
    const client = this.requireSkillsShClient();
    const result = await client.list(input);
    for (const entry of result.skills) this.discoveredSkills.set(entry.id, entry);
    return result;
  }

  async aiSearchDiscoveredSkills(input: { query: string; language: "en" | "zh" }): Promise<SkillAiSearchResult> {
    if (!this.dependencies.executeAiSearch) throw new Error("AI Skill exploration is unavailable.");
    const client = this.requireSkillsShClient();
    const result = await runSkillAiSearch(
      input,
      (query) => client.list({ page: 0, query }),
      (skill) => client.getDetail(skill),
      (prompt) => this.dependencies.executeAiSearch!(
        this.dependencies.getSettings().skillAiRuntimeId,
        prompt,
      ),
    );
    for (const entry of result.skills) this.discoveredSkills.set(entry.id, entry);
    return result;
  }

  getDiscoveredSkill(id: string): Promise<SkillsShDetail> {
    const entry = this.discoveredSkills.get(id);
    if (!entry) throw new Error("This Skill is no longer in the current discovery results. Refresh and try again.");
    return this.requireSkillsShClient().getDetail(entry);
  }

  async importDiscoveredSkill(id: string): Promise<ManagedSkillImportResult> {
    if (!this.managedLibrary) throw new Error("The managed Skill library is unavailable.");
    const detail = await this.getDiscoveredSkill(id);
    return this.managedLibrary.importFiles({
      suggestedId: detail.entry.skillId,
      origin: {
        kind: "skills-sh",
        label: "skills.sh",
        source: detail.entry.source,
        url: detail.entry.url,
      },
      files: detail.files,
    });
  }

  ensureBuiltinSkills(bundledSkillsPath: string): void {
    this.managedLibrary?.ensureBuiltinSkills(bundledSkillsPath);
  }

  async refreshUsage(): Promise<SkillUsageRefreshStatus> {
    if (this.usageRefreshPromise) return this.usageRefreshPromise;
    const request = this.performUsageRefresh();
    this.usageRefreshPromise = request;
    void request.finally(() => {
      if (this.usageRefreshPromise === request) this.usageRefreshPromise = null;
    }).catch(() => undefined);
    return request;
  }

  private async performUsageRefresh(): Promise<SkillUsageRefreshStatus> {
    const store = this.dependencies.getStore();
    const settings = this.dependencies.getSettings();
    const sources = await this.operations.listSkillUsageSources({
      homeDir: this.dependencies.homeDir,
      includeTclaude: settings.includeTclaude,
      includeTcodex: settings.includeTcodex,
      includeStepcode: settings.includeStepcode,
      includeCodeBuddyCli: settings.includeCodeBuddyCli,
      includeWorkBuddy: settings.includeWorkBuddy,
      includeCodeWizCli: settings.includeCodeWizCli,
      includeOpenClaw: settings.includeOpenClaw,
      includeHermes: settings.includeHermes,
      includeOpenCode: settings.includeOpenCode,
      includeZcode: settings.includeZcode,
      includeCursorAgent: settings.includeCursorAgent,
      includeQoder: settings.includeQoder,
    });
    let refreshed = 0;
    let skipped = 0;
    for (const source of sources) {
      if (await store.isSkillUsageSourceFresh(source)) {
        skipped += 1;
        continue;
      }
      await store.upsertSkillUsageSource(
        source,
        await this.operations.readSkillUsageSourceEvents(source),
      );
      refreshed += 1;
    }
    await store.pruneSkillUsageSources(sources.map((source) => source.path));
    return {
      refreshed,
      skipped,
      total: sources.length,
      totalEvents: (await store.getSkillUsageSnapshot()).totalEvents,
      lastRefreshedAt: this.dependencies.now(),
    };
  }

  async refreshUsageSafely(): Promise<void> {
    try {
      await this.refreshUsage();
    } catch (error) {
      this.dependencies.logError(`Failed to refresh skill usage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  startUsageRefresh(): void {
    if (!this.initialUsageTimer) {
      this.initialUsageTimer = this.timers.setTimeout(() => {
        this.initialUsageTimer = null;
        void this.refreshUsageSafely();
      }, INITIAL_SKILL_USAGE_REFRESH_DELAY_MS);
    }
    if (this.autoUsageTimer) return;
    this.autoUsageTimer = this.timers.setInterval(
      () => void this.refreshUsageSafely(),
      AUTO_SKILL_USAGE_REFRESH_INTERVAL_MS,
    );
  }

  stopUsageRefresh(): void {
    if (this.initialUsageTimer) {
      this.timers.clearTimeout(this.initialUsageTimer);
      this.initialUsageTimer = null;
    }
    if (!this.autoUsageTimer) return;
    this.timers.clearInterval(this.autoUsageTimer);
    this.autoUsageTimer = null;
  }

  async getSyncSnapshot(): Promise<SkillSyncSnapshot> {
    const setupSql = this.operations.buildSkillSyncSetupSql();
    const settings = this.dependencies.getSettings();
    const store = this.dependencies.getStore();
    if (!this.syncConfigured(settings)) {
      return {
        status: {
          kind: "unconfigured",
          setupSql,
          remediation: "settings",
          message: "Configure Supabase URL and anon key in Settings to sync skills.",
        },
        remoteSkillGroups: [],
        bindings: await store.listSkillSyncBindings(),
        relations: [],
        scannedAt: this.dependencies.now(),
      };
    }
    const client = this.createSyncClient();
    const status = await client.checkStatus();
    const remoteSkillGroups = status.kind === "ready"
      ? this.operations.groupRemoteSkillVersions(await client.listRemoteSkillVersions())
      : [];
    const bindings = await store.listSkillSyncBindings();
    return {
      status,
      remoteSkillGroups,
      bindings,
      relations: status.kind === "ready"
        ? await this.buildSyncRelations((await this.listSkills()).skills, remoteSkillGroups, bindings)
        : [],
      scannedAt: this.dependencies.now(),
    };
  }

  async upload(skillPath: string, force = false): Promise<SkillSyncUploadOutcome> {
    const store = this.dependencies.getStore();
    const skill = await this.findInstalledSkill(skillPath);
    if (!this.operations.isSyncableSkill(skill)) throw new Error("Only user and shared Skills can be uploaded.");
    const location = this.operations.portableSkillLocation(skill);
    if (!location) throw new Error("Only user and shared Skills can be uploaded.");
    const client = this.createSyncClient();
    const fingerprint = this.operations.skillSyncFingerprint(skill);
    const { base, contentHash } = this.operations.buildSkillVersionBasePayload(skill);
    const remoteGroup = this.operations.groupRemoteSkillVersions(await client.listRemoteSkillVersions())
      .find((group) => group.fingerprint === fingerprint) ?? null;
    const latest = remoteGroup?.latest ?? null;
    if (latest && latest.contentHash === contentHash) {
      const binding = await this.persistBinding(skill.path, location.identity, latest.id, latest.updatedAt, latest.version, contentHash, "upload");
      return { status: "skipped", remoteSkillId: latest.id, binding, version: latest.version };
    }
    const existingBinding = await store.getSkillSyncBindingForPortableIdentity(location.identity);
    if (latest && !force && (!existingBinding?.lastContentHash || latest.contentHash !== existingBinding.lastContentHash)) {
      return {
        status: "needs-confirmation",
        conflict: {
          name: latest.name,
          agent: latest.agent,
          latestVersion: latest.version,
          latestSource: latest.source,
          latestPath: latest.relativePath ?? "",
        },
      };
    }
    const existingVersions = remoteGroup?.versions
      .filter((version) => version.localFingerprint === fingerprint)
      .map((version) => version.version) ?? [];
    const remoteSkill = await client.uploadSkillVersion(base, Math.max(0, ...existingVersions) + 1);
    const binding = await this.persistBinding(skill.path, location.identity, remoteSkill.id, remoteSkill.updatedAt, remoteSkill.version, contentHash, "upload");
    return { status: "uploaded", remoteSkill, binding, version: remoteSkill.version };
  }

  async install(remoteSkillId: string): Promise<SkillSyncInstallResult> {
    const remoteSkill = await this.createSyncClient().getRemoteSkill(remoteSkillId);
    if (remoteSkill.legacy || !remoteSkill.portableScope || !remoteSkill.relativePath) {
      throw new Error("This legacy Skill can only be previewed or deleted because its install location is uncertain.");
    }
    if (!this.managedLibrary) {
      const installed = this.operations.installRemoteSkillLocally(remoteSkill);
      const identity = `${remoteSkill.portableScope}/${remoteSkill.relativePath}`;
      const binding = await this.persistBinding(installed.installedPath, identity, remoteSkill.id, remoteSkill.updatedAt, remoteSkill.version, remoteSkill.contentHash, "download");
      return { remoteSkill, binding, installedPath: installed.installedPath, overwritten: installed.overwritten };
    }
    const suggestedId = remoteSkill.relativePath.split("/").filter(Boolean).at(-1) || remoteSkill.name;
    const existing = this.managedLibrary.list().skills.some((skill) => skill.managedId === suggestedId);
    const files = this.operations.skillSyncFilesFromMetadata(remoteSkill.metadata)
      .filter((file) => file.relativePath.toLowerCase() !== "skill.md")
      .map((file) => ({
        relativePath: file.relativePath,
        contents: Buffer.from(file.contentBase64, "base64"),
        mode: file.mode,
      }));
    const input: ManagedSkillFileImport = {
      suggestedId,
      origin: { kind: "remote", label: "Cloud sync" },
      files: [{ relativePath: "SKILL.md", contents: remoteSkill.markdown }, ...files],
    };
    const imported = existing ? this.managedLibrary.replaceFiles(input) : this.managedLibrary.importFiles(input);
    const identity = `agent-recall/${imported.managedId}`;
    const binding = await this.persistBinding(imported.skill.path, identity, remoteSkill.id, remoteSkill.updatedAt, remoteSkill.version, remoteSkill.contentHash, "download");
    return { remoteSkill, binding, installedPath: imported.skill.path, overwritten: existing };
  }

  getVersion(remoteSkillId: string): Promise<RemoteSkill> {
    return this.createSyncClient().getRemoteSkill(remoteSkillId);
  }

  async getDiff(localSkillPath: string | null, remoteSkillId: string | null): Promise<SkillDiffSnapshot> {
    let localSnapshot: SkillContentSnapshot | null = null;
    let remoteSnapshot: SkillContentSnapshot | null = null;
    if (localSkillPath) {
      const localSkill = await this.findInstalledSkill(localSkillPath);
      const { base, contentHash } = this.operations.buildSkillVersionBasePayload(localSkill);
      localSnapshot = { contentHash, files: this.operations.skillSyncFilesFromMetadata(base.metadata ?? {}) };
    }
    if (remoteSkillId) {
      const remoteSkill = await this.getVersion(remoteSkillId);
      const files = this.operations.skillSyncFilesFromMetadata(remoteSkill.metadata);
      remoteSnapshot = {
        contentHash: remoteSkill.contentHash,
        files: files.some((file) => file.relativePath === "SKILL.md")
          ? files
          : [{ relativePath: "SKILL.md", contentBase64: Buffer.from(remoteSkill.markdown, "utf8").toString("base64") }, ...files],
      };
    }
    return this.operations.buildSkillDiffSnapshot(localSnapshot, remoteSnapshot);
  }

  async downloadMany(fingerprints: string[]): Promise<SkillSyncBatchResult> {
    const requested = this.uniqueValues(fingerprints);
    const snapshot = await this.getSyncSnapshot();
    const groups = new Map(snapshot.remoteSkillGroups.map((group) => [group.fingerprint, group]));
    const relations = new Map((snapshot.relations ?? []).flatMap((relation) =>
      relation.remoteFingerprint ? [[relation.remoteFingerprint, relation] as const] : []));
    const result = this.emptyBatchResult(requested.length);
    await this.runBounded(requested, 4, async (fingerprint) => {
      const group = groups.get(fingerprint);
      const relation = relations.get(fingerprint);
      if (!group || !relation) {
        result.skipped.push({ id: fingerprint, reason: "Remote Skill no longer exists." });
      } else if (relation.state === "legacy") {
        result.skipped.push({ id: fingerprint, reason: "Legacy record has no safe install location." });
      } else if (relation.state === "synced" || relation.state === "local-newer") {
        result.skipped.push({ id: fingerprint, reason: relation.state === "synced" ? "Already synced." : "Local version is newer." });
      } else if (relation.state === "conflict") {
        result.conflicts.push(fingerprint);
      } else {
        try {
          await this.install(group.latest.id);
          result.succeeded.push(fingerprint);
        } catch (error) {
          result.failures.push({ id: fingerprint, message: error instanceof Error ? error.message : String(error) });
        }
      }
    });
    return result;
  }

  async deleteMany(fingerprints: string[]): Promise<SkillSyncBatchResult> {
    const requested = this.uniqueValues(fingerprints);
    const client = this.createSyncClient();
    const groups = new Map(this.operations.groupRemoteSkillVersions(await client.listRemoteSkillVersions())
      .map((group) => [group.fingerprint, group]));
    const result = this.emptyBatchResult(requested.length);
    await this.runBounded(requested, 4, async (fingerprint) => {
      try {
        const group = groups.get(fingerprint);
        if (!group) {
          result.skipped.push({ id: fingerprint, reason: "Remote Skill no longer exists." });
          return;
        }
        const deletedIds = await client.deleteRemoteSkillVersions(group.versions.map((version) => version.id));
        if (deletedIds.length === 0) {
          result.skipped.push({ id: fingerprint, reason: "Remote Skill no longer exists." });
        } else {
          await this.dependencies.getStore().deleteSkillSyncBindingsForRemoteIds(deletedIds);
          result.succeeded.push(fingerprint);
        }
      } catch (error) {
        result.failures.push({ id: fingerprint, message: error instanceof Error ? error.message : String(error) });
      }
    });
    return result;
  }

  copySetupSql(): void {
    this.dependencies.copyText(this.operations.buildSkillSyncSetupSql());
  }

  async copyPath(skillPath: string): Promise<void> {
    this.dependencies.copyText((await this.findInstalledSkill(skillPath)).path);
  }

  async reveal(skillPath: string): Promise<void> {
    const skill = await this.findInstalledSkill(skillPath);
    const normalized = path.resolve(skillPath);
    const target = path.resolve(skill.directoryPath) === normalized ? skill.directoryPath : skill.path;
    await this.dependencies.revealPath(target);
  }

  async delete(skillPath: string): Promise<DeleteInstalledSkillResult> {
    if (this.managedLibrary) {
      const normalized = path.resolve(skillPath);
      const skill = this.managedLibrary.list().skills.find((item) =>
        path.resolve(item.path) === normalized || path.resolve(item.directoryPath) === normalized);
      if (!skill) throw new Error("Skill is no longer installed or is outside the managed library.");
      return this.managedLibrary.delete(skill.managedId);
    }
    const projectDirs = this.operations.skillProjectDirsFromIndexedProjects(
      await this.dependencies.getStore().listProjects(),
    );
    return this.operations.deleteInstalledSkill(skillPath, { projectDirs });
  }

  getUsageHookStatus(): boolean {
    try {
      return this.dependencies.getHookSetup().skillUsageHookStatus().installed;
    } catch {
      return false;
    }
  }

  // Eval-gated: resolving triggers against indexed sessions is only exposed
  // once the user has opted into Eval in Settings.
  async listSkillTriggers(
    options: { skill?: string; limit?: number } = {},
  ): Promise<SkillTriggerLink[]> {
    this.requireEvalEnabled();
    return this.dependencies.getStore().listRecentSkillTriggers(options);
  }

  // Live-report overview: merges recorded triggers with the installed skill
  // list so skills without any record still appear, labelled by what the
  // pipeline can actually observe.
  async getSkillEvalOverview(): Promise<SkillEvalOverview> {
    this.requireEvalEnabled();
    const store = this.dependencies.getStore();
    const [overview, installedSnapshot, hookEventsExist] = await Promise.all([
      store.listSkillUsageOverview(),
      this.listSkills(),
      store.hasClaudeHookUsageEvents(),
    ]);
    const hookInstalled = this.getUsageHookStatus();
    const claudeHookObservable = hookInstalled && hookEventsExist;
    const byName = new Map<string, SkillEvalOverviewItem>();
    for (const row of overview) {
      byName.set(row.skill.trim().toLowerCase(), {
        skill: row.skill,
        agent: row.agent,
        installed: false,
        totalTriggers: row.totalTriggers,
        triggers7d: row.triggers7d,
        triggers30d: row.triggers30d,
        lastTriggeredAt: row.lastTriggeredAt,
        linkedTriggers: row.linkedTriggers,
        observation: "exercised",
      });
    }
    for (const skill of installedSnapshot.skills) {
      const key = skill.name.trim().toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        existing.installed = true;
        continue;
      }
      // Skill triggers are recovered from each agent's own session transcripts,
      // so "no records" genuinely means "never used" wherever those transcripts
      // are scanned; the hook only adds the trigger-time version fingerprint on
      // top. Trae keeps no scanned transcript, so its skills stay unobserved
      // instead of being reported as unused.
      const observable = skill.agent !== "trae";
      byName.set(key, {
        skill: skill.name,
        agent: null,
        installed: true,
        totalTriggers: 0,
        triggers7d: 0,
        triggers30d: 0,
        lastTriggeredAt: null,
        linkedTriggers: 0,
        observation: observable ? "never-used" : "unobserved",
      });
    }
    const skills = [...byName.values()].sort((a, b) =>
      (b.lastTriggeredAt ?? 0) - (a.lastTriggeredAt ?? 0) || a.skill.localeCompare(b.skill));
    return { hookInstalled, claudeHookObservable, skills };
  }

  async getSkillEvalDetail(skillName: string): Promise<SkillEvalDetail> {
    this.requireEvalEnabled();
    const name = skillName.trim();
    if (!name) throw new Error("A skill name is required.");
    const store = this.dependencies.getStore();
    const [signals, groups, installedSnapshot, bindings] = await Promise.all([
      store.getSkillPerformanceSignals(name),
      store.listSkillVersionGroups(name),
      this.listSkills(),
      store.listSkillSyncBindings(),
    ]);
    const installed = installedSnapshot.skills.find(
      (item) => item.name.trim().toLowerCase() === name.toLowerCase());
    // Same invariant as skillMarkdownHash in bin/skill-usage-record.cjs:
    // sha256 over the raw SKILL.md bytes. Keep the two in lockstep.
    let currentHash: string | null = null;
    if (installed) {
      try {
        currentHash = createHash("sha256").update(fs.readFileSync(installed.path)).digest("hex");
      } catch {
        currentHash = null;
      }
    }
    const binding = installed
      ? bindings.find((item) => path.resolve(item.localSkillPath) === path.resolve(installed.directoryPath)) ?? null
      : null;
    return {
      skill: installed?.name ?? name,
      signals,
      versions: groups.map((group) => ({
        ...group,
        current: Boolean(currentHash && group.skillHash === currentHash),
      })),
      currentHash,
      remoteVersion: binding?.remoteVersion ?? null,
    };
  }

  private requireEvalEnabled(): void {
    if (!this.dependencies.getSettings().evalEnabled) {
      throw new Error("Eval is disabled. Enable it in Settings first.");
    }
  }

  async getSkillFindings(skillName: string): Promise<SkillFinding[]> {
    this.requireEvalEnabled();
    const name = skillName.trim();
    if (!name) throw new Error("A skill name is required.");
    const store = this.dependencies.getStore();
    const [overview, signals, toolOutcomes] = await Promise.all([
      store.listSkillUsageOverview(),
      store.getSkillPerformanceSignals(name),
      store.listSkillToolOutcomes(name),
    ]);
    const overviewItem = overview.find(
      (item) => item.skill.trim().toLowerCase() === name.toLowerCase(),
    ) ?? null;
    const installedSnapshot = await this.listSkills();
    const installedSkill = installedSnapshot.skills.find(
      (item) => item.name.trim().toLowerCase() === name.toLowerCase(),
    );
    return evaluateSkillFindings({
      skill: name,
      overviewItem: buildOverviewLike(overviewItem, installedSkill ?? null),
      signals,
      toolOutcomes,
    });
  }

  async getSkillFindingCounts(): Promise<{ skill: string; low: number; medium: number }[]> {
    this.requireEvalEnabled();
    const store = this.dependencies.getStore();
    const overview = await store.listSkillUsageOverview();
    const installedSnapshot = await this.listSkills();
    const installedByName = new Map(
      installedSnapshot.skills.map((s) => [s.name.trim().toLowerCase(), s]),
    );
    // Collect all skill names (triggered + installed-never-used).
    const allNames = new Set<string>();
    for (const row of overview) allNames.add(row.skill.trim().toLowerCase());
    for (const name of installedByName.keys()) allNames.add(name);
    const results: { skill: string; low: number; medium: number }[] = [];
    for (const name of allNames) {
      const [signals, toolOutcomes] = await Promise.all([
        store.getSkillPerformanceSignals(name),
        store.listSkillToolOutcomes(name),
      ]);
      const overviewItem = overview.find(
        (item) => item.skill.trim().toLowerCase() === name,
      ) ?? null;
      const installedSkill = installedByName.get(name) ?? null;
      const findings = evaluateSkillFindings({
        skill: name,
        overviewItem: buildOverviewLike(overviewItem, installedSkill),
        signals,
        toolOutcomes,
      });
      const low = findings.filter((f) => f.severity === "low").length;
      const medium = findings.filter((f) => f.severity === "medium").length;
      if (low > 0 || medium > 0) {
        results.push({ skill: overviewItem?.skill ?? name, low, medium });
      }
    }
    return results;
  }

  // ── Skill regression evaluation (phase four) ─────────────────────────
  // User-defined cases bound to a skill version. Runs execute through the
  // automation engine; each run is re-attributed to the then-current skill
  // hash so drift detection is a plain hash comparison.

  async getSkillEvalSuites(skillName: string): Promise<SkillEvalSuite[]> {
    this.requireEvalEnabled();
    const name = skillName.trim();
    if (!name) throw new Error("A skill name is required.");
    const evaluations = this.requireEvaluationService();
    const [experiments, datasets, currentHash] = await Promise.all([
      evaluations.listExperiments(),
      evaluations.listDatasets(),
      this.currentSkillHash(name),
    ]);
    const datasetById = new Map(datasets.map((item) => [item.id, item]));
    const bound = experiments.filter(
      (item) => (item.skillName ?? "").trim().toLowerCase() === name.toLowerCase(),
    );
    // Independent per-suite run lookups are issued concurrently to keep the
    // card snappy when a skill has many suites.
    const lastRuns = await Promise.all(
      bound.map(async (experiment) => {
        const runsPage = await evaluations.listRuns({ experimentId: experiment.id, limit: 1 });
        return runsPage.items[0] ?? null;
      }),
    );
    const suites: SkillEvalSuite[] = bound.map((experiment, index) => {
      const last = lastRuns[index];
      return {
        id: experiment.id,
        name: experiment.name,
        skill: name,
        skillHash: experiment.skillHash ?? null,
        currentHash,
        drifted: Boolean(
          experiment.skillHash && currentHash && experiment.skillHash !== currentHash),
        agentId: experiment.agentId,
        evaluatorIds: experiment.evaluatorIds,
        repetitions: experiment.repetitions,
        caseCount: datasetById.get(experiment.datasetId)?.items.length ?? 0,
        createdAt: experiment.createdAt,
        updatedAt: experiment.updatedAt,
        lastRun: last
          ? {
              id: last.id,
              startedAt: last.startedAt,
              status: last.status,
              passRate: last.passRate ?? null,
              averageScore: last.averageScore ?? null,
            }
          : null,
      };
    });
    return suites.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSkillEvalSuite(input: CreateSkillEvalSuiteInput): Promise<SkillEvalSuite> {
    this.requireEvalEnabled();
    const name = input.skill.trim();
    if (!name) throw new Error("A skill name is required.");
    if (!input.name.trim()) throw new Error("A suite name is required.");
    if (!input.agentId.trim()) throw new Error("An execution Agent is required.");
    if (input.cases.length === 0) throw new Error("At least one case is required.");
    const evaluations = this.requireEvaluationService();
    const evaluatorIds = await this.resolveSuiteEvaluators(
      evaluations,
      input.agentId.trim(),
      input.evaluatorIds,
      input.useBuiltinJudge,
    );
    const now = this.dependencies.now();
    const dataset = await evaluations.saveDataset({
      id: `dataset-${now}`,
      name: input.name.trim(),
      description: name,
      items: input.cases.map((value, index) => ({
        id: `case-${now}-${index}`,
        input: value.input,
        ...(value.expectedOutput !== undefined ? { expectedOutput: value.expectedOutput } : {}),
        metadata: {},
        sequence: index,
      })),
      createdAt: now,
      updatedAt: now,
    });
    const currentHash = await this.currentSkillHash(name);
    const experiment = await evaluations.saveExperiment({
      id: `experiment-${now}`,
      name: input.name.trim(),
      datasetId: dataset.id,
      agentId: input.agentId,
      evaluatorIds,
      repetitions: Math.max(1, Math.min(5, Math.floor(input.repetitions))),
      skillName: name,
      skillHash: currentHash,
      createdAt: now,
      updatedAt: now,
    });
    return {
      id: experiment.id,
      name: experiment.name,
      skill: name,
      skillHash: experiment.skillHash ?? null,
      currentHash,
      drifted: false,
      agentId: experiment.agentId,
      evaluatorIds: experiment.evaluatorIds,
      repetitions: experiment.repetitions,
      caseCount: dataset.items.length,
      createdAt: experiment.createdAt,
      updatedAt: experiment.updatedAt,
      lastRun: null,
    };
  }

  async getSkillEvalSuiteCases(experimentId: string): Promise<SkillEvalSuiteCase[]> {
    this.requireEvalEnabled();
    const id = experimentId.trim();
    if (!id) throw new Error("An evaluation suite id is required.");
    const evaluations = this.requireEvaluationService();
    const experiment = (await evaluations.listExperiments()).find((item) => item.id === id);
    if (!experiment) throw new Error(`Evaluation suite not found: ${id}`);
    const dataset = (await evaluations.listDatasets()).find((item) => item.id === experiment.datasetId);
    if (!dataset) throw new Error(`Evaluation dataset not found: ${experiment.datasetId}`);
    return dataset.items.map((item) => ({
      input: item.input,
      ...(item.expectedOutput !== undefined && item.expectedOutput !== null
        ? { expectedOutput: item.expectedOutput }
        : {}),
    }));
  }

  async updateSkillEvalSuite(input: UpdateSkillEvalSuiteInput): Promise<SkillEvalSuite> {
    this.requireEvalEnabled();
    const id = input.id.trim();
    if (!id) throw new Error("An evaluation suite id is required.");
    if (!input.name.trim()) throw new Error("A suite name is required.");
    if (!input.agentId.trim()) throw new Error("An execution Agent is required.");
    if (input.cases.length === 0) throw new Error("At least one case is required.");
    const evaluations = this.requireEvaluationService();
    const experiment = (await evaluations.listExperiments()).find((item) => item.id === id);
    if (!experiment) throw new Error(`Evaluation suite not found: ${id}`);
    const dataset = (await evaluations.listDatasets()).find((item) => item.id === experiment.datasetId);
    if (!dataset) throw new Error(`Evaluation dataset not found: ${experiment.datasetId}`);
    const evaluatorIds = await this.resolveSuiteEvaluators(
      evaluations,
      input.agentId.trim(),
      input.evaluatorIds,
      input.useBuiltinJudge,
    );
    const now = this.dependencies.now();
    // Item ids are preserved positionally so past runs stay joinable by
    // dataset item; only appended cases get fresh ids.
    await evaluations.saveDataset({
      ...dataset,
      name: input.name.trim(),
      description: experiment.skillName ?? dataset.description,
      items: input.cases.map((value, index) => ({
        id: dataset.items[index]?.id ?? `case-${now}-${index}`,
        input: value.input,
        ...(value.expectedOutput !== undefined ? { expectedOutput: value.expectedOutput } : {}),
        metadata: dataset.items[index]?.metadata ?? {},
        sequence: index,
      })),
      updatedAt: now,
    });
    await evaluations.saveExperiment({
      ...experiment,
      name: input.name.trim(),
      agentId: input.agentId.trim(),
      evaluatorIds,
      repetitions: Math.max(1, Math.min(5, Math.floor(input.repetitions))),
      updatedAt: now,
    });
    const skill = (experiment.skillName ?? "").trim();
    const suites = skill ? await this.getSkillEvalSuites(skill) : [];
    const updated = suites.find((item) => item.id === id);
    if (!updated) throw new Error(`Evaluation suite not found: ${id}`);
    return updated;
  }

  async deleteSkillEvalSuite(experimentId: string): Promise<void> {
    this.requireEvalEnabled();
    const id = experimentId.trim();
    if (!id) throw new Error("An evaluation suite id is required.");
    const evaluations = this.requireEvaluationService();
    const experiment = (await evaluations.listExperiments()).find((item) => item.id === id);
    if (!experiment) throw new Error(`Evaluation suite not found: ${id}`);
    const runs = await evaluations.listRuns({ experimentId: id, limit: 100 });
    for (const run of runs.items) await evaluations.deleteRun(run.id);
    await evaluations.deleteExperiment(id);
    const datasetShared = (await evaluations.listExperiments()).some(
      (item) => item.datasetId === experiment.datasetId,
    );
    if (!datasetShared) await evaluations.deleteDataset(experiment.datasetId);
  }

  // A suite holds at most one built-in judge, and it must match the execution
  // agent's channel. Custom evaluators pass through untouched; a stale
  // built-in id from a previous channel is replaced, not kept.
  private async resolveSuiteEvaluators(
    evaluations: EvaluationService,
    agentId: string,
    selectedIds: string[],
    useBuiltinJudge: boolean,
  ): Promise<string[]> {
    const evaluatorIds = selectedIds.filter((item) => !item.startsWith("builtin-judge-"));
    if (useBuiltinJudge) {
      const builtin = await evaluations.ensureBuiltinJudge(agentId);
      if (!evaluatorIds.includes(builtin.id)) evaluatorIds.unshift(builtin.id);
    }
    if (evaluatorIds.length === 0) throw new Error("At least one evaluator is required.");
    return evaluatorIds;
  }

  // Starts the suite run in the background and returns its id immediately;
  // clients poll getSkillEvalRun for progress and may cancel at any time.
  async runSkillEvalSuite(experimentId: string): Promise<{ runId: string }> {
    this.requireEvalEnabled();
    const id = experimentId.trim();
    if (!id) throw new Error("An evaluation suite id is required.");
    const evaluations = this.requireEvaluationService();
    const experiment = (await evaluations.listExperiments()).find((item) => item.id === id);
    if (!experiment) throw new Error(`Evaluation suite not found: ${id}`);
    const skill = (experiment.skillName ?? "").trim();
    if (!skill) throw new Error("This evaluation suite is not bound to a skill.");
    const installedSnapshot = await this.listSkills();
    const installed = installedSnapshot.skills.find(
      (item) => item.name.trim().toLowerCase() === skill.toLowerCase(),
    );
    if (!installed) throw new Error(`Skill is not installed: ${skill}`);
    // Attribute the upcoming run to the version that actually executes it:
    // refresh skill_hash to the current SKILL.md fingerprint before delegating.
    const currentHash = await this.currentSkillHash(skill);
    if (experiment.skillHash !== currentHash) {
      await evaluations.saveExperiment({
        ...experiment,
        skillHash: currentHash,
        updatedAt: this.dependencies.now(),
      });
    }
    // Sync the built-in judge to its managed definition right before use, so
    // suites created under an older rubric pick up the current one.
    if (experiment.evaluatorIds.some((id) => id.startsWith("builtin-judge-"))) {
      await evaluations.ensureBuiltinJudge(experiment.agentId);
    }
    // Attribute the run to the version that actually executes it.
    const runId = await evaluations.startExperiment(id, { skillHash: currentHash });
    return { runId };
  }

  async getSkillEvalRun(runId: string): Promise<EvaluationRun | null> {
    this.requireEvalEnabled();
    const id = runId.trim();
    if (!id) throw new Error("A run id is required.");
    return (await this.requireEvaluationService().getRun(id)) ?? null;
  }

  // Newest-first summaries of a suite's runs, for the run history drill-down.
  async getSkillEvalSuiteRuns(experimentId: string): Promise<EvaluationRunSummary[]> {
    this.requireEvalEnabled();
    const id = experimentId.trim();
    if (!id) throw new Error("An evaluation suite id is required.");
    const evaluations = this.requireEvaluationService();
    const experiment = (await evaluations.listExperiments()).find((item) => item.id === id);
    if (!experiment) throw new Error(`Evaluation suite not found: ${id}`);
    if (!(experiment.skillName ?? "").trim()) {
      throw new Error("This evaluation suite is not bound to a skill.");
    }
    const page = await evaluations.listRuns({ experimentId: id, limit: 10 });
    return page.items;
  }

  cancelSkillEvalRun(runId: string): void {
    this.requireEvalEnabled();
    const id = runId.trim();
    if (!id) throw new Error("A run id is required.");
    this.requireEvaluationService().cancelRun(id);
  }

  // Same invariant as skillMarkdownHash in bin/skill-usage-record.cjs and
  // getSkillEvalDetail above: sha256 over the raw SKILL.md bytes.
  private async currentSkillHash(skillName: string): Promise<string | null> {
    const installedSnapshot = await this.listSkills();
    const installed = installedSnapshot.skills.find(
      (item) => item.name.trim().toLowerCase() === skillName.toLowerCase(),
    );
    if (!installed) return null;
    try {
      return createHash("sha256").update(fs.readFileSync(installed.path)).digest("hex");
    } catch {
      return null;
    }
  }

  private requireEvaluationService(): EvaluationService {
    const evaluations = this.dependencies.getEvaluationService?.();
    if (!evaluations) throw new Error("Runtime is not ready yet.");
    return evaluations;
  }

  installUsageHook(): string {
    const result = this.dependencies.getHookSetup().installSkillUsageHook();
    if (result.status === "error") throw new Error(result.detail || "Could not configure the skill usage hook.");
    return result.status;
  }

  uninstallUsageHook(): string {
    const result = this.dependencies.getHookSetup().uninstallSkillUsageHook();
    if (result.status === "error") throw new Error(result.detail || "Could not remove the skill usage hook.");
    return result.status;
  }

  private syncConfigured(settings: AppSettings): boolean {
    return Boolean(settings.skillSyncEnabled && settings.skillSyncSupabaseUrl && settings.skillSyncSupabaseAnonKey);
  }

  private async projectDirs(): Promise<string[]> {
    return this.operations.skillProjectDirsFromIndexedProjects(
      await this.dependencies.getStore().listProjects(),
    );
  }

  private requireSkillsShClient(): SkillsShClientPort {
    if (!this.skillsShClient) throw new Error("Skill discovery is unavailable.");
    return this.skillsShClient;
  }

  private createSyncClient(): SkillSyncClientPort {
    const settings = this.dependencies.getSettings();
    if (!this.syncConfigured(settings)) throw new Error("Supabase skill sync is not configured.");
    const options = { url: settings.skillSyncSupabaseUrl, anonKey: settings.skillSyncSupabaseAnonKey };
    return this.dependencies.createSyncClient?.(options) ?? new SupabaseSkillSyncClient(options);
  }

  private async findInstalledSkill(skillPath: string): Promise<InstalledSkill> {
    const normalized = path.resolve(skillPath);
    const installed = (await this.listSkills()).skills;
    const installedSkill = installed.find((item) =>
      path.resolve(item.path) === normalized || path.resolve(item.directoryPath) === normalized);
    if (installedSkill) return installedSkill;
    const localSkill = this.managedLibrary
      ? (await this.listImportCandidates()).skills.find((item) =>
        path.resolve(item.path) === normalized || path.resolve(item.directoryPath) === normalized)
      : null;
    if (!localSkill) throw new Error("Skill is no longer installed or is outside managed roots.");
    return localSkill;
  }

  private async buildSyncRelations(
    skills: InstalledSkill[],
    remoteGroups: SkillSyncSnapshot["remoteSkillGroups"],
    bindings: SkillSyncBinding[],
  ): Promise<SkillSyncRelation[]> {
    const syncable = skills.flatMap((skill) => {
      const location = this.operations.portableSkillLocation(skill);
      return location ? [{ skill, location }] : [];
    });
    const local = await Promise.all(syncable.map(async (entry) => ({
      ...entry,
      contentHash: await this.operations.skillSyncLocalContentHash(entry.skill),
    })));
    const localsByIdentity = new Map(local.map((entry) => [entry.location.identity, entry]));
    const bindingsByIdentity = new Map(bindings.flatMap((binding) =>
      binding.portableIdentity ? [[binding.portableIdentity, binding] as const] : []));
    const used = new Set<string>();
    const relations: SkillSyncRelation[] = [];
    for (const group of remoteGroups) {
      const identity = group.portableScope && group.relativePath
        ? `${group.portableScope}/${group.relativePath}`
        : `legacy:${group.fingerprint}`;
      const localEntry = group.legacy ? null : localsByIdentity.get(identity) ?? null;
      const binding = bindingsByIdentity.get(identity);
      if (localEntry) used.add(identity);
      let state: SkillSyncRelation["state"];
      if (group.legacy) state = "legacy";
      else if (!localEntry) state = "remote-only";
      else if (localEntry.contentHash === group.latest.contentHash) state = "synced";
      else if (!binding?.lastContentHash) state = "conflict";
      else {
        const localChanged = localEntry.contentHash !== binding.lastContentHash;
        const remoteChanged = group.latest.contentHash !== binding.lastContentHash;
        state = localChanged && remoteChanged ? "conflict" : localChanged ? "local-newer" : remoteChanged ? "remote-newer" : "synced";
      }
      relations.push({
        identity,
        localSkillPath: localEntry?.skill.path ?? null,
        localContentHash: localEntry?.contentHash ?? "",
        remoteFingerprint: group.fingerprint,
        remoteLatestId: group.latest.id,
        remoteContentHash: group.latest.contentHash,
        state,
      });
    }
    for (const entry of local) {
      if (!used.has(entry.location.identity)) {
        relations.push({
          identity: entry.location.identity,
          localSkillPath: entry.skill.path,
          localContentHash: entry.contentHash,
          remoteFingerprint: null,
          remoteLatestId: null,
          remoteContentHash: "",
          state: "local-only",
        });
      }
    }
    return relations;
  }

  private async persistBinding(
    localSkillPath: string,
    portableIdentity: string,
    remoteSkillId: string,
    remoteUpdatedAt: string,
    remoteVersion: number,
    lastContentHash: string,
    direction: "upload" | "download",
  ): Promise<SkillSyncBinding> {
    const binding: SkillSyncBinding = {
      localSkillPath,
      portableIdentity,
      remoteSkillId,
      remoteUpdatedAt,
      remoteVersion,
      lastContentHash,
      lastSyncedAt: this.dependencies.now(),
      direction,
    };
    await this.dependencies.getStore().upsertSkillSyncBinding(binding);
    return binding;
  }

  private uniqueValues(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private emptyBatchResult(requested: number): SkillSyncBatchResult {
    return { requested, succeeded: [], skipped: [], conflicts: [], failures: [] };
  }

  private async runBounded<T>(items: T[], concurrency: number, action: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
      while (cursor < items.length) await action(items[cursor++]);
    });
    await Promise.all(workers);
  }
}

// Builds the overview-like object for the findings evaluator from an overview
// row (if any) and an installed skill (if any). Observation is derived from
// totalTriggers — NOT linkedTriggers — because a skill with unlinked triggers
// was still exercised; "never-used" requires zero total triggers. Only trae
// (no scanned transcript) is unobserved.
function buildOverviewLike(
  overviewItem: SkillUsageOverviewRow | null,
  installedSkill: InstalledSkill | null,
): { observation: "exercised" | "never-used" | "unobserved"; installed: boolean; totalTriggers: number } | null {
  if (overviewItem) {
    return {
      observation: overviewItem.totalTriggers > 0 ? "exercised" : "never-used",
      installed: Boolean(installedSkill),
      totalTriggers: overviewItem.totalTriggers,
    };
  }
  if (installedSkill) {
    return {
      observation: installedSkill.agent === "trae" ? "unobserved" : "never-used",
      installed: true,
      totalTriggers: 0,
    };
  }
  return null;
}
