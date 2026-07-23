import * as os from "node:os";
import * as path from "node:path";
import type { AppSettings } from "../../core/platform";
import type { SkillSyncBinding } from "../../core/session-store";
import { runSkillAiSearch, type SkillAiSearchResult } from "../../core/skill-ai-search";
import type { ChatCompletionFn, SummaryEndpoint } from "../../core/session-summarizer";
import {
  ManagedSkillLibrary,
  type ManagedSkill,
  type ManagedSkillFileImport,
  type ManagedSkillImportResult,
  type ManagedSkillsSnapshot,
  type SkillInstallTarget,
} from "../../core/managed-skill-library";
import {
  SkillsShClient,
  type SkillsShDetail,
  type SkillsShEntry,
  type SkillsShPage,
} from "../../core/skills-sh";
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
  listSkillUsageSources,
  readSkillUsageSourceEvents,
  usageForSkill,
  type SkillUsageEvent,
  type SkillUsageRefreshStatus,
  type SkillUsageSnapshot,
  type SkillUsageSource,
} from "../../core/skill-usage";
import {
  AUTO_SKILL_USAGE_REFRESH_INTERVAL_MS,
  INITIAL_SKILL_USAGE_REFRESH_DELAY_MS,
} from "../../core/refresh-policy";
import type { ProjectSummary } from "../../core/types";

export interface SkillUsageHookSetup {
  installSkillUsageHook(options?: Record<string, unknown>): { status: string; detail?: string };
  uninstallSkillUsageHook(options?: Record<string, unknown>): { status: string; detail?: string };
  skillUsageHookStatus(options?: Record<string, unknown>): { installed: boolean };
}

export interface SkillStorePort {
  listProjects(): Promise<ProjectSummary[]>;
  getSkillUsageSnapshot(): Promise<SkillUsageSnapshot>;
  isSkillUsageSourceFresh(source: SkillUsageSource): Promise<boolean>;
  upsertSkillUsageSource(source: SkillUsageSource, events: SkillUsageEvent[]): Promise<void>;
  pruneSkillUsageSources(activePaths: string[]): Promise<void>;
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
  importFiles(input: ManagedSkillFileImport): ManagedSkillImportResult;
  replaceFiles(input: ManagedSkillFileImport): ManagedSkillImportResult;
  updateTargets(managedId: string, targets: SkillInstallTarget[]): ManagedSkill;
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
  listSkillUsageSources: typeof listSkillUsageSources;
  readSkillUsageSourceEvents: typeof readSkillUsageSourceEvents;
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
  createSyncClient?(options: { url: string; anonKey: string }): SkillSyncClientPort;
  copyText(text: string): void;
  revealPath(path: string): Promise<void>;
  now(): number;
  logError(message: string): void;
  managedLibrary?: ManagedSkillLibraryPort;
  skillsShClient?: SkillsShClientPort;
  resolveAiEndpoint?(): Promise<SummaryEndpoint | null>;
  completeAi?: ChatCompletionFn;
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
  listSkillUsageSources,
  readSkillUsageSourceEvents,
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

export class SkillService {
  private readonly operations: SkillServiceOperations;
  private readonly timers: NonNullable<SkillServiceDependencies["timers"]>;
  private readonly managedLibrary: ManagedSkillLibraryPort | null;
  private readonly skillsShClient: SkillsShClientPort | null;
  private readonly discoveredSkills = new Map<string, SkillsShEntry>();
  private importCandidatesCache: InstalledSkillsSnapshot | null = null;
  private initialUsageTimer: ReturnType<typeof setTimeout> | null = null;
  private autoUsageTimer: ReturnType<typeof setInterval> | null = null;

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
      const stat = this.managedLibrary
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
        const stat = this.operations.usageForSkill(usage, skill.name, skill.agent);
        return { ...skill, usageCount: stat?.count ?? 0, lastUsedAt: stat?.lastUsedAt ?? null };
      }),
    };
  }

  async importLocalSkills(skillPaths: string[]): Promise<ManagedSkillImportResult[]> {
    if (!this.managedLibrary) throw new Error("The managed Skill library is unavailable.");
    const projectDirs = await this.projectDirs();
    return this.uniqueValues(skillPaths).map((skillPath) => this.managedLibrary!.importLocalSkill(skillPath, projectDirs));
  }

  updateManagedSkillTargets(managedId: string, targets: SkillInstallTarget[]): ManagedSkill {
    if (!this.managedLibrary) throw new Error("The managed Skill library is unavailable.");
    return this.managedLibrary.updateTargets(managedId, targets);
  }

  async listDiscoveredSkills(input: { page: number; query: string }): Promise<SkillsShPage> {
    const client = this.requireSkillsShClient();
    const result = await client.list(input);
    for (const entry of result.skills) this.discoveredSkills.set(entry.id, entry);
    return result;
  }

  async aiSearchDiscoveredSkills(input: { query: string; language: "en" | "zh" }): Promise<SkillAiSearchResult> {
    if (!this.dependencies.resolveAiEndpoint) throw new Error("AI Skill search is unavailable.");
    const endpoint = await this.dependencies.resolveAiEndpoint();
    if (!endpoint) throw new Error("AI Skill search has no usable provider. Configure one on the Provider page.");
    const client = this.requireSkillsShClient();
    const result = await runSkillAiSearch(
      input,
      endpoint,
      (query) => client.list({ page: 0, query }),
      this.dependencies.completeAi,
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

  async refreshUsage(): Promise<SkillUsageRefreshStatus> {
    const store = this.dependencies.getStore();
    const sources = this.operations.listSkillUsageSources();
    let refreshed = 0;
    let skipped = 0;
    for (const source of sources) {
      if (await store.isSkillUsageSourceFresh(source)) {
        skipped += 1;
        continue;
      }
      await store.upsertSkillUsageSource(source, this.operations.readSkillUsageSourceEvents(source));
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
