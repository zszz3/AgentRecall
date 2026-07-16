import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import Store from "electron-store";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import * as os from "node:os";
import {
  apiProviderPreset,
  mergeApiConfigWithProfileDefaults,
  mergeClaudeApiConfigWithProfileDefaults,
  normalizeApiConfig,
  type ApiConfig,
  type ClaudeApiConfig,
} from "../core/api-config";
import { CodexChatProxy, type CodexChatProxyStatus } from "../core/codex-chat-proxy";
import { applyClaudeApiConfig, loadClaudeApiConfigDefaults } from "../core/claude-profile";
import { applyCodexApiConfig, loadActiveCodexSummaryEndpointDefaults, loadCodexConfigSnapshot, loadCodexProfileDefaults, probeCodexModels } from "../core/codex-profile";
import { indexMigratedSessionFile, syncDefaultSessionsInBatches, type IndexStatus } from "../core/indexer";
import { formatSessionMarkdown, formatSessionPlainText } from "../core/format-session";
import {
  defaultSettings,
  getMigrationResumeProcessSpec,
  getSafeMigrationResumeCommand,
  getResumeCommand,
  inspectMigrationCli,
  mergeAppSettings,
  normalizeTerminal,
  openNativeApp,
  openMigrationResumeInTerminal,
  openResumeInSpecificTerminal,
  openResumeInTerminal,
  revealInFileManager,
} from "../core/platform";
import { loadUsageQuotaSnapshot } from "../core/quota";
import { focusLiveSessionTerminal, setLiveSessionTerminalTitle } from "../core/session-focus";
import { setSessionCustomTitleAndSyncTerminal } from "../core/session-title-sync";
import { createCachedLiveSessionSnapshotLoader } from "../core/session-activity";
import { summarizeSession, type SummaryEndpoint } from "../core/session-summarizer";
import {
  buildCodexExecEndpoint as buildCodexExecEndpointShared,
  resolveSummaryEndpointFromSettings as resolveSummaryEndpointFromSettingsShared,
} from "../core/summary-endpoint";
import {
  isLocalCliEndpoint,
  runAiAssistantFallback,
  runAiAssistantTurn,
  type AiChatMessage,
  type FallbackSessionHit,
  type ToolExecutionResult,
} from "../core/ai-assistant";
import { applyMigrationLengthPolicy, createMigrationCompressor } from "../core/session-migration-compression";
import { migrateSession, migrationAgentForSource } from "../core/session-migration";
import { runLocalSessionMigration } from "./local-session-migration";
import { targetFilePath, writeMigratedSession } from "../core/session-migration-writers";
import { writeDbPointer } from "../core/app-paths";
import { routeResumeSession } from "../core/resume-router";
import { diagnoseRemoteEnvironment, preflightRemoteSessionResume } from "../core/remote-health";
import { buildRemoteSyncSshArgs, fetchRemoteSessionFilePayload, fetchRemoteSessionMessagePage, syncRemoteEnvironment } from "../core/remote-sync";
import { loadRemoteSessionDetailPayload } from "../core/remote-session-loader";
import { restoreRemotePortableSession } from "../core/remote-session-restore";
import {
  buildRemoteSessionSetupSql,
  buildRemoteSessionUploadFromStore,
  buildSessionSyncItems,
  SupabaseRemoteSessionClient,
  type RemoteSessionDetailSnapshot,
  type RemoteSessionListItem,
  type RemoteSessionStatus,
  type RemoteSessionUploadResult,
  type SessionSyncItem,
} from "../core/remote-session-sync";
import { RemoteEnvironmentLifecycle } from "../core/remote-environment-lifecycle";
import { RemoteWatchManager } from "../core/remote-watch";
import { SessionStore, type SkillSyncBinding, type TraceEventQueryOptions } from "../core/session-store";
import {
  deleteInstalledSkill,
  installRemoteSkillLocally,
  isSyncableSkill,
  listInstalledSkills,
  portableSkillLocation,
  skillProjectDirsFromIndexedProjects,
  type InstalledSkill,
  type InstalledSkillsSnapshot,
} from "../core/skill-manager";
import {
  buildSkillSyncSetupSql,
  buildSkillVersionBasePayload,
  groupRemoteSkillVersions,
  skillSyncFilesFromMetadata,
  skillSyncLocalContentHash,
  skillSyncFingerprint,
  SupabaseSkillSyncClient,
  type RemoteSkill,
  type SkillSyncInstallResult,
  type SkillSyncBatchResult,
  type SkillSyncRelation,
  type SkillSyncSnapshot,
  type SkillSyncUploadOutcome,
} from "../core/skill-sync";
import { buildSkillDiffSnapshot, type SkillContentSnapshot, type SkillDiffSnapshot } from "../core/skill-diff";
import { buildCombinedSupabaseSetupSql, supabaseSqlEditorUrl } from "../core/supabase-setup";
import {
  clearSessionSyncQueue,
  coalesceSessionSyncQueueEvents,
  readSessionSyncQueue,
  removeSessionSyncQueueFiles,
  type SessionSyncHookStatus,
} from "../core/session-sync-queue";
import {
  listSkillUsageSources,
  readSkillUsageSourceEvents,
  usageForSkill,
  type SkillUsageRefreshStatus,
} from "../core/skill-usage";
import { buildSshArgs, readUserSshConfig } from "../core/ssh-config";
import {
  AUTO_INDEX_REFRESH_INTERVAL_MS,
  AUTO_SESSION_SYNC_QUEUE_INTERVAL_MS,
  AUTO_SKILL_USAGE_REFRESH_INTERVAL_MS,
  INITIAL_INDEX_DELAY_MS,
  INITIAL_SKILL_USAGE_REFRESH_DELAY_MS,
} from "../core/refresh-policy";
import { globalShortcutLabel, normalizeGlobalShortcut } from "../core/shortcuts";
import { isLocalSessionEnvironment } from "../core/session-environment";
import type { AppSettings, AppSettingsUpdate } from "../core/platform";
import type { AppUpdateInstallResult, AppUpdateManifest, AppUpdateStatus } from "../core/app-update-types";
import type {
  EnvironmentUpsertInput,
  MigrationAgent,
  MigrationTarget,
  PortableSession,
  ProjectQueryOptions,
  SearchOptions,
  SessionEnvironment,
  SessionMigrationResult,
  SessionSearchResult,
  SessionSource,
  SessionStatsOptions,
  TagListOptions,
} from "../core/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_NAME = "Agent-Session-Search";
const TRAY_ICON_RELATIVE_PATH = path.join("assets", "tray-iconTemplate.png");
const releaseUpdateRuntime = app.isPackaged || process.env.AGENT_SESSION_SEARCH_RELEASE_BUILD === "1";
type ApiProviderKeyTarget = "codex" | "claude" | "summary";

const OPTIONAL_SOURCE_SETTINGS: Array<{ key: keyof Pick<AppSettings, "includeClaudeInternal" | "includeCodexInternal" | "includeTclaude" | "includeTcodex" | "includeCodeBuddyCli" | "includeCodeWizCli" | "includeOpenClaw" | "includeHermes" | "includeOpenCode" | "includeCursorAgent" | "includeTrae">; sources: SessionSource[] }> = [
  { key: "includeClaudeInternal", sources: ["claude-internal"] },
  { key: "includeCodexInternal", sources: ["codex-internal"] },
  { key: "includeTclaude", sources: ["tclaude-cli"] },
  { key: "includeTcodex", sources: ["tcodex-cli"] },
  { key: "includeCodeBuddyCli", sources: ["codebuddy-cli"] },
  { key: "includeCodeWizCli", sources: ["codewiz-cli"] },
  { key: "includeOpenClaw", sources: ["openclaw"] },
  { key: "includeHermes", sources: ["hermes"] },
  { key: "includeOpenCode", sources: ["opencode-cli"] },
  { key: "includeCursorAgent", sources: ["cursor-agent"] },
  { key: "includeTrae", sources: ["trae"] },
];

// The skill-usage hook installer is a self-contained CommonJS script in bin/
// (sibling of out/), shared with the global-install path. Load it lazily via a
// runtime require so the bundler leaves it as an external dependency, and the
// hook command it writes points back at bin/skill-usage-record.cjs.
const requireCjs = createRequire(import.meta.url);
const SKILL_USAGE_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-skill-usage-hook.cjs");
interface SkillUsageHookSetup {
  installSkillUsageHook(options?: Record<string, unknown>): { status: string; detail?: string };
  uninstallSkillUsageHook(options?: Record<string, unknown>): { status: string; detail?: string };
  skillUsageHookStatus(options?: Record<string, unknown>): { installed: boolean };
}
function loadSkillUsageHookSetup(): SkillUsageHookSetup {
  return requireCjs(SKILL_USAGE_HOOK_SETUP_PATH) as SkillUsageHookSetup;
}

const SESSION_SYNC_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-session-sync-hook.cjs");
interface SessionSyncHookSetup {
  installSessionSyncHooks(options?: Record<string, unknown>): { status: string; detail?: string };
  uninstallSessionSyncHooks(options?: Record<string, unknown>): { status: string; detail?: string };
  sessionSyncHookStatus(options?: Record<string, unknown>): { installed: boolean; claude: boolean; codex: boolean; error?: string };
}
function loadSessionSyncHookSetup(): SessionSyncHookSetup {
  return requireCjs(SESSION_SYNC_HOOK_SETUP_PATH) as SessionSyncHookSetup;
}

const MCP_SETUP_PATH = path.join(__dirname, "../../bin/setup-mcp.cjs");
interface McpSetup {
  run(remove: boolean): string[];
  status(): boolean;
}
function loadMcpSetup(): McpSetup {
  return requireCjs(MCP_SETUP_PATH) as McpSetup;
}

const UPDATE_CLIENT_PATH = path.join(__dirname, "../../bin/update-client.cjs");
const APPLY_UPDATE_PATH = path.join(__dirname, "../../bin/apply-update.cjs");
interface UpdateClientModule {
  LATEST_RELEASE_URL: string;
  checkForUpdate(options?: { currentVersion?: string; force?: boolean; showSkipped?: boolean }): Promise<AppUpdateStatus>;
  clearAppProcess(pid?: number): Promise<void>;
  clearInstallStatus(): Promise<void>;
  currentVersion(): string;
  formatUpdateError(error: unknown): string;
  manualInstallCommand(): string;
  parseUpdateManifest(value: unknown): AppUpdateManifest;
  readInstallStatus(): Promise<{ status?: string; version?: string; error?: string | null } | null>;
  skipUpdateVersion(version: string): Promise<void>;
  snoozeUpdatePrompt(version: string): Promise<void>;
  writeAppProcess(pid?: number): Promise<string>;
  writeUpdatePreference(enabled: boolean): Promise<void>;
}
function loadUpdateClient(): UpdateClientModule {
  return requireCjs(UPDATE_CLIENT_PATH) as UpdateClientModule;
}

function ensureSessionSearchMcpPreference(): boolean {
  const setup = loadMcpSetup();
  if (getSettings().sessionSearchMcpEnabled) {
    if (!setup.status()) setup.run(false);
  }
  return setup.status();
}

// Merges skill-usage counts and hook-install state onto the scanned skill list
// so the renderer can sort by most-used.
function buildSkillsSnapshot(): InstalledSkillsSnapshot {
  const projectDirs = skillProjectDirsFromIndexedProjects(store.listProjects());
  const snapshot = listInstalledSkills({ projectDirs });
  const usage = store.getSkillUsageSnapshot();
  const skills = snapshot.skills.map((skill) => {
    const stat = usageForSkill(usage, skill.name, skill.agent);
    return { ...skill, usageCount: stat?.count ?? 0, lastUsedAt: stat?.lastUsedAt ?? null };
  });

  let hookInstalled = false;
  try {
    hookInstalled = loadSkillUsageHookSetup().skillUsageHookStatus().installed;
  } catch {
    hookInstalled = false;
  }

  return { ...snapshot, skills, usage: { hookInstalled, logExists: usage.exists, totalEvents: usage.totalEvents } };
}

function refreshSkillUsageIndex(): SkillUsageRefreshStatus {
  const sources = listSkillUsageSources();
  let refreshed = 0;
  let skipped = 0;

  for (const source of sources) {
    if (store.isSkillUsageSourceFresh(source)) {
      skipped += 1;
      continue;
    }
    store.upsertSkillUsageSource(source, readSkillUsageSourceEvents(source));
    refreshed += 1;
  }

  store.pruneSkillUsageSources(sources.map((source) => source.path));
  const usage = store.getSkillUsageSnapshot();
  return {
    refreshed,
    skipped,
    total: sources.length,
    totalEvents: usage.totalEvents,
    lastRefreshedAt: Date.now(),
  };
}

