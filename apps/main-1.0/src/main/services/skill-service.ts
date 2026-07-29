import * as path from "node:path";
import type { AppSettings } from "../../core/platform";
import type { SkillSyncBinding } from "../../core/session-store";
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
  listProjects(): ProjectSummary[];
  getSkillUsageSnapshot(): SkillUsageSnapshot;
  isSkillUsageSourceFresh(source: SkillUsageSource): boolean;
  upsertSkillUsageSource(source: SkillUsageSource, events: SkillUsageEvent[]): void;
  pruneSkillUsageSources(activePaths: string[]): void;
  listSkillSyncBindings(): SkillSyncBinding[];
  getSkillSyncBindingForPortableIdentity(identity: string): SkillSyncBinding | null;
  upsertSkillSyncBinding(binding: SkillSyncBinding): void;
  deleteSkillSyncBindingsForRemoteIds(remoteIds: string[]): void;
}

export interface SkillSyncClientPort {
  checkStatus(): Promise<SkillSyncStatus>;
  listRemoteSkillVersions(): Promise<RemoteSkillVersion[]>;
  uploadSkillVersion(base: SkillVersionBasePayload, version: number): Promise<RemoteSkill>;
  getRemoteSkill(remoteId: string): Promise<RemoteSkill>;
  deleteRemoteSkillVersions(remoteIds: string[]): Promise<string[]>;
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
  private initialUsageTimer: ReturnType<typeof setTimeout> | null = null;
  private autoUsageTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dependencies: SkillServiceDependencies) {
    this.operations = { ...defaultOperations, ...dependencies.operations };
    this.timers = dependencies.timers ?? defaultTimers;
  }

  listSkills(): InstalledSkillsSnapshot {
    const store = this.dependencies.getStore();
    const projectDirs = this.operations.skillProjectDirsFromIndexedProjects(store.listProjects());
    const snapshot = this.operations.listInstalledSkills({ projectDirs });
    const usage = store.getSkillUsageSnapshot();
    const skills = snapshot.skills.map((skill) => {
      const stat = this.operations.usageForSkill(usage, skill.name, skill.agent);
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

  refreshUsage(): SkillUsageRefreshStatus {
    const store = this.dependencies.getStore();
    const settings = this.dependencies.getSettings();
    const sources = this.operations.listSkillUsageSources({
      includeTclaude: settings.includeTclaude,
      includeTcodex: settings.includeTcodex,
      includeCodeBuddyCli: settings.includeCodeBuddyCli,
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
      if (store.isSkillUsageSourceFresh(source)) {
        skipped += 1;
        continue;
      }
      store.upsertSkillUsageSource(source, this.operations.readSkillUsageSourceEvents(source));
      refreshed += 1;
    }
    store.pruneSkillUsageSources(sources.map((source) => source.path));
    return {
      refreshed,
      skipped,
      total: sources.length,
      totalEvents: store.getSkillUsageSnapshot().totalEvents,
      lastRefreshedAt: this.dependencies.now(),
    };
  }

  refreshUsageSafely(): void {
    try {
      this.refreshUsage();
    } catch (error) {
      this.dependencies.logError(`Failed to refresh skill usage: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  startUsageRefresh(): void {
    if (!this.initialUsageTimer) {
      this.initialUsageTimer = this.timers.setTimeout(() => {
        this.initialUsageTimer = null;
        this.refreshUsageSafely();
      }, INITIAL_SKILL_USAGE_REFRESH_DELAY_MS);
    }
    if (this.autoUsageTimer) return;
    this.autoUsageTimer = this.timers.setInterval(
      () => this.refreshUsageSafely(),
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
        bindings: store.listSkillSyncBindings(),
        relations: [],
        scannedAt: this.dependencies.now(),
      };
    }
    const client = this.createSyncClient();
    const status = await client.checkStatus();
    const remoteSkillGroups = status.kind === "ready"
      ? this.operations.groupRemoteSkillVersions(await client.listRemoteSkillVersions())
      : [];
    const bindings = store.listSkillSyncBindings();
    return {
      status,
      remoteSkillGroups,
      bindings,
      relations: status.kind === "ready"
        ? await this.buildSyncRelations(this.listSkills().skills, remoteSkillGroups, bindings)
        : [],
      scannedAt: this.dependencies.now(),
    };
  }

  async upload(skillPath: string, force = false): Promise<SkillSyncUploadOutcome> {
    const store = this.dependencies.getStore();
    const skill = this.findInstalledSkill(skillPath);
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
      const binding = this.persistBinding(skill.path, location.identity, latest.id, latest.updatedAt, latest.version, contentHash, "upload");
      return { status: "skipped", remoteSkillId: latest.id, binding, version: latest.version };
    }
    const existingBinding = store.getSkillSyncBindingForPortableIdentity(location.identity);
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
    const binding = this.persistBinding(skill.path, location.identity, remoteSkill.id, remoteSkill.updatedAt, remoteSkill.version, contentHash, "upload");
    return { status: "uploaded", remoteSkill, binding, version: remoteSkill.version };
  }

  async install(remoteSkillId: string): Promise<SkillSyncInstallResult> {
    const remoteSkill = await this.createSyncClient().getRemoteSkill(remoteSkillId);
    if (remoteSkill.legacy || !remoteSkill.portableScope || !remoteSkill.relativePath) {
      throw new Error("This legacy Skill can only be previewed or deleted because its install location is uncertain.");
    }
    const installed = this.operations.installRemoteSkillLocally(remoteSkill);
    const identity = `${remoteSkill.portableScope}/${remoteSkill.relativePath}`;
    const binding = this.persistBinding(installed.installedPath, identity, remoteSkill.id, remoteSkill.updatedAt, remoteSkill.version, remoteSkill.contentHash, "download");
    return { remoteSkill, binding, installedPath: installed.installedPath, overwritten: installed.overwritten };
  }

  getVersion(remoteSkillId: string): Promise<RemoteSkill> {
    return this.createSyncClient().getRemoteSkill(remoteSkillId);
  }

  async getDiff(localSkillPath: string | null, remoteSkillId: string | null): Promise<SkillDiffSnapshot> {
    let localSnapshot: SkillContentSnapshot | null = null;
    let remoteSnapshot: SkillContentSnapshot | null = null;
    if (localSkillPath) {
      const localSkill = this.findInstalledSkill(localSkillPath);
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
          this.dependencies.getStore().deleteSkillSyncBindingsForRemoteIds(deletedIds);
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

  copyPath(skillPath: string): void {
    this.dependencies.copyText(this.findInstalledSkill(skillPath).path);
  }

  reveal(skillPath: string): Promise<void> {
    const skill = this.findInstalledSkill(skillPath);
    const normalized = path.resolve(skillPath);
    const target = path.resolve(skill.directoryPath) === normalized ? skill.directoryPath : skill.path;
    return this.dependencies.revealPath(target);
  }

  delete(skillPath: string): DeleteInstalledSkillResult {
    const projectDirs = this.operations.skillProjectDirsFromIndexedProjects(this.dependencies.getStore().listProjects());
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

  private createSyncClient(): SkillSyncClientPort {
    const settings = this.dependencies.getSettings();
    if (!this.syncConfigured(settings)) throw new Error("Supabase skill sync is not configured.");
    const options = { url: settings.skillSyncSupabaseUrl, anonKey: settings.skillSyncSupabaseAnonKey };
    return this.dependencies.createSyncClient?.(options) ?? new SupabaseSkillSyncClient(options);
  }

  private findInstalledSkill(skillPath: string): InstalledSkill {
    const normalized = path.resolve(skillPath);
    const skill = this.listSkills().skills.find((item) =>
      path.resolve(item.path) === normalized || path.resolve(item.directoryPath) === normalized);
    if (!skill) throw new Error("Skill is no longer installed or is outside managed roots.");
    return skill;
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

  private persistBinding(
    localSkillPath: string,
    portableIdentity: string,
    remoteSkillId: string,
    remoteUpdatedAt: string,
    remoteVersion: number,
    lastContentHash: string,
    direction: "upload" | "download",
  ): SkillSyncBinding {
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
    this.dependencies.getStore().upsertSkillSyncBinding(binding);
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