function refreshSkillUsageIndexSafely(): void {
  try {
    refreshSkillUsageIndex();
  } catch (error) {
    console.error(`Failed to refresh skill usage: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createSkillSyncClient(): SupabaseSkillSyncClient {
  const settings = getSettings();
  if (!settings.skillSyncEnabled || !settings.skillSyncSupabaseUrl || !settings.skillSyncSupabaseAnonKey) {
    throw new Error("Supabase skill sync is not configured.");
  }
  return new SupabaseSkillSyncClient({
    url: settings.skillSyncSupabaseUrl,
    anonKey: settings.skillSyncSupabaseAnonKey,
  });
}

async function buildSkillSyncSnapshot(): Promise<SkillSyncSnapshot> {
  const setupSql = buildSkillSyncSetupSql();
  const settings = getSettings();
  if (!settings.skillSyncEnabled || !settings.skillSyncSupabaseUrl || !settings.skillSyncSupabaseAnonKey) {
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
      scannedAt: Date.now(),
    };
  }

  const client = createSkillSyncClient();
  const status = await client.checkStatus();
  const remoteSkillGroups = status.kind === "ready" ? groupRemoteSkillVersions(await client.listRemoteSkillVersions()) : [];
  const bindings = store.listSkillSyncBindings();
  return {
    status,
    remoteSkillGroups,
    bindings,
    relations: status.kind === "ready" ? await buildSkillSyncRelations(buildSkillsSnapshot().skills, remoteSkillGroups, bindings) : [],
    scannedAt: Date.now(),
  };
}

async function buildSkillSyncRelations(
  skills: InstalledSkill[],
  remoteGroups: SkillSyncSnapshot["remoteSkillGroups"],
  bindings: SkillSyncBinding[],
): Promise<SkillSyncRelation[]> {
  const syncable = skills.flatMap((skill) => {
    const location = portableSkillLocation(skill);
    if (!location) return [];
    return [{ skill, location }];
  });
  const local = await Promise.all(syncable.map(async (entry) => ({
    ...entry,
    contentHash: await skillSyncLocalContentHash(entry.skill),
  })));
  const localsByIdentity = new Map(local.map((entry) => [entry.location.identity, entry]));
  const bindingsByIdentity = new Map(bindings.flatMap((binding) => binding.portableIdentity ? [[binding.portableIdentity, binding] as const] : []));
  const used = new Set<string>();
  const relations: SkillSyncRelation[] = [];

  for (const group of remoteGroups) {
    const identity = group.portableScope && group.relativePath ? `${group.portableScope}/${group.relativePath}` : `legacy:${group.fingerprint}`;
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
    if (used.has(entry.location.identity)) continue;
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
  return relations;
}

async function uploadLocalSkillToSupabase(skillPath: string, force = false): Promise<SkillSyncUploadOutcome> {
  const skill = findInstalledSkillByPath(skillPath);
  if (!isSyncableSkill(skill)) throw new Error("Only user and shared Skills can be uploaded.");
  const client = createSkillSyncClient();
  const location = portableSkillLocation(skill);
  if (!location) throw new Error("Only user and shared Skills can be uploaded.");
  const fingerprint = skillSyncFingerprint(skill);
  const { base, contentHash } = buildSkillVersionBasePayload(skill);
  const remoteGroup = groupRemoteSkillVersions(await client.listRemoteSkillVersions())
    .find((group) => group.fingerprint === fingerprint) ?? null;
  const latest = remoteGroup?.latest ?? null;

  // Nothing changed since the current latest version: keep the binding, don't create noise.
  if (latest && latest.contentHash === contentHash) {
    const binding = persistSkillSyncBinding(skill.path, location.identity, latest.id, latest.updatedAt, latest.version, contentHash, "upload");
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
  const newBinding = persistSkillSyncBinding(skill.path, location.identity, remoteSkill.id, remoteSkill.updatedAt, remoteSkill.version, contentHash, "upload");
  return { status: "uploaded", remoteSkill, binding: newBinding, version: remoteSkill.version };
}

async function installRemoteSkillFromSupabase(remoteSkillId: string): Promise<SkillSyncInstallResult> {
  const client = createSkillSyncClient();
  const remoteSkill = await client.getRemoteSkill(remoteSkillId);
  if (remoteSkill.legacy || !remoteSkill.portableScope || !remoteSkill.relativePath) {
    throw new Error("This legacy Skill can only be previewed or deleted because its install location is uncertain.");
  }
  const installed = installRemoteSkillLocally(remoteSkill);
  const identity = `${remoteSkill.portableScope}/${remoteSkill.relativePath}`;
  const binding = persistSkillSyncBinding(installed.installedPath, identity, remoteSkill.id, remoteSkill.updatedAt, remoteSkill.version, remoteSkill.contentHash, "download");
  return {
    remoteSkill,
    binding,
    installedPath: installed.installedPath,
    overwritten: installed.overwritten,
  };
}

function getRemoteSkillVersionDetail(remoteSkillId: string): Promise<RemoteSkill> {
  return createSkillSyncClient().getRemoteSkill(remoteSkillId);
}

async function getSyncedSkillDiff(
  localSkillPath: string | null,
  remoteSkillId: string | null,
): Promise<SkillDiffSnapshot> {
  let localSnapshot: SkillContentSnapshot | null = null;
  let remoteSnapshot: SkillContentSnapshot | null = null;

  if (localSkillPath) {
    const localSkill = findInstalledSkillByPath(localSkillPath);
    const { base, contentHash } = buildSkillVersionBasePayload(localSkill);
    localSnapshot = {
      contentHash,
      files: skillSyncFilesFromMetadata(base.metadata ?? {}),
    };
  }

  if (remoteSkillId) {
    const remoteSkill = await getRemoteSkillVersionDetail(remoteSkillId);
    const files = skillSyncFilesFromMetadata(remoteSkill.metadata);
    remoteSnapshot = {
      contentHash: remoteSkill.contentHash,
      files: files.some((file) => file.relativePath === "SKILL.md")
        ? files
        : [{ relativePath: "SKILL.md", contentBase64: Buffer.from(remoteSkill.markdown, "utf8").toString("base64") }, ...files],
    };
  }

  return buildSkillDiffSnapshot(localSnapshot, remoteSnapshot);
}

async function downloadRemoteSkillGroups(fingerprints: string[]): Promise<SkillSyncBatchResult> {
  const requested = [...new Set(fingerprints.map((value) => value.trim()).filter(Boolean))];
  const snapshot = await buildSkillSyncSnapshot();
  const groups = new Map(snapshot.remoteSkillGroups.map((group) => [group.fingerprint, group]));
  const relations = new Map((snapshot.relations ?? []).flatMap((relation) => relation.remoteFingerprint ? [[relation.remoteFingerprint, relation] as const] : []));
  const result: SkillSyncBatchResult = { requested: requested.length, succeeded: [], skipped: [], conflicts: [], failures: [] };
  await runBounded(requested, 4, async (fingerprint) => {
    const group = groups.get(fingerprint);
    const relation = relations.get(fingerprint);
    if (!group || !relation) {
      result.skipped.push({ id: fingerprint, reason: "Remote Skill no longer exists." });
      return;
    }
    if (relation.state === "legacy") {
      result.skipped.push({ id: fingerprint, reason: "Legacy record has no safe install location." });
      return;
    }
    if (relation.state === "synced" || relation.state === "local-newer") {
      result.skipped.push({ id: fingerprint, reason: relation.state === "synced" ? "Already synced." : "Local version is newer." });
      return;
    }
    if (relation.state === "conflict") {
      result.conflicts.push(fingerprint);
      return;
    }
    try {
      await installRemoteSkillFromSupabase(group.latest.id);
      result.succeeded.push(fingerprint);
    } catch (error) {
      result.failures.push({ id: fingerprint, message: error instanceof Error ? error.message : String(error) });
    }
  });
  return result;
}

async function deleteRemoteSkillGroups(fingerprints: string[]): Promise<SkillSyncBatchResult> {
  const requested = [...new Set(fingerprints.map((value) => value.trim()).filter(Boolean))];
  const client = createSkillSyncClient();
  const groups = new Map(groupRemoteSkillVersions(await client.listRemoteSkillVersions()).map((group) => [group.fingerprint, group]));
  const result: SkillSyncBatchResult = { requested: requested.length, succeeded: [], skipped: [], conflicts: [], failures: [] };
  await runBounded(requested, 4, async (fingerprint) => {
    try {
      const group = groups.get(fingerprint);
      if (!group) {
        result.skipped.push({ id: fingerprint, reason: "Remote Skill no longer exists." });
        return;
      }
      const deletedIds = await client.deleteRemoteSkillVersions(group.versions.map((version) => version.id));
      if (deletedIds.length === 0) result.skipped.push({ id: fingerprint, reason: "Remote Skill no longer exists." });
      else {
        store.deleteSkillSyncBindingsForRemoteIds(deletedIds);
        result.succeeded.push(fingerprint);
      }
    } catch (error) {
      result.failures.push({ id: fingerprint, message: error instanceof Error ? error.message : String(error) });
    }
  });
  return result;
}

async function runBounded<T>(items: T[], concurrency: number, action: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await action(items[index]);
    }
  });
  await Promise.all(workers);
}

function persistSkillSyncBinding(
  localSkillPath: string,
  portableIdentity: string,
  remoteSkillId: string,
  remoteUpdatedAt: string,
  remoteVersion: number,
  lastContentHash: string,
  direction: "upload" | "download",
): SkillSyncBinding {
  const binding: SkillSyncBinding = { localSkillPath, portableIdentity, remoteSkillId, remoteUpdatedAt, remoteVersion, lastContentHash, lastSyncedAt: Date.now(), direction };
  store.upsertSkillSyncBinding(binding);
  return binding;
}

function createRemoteSessionClient(): SupabaseRemoteSessionClient {
  const settings = getSettings();
  if (!settings.remoteSyncEnabled || !settings.remoteSyncSupabaseUrl || !settings.remoteSyncSupabaseAnonKey) {
    throw new Error("Supabase remote session sync is not configured.");
  }
  return new SupabaseRemoteSessionClient({
    url: settings.remoteSyncSupabaseUrl,
    anonKey: settings.remoteSyncSupabaseAnonKey,
  });
}

async function getRemoteSessionStatus(): Promise<RemoteSessionStatus> {
  const setupSql = buildRemoteSessionSetupSql();
  const settings = getSettings();
  if (!settings.remoteSyncEnabled || !settings.remoteSyncSupabaseUrl || !settings.remoteSyncSupabaseAnonKey) {
    return {
      kind: "unconfigured",
      setupSql,
      remediation: "settings",
      message: "Configure Supabase URL and anon key in Settings to sync remote sessions.",
    };
  }
  return createRemoteSessionClient().checkStatus();
}

async function uploadSessionToRemote(sessionKey: string, force = false): Promise<RemoteSessionUploadResult> {
  const client = createRemoteSessionClient();
  await ensureRemoteSessionDetailsLoaded(sessionKey);
  const binding = store.getSessionSyncBindingForLocalKey(sessionKey);
  const { payload, detailJson, portableJson } = buildRemoteSessionUploadFromStore(store, sessionKey, Date.now(), binding?.remoteSessionId);
  if (binding && !force) {
    const remote = await client.getRemoteSession(binding.remoteSessionId).catch((error) => {
      if (error instanceof Error && error.message === "Remote session was not found.") return null;
      throw error;
    });
    if (remote) {
      const localChanged = payload.content_hash !== binding.lastLocalRevision;
      const remoteChanged = remote.contentHash !== binding.lastRemoteRevision;
      if (localChanged && remoteChanged) throw new Error("Both local and cloud copies changed. Choose a conflict action before overwriting the cloud copy.");
    }
  }
  const result = await client.uploadSession(payload, detailJson, portableJson);
  store.upsertSessionSyncBinding({
    localSessionKey: sessionKey,
    remoteSessionId: result.remoteSession.id,
    lastLocalRevision: payload.content_hash,
    lastRemoteRevision: result.remoteSession.contentHash,
    lastSyncedAt: Date.now(),
    direction: "upload",
  });
  return result;
}

function listRemoteSessions(query = ""): Promise<RemoteSessionListItem[]> {
  return createRemoteSessionClient().listRemoteSessions(query);
}

async function listSessionSyncItems(): Promise<SessionSyncItem[]> {
  const client = createRemoteSessionClient();
  const remotes = (await client.listRemoteSessions())
    .filter((remote) => store.getSession(remote.sourceSessionKey)?.isSubagent !== true);
  const locals: Array<{ session: SessionSearchResult; revision: string }> = [];
  await runBounded(store.searchSessions({ limit: 100_000, excludeSubagents: true }), 4, async (session) => {
    if (!migrationAgentForSource(session.source) || !session.projectPath.trim()) return;
    try {
      await ensureRemoteSessionDetailsLoaded(session.sessionKey);
      const hydrated = store.getSession(session.sessionKey);
      if (!hydrated) return;
      const built = buildRemoteSessionUploadFromStore(store, session.sessionKey, 0, store.getSessionSyncBindingForLocalKey(session.sessionKey)?.remoteSessionId);
      locals.push({ session: hydrated, revision: built.payload.content_hash });
    } catch (error) {
      throw new Error(`Could not load ${session.displayTitle || session.sessionKey} before comparing it with the cloud copy: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return buildSessionSyncItems(locals, remotes, store.listSessionSyncBindings());
}

async function deleteRemoteSessionCopies(remoteIds: string[]): Promise<import("../core/remote-session-sync").RemoteSessionDeleteResult> {
  const result = await createRemoteSessionClient().deleteRemoteSessions(remoteIds);
  for (const id of [...result.deletedIds, ...result.missingIds]) store.deleteSessionSyncBindingForRemoteId(id);
  return result;
}

function getRemoteSessionDetail(remoteId: string): Promise<RemoteSessionDetailSnapshot> {
  return createRemoteSessionClient().getDetailSnapshot(remoteId);
}

async function restoreRemoteSession(
  event: IpcMainInvokeEvent,
  remoteId: string,
  target: MigrationAgent,
  localProjectPath: string,
): Promise<SessionMigrationResult> {
  const client = createRemoteSessionClient();
  const portable = await client.getPortableSession(remoteId);
  // 没配自定义摘要 endpoint 时回退本地 Codex CLI(缺失则再退 Claude),让迁移仍走 AI 压缩而非直接本地截断——与 AI 助手一致。
  const settings = await getHydratedSettings();
  const endpoint = (await resolveSummaryEndpointFromSettings()) ?? buildCodexExecEndpoint(settings);
  const compressor = endpoint ? createMigrationCompressor(endpoint, undefined, settings.compressionConcurrency) : null;
  const result = await restoreRemotePortableSession({
    remoteId,
    portable,
    target,
    localProjectPath,
    deps: {
      inspectCli: (migrationTarget) => inspectMigrationCli(migrationTarget, getSettings()),
      prepare: (session, onProgress) => applyMigrationLengthPolicy(session, compressor, onProgress),
      write: (migrationTarget, session) => writeMigratedSession({ target: migrationTarget, session }),
      record: (record) => store.recordSessionMigration(record),
      refreshIndex: async (migrationTarget, writtenFilePath, targetSessionId) => {
        const status = indexMigratedSessionFile(store, migrationTarget, writtenFilePath, targetSessionId);
        indexStatus = status;
        mainWindow?.webContents.send("index-status", indexStatus);
      },
      launch: (migrationTarget, targetSessionId, projectPath) =>
        openMigrationResumeInTerminal(migrationTarget, targetSessionId, projectPath, getSettings()),
      resumeCommand: migrationResumeDisplayCommand,
      fallbackResumeCommand: fallbackMigrationResumeDisplayCommand,
      onProgress: (progress) => event.sender.send("session:migration-progress", progress),
      idFactory: () => randomUUID(),
      now: () => Date.now(),
      projectPathExists: pathExists,
      projectPathIsDirectory: pathIsDirectory,
    },
  });
  await bindRestoredSession(client, remoteId, result.targetSessionId);
  return result;
}

async function restoreRemoteSessionToSourceEnvironment(
  event: IpcMainInvokeEvent,
  remoteId: string,
  target: MigrationAgent,
): Promise<SessionMigrationResult> {
  const client = createRemoteSessionClient();
  const remoteSession = await client.getRemoteSession(remoteId);
  if (remoteSession.sourceEnvironmentKind !== "ssh") {
    throw new Error("This remote session was not saved from an SSH environment.");
  }
  const environment = store.getEnvironment(remoteSession.sourceEnvironmentId);
  if (!environment || environment.kind !== "ssh") {
    throw new Error("The SSH environment for this remote session is not configured on this machine.");
  }

  const portable = await client.getPortableSession(remoteId);
  const settings = await getHydratedSettings();
  const endpoint = (await resolveSummaryEndpointFromSettings()) ?? buildCodexExecEndpoint(settings);
  const compressor = endpoint ? createMigrationCompressor(endpoint, undefined, settings.compressionConcurrency) : null;

  const result = await restoreRemotePortableSession({
    remoteId,
    portable,
    target,
    localProjectPath: portable.projectPath,
    deps: {
      inspectCli: async () => undefined,
      prepare: (session, onProgress) => applyMigrationLengthPolicy(session, compressor, onProgress),
      write: (migrationTarget, session) => writeMigratedSessionToSshEnvironment(environment, migrationTarget, session),
      record: (record) => store.recordSessionMigration(record),
      refreshIndex: async () => {
        await syncRemoteEnvironment(store, environment, {
          enabledOptionalSources: enabledRemoteOptionalSources(getSettings()),
        });
        mainWindow?.webContents.send("environments-updated", store.listEnvironments());
      },
      launch: async () => undefined,
      resumeCommand: (migrationTarget, targetSessionId, projectPath) => remoteMigrationResumeDisplayCommand(environment, migrationTarget, targetSessionId, projectPath),
      fallbackResumeCommand: (migrationTarget, targetSessionId, projectPath) => remoteMigrationResumeDisplayCommand(environment, migrationTarget, targetSessionId, projectPath),
      onProgress: (progress) => event.sender.send("session:migration-progress", progress),
      idFactory: () => randomUUID(),
      now: () => Date.now(),
      projectPathExists: (projectPath) => remotePathExists(environment, projectPath),
      projectPathIsDirectory: (projectPath) => remotePathIsDirectory(environment, projectPath),
    },
  });
  await bindRestoredSession(client, remoteId, result.targetSessionId);
  return result;
}

async function bindRestoredSession(client: SupabaseRemoteSessionClient, remoteId: string, targetSessionId: string): Promise<void> {
  try {
    const local = store.searchSessions({ limit: 100_000 }).find((session) => session.rawId === targetSessionId);
    if (!local) return;
    const built = buildRemoteSessionUploadFromStore(store, local.sessionKey, 0, remoteId);
    const remote = await client.getRemoteSession(remoteId);
    store.upsertSessionSyncBinding({
      localSessionKey: local.sessionKey,
      remoteSessionId: remoteId,
      lastLocalRevision: built.payload.content_hash,
      lastRemoteRevision: remote.contentHash,
      lastSyncedAt: Date.now(),
      direction: "restore",
    });
  } catch {
    // The restored conversation is still usable when its sync binding cannot be recorded.
  }
}

function findInstalledSkillByPath(skillPath: string): InstalledSkill {
  const normalized = path.resolve(skillPath);
  const skill = buildSkillsSnapshot().skills.find((item) => path.resolve(item.path) === normalized);
  if (!skill) throw new Error("Skill is no longer installed or is outside managed roots.");
  return skill;
}

app.setName(PRODUCT_NAME);
app.setAppUserModelId("dev.zszz3.agent-session-search");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: SessionStore;
let indexStatus: IndexStatus = { running: false, indexed: 0, skipped: 0, total: 0, lastIndexedAt: null, error: null };
let activeIndexRun: Promise<IndexStatus> | null = null;
let autoIndexTimer: ReturnType<typeof setInterval> | null = null;
let initialSkillUsageTimer: ReturnType<typeof setTimeout> | null = null;
let autoSkillUsageTimer: ReturnType<typeof setInterval> | null = null;
let autoSessionSyncQueueTimer: ReturnType<typeof setInterval> | null = null;
let sessionSyncQueueRunning = false;
let sessionSyncHookLastProcessedAt: number | null = null;
let sessionSyncHookLastError: string | null = null;
let registeredGlobalShortcut: string | null = null;
let remoteWatchManager: RemoteWatchManager | null = null;
let remoteEnvironmentLifecycle: RemoteEnvironmentLifecycle | null = null;
let codexChatProxy: CodexChatProxy | null = null;
let codexChatProxySignature: string | null = null;
let appUpdateStatus: AppUpdateStatus | null = null;
let activeAppUpdateCheck: Promise<AppUpdateStatus> | null = null;
let previousUpdateResultShown = false;
const remoteDetailLoads = new Map<string, Promise<void>>();

const settingsStore = new Store<AppSettings>({
  defaults: defaultSettings,
});

type SavedWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
};

const windowStateStore = new Store<SavedWindowState>({
  name: "window-state",
  defaults: { width: 0, height: 0 },
});

function getSettings(): AppSettings {
  const settings = mergeAppSettings(defaultSettings, settingsStore.store);
  return {
    ...settings,
    globalShortcut: normalizeGlobalShortcut(settings.globalShortcut),
    defaultTerminal: normalizeTerminal(settings.defaultTerminal),
  };
}

function emptyAppUpdateStatus(): AppUpdateStatus {
  return {
    currentVersion: loadUpdateClient().currentVersion(),
    developmentBuild: false,
    checkedAt: 0,
    fromCache: false,
    updateAvailable: false,
    manifest: null,
    error: null,
  };
}

function updateAutoCheckDisabledByEnvironment(): boolean {
  return process.env.AGENT_SESSION_SEARCH_NO_UPDATE_CHECK === "1";
}

function developmentAppUpdateStatus(): AppUpdateStatus {
  return {
    ...emptyAppUpdateStatus(),
    developmentBuild: true,
  };
}

async function refreshAppUpdateStatus(force = false): Promise<AppUpdateStatus> {
  if (!releaseUpdateRuntime) return developmentAppUpdateStatus();
  if (activeAppUpdateCheck) return activeAppUpdateCheck;
  activeAppUpdateCheck = loadUpdateClient()
    .checkForUpdate({ currentVersion: loadUpdateClient().currentVersion(), force })
    .then(async (status) => {
      const installStatus = await loadUpdateClient().readInstallStatus().catch(() => null);
      const releaseStatus = { ...status, developmentBuild: false };
      const nextStatus = installStatus?.status === "error" && installStatus.error
        ? { ...releaseStatus, error: `上次更新失败：${installStatus.error}` }
        : releaseStatus;
      appUpdateStatus = nextStatus;
      mainWindow?.webContents.send("app-update:status", nextStatus);
      return nextStatus;
    })
    .finally(() => {
      activeAppUpdateCheck = null;
    });
  return activeAppUpdateCheck;
}

async function getAppUpdateStatus(force = false): Promise<AppUpdateStatus> {
  if (!releaseUpdateRuntime) return developmentAppUpdateStatus();
  if (!force && updateAutoCheckDisabledByEnvironment()) return appUpdateStatus ?? emptyAppUpdateStatus();
  if (!force && !getSettings().autoCheckUpdates) return appUpdateStatus ?? emptyAppUpdateStatus();
  if (!force && appUpdateStatus) return appUpdateStatus;
  return refreshAppUpdateStatus(force);
}

async function startAppUpdate(): Promise<AppUpdateInstallResult> {
  if (!releaseUpdateRuntime) throw new Error("Application updates are unavailable in development builds.");
  const manifest = loadUpdateClient().parseUpdateManifest(appUpdateStatus?.manifest);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-search-app-update-"));
  const manifestPath = path.join(directory, "update.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [APPLY_UPDATE_PATH, "--manifest", manifestPath, "--wait-pid", String(process.pid)], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  child.unref();
  setTimeout(() => app.quit(), 100);
  return { started: true, version: manifest.version };
}

async function skipCurrentAppUpdate(untilNextVersion: boolean): Promise<AppUpdateStatus> {
  const status = appUpdateStatus?.updateAvailable ? appUpdateStatus : await getAppUpdateStatus(false);
  const version = status.manifest?.version;
  if (!status.updateAvailable || !version) return status;
  if (untilNextVersion) await loadUpdateClient().skipUpdateVersion(version);
  else await loadUpdateClient().snoozeUpdatePrompt(version);
  const nextStatus = await refreshAppUpdateStatus(false);
  appUpdateStatus = nextStatus;
  mainWindow?.webContents.send("app-update:status", nextStatus);
  return nextStatus;
}

async function showPreviousUpdateResult(): Promise<void> {
  if (previousUpdateResultShown) return;
  const client = loadUpdateClient();
  const status = await client.readInstallStatus().catch(() => null);
  const current = client.currentVersion();
  const installed = status?.status === "installed" && status.version === current;
  const failed = status?.status === "error" && Boolean(status.error);
  if (!installed && !failed) return;
  previousUpdateResultShown = true;
  if (installed) {
    const options = {
      type: "info" as const,
      title: "更新完成",
      message: `Agent-Session-Search v${current} 已安装完成。`,
      detail: "应用已经使用新版本重新启动。",
    };
    if (mainWindow) await dialog.showMessageBox(mainWindow, options);
    else await dialog.showMessageBox(options);
  } else {
    const command = client.manualInstallCommand();
    const options = {
      type: "error" as const,
      title: "更新失败",
      message: "自动更新未能完成，可以手动安装最新版本。",
      detail: `${client.formatUpdateError(status?.error)}\n\n可以复制命令手动覆盖安装，或打开 GitHub Release 页面下载：\n${command}`,
      buttons: ["复制安装命令", "打开 Release 页面", "稍后处理"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) clipboard.writeText(command);
    if (result.response === 1) await shell.openExternal(client.LATEST_RELEASE_URL);
  }
  await client.clearInstallStatus().catch(() => undefined);
}

function visibleSearchOptions(options: SearchOptions = {}): SearchOptions {
  return { ...options, excludeSubagents: getSettings().hideSubagentSessions };
}

function visibleStatsOptions(options: SessionStatsOptions = {}): SessionStatsOptions {
  return { ...options, excludeSubagents: getSettings().hideSubagentSessions };
}

function visibleProjectOptions(): { excludeSubagents: boolean } {
  return { excludeSubagents: getSettings().hideSubagentSessions };
}

function pruneDisabledOptionalSources(settings: AppSettings): void {
  const disabledSources = OPTIONAL_SOURCE_SETTINGS.flatMap((item) => (settings[item.key] ? [] : item.sources));
  store.deleteSessionsBySource(disabledSources);
}

function enabledRemoteOptionalSources(settings: AppSettings): SessionSource[] {
  return [
    ...(settings.includeTclaude ? ["tclaude-cli" as const] : []),
    ...(settings.includeTcodex ? ["tcodex-cli" as const] : []),
    ...(settings.includeCodeBuddyCli ? ["codebuddy-cli" as const] : []),
  ];
}

async function getHydratedSettings(): Promise<AppSettings> {
  const settings = getSettings();
  const [profileDefaults, claudeProfileDefaults] = await Promise.all([
    loadCodexProfileDefaults(),
    loadClaudeApiConfigDefaults(),
  ]);
  return withStoredApiProviderKeys({
    ...settings,
    apiConfig: mergeApiConfigWithProfileDefaults(settings.apiConfig, getSavedApiConfigPatch(), profileDefaults),
    claudeApiConfig: mergeClaudeApiConfigWithProfileDefaults(
      settings.claudeApiConfig,
      getSavedClaudeApiConfigPatch(),
      claudeProfileDefaults,
    ),
  });
}

function withStoredApiProviderKeys(settings: AppSettings): AppSettings {
  const next = { ...settings };
  if (next.apiConfig.activeProvider === "custom") {
    next.apiConfig = {
      ...next.apiConfig,
      customApiKey: store.getApiProviderKey("codex", next.apiConfig.customProviderId),
    };
  }
  if (next.claudeApiConfig.activeProvider === "custom") {
    next.claudeApiConfig = {
      ...next.claudeApiConfig,
      customApiKey: store.getApiProviderKey("claude", next.claudeApiConfig.customProviderId),
    };
  }
  if (next.summaryApiConfig.activeProvider === "custom") {
    next.summaryApiConfig = {
      ...next.summaryApiConfig,
      customApiKey: store.getApiProviderKey("summary", next.summaryApiConfig.customProviderId),
    };
  }
  return next;
}

function withoutApiProviderKeys(settings: AppSettings): AppSettings {
  return {
    ...settings,
    apiConfig: { ...settings.apiConfig, customApiKey: "" },
    claudeApiConfig: { ...settings.claudeApiConfig, customApiKey: "" },
    summaryApiConfig: { ...settings.summaryApiConfig, customApiKey: "" },
  };
}

function persistApiProviderKeysFromUpdate(update: AppSettingsUpdate, next: AppSettings): void {
  if (update.apiConfig && next.apiConfig.activeProvider === "custom") {
    store.setApiProviderKey("codex", next.apiConfig.customProviderId, next.apiConfig.customApiKey);
  }
  if (update.claudeApiConfig && next.claudeApiConfig.activeProvider === "custom") {
    store.setApiProviderKey("claude", next.claudeApiConfig.customProviderId, next.claudeApiConfig.customApiKey);
  }
  if (update.summaryApiConfig && next.summaryApiConfig.activeProvider === "custom") {
    store.setApiProviderKey("summary", next.summaryApiConfig.customProviderId, next.summaryApiConfig.customApiKey);
  }
}

function migrateLegacyApiProviderKeys(): void {
  const settings = getSettings();
  if (
    settings.apiConfig.activeProvider === "custom" &&
    settings.apiConfig.customApiKey &&
    !store.getApiProviderKey("codex", settings.apiConfig.customProviderId)
  ) {
    store.setApiProviderKey("codex", settings.apiConfig.customProviderId, settings.apiConfig.customApiKey);
  }
  if (
    settings.claudeApiConfig.activeProvider === "custom" &&
    settings.claudeApiConfig.customApiKey &&
    !store.getApiProviderKey("claude", settings.claudeApiConfig.customProviderId)
  ) {
    store.setApiProviderKey("claude", settings.claudeApiConfig.customProviderId, settings.claudeApiConfig.customApiKey);
  }
  settingsStore.set("apiConfig.customApiKey", "");
  settingsStore.set("claudeApiConfig.customApiKey", "");
}

function apiConfigWithPresetDefaultsForProxy(config: Partial<ApiConfig>): ApiConfig {
  const normalized = normalizeApiConfig(config);
  const preset = apiProviderPreset(normalized.customProviderId);
  return normalizeApiConfig({
    ...normalized,
    customProviderId: preset.id,
    customProviderName: config.customProviderName?.trim() || preset.providerName,
    customBaseUrl: config.customBaseUrl?.trim() || preset.baseUrl,
    customModel: config.customModel?.trim() || preset.model,
    customApiFormat: config.customApiFormat ?? preset.apiFormat,
  });
}

function shouldUseCodexChatProxy(apiConfig: ApiConfig): boolean {
  return apiConfig.activeProvider === "custom" && apiConfig.customApiFormat === "openai_chat";
}

async function stopCodexChatProxy(): Promise<void> {
  const proxy = codexChatProxy;
  codexChatProxy = null;
  codexChatProxySignature = null;
  await proxy?.stop();
}

function codexChatProxySignatureFor(apiConfig: ApiConfig): string {
  return JSON.stringify({
    upstreamBaseUrl: apiConfig.customBaseUrl.replace(/\/+$/, ""),
    model: apiConfig.customModel,
    apiKey: apiConfig.customApiKey,
  });
}

async function ensureCodexChatProxy(apiConfig: ApiConfig): Promise<CodexChatProxyStatus> {
  if (!apiConfig.customApiKey) throw new Error(`API key is required to start ${apiConfig.customProviderName} proxy.`);
  if (!apiConfig.customBaseUrl) throw new Error(`Base URL is required to start ${apiConfig.customProviderName} proxy.`);
  if (!apiConfig.customModel) throw new Error(`Model is required to start ${apiConfig.customProviderName} proxy.`);

  const current = codexChatProxy?.getStatus();
  const targetSignature = codexChatProxySignatureFor(apiConfig);
  if (
    current?.running &&
    codexChatProxySignature === targetSignature &&
    current.upstreamBaseUrl === apiConfig.customBaseUrl.replace(/\/+$/, "") &&
    current.model === apiConfig.customModel
  ) {
    return current;
  }

  await stopCodexChatProxy();
  const proxy = new CodexChatProxy({
    upstreamBaseUrl: apiConfig.customBaseUrl,
    apiKey: apiConfig.customApiKey,
    model: apiConfig.customModel,
    listenHost: "127.0.0.1",
    listenPort: 15721,
  });
  const status = await proxy.start();
  codexChatProxy = proxy;
  codexChatProxySignature = targetSignature;
  return status;
}

async function applyCodexApiConfigWithProxy(apiConfigInput: Partial<ApiConfig>) {
  const apiConfig = apiConfigWithPresetDefaultsForProxy(apiConfigInput);
  if (!shouldUseCodexChatProxy(apiConfig)) {
    await stopCodexChatProxy();
    return applyCodexApiConfig({ apiConfig });
  }
  const proxyStatus = await ensureCodexChatProxy(apiConfig);
  return applyCodexApiConfig({ apiConfig, chatProxyBaseUrl: proxyStatus.baseUrl });
}

async function restoreCodexChatProxyFromSettings(): Promise<void> {
  const settings = getSettings();
  const apiConfig = apiConfigWithPresetDefaultsForProxy({
    ...settings.apiConfig,
    customApiKey:
      settings.apiConfig.activeProvider === "custom" ? store.getApiProviderKey("codex", settings.apiConfig.customProviderId) : "",
  });
  if (!shouldUseCodexChatProxy(apiConfig) || !apiConfig.customApiKey) return;
  try {
    await ensureCodexChatProxy(apiConfig);
  } catch (error) {
    console.error(`Failed to restore Codex Chat proxy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeApiProviderKeyTarget(target: unknown): ApiProviderKeyTarget {
  if (target === "codex" || target === "claude" || target === "summary") return target;
  throw new Error("Unknown API provider key target.");
}

function getSavedApiConfigPatch(): Partial<ApiConfig> {
  const saved: Partial<ApiConfig> = {};
  const readSaved = <K extends keyof ApiConfig>(key: K): void => {
    const pathKey = `apiConfig.${key}` as `apiConfig.${keyof ApiConfig}`;
    if (settingsStore.has(pathKey)) saved[key] = settingsStore.get(pathKey) as ApiConfig[K];
  };

  readSaved("activeProvider");
  readSaved("customProviderId");
  readSaved("customProviderName");
  readSaved("customBaseUrl");
  readSaved("customApiKey");
  readSaved("customModel");
  readSaved("customApiFormat");
  return saved;
}

function getSavedClaudeApiConfigPatch(): Partial<ClaudeApiConfig> {
  const saved: Partial<ClaudeApiConfig> = {};
  const readSaved = <K extends keyof ClaudeApiConfig>(key: K): void => {
    const pathKey = `claudeApiConfig.${key}` as `claudeApiConfig.${keyof ClaudeApiConfig}`;
    if (settingsStore.has(pathKey)) saved[key] = settingsStore.get(pathKey) as ClaudeApiConfig[K];
  };

  readSaved("activeProvider");
  readSaved("customProviderId");
  readSaved("customProviderName");
  readSaved("customBaseUrl");
  readSaved("customApiKey");
  readSaved("customModel");
  readSaved("customHaikuModel");
  readSaved("customSonnetModel");
  readSaved("customOpusModel");
  readSaved("customApiFormat");
  readSaved("customApiKeyField");
  return saved;
}

function markdownExportFileName(title: string): string {
  const safeTitle = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${safeTitle || "session"}.md`;
}

function sshArgsForSession(session: SessionSearchResult): string[] | undefined {
  if (isLocalSessionEnvironment(session)) return undefined;
  const environment = store.getEnvironment(session.environmentId);
  if (!environment || environment.kind !== "ssh") return undefined;
  try {
    const args = buildSshArgs(environment, "");
    return args.slice(0, -1);
  } catch {
    return undefined;
  }
}

function requireSshArgsForRemoteSession(session: SessionSearchResult): string[] | undefined {
  const sshArgs = sshArgsForSession(session);
  if (!isLocalSessionEnvironment(session) && !sshArgs) {
    throw new Error("SSH environment is not available for this remote session.");
  }
  return sshArgs;
}

function requireRemoteSshEnvironment(session: SessionSearchResult): SessionEnvironment | null {
  if (isLocalSessionEnvironment(session)) return null;
  const environment = store.getEnvironment(session.environmentId);
  if (!environment || environment.kind !== "ssh") throw new Error("SSH environment is not available for this remote session.");
  return environment;
}

function requireSshEnvironment(environmentId: string): SessionEnvironment {
  const environment = store.getEnvironment(environmentId);
  if (!environment) throw new Error("SSH environment was not found.");
  if (environment.kind !== "ssh") throw new Error("Diagnostics are only available for SSH environments.");
  return environment;
}

async function ensureRemoteResumePreflight(session: SessionSearchResult): Promise<void> {
  const environment = requireRemoteSshEnvironment(session);
  if (!environment) return;
  const report = await preflightRemoteSessionResume(environment, session);
  const errors = report.checks.filter((check) => check.status === "error");
  if (errors.length === 0) return;
  const detail = errors.map((check) => `${check.label}: ${check.message}`).join("; ");
  throw new Error(`Remote resume preflight failed: ${detail}`);
}

function hasHydratedRemoteDetails(sessionKey: string): boolean {
  return store.getMessages(sessionKey, 0, 1).length > 0;
}

async function ensureRemoteSessionDetailsLoaded(sessionKey: string): Promise<void> {
  const session = store.getSession(sessionKey);
  if (!session || isLocalSessionEnvironment(session)) return;
  if (hasHydratedRemoteDetails(sessionKey)) return;

  const active = remoteDetailLoads.get(sessionKey);
  if (active) return active;

  const load = (async () => {
    const latest = store.getSession(sessionKey);
    if (!latest || isLocalSessionEnvironment(latest)) return;
    if (latest.source === "codewiz-cli") return;
    const environment = store.getEnvironment(latest.environmentId);
    if (!environment || environment.kind !== "ssh") throw new Error("SSH environment is not available for this remote session.");
    const payload = await fetchRemoteSessionFilePayload(environment, latest);
    const loaded = loadRemoteSessionDetailPayload(environment, payload, latest);
    if (loaded) store.upsertIndexedSession(loaded.session, loaded.messages, loaded.tokenEvents, loaded.traceEvents);
  })().finally(() => {
    remoteDetailLoads.delete(sessionKey);
  });

  remoteDetailLoads.set(sessionKey, load);
  return load;
}

async function chooseMarkdownExportPath(defaultFileName: string): Promise<string | null> {
  const options = {
    title: "Export Markdown",
    defaultPath: path.join(app.getPath("documents"), defaultFileName),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  return path.extname(result.filePath) ? result.filePath : `${result.filePath}.md`;
}

async function chooseLocalProjectDirectory(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose local project directory",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 820;
const MIN_WINDOW_WIDTH = 860;
const MIN_WINDOW_HEIGHT = 560;

function getPreferredWindowBounds(): { width: number; height: number; x: number; y: number } {
  const cursorPoint = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursorPoint);
  const width = Math.min(DEFAULT_WINDOW_WIDTH, workArea.width);
  const height = Math.min(DEFAULT_WINDOW_HEIGHT, workArea.height);

  return {
    width,
    height,
    x: Math.round(workArea.x + Math.max(0, workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height - height) / 2),
  };
}

function getRestoredWindowBounds(): { width: number; height: number; x: number; y: number } {
  const saved = windowStateStore.store;
  if (saved.width >= MIN_WINDOW_WIDTH && saved.height >= MIN_WINDOW_HEIGHT) {
    const { workArea } = screen.getDisplayMatching({
      x: saved.x ?? 0,
      y: saved.y ?? 0,
      width: saved.width,
      height: saved.height,
    });
    if (
      saved.x !== undefined &&
      saved.y !== undefined &&
      saved.x + saved.width > workArea.x &&
      saved.y + saved.height > workArea.y &&
      saved.x < workArea.x + workArea.width &&
      saved.y < workArea.y + workArea.height
    ) {
      return { width: saved.width, height: saved.height, x: saved.x, y: saved.y };
    }
  }
  return getPreferredWindowBounds();
}

function persistWindowState(): void {
  if (!mainWindow) return;
  if (mainWindow.isMaximized() || mainWindow.isFullScreen()) {
    windowStateStore.set("isMaximized", true);
    return;
  }
  const bounds = mainWindow.getBounds();
  windowStateStore.set({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: false,
  });
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, "../preload/index.mjs");
  const initialBounds = getRestoredWindowBounds();
  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: PRODUCT_NAME,
    show: false,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    backgroundColor: "#0a0b0d",
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (windowStateStore.get("isMaximized") === true) {
    mainWindow.maximize();
  }

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[renderer] did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error("[renderer]", message, `${sourceId}:${line}`);
    else console.log("[renderer]", message);
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("resize", persistWindowState);
  mainWindow.on("move", persistWindowState);
  mainWindow.on("maximize", persistWindowState);
  mainWindow.on("unmaximize", persistWindowState);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function toggleWindow(): void {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  showWindow();
}

function showWindow(): void {
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("focus-search");
}

function registerAppGlobalShortcut(accelerator: string): boolean {
  if (registeredGlobalShortcut === accelerator) return true;

  const previous = registeredGlobalShortcut;
  if (previous) {
    globalShortcut.unregister(previous);
    registeredGlobalShortcut = null;
  }

  if (!accelerator) return true;

  const registered = globalShortcut.register(accelerator, toggleWindow);
  if (registered) {
    registeredGlobalShortcut = accelerator;
    return true;
  }

  if (previous && globalShortcut.register(previous, toggleWindow)) {
    registeredGlobalShortcut = previous;
  }
  return false;
}

function createTray(): void {
  const image = loadTrayIcon();
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${PRODUCT_NAME}`, click: showWindow },
      { label: "Refresh Now", click: () => void runIndexSync() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showWindow);
}

function loadTrayIcon(): Electron.NativeImage {
  const iconPath = resolveAssetPath(TRAY_ICON_RELATIVE_PATH);
  if (iconPath) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEqADAAQAAAABAAAAEgAAAACaqbJVAAABU0lEQVQ4Ec2Tu0pDQRCGk2iCighpJSKIVaqANvbaWQdBsZAgWFr5CD6EMRAh4FsIFmm8lIKFAa8kNqmMF6Lm+4+7um62Sghk4GNn/rNnzuzMnlhs2CzuFVQg3oQJT1fYgiMoKvBtxBGU5AAS8OLo1s3gbMAjXFoxtJ4i3kEy9NDo96za12WjjqLjPMM0VGAMrL3hrEMDQseOjmE397W6FdlEtzjbMG6EV9Yr42s4/oDMo7/lHFcswbfHMvExfBldfZqHX3OzK4lMidbArShPvApNaMMUaHpZeIdgjybRF2EBtPEMlOQQaqDJ7sIcrEBkoR7N8EQ90tQ0rROQ3UAu8n58uWkT/1t0bn3Nv0e6tA/wBLoeF1AHHXEWuqyAoiYrmfrlck38CXYItun7aJG5v4iuvRqor/hVfaCpKlVdhj1QC7ZAv1MVerYUb5Zgp+cMA32xA3OAR0Jsy3XjAAAAAElFTkSuQmCC",
  );
}

function resolveAssetPath(relativePath: string): string | null {
  const candidates = [
    path.join(__dirname, "..", "..", relativePath),
    path.join(app.getAppPath(), relativePath),
    path.join(process.resourcesPath, relativePath),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function createApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME });

  const template: MenuItemConstructorOptions[] = [
    {
      label: PRODUCT_NAME,
      submenu: [
        { label: `About ${PRODUCT_NAME}`, role: "about" },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "Command+,",
          click: () => {
            showWindow();
            mainWindow?.webContents.send("open-settings");
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { label: `Hide ${PRODUCT_NAME}`, accelerator: "Command+H", role: "hide" },
        { label: "Hide Others", accelerator: "Command+Alt+H", role: "hideOthers" },
        { label: "Show All", role: "unhide" },
        { type: "separator" },
        { label: `Quit ${PRODUCT_NAME}`, accelerator: "Command+Q", click: () => app.quit() },
      ],
    },
    {
      label: "File",
      submenu: [{ role: "close" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Refresh Now", accelerator: "CmdOrCtrl+R", click: () => void runIndexSync() },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function emitEnvironmentsUpdated(): void {
  mainWindow?.webContents.send("environments-updated", store.listEnvironments());
}

function remoteSyncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureRemoteWatchManager(): RemoteWatchManager {
  if (!remoteWatchManager) {
    remoteWatchManager = new RemoteWatchManager({
      syncEnvironment: (environment) => ensureRemoteEnvironmentLifecycle().syncFromWatcher(environment),
      onSyncError: (environment, error) => {
        store.updateEnvironmentSyncState(environment.id, "error", { lastError: remoteSyncErrorMessage(error) });
        emitEnvironmentsUpdated();
      },
    });
  }
  return remoteWatchManager;
}

function ensureRemoteEnvironmentLifecycle(): RemoteEnvironmentLifecycle {
  if (!remoteEnvironmentLifecycle) {
    remoteEnvironmentLifecycle = new RemoteEnvironmentLifecycle({
      store,
      syncEnvironment: (environment) =>
        syncRemoteEnvironment(store, environment, {
          enabledOptionalSources: enabledRemoteOptionalSources(getSettings()),
        }).then(() => undefined),
      watchManager: ensureRemoteWatchManager(),
      onEnvironmentsUpdated: () => emitEnvironmentsUpdated(),
    });
  }
  return remoteEnvironmentLifecycle;
}

async function runIndexSync(): Promise<IndexStatus> {
  if (activeIndexRun) return activeIndexRun;

  const settings = getSettings();
  pruneDisabledOptionalSources(settings);
  indexStatus = { ...indexStatus, running: true, error: null };
  mainWindow?.webContents.send("index-status", indexStatus);

  activeIndexRun = syncDefaultSessionsInBatches(store, {
    batchSize: 2,
    loadOptions: {
      includeClaudeInternal: settings.includeClaudeInternal,
      includeCodexInternal: settings.includeCodexInternal,
      includeTclaude: settings.includeTclaude,
      includeTcodex: settings.includeTcodex,
      includeCodeBuddyCli: settings.includeCodeBuddyCli,
      includeCodeWizCli: settings.includeCodeWizCli,
      includeOpenClaw: settings.includeOpenClaw,
      includeHermes: settings.includeHermes,
      includeOpenCode: settings.includeOpenCode,
      includeCursorAgent: settings.includeCursorAgent,
      includeTrae: settings.includeTrae,
    },
    onProgress: (status) => {
      indexStatus = { ...status, lastIndexedAt: indexStatus.lastIndexedAt };
      mainWindow?.webContents.send("index-status", indexStatus);
    },
  })
    .then((status) => {
      indexStatus = status;
      mainWindow?.webContents.send("index-status", indexStatus);
      void maybeAutoBackfillSummaries();
      return indexStatus;
    })
    .catch((error) => {
      indexStatus = {
        running: false,
        indexed: 0,
        skipped: 0,
        total: 0,
        lastIndexedAt: indexStatus.lastIndexedAt,
        error: String(error),
      };
      mainWindow?.webContents.send("index-status", indexStatus);
      return indexStatus;
    })
    .finally(() => {
      ensureRemoteEnvironmentLifecycle().startEnabledEnvironments();
      activeIndexRun = null;
    });

  return activeIndexRun;
}

function getSessionSyncHookStatus(): SessionSyncHookStatus {
  const hook = loadSessionSyncHookSetup().sessionSyncHookStatus();
  const queue = readSessionSyncQueue();
  return {
    installed: hook.installed,
    claude: hook.claude,
    codex: hook.codex,
    pending: queue.events.length,
    lastProcessedAt: sessionSyncHookLastProcessedAt,
    lastError: hook.error || sessionSyncHookLastError,
  };
}

async function drainSessionSyncQueue(): Promise<void> {
  if (sessionSyncQueueRunning || !getSettings().remoteSyncEnabled) return;
  const queued = readSessionSyncQueue();
  removeSessionSyncQueueFiles(queued.invalidFiles);
  const coalesced = coalesceSessionSyncQueueEvents(queued.events);
  removeSessionSyncQueueFiles(coalesced.supersededFiles);
  if (coalesced.events.length === 0) return;

  sessionSyncQueueRunning = true;
  sessionSyncHookLastError = null;
  try {
    await runIndexSync();
    const localSessions = store.searchSessions({ limit: 100_000, excludeSubagents: false })
      .filter((session) => isLocalSessionEnvironment(session));

    for (const event of coalesced.events) {
      if (!getSettings().remoteSyncEnabled || !loadSessionSyncHookSetup().sessionSyncHookStatus().installed) break;
      const session = localSessions.find((candidate) =>
        migrationAgentForSource(candidate.source) === event.agent &&
        ((event.transcriptPath && path.resolve(candidate.filePath) === path.resolve(event.transcriptPath)) || candidate.rawId === event.sessionId),
      );
      if (!session) continue;
      if (session.isSubagent) {
        removeSessionSyncQueueFiles([event.filePath]);
        continue;
      }

      try {
        await ensureRemoteSessionDetailsLoaded(session.sessionKey);
        const binding = store.getSessionSyncBindingForLocalKey(session.sessionKey);
        const built = buildRemoteSessionUploadFromStore(store, session.sessionKey, 0, binding?.remoteSessionId);
        if (binding && binding.lastLocalRevision === built.payload.content_hash) {
          removeSessionSyncQueueFiles([event.filePath]);
          sessionSyncHookLastProcessedAt = Date.now();
          continue;
        }
        await uploadSessionToRemote(session.sessionKey);
        removeSessionSyncQueueFiles([event.filePath]);
        sessionSyncHookLastProcessedAt = Date.now();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sessionSyncHookLastError = message;
        if (message.includes("Both local and cloud copies changed")) {
          removeSessionSyncQueueFiles([event.filePath]);
        }
      }
    }
  } finally {
    sessionSyncQueueRunning = false;
  }
}

function startAutoSessionSyncQueue(): void {
  if (autoSessionSyncQueueTimer) return;
  autoSessionSyncQueueTimer = setInterval(() => void drainSessionSyncQueue(), AUTO_SESSION_SYNC_QUEUE_INTERVAL_MS);
  void drainSessionSyncQueue();
}

function stopAutoSessionSyncQueue(): void {
  if (!autoSessionSyncQueueTimer) return;
  clearInterval(autoSessionSyncQueueTimer);
  autoSessionSyncQueueTimer = null;
}

const loadCachedLiveSessionSnapshot = createCachedLiveSessionSnapshotLoader();

let summaryBackfillRunning = false;

const SUMMARY_PROVIDER_ERROR =
  "AI summary has no usable provider. Select Codex, Claude Code, or configure a direct summary API provider in Settings.";

function buildCodexExecEndpoint(settings: AppSettings): SummaryEndpoint {
  return buildCodexExecEndpointShared(settings, {
    onTemporarySession: (sessionKey) => {
      try {
        store.deleteSession(sessionKey);
      } catch {
        // Best-effort cleanup if an ephemeral Codex call is indexed before it exits.
      }
    },
  });
}

async function resolveSummaryEndpointFromSettings(): Promise<SummaryEndpoint | null> {
  const settings = await getHydratedSettings();
  const onTemporarySession = (sessionKey: string): void => {
    try {
      store.deleteSession(sessionKey);
    } catch {
      // Best-effort cleanup if an ephemeral summary call is indexed before it exits.
    }
  };
  if (settings.summarySource === "custom") {
    const endpoint = resolveSummaryEndpointFromSettingsShared(settings, {});
    if (endpoint) return endpoint;
    const codexDefaults = await loadActiveCodexSummaryEndpointDefaults();
    if (codexDefaults) {
      return {
        baseUrl: codexDefaults.baseUrl,
        model: codexDefaults.model,
        apiKey: codexDefaults.apiKey,
        apiFormat: codexDefaults.apiFormat,
      };
    }
    return buildCodexExecEndpointShared(settings, { onTemporarySession });
  }
  return resolveSummaryEndpointFromSettingsShared(settings, { onTemporarySession });
}

const SUMMARY_HEAD_MESSAGES = 24;
const SUMMARY_TAIL_MESSAGES = 16;
// Sessions at or below this many messages are summarized in full.
const SUMMARY_FULL_THRESHOLD = SUMMARY_HEAD_MESSAGES + SUMMARY_TAIL_MESSAGES;

// Short sessions are summarized in full; long ones use a head + tail excerpt so the
// original problem and the final resolution both survive, fetching only a bounded slice.
async function summarizeOneSession(sessionKey: string, endpoint: SummaryEndpoint): Promise<void> {
  const count = store.getMessageCount(sessionKey);
  let excerpt;
  if (count <= SUMMARY_FULL_THRESHOLD) {
    excerpt = { head: store.getMessages(sessionKey, 0, SUMMARY_FULL_THRESHOLD), tail: [], omittedCount: 0 };
  } else {
    excerpt = {
      head: store.getMessages(sessionKey, 0, SUMMARY_HEAD_MESSAGES),
      tail: store.getMessages(sessionKey, count - SUMMARY_TAIL_MESSAGES, SUMMARY_TAIL_MESSAGES),
      omittedCount: count - SUMMARY_HEAD_MESSAGES - SUMMARY_TAIL_MESSAGES,
    };
  }
  const result = await summarizeSession(excerpt, endpoint);
  store.setAiSummary(sessionKey, result.summary, endpoint.model);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function pathIsDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

function migrationResumeDisplayCommand(target: MigrationTarget, sessionId: string, projectPath: string): string {
  return getMigrationResumeProcessSpec(target, sessionId, projectPath, getSettings()).displayCommand;
}

function quotePosixToken(value: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function fallbackMigrationResumeDisplayCommand(target: MigrationTarget, sessionId: string, projectPath: string): string {
  return getSafeMigrationResumeCommand(target, sessionId, projectPath, getSettings());
}

function remoteMigrationResumeDisplayCommand(
  environment: SessionEnvironment,
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
): string {
  const remoteCommand = getMigrationResumeProcessSpec(target, sessionId, projectPath, getSettings(), { platform: "linux" }).displayCommand;
  return ["ssh", ...buildRemoteSyncSshArgs(environment, remoteCommand).map(quotePosixToken)].join(" ");
}

function localSessionMigrationRuntime(event: IpcMainInvokeEvent) {
  return {
    resolveSummaryEndpoint: (snapshot: AppSettings) => resolveSummaryEndpointFromSettingsShared(snapshot, {
      onTemporarySession: (temporarySessionKey) => {
        try {
          store.deleteSession(temporarySessionKey);
        } catch {
          // Best-effort cleanup if an ephemeral summary call is indexed before it exits.
        }
      },
    }) ?? buildCodexExecEndpoint(snapshot),
    createCompressor: (endpoint: SummaryEndpoint, concurrency: number) =>
      createMigrationCompressor(endpoint, undefined, concurrency),
    migrate: migrateSession,
    inspectCli: (migrationTarget: MigrationTarget, snapshot: AppSettings) => inspectMigrationCli(migrationTarget, snapshot),
    prepare: (portable: PortableSession, onProgress: Parameters<typeof applyMigrationLengthPolicy>[2], compressor: ReturnType<typeof createMigrationCompressor> | null) =>
      applyMigrationLengthPolicy(portable, compressor, onProgress),
    write: (migrationTarget: MigrationTarget, portable: PortableSession) =>
      writeMigratedSession({ target: migrationTarget, session: portable }),
    record: (record: Parameters<SessionStore["recordSessionMigration"]>[0]) => store.recordSessionMigration(record),
    refreshIndex: async (migrationTarget: MigrationTarget, writtenFilePath: string, targetSessionId: string) => {
      const status = indexMigratedSessionFile(store, migrationTarget, writtenFilePath, targetSessionId);
      indexStatus = status;
      mainWindow?.webContents.send("index-status", indexStatus);
    },
    launch: (migrationTarget: MigrationTarget, targetSessionId: string, projectPath: string, snapshot: AppSettings) =>
      openMigrationResumeInTerminal(migrationTarget, targetSessionId, projectPath, snapshot),
    resumeCommand: (migrationTarget: MigrationTarget, targetSessionId: string, projectPath: string, snapshot: AppSettings) =>
      getMigrationResumeProcessSpec(migrationTarget, targetSessionId, projectPath, snapshot).displayCommand,
    fallbackResumeCommand: (migrationTarget: MigrationTarget, targetSessionId: string, projectPath: string, snapshot: AppSettings) =>
      getSafeMigrationResumeCommand(migrationTarget, targetSessionId, projectPath, snapshot),
    onProgress: (progress: Parameters<NonNullable<import("../core/session-migration").SessionMigrationDependencies["onProgress"]>>[0]) =>
      event.sender.send("session:migration-progress", progress),
    idFactory: () => randomUUID(),
    now: () => Date.now(),
    projectPathExists: pathExists,
    projectPathIsDirectory: pathIsDirectory,
  };
}

async function writeMigratedSessionToSshEnvironment(
  environment: SessionEnvironment,
  target: MigrationAgent,
  session: PortableSession,
): Promise<{ sessionId: string; filePath: string }> {
  const now = new Date();
  const tempHome = await fs.mkdtemp(path.join(app.getPath("temp"), "agent-session-remote-restore-"));
  try {
    const written = await writeMigratedSession({ target, session, homeDir: tempHome, now });
    const remoteHome = await remoteHomeDir(environment);
    const remotePath = targetFilePath(target, session.projectPath, written.sessionId, remoteHome, now);
    const content = await fs.readFile(written.filePath);
    await runRemotePython(environment, REMOTE_WRITE_FILE_SCRIPT, {
      path: remotePath,
      contentBase64: content.toString("base64"),
    });
    return { sessionId: written.sessionId, filePath: remotePath };
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

async function remoteHomeDir(environment: SessionEnvironment): Promise<string> {
  const output = await runRemotePython(environment, "from pathlib import Path\nprint(Path.home())", {});
  const home = output.trim();
  if (!home) throw new Error("Could not resolve remote home directory.");
  return home;
}

async function remotePathExists(environment: SessionEnvironment, targetPath: string): Promise<boolean> {
  return (await runRemotePathCheck(environment, targetPath, "exists")) === "true";
}

async function remotePathIsDirectory(environment: SessionEnvironment, targetPath: string): Promise<boolean> {
  return (await runRemotePathCheck(environment, targetPath, "is_dir")) === "true";
}

async function runRemotePathCheck(environment: SessionEnvironment, targetPath: string, check: "exists" | "is_dir"): Promise<string> {
  const output = await runRemotePython(
    environment,
    [
      "import json, sys",
      "from pathlib import Path",
      "payload = json.load(sys.stdin)",
      "path = Path(payload['path'])",
      "check = payload['check']",
      "print('true' if (path.exists() if check == 'exists' else path.is_dir()) else 'false')",
    ].join("\n"),
    { path: targetPath, check },
  );
  return output.trim();
}

function runRemotePython(environment: SessionEnvironment, script: string, payload: unknown): Promise<string> {
  const remoteCommand = buildPythonBase64Command(script);
  return runSshWithInput(environment, remoteCommand, `${JSON.stringify(payload)}\n`);
}

function runSshWithInput(environment: SessionEnvironment, remoteCommand: string, input: string): Promise<string> {
  const args = buildRemoteSyncSshArgs(environment, remoteCommand);
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", args, { maxBuffer: 128 * 1024 * 1024, timeout: 90_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

function buildPythonBase64Command(script: string): string {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const compressed = zlib.deflateRawSync(Buffer.from(script, "utf-8"));
  const encoded = compressed.toString("base64");
  return `python3 -c 'import base64,zlib; exec(zlib.decompress(base64.b64decode("${encoded}"), -15).decode("utf-8"))'`;
}

const REMOTE_WRITE_FILE_SCRIPT = [
  "import base64, json, os, sys, uuid",
  "from pathlib import Path",
  "payload = json.load(sys.stdin)",
  "target = Path(payload['path'])",
  "content = base64.b64decode(payload['contentBase64'])",
  "target.parent.mkdir(parents=True, exist_ok=True)",
  "tmp = target.with_name(target.name + '.tmp-' + uuid.uuid4().hex)",
  "tmp.write_bytes(content)",
  "os.chmod(tmp, 0o600)",
  "os.replace(tmp, target)",
  "print(str(target))",
].join("\n");

async function maybeAutoBackfillSummaries(): Promise<void> {
  if (summaryBackfillRunning) return;
  const settings = getSettings();
  if (!settings.summaryAutoBackfill) return;
  const endpoint = await resolveSummaryEndpointFromSettings();
  if (!endpoint) return;
  summaryBackfillRunning = true;
  try {
    const maxAgeMs = settings.summaryMaxAgeDays * 86_400_000;
    const candidates = store.listSessionsNeedingSummary(Date.now(), maxAgeMs, 25);
    for (const candidate of candidates) {
      try {
        await summarizeOneSession(candidate.sessionKey, endpoint);
      } catch {
        // Skip sessions the provider cannot summarize; keep going.
      }
    }
  } finally {
    summaryBackfillRunning = false;
  }
}

function startAutoIndexRefresh(): void {
  if (autoIndexTimer) return;
  autoIndexTimer = setInterval(() => {
    void runIndexSync();
  }, AUTO_INDEX_REFRESH_INTERVAL_MS);
}

function stopAutoIndexRefresh(): void {
  if (!autoIndexTimer) return;
  clearInterval(autoIndexTimer);
  autoIndexTimer = null;
}

function startAutoSkillUsageRefresh(): void {
  if (!initialSkillUsageTimer) {
    initialSkillUsageTimer = setTimeout(() => {
      initialSkillUsageTimer = null;
      refreshSkillUsageIndexSafely();
    }, INITIAL_SKILL_USAGE_REFRESH_DELAY_MS);
  }
  if (autoSkillUsageTimer) return;
  autoSkillUsageTimer = setInterval(() => {
    refreshSkillUsageIndexSafely();
  }, AUTO_SKILL_USAGE_REFRESH_INTERVAL_MS);
}

function stopAutoSkillUsageRefresh(): void {
  if (initialSkillUsageTimer) {
    clearTimeout(initialSkillUsageTimer);
    initialSkillUsageTimer = null;
  }
  if (!autoSkillUsageTimer) return;
  clearInterval(autoSkillUsageTimer);
  autoSkillUsageTimer = null;
}

function registerIpc(): void {
  ipcMain.handle("search:sessions", (_event, options: SearchOptions) => store.searchSessions(visibleSearchOptions(options)));
  ipcMain.handle("search:session-page", (_event, options: SearchOptions) => store.searchSessionPage(visibleSearchOptions(options)));
  ipcMain.handle("session:get", (_event, sessionKey: string) => {
    store.markOpened(sessionKey);
    return store.getSession(sessionKey);
  });
  ipcMain.handle("session:messages", async (_event, sessionKey: string, offset?: number, limit?: number) => {
    const pageOffset = offset ?? 0;
    const pageLimit = limit ?? 120;
    const session = store.getSession(sessionKey);
    if (session && !isLocalSessionEnvironment(session) && !hasHydratedRemoteDetails(sessionKey)) {
      if (session.messageCount <= 0) return [];
      const environment = requireRemoteSshEnvironment(session);
      if (!environment) return [];
      return fetchRemoteSessionMessagePage(environment, session, pageOffset, pageLimit);
    }
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    return store.getMessages(sessionKey, pageOffset, pageLimit);
  });
  ipcMain.handle("session:trace-events", async (_event, sessionKey: string, options?: TraceEventQueryOptions) => {
    const session = store.getSession(sessionKey);
    if (session && !isLocalSessionEnvironment(session) && !hasHydratedRemoteDetails(sessionKey)) return [];
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    return store.getTraceEvents(sessionKey, options);
  });
  ipcMain.handle("sessions:live", () => loadCachedLiveSessionSnapshot({ includeTrae: getSettings().includeTrae }));
  ipcMain.handle("session:summarize", async (_event, sessionKey: string) => {
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    const endpoint = await resolveSummaryEndpointFromSettings();
    if (!endpoint) {
      throw new Error(SUMMARY_PROVIDER_ERROR);
    }
    await summarizeOneSession(sessionKey, endpoint);
    return store.getSession(sessionKey);
  });
  ipcMain.handle("session:summarize-missing", async (event) => {
    const endpoint = await resolveSummaryEndpointFromSettings();
    if (!endpoint) {
      throw new Error(SUMMARY_PROVIDER_ERROR);
    }
    const settings = getSettings();
    const maxAgeMs = settings.summaryMaxAgeDays * 86_400_000;
    // Cover all missing/stale sessions in the age window in one run (bounded for
    // safety). Failed ones stay missing and are retried on the next run.
    const candidates = store.listSessionsNeedingSummary(Date.now(), maxAgeMs, 500);
    const total = candidates.length;
    let processed = 0;
    let failed = 0;
    let next = 0;
    const sendProgress = (): void => {
      event.sender.send("summary:progress", { processed, failed, total });
    };
    sendProgress();
    // A few in parallel so a large backlog finishes in reasonable wall time; each
    // request is individually time-bounded, so one slow provider can't stall it.
    const worker = async (): Promise<void> => {
      while (next < candidates.length) {
        const candidate = candidates[next++];
        try {
          await summarizeOneSession(candidate.sessionKey, endpoint);
          processed += 1;
        } catch {
          failed += 1;
        }
        sendProgress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
    return { processed, failed, total };
  });
  ipcMain.handle("ai:assistant-chat", async (_event, messages: AiChatMessage[]) => {
    // The assistant shares the summary provider routing. When the user picked a
    // direct API provider but left it incomplete, fall back to the local Codex
    // CLI so the assistant still works out of the box.
    const endpoint = (await resolveSummaryEndpointFromSettings()) ?? buildCodexExecEndpoint(await getHydratedSettings());

    // Local CLI providers (codex exec / claude) can't do HTTP function calling.
    // Fall back to: keyword-search the store with the user's words, then let the
    // CLI write a grounded answer over the hits.
    if (isLocalCliEndpoint(endpoint)) {
      const search = async (query: string): Promise<FallbackSessionHit[]> => {
        const sessions = store.searchSessions(visibleSearchOptions({ query, limit: 12 }));
        return sessions.map((session) => ({
          sessionKey: session.sessionKey,
          title: session.displayTitle,
          source: session.source,
          project: session.projectPath,
          summary: session.aiSummary ?? session.firstQuestion ?? null,
        }));
      };
      const { reply, sessionKeys } = await runAiAssistantFallback(endpoint, messages, search);
      const sessions = sessionKeys
        .map((key) => store.getSession(key))
        .filter((session): session is SessionSearchResult => session !== null);
      return { reply, sessions };
    }
    // The model's tool calls run against the local SessionStore — the same data
    // the MCP server exposes. We collect surfaced sessionKeys so the renderer can
    // hydrate full results into clickable cards.
    const executeTool = async (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => {
      switch (name) {
        case "search_sessions": {
          const query = typeof args.query === "string" ? args.query : "";
          const source = typeof args.source === "string" && args.source ? args.source : undefined;
          const projectPath = typeof args.project === "string" && args.project ? args.project : undefined;
          const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20;
          const sessions = store.searchSessions(visibleSearchOptions({
            query,
            source: source as SearchOptions["source"],
            projectPath,
            limit,
          }));
          return {
            result: sessions.map((session) => ({
              sessionKey: session.sessionKey,
              title: session.displayTitle,
              source: session.source,
              project: session.projectPath,
              timestamp: session.timestamp,
              summary: session.aiSummary ?? session.firstQuestion ?? null,
            })),
            sessionKeys: sessions.map((session) => session.sessionKey),
          };
        }
        case "list_projects": {
          const projects = store.listProjects(visibleProjectOptions());
          return {
            result: projects.map((project) => ({ project: project.path, sessions: project.sessionCount })),
            sessionKeys: [],
          };
        }
        case "list_tags": {
          return { result: store.listTags(), sessionKeys: [] };
        }
        case "get_session": {
          const sessionKey = typeof args.sessionKey === "string" ? args.sessionKey : "";
          if (!sessionKey) return { result: { error: "sessionKey is required." }, sessionKeys: [] };
          await ensureRemoteSessionDetailsLoaded(sessionKey);
          const session = store.getSession(sessionKey);
          if (!session) return { result: { error: "Session not found." }, sessionKeys: [] };
          const maxMessages = typeof args.maxMessages === "number" ? Math.max(1, Math.min(200, Math.floor(args.maxMessages))) : 40;
          const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
          const messageList = store.getMessages(sessionKey, offset, maxMessages);
          return {
            result: {
              sessionKey: session.sessionKey,
              title: session.displayTitle,
              source: session.source,
              project: session.projectPath,
              timestamp: session.timestamp,
              summary: session.aiSummary,
              totalMessages: session.messageCount,
              messages: messageList.map((message) => ({ role: message.role, content: message.content })),
            },
            sessionKeys: [session.sessionKey],
          };
        }
        default:
          return { result: { error: `Unknown tool: ${name}` }, sessionKeys: [] };
      }
    };

    const { reply, sessionKeys } = await runAiAssistantTurn(endpoint, messages, executeTool);
    const sessions = sessionKeys
      .map((key) => store.getSession(key))
      .filter((session): session is SessionSearchResult => session !== null);
    return { reply, sessions };
  });
  ipcMain.handle("mcp:status", () => {
    try {
      return ensureSessionSearchMcpPreference();
    } catch {
      return false;
    }
  });
  ipcMain.handle("mcp:set-enabled", (_event, enabled: boolean) => {
    const setup = loadMcpSetup();
    setup.run(!enabled);
    settingsStore.set("sessionSearchMcpEnabled", enabled);
    return setup.status();
  });
  ipcMain.handle("stats:get", (_event, options?: SessionStatsOptions) => store.getStats(visibleStatsOptions(options)));
  ipcMain.handle("quota:get", () => {
    const settings = getSettings();
    return loadUsageQuotaSnapshot({
      hideCodexQuota: settings.hideCodexQuota,
      hideClaudeQuota: settings.hideClaudeQuota,
    });
  });
  ipcMain.handle("tags:list", (_event, options?: TagListOptions) =>
    store.listTags({ ...visibleProjectOptions(), ...options }),
  );
  ipcMain.handle("projects:list", (_event, options?: ProjectQueryOptions) =>
    store.listProjects({ ...visibleProjectOptions(), ...options }),
  );
  ipcMain.handle("tags:by-project", () => store.listTagsByProject(visibleProjectOptions()));
  ipcMain.handle("environments:list", () => store.listEnvironments());
  ipcMain.handle("ssh-config:list-hosts", () => readUserSshConfig());
  ipcMain.handle("environment:save", (_event, input: EnvironmentUpsertInput) =>
    ensureRemoteEnvironmentLifecycle().saveEnvironment(input),
  );
  ipcMain.handle("environment:delete", (_event, environmentId: string) =>
    ensureRemoteEnvironmentLifecycle().deleteEnvironment(environmentId),
  );
  ipcMain.handle("environment:refresh", (_event, environmentId: string) =>
    ensureRemoteEnvironmentLifecycle().refreshEnvironment(environmentId),
  );
  ipcMain.handle("environment:diagnose", (_event, environmentId: string) =>
    diagnoseRemoteEnvironment(requireSshEnvironment(environmentId)),
  );
  ipcMain.handle("title:set", (_event, sessionKey: string, title: string | null) =>
    setSessionCustomTitleAndSyncTerminal(sessionKey, title, {
      getSession: (key) => store.getSession(key),
      setCustomTitle: (key, customTitle) => store.setCustomTitle(key, customTitle),
      loadLiveSessions: () => loadCachedLiveSessionSnapshot({ includeTrae: getSettings().includeTrae }),
      setLiveTerminalTitle: (pid, displayTitle) => setLiveSessionTerminalTitle(pid, displayTitle),
      onSyncError: (error) => console.warn("[terminal-title] Could not synchronize live terminal title.", error),
    }),
  );
  ipcMain.handle("tag:add", (_event, sessionKey: string, tagName: string) => store.addTag(sessionKey, tagName));
  ipcMain.handle("tag:remove", (_event, sessionKey: string, tagName: string) => store.removeTag(sessionKey, tagName));
  ipcMain.handle("tag:delete", (_event, tagName: string) => store.deleteTag(tagName));
  ipcMain.handle("favorite:set", (_event, sessionKey: string, favorited: boolean) => store.setFavorited(sessionKey, favorited));
  ipcMain.handle("pin:set", (_event, sessionKey: string, pinned: boolean) => store.setPinned(sessionKey, pinned));
  ipcMain.handle("hide:set", (_event, sessionKey: string, hidden: boolean) => store.setHidden(sessionKey, hidden));
  ipcMain.handle("session:delete", (_event, sessionKey: string) => store.deleteSession(sessionKey));
  ipcMain.handle("index:refresh", () => runIndexSync());
  ipcMain.handle("index:status", () => indexStatus);
  ipcMain.handle("app-update:get-status", (_event, force?: boolean) => getAppUpdateStatus(Boolean(force)));
  ipcMain.handle("app-update:install", () => startAppUpdate());
  ipcMain.handle("app-update:skip", (_event, untilNextVersion?: boolean) => skipCurrentAppUpdate(Boolean(untilNextVersion)));
  ipcMain.handle("settings:get", () => getHydratedSettings());
  ipcMain.handle("codex-config:get", () => loadCodexConfigSnapshot());
  ipcMain.handle("codex-config:probe-models", (_event, input: { baseUrl?: unknown; apiKey?: unknown; providerId?: unknown }) => {
    const settings = getSettings();
    const providerId = typeof input?.providerId === "string" && input.providerId ? input.providerId : undefined;
    const savedKey = (providerId ? store.getApiProviderKey("codex", providerId) : "") || store.getApiProviderKey("codex", settings.apiConfig.customProviderId);
    return probeCodexModels({
      baseUrl: String(input?.baseUrl ?? ""),
      apiKey: String(input?.apiKey ?? "") || savedKey,
      providerId,
    });
  });
  ipcMain.handle("codex-profile:apply", (_event, apiConfig: Partial<ApiConfig>) => applyCodexApiConfigWithProxy(apiConfig));
  ipcMain.handle("claude-profile:apply", (_event, apiConfig: Partial<ClaudeApiConfig>) => applyClaudeApiConfig({ apiConfig }));
  ipcMain.handle("codex-chat-proxy:status", () => codexChatProxy?.getStatus() ?? null);
  ipcMain.handle("codex-chat-proxy:stop", async () => {
    await stopCodexChatProxy();
    return null;
  });
  ipcMain.handle("settings:set", async (_event, settings: AppSettingsUpdate) => {
    const previous = getSettings();
    const next = mergeAppSettings(previous, settings);
    if (next.globalShortcut !== previous.globalShortcut && !registerAppGlobalShortcut(next.globalShortcut)) {
      throw new Error(
        `Shortcut ${globalShortcutLabel(next.globalShortcut)} could not be registered. It may be used by another app.`,
      );
    }
    if ("remoteSyncEnabled" in settings && !next.remoteSyncEnabled) {
      const result = loadSessionSyncHookSetup().uninstallSessionSyncHooks();
      if (result.status === "error") throw new Error(result.detail || "Could not remove the session sync hooks.");
      clearSessionSyncQueue();
      sessionSyncHookLastError = null;
    }
    persistApiProviderKeysFromUpdate(settings, next);
    settingsStore.set(withoutApiProviderKeys(next));
    if ("autoCheckUpdates" in settings && releaseUpdateRuntime) {
      await loadUpdateClient().writeUpdatePreference(next.autoCheckUpdates);
      if (next.autoCheckUpdates) void refreshAppUpdateStatus(false);
    }
    pruneDisabledOptionalSources(next);
    return withStoredApiProviderKeys(next);
  });
  ipcMain.handle("api-provider-key:get", (_event, target: unknown, providerId: string) =>
    store.getApiProviderKey(normalizeApiProviderKeyTarget(target), providerId),
  );
  ipcMain.handle("skills:list", () => buildSkillsSnapshot());
  ipcMain.handle("skills:refresh-usage", () => refreshSkillUsageIndex());
  ipcMain.handle("skills:sync-snapshot", () => buildSkillSyncSnapshot());
  ipcMain.handle("skills:sync-upload", (_event, skillPath: string, force?: boolean) => uploadLocalSkillToSupabase(skillPath, force ?? false));
  ipcMain.handle("skills:sync-install", (_event, remoteSkillId: string) => installRemoteSkillFromSupabase(remoteSkillId));
  ipcMain.handle("skills:sync-download-many", (_event, fingerprints: unknown) =>
    downloadRemoteSkillGroups(Array.isArray(fingerprints) ? fingerprints.filter((value): value is string => typeof value === "string") : []),
  );
  ipcMain.handle("skills:sync-delete-many", (_event, fingerprints: unknown) =>
    deleteRemoteSkillGroups(Array.isArray(fingerprints) ? fingerprints.filter((value): value is string => typeof value === "string") : []),
  );
  ipcMain.handle("skills:sync-get-version", (_event, remoteSkillId: string) => getRemoteSkillVersionDetail(remoteSkillId));
  ipcMain.handle("skills:sync-diff", (_event, localSkillPath: unknown, remoteSkillId: unknown) =>
    getSyncedSkillDiff(
      typeof localSkillPath === "string" ? localSkillPath : null,
      typeof remoteSkillId === "string" ? remoteSkillId : null,
    ),
  );
  ipcMain.handle("skills:sync-copy-setup-sql", () => {
    clipboard.writeText(buildSkillSyncSetupSql());
  });
  ipcMain.handle("supabase:copy-combined-setup-sql", () => {
    clipboard.writeText(buildCombinedSupabaseSetupSql());
  });
  ipcMain.handle("supabase:open-sql-editor", (_event, target: unknown) => {
    const settings = getSettings();
    const projectUrl = target === "skills" ? settings.skillSyncSupabaseUrl : settings.remoteSyncSupabaseUrl;
    return shell.openExternal(supabaseSqlEditorUrl(projectUrl));
  });
  ipcMain.handle("remote-session:status", () => getRemoteSessionStatus());
  ipcMain.handle("remote-session:copy-setup-sql", () => {
    clipboard.writeText(buildRemoteSessionSetupSql());
  });
  ipcMain.handle("remote-session:hook-status", () => getSessionSyncHookStatus());
  ipcMain.handle("remote-session:install-hooks", () => {
    const settings = getSettings();
    if (!settings.remoteSyncEnabled || !settings.remoteSyncSupabaseUrl || !settings.remoteSyncSupabaseAnonKey) {
      throw new Error("Enable remote session sync and configure Supabase before installing hooks.");
    }
    const result = loadSessionSyncHookSetup().installSessionSyncHooks();
    if (result.status === "error") throw new Error(result.detail || "Could not configure the session sync hooks.");
    void drainSessionSyncQueue();
    return getSessionSyncHookStatus();
  });
  ipcMain.handle("remote-session:uninstall-hooks", () => {
    const result = loadSessionSyncHookSetup().uninstallSessionSyncHooks();
    if (result.status === "error") throw new Error(result.detail || "Could not remove the session sync hooks.");
    clearSessionSyncQueue();
    sessionSyncHookLastError = null;
    return getSessionSyncHookStatus();
  });
  ipcMain.handle("remote-session:upload", (_event, sessionKey: string, force?: boolean) => uploadSessionToRemote(sessionKey, force ?? false));
  ipcMain.handle("remote-session:list", (_event, query?: string) => listRemoteSessions(query ?? ""));
  ipcMain.handle("remote-session:sync-items", () => listSessionSyncItems());
  ipcMain.handle("remote-session:detail", (_event, remoteId: string) => getRemoteSessionDetail(remoteId));
  ipcMain.handle("remote-session:choose-project", () => chooseLocalProjectDirectory());
  ipcMain.handle("remote-session:restore", (event, remoteId: string, target: MigrationAgent, localProjectPath: string) =>
    restoreRemoteSession(event, remoteId, target, localProjectPath),
  );
  ipcMain.handle("remote-session:restore-to-source-environment", (event, remoteId: string, target: MigrationAgent) =>
    restoreRemoteSessionToSourceEnvironment(event, remoteId, target),
  );
  ipcMain.handle("remote-session:delete", async (_event, remoteId: string) => {
    const result = await deleteRemoteSessionCopies([remoteId]);
    return result.deletedIds.includes(remoteId);
  });
  ipcMain.handle("remote-session:delete-many", (_event, remoteIds: unknown) =>
    deleteRemoteSessionCopies(
      Array.isArray(remoteIds) ? remoteIds.filter((id): id is string => typeof id === "string") : [],
    ),
  );
  ipcMain.handle("skills:copy-path", (_event, skillPath: string) => {
    clipboard.writeText(skillPath);
  });
  ipcMain.handle("skills:reveal", async (_event, targetPath: string) => {
    await revealInFileManager(targetPath);
  });
  ipcMain.handle("skills:delete", (_event, skillPath: string) => deleteInstalledSkill(skillPath, { projectDirs: skillProjectDirsFromIndexedProjects(store.listProjects()) }));
  ipcMain.handle("skills:usage-hook-status", () => {
    try {
      return loadSkillUsageHookSetup().skillUsageHookStatus().installed;
    } catch {
      return false;
    }
  });
  ipcMain.handle("skills:install-usage-hook", () => {
    const result = loadSkillUsageHookSetup().installSkillUsageHook();
    if (result.status === "error") throw new Error(result.detail || "Could not configure the skill usage hook.");
    return result.status;
  });
  ipcMain.handle("skills:uninstall-usage-hook", () => {
    const result = loadSkillUsageHookSetup().uninstallSkillUsageHook();
    if (result.status === "error") throw new Error(result.detail || "Could not remove the skill usage hook.");
    return result.status;
  });
  ipcMain.handle("command:copy-resume", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(getResumeCommand(session, getSettings(), { sshArgs: requireSshArgsForRemoteSession(session) }));
  });
  ipcMain.handle("command:resume", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return { route: "resume" as const };
    const sshArgs = requireSshArgsForRemoteSession(session);
    if (!isLocalSessionEnvironment(session)) {
      await ensureRemoteResumePreflight(session);
      await openResumeInTerminal(session, getSettings(), { sshArgs });
      store.markResumed(sessionKey);
      return { route: "resume" as const };
    }
    const snapshot = await loadCachedLiveSessionSnapshot({ includeTrae: getSettings().includeTrae });
    const route = snapshot.error ? { route: "resume" as const } : routeResumeSession(session, snapshot.sessions);
    if (route.route === "focus") {
      await focusLiveSessionTerminal(route.pid);
      store.markResumed(sessionKey);
      return route;
    }
    await openResumeInTerminal(session, getSettings(), { sshArgs });
    store.markResumed(sessionKey);
    return route;
  });
  ipcMain.handle("command:resume-iterm", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    const sshArgs = requireSshArgsForRemoteSession(session);
    await ensureRemoteResumePreflight(session);
    await openResumeInSpecificTerminal(session, getSettings(), "iTerm", { sshArgs });
    store.markResumed(sessionKey);
  });
  ipcMain.handle("session:migrate", async (event, sessionKey: string, target: unknown) => {
    const session = store.getSession(sessionKey);
    if (!session) throw new Error("Session not found.");
    const messages = store.getAllMessages(sessionKey);
    const settings = Object.freeze(await getHydratedSettings());

    return runLocalSessionMigration({
      source: session,
      messages,
      target,
      settings,
    }, localSessionMigrationRuntime(event));
  });
  ipcMain.handle("command:open-app", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return false;
    if (!isLocalSessionEnvironment(session)) return false;
    await openNativeApp(session.source);
    return true;
  });
  ipcMain.handle("command:reveal", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return false;
    if (!isLocalSessionEnvironment(session)) return false;
    await revealInFileManager(session.projectPath || session.filePath);
    return true;
  });
  ipcMain.handle("command:copy-markdown", async (_event, sessionKey: string) => {
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(formatSessionMarkdown(session, store.getAllMessages(sessionKey), store.getTraceEvents(sessionKey)));
  });
  ipcMain.handle("command:export-markdown", async (_event, sessionKey: string) => {
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    const session = store.getSession(sessionKey);
    if (!session) return false;
    const exportPath = await chooseMarkdownExportPath(markdownExportFileName(session.displayTitle || session.originalTitle || session.rawId));
    if (!exportPath) return false;
    await fs.writeFile(exportPath, formatSessionMarkdown(session, store.getAllMessages(sessionKey), store.getTraceEvents(sessionKey)), "utf-8");
    return true;
  });
  ipcMain.handle("command:copy-plain", async (_event, sessionKey: string) => {
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(formatSessionPlainText(session, store.getAllMessages(sessionKey), store.getTraceEvents(sessionKey)));
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // second-instance can fire before whenReady resolves; defer to avoid
    // creating a BrowserWindow before Electron is fully initialized.
    app.whenReady().then(() => showWindow());
  });
}

app.whenReady().then(() => {
  if (releaseUpdateRuntime) {
    void loadUpdateClient().writeAppProcess(process.pid).catch((error) => console.error(`Failed to write app process state: ${String(error)}`));
    void loadUpdateClient().writeUpdatePreference(getSettings().autoCheckUpdates).catch((error) => console.error(`Failed to write update preference: ${String(error)}`));
  }
  const dbPath = path.join(app.getPath("userData"), "session-search.sqlite");
  store = new SessionStore(dbPath);
  // Publish the live database path so the standalone MCP server can find it.
  try {
    writeDbPointer(dbPath);
  } catch {
    // Non-fatal: the MCP server can still be pointed at the DB via env var.
  }
  try {
    ensureSessionSearchMcpPreference();
  } catch (error) {
    console.error(`Failed to configure session search MCP: ${error instanceof Error ? error.message : String(error)}`);
  }
  migrateLegacyApiProviderKeys();
  pruneDisabledOptionalSources(getSettings());
  registerIpc();
  createApplicationMenu();
  createWindow();
  createTray();
  if (releaseUpdateRuntime) void showPreviousUpdateResult();
  const shortcut = getSettings().globalShortcut;
  if (!registerAppGlobalShortcut(shortcut)) {
    console.error(`Global shortcut ${globalShortcutLabel(shortcut)} could not be registered.`);
  }
  ensureRemoteEnvironmentLifecycle().startEnabledEnvironments();
  void restoreCodexChatProxyFromSettings();
  setTimeout(() => void runIndexSync(), INITIAL_INDEX_DELAY_MS);
  startAutoIndexRefresh();
  startAutoSkillUsageRefresh();
  startAutoSessionSyncQueue();
  if (releaseUpdateRuntime && getSettings().autoCheckUpdates) setTimeout(() => void refreshAppUpdateStatus(false), 1_000);
});

app.on("window-all-closed", () => {
  // Keep the menu bar app alive; users can quit from the tray/menu.
});

app.on("activate", () => {
  showWindow();
});

app.on("before-quit", () => {
  if (releaseUpdateRuntime) void loadUpdateClient().clearAppProcess(process.pid).catch(() => undefined);
  stopAutoIndexRefresh();
  stopAutoSkillUsageRefresh();
  stopAutoSessionSyncQueue();
  remoteEnvironmentLifecycle?.stopAll();
  void stopCodexChatProxy();
  globalShortcut.unregisterAll();
  store?.close();
});
