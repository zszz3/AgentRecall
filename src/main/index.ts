import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import Store from "electron-store";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
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
import { applyCodexApiConfig, loadCodexProfileDefaults } from "../core/codex-profile";
import { indexMigratedSessionFile, syncDefaultSessionsInBatches, type IndexStatus } from "../core/indexer";
import { formatSessionMarkdown, formatSessionPlainText } from "../core/format-session";
import {
  defaultSettings,
  getMigrationResumeProcessSpec,
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
import { focusLiveSessionTerminal } from "../core/session-focus";
import { loadLiveSessionSnapshot } from "../core/session-activity";
import { type TrackedLiveSession, updateLiveTracker } from "../core/live-transitions";
import { resolveSummaryEndpoint, summarizeSession, type SummaryEndpoint } from "../core/session-summarizer";
import {
  isLocalCliEndpoint,
  runAiAssistantFallback,
  runAiAssistantTurn,
  type AiChatMessage,
  type FallbackSessionHit,
  type ToolExecutionResult,
} from "../core/ai-assistant";
import { applyMigrationLengthPolicy, createMigrationCompressor } from "../core/session-migration-compression";
import { migrateSession } from "../core/session-migration";
import { writeMigratedSession } from "../core/session-migration-writers";
import { writeDbPointer } from "../core/app-paths";
import { routeResumeSession } from "../core/resume-router";
import { diagnoseRemoteEnvironment, preflightRemoteSessionResume } from "../core/remote-health";
import { fetchRemoteSessionFilePayload, fetchRemoteSessionMessagePage, syncRemoteEnvironment } from "../core/remote-sync";
import { loadRemoteSessionDetailPayload } from "../core/remote-session-loader";
import { RemoteEnvironmentLifecycle } from "../core/remote-environment-lifecycle";
import { RemoteWatchManager } from "../core/remote-watch";
import { SessionStore, type TraceEventQueryOptions } from "../core/session-store";
import {
  deleteInstalledSkill,
  installRemoteSkillLocally,
  listInstalledSkills,
  skillProjectDirsFromIndexedProjects,
  type InstalledSkill,
  type InstalledSkillsSnapshot,
} from "../core/skill-manager";
import {
  buildSkillSyncSetupSql,
  SupabaseSkillSyncClient,
  type SkillSyncInstallResult,
  type SkillSyncSnapshot,
  type SkillSyncUploadResult,
} from "../core/skill-sync";
import {
  listSkillUsageSources,
  readSkillUsageSourceEvents,
  usageForSkill,
  type SkillUsageRefreshStatus,
} from "../core/skill-usage";
import { buildSshArgs, readUserSshConfig } from "../core/ssh-config";
import {
  AUTO_INDEX_REFRESH_INTERVAL_MS,
  AUTO_SKILL_USAGE_REFRESH_INTERVAL_MS,
  INITIAL_INDEX_DELAY_MS,
  INITIAL_SKILL_USAGE_REFRESH_DELAY_MS,
} from "../core/refresh-policy";
import { globalShortcutLabel, normalizeGlobalShortcut } from "../core/shortcuts";
import type { AppSettings, AppSettingsUpdate } from "../core/platform";
import type {
  EnvironmentUpsertInput,
  MigrationAgent,
  SearchOptions,
  SessionEnvironment,
  SessionSearchResult,
  SessionSource,
  SessionStatsOptions,
} from "../core/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_NAME = "Agent-Session-Search";
const TRAY_ICON_RELATIVE_PATH = path.join("assets", "tray-iconTemplate.png");
type ApiProviderKeyTarget = "codex" | "claude" | "summary";

const OPTIONAL_SOURCE_SETTINGS: Array<{ key: keyof Pick<AppSettings, "includeClaudeInternal" | "includeCodexInternal" | "includeCodeBuddyCli" | "includeOpenClaw" | "includeHermes" | "includeOpenCode" | "includeCursorAgent" | "includeTrae">; sources: SessionSource[] }> = [
  { key: "includeClaudeInternal", sources: ["claude-internal"] },
  { key: "includeCodexInternal", sources: ["codex-internal"] },
  { key: "includeCodeBuddyCli", sources: ["codebuddy-cli"] },
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

const MCP_SETUP_PATH = path.join(__dirname, "../../bin/setup-mcp.cjs");
interface McpSetup {
  run(remove: boolean): string[];
  status(): boolean;
}
function loadMcpSetup(): McpSetup {
  return requireCjs(MCP_SETUP_PATH) as McpSetup;
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
        message: "Configure Supabase URL and anon key in Settings to sync skills.",
      },
      remoteSkills: [],
      bindings: store.listSkillSyncBindings(),
      scannedAt: Date.now(),
    };
  }

  const client = createSkillSyncClient();
  const status = await client.checkStatus();
  const remoteSkills = status.kind === "ready" ? await client.listRemoteSkills() : [];
  return {
    status,
    remoteSkills,
    bindings: store.listSkillSyncBindings(),
    scannedAt: Date.now(),
  };
}

async function uploadLocalSkillToSupabase(skillPath: string): Promise<SkillSyncUploadResult> {
  const skill = findInstalledSkillByPath(skillPath);
  const client = createSkillSyncClient();
  const existing = store.getSkillSyncBindingForLocalPath(skill.path);
  const remoteSkill = existing
    ? await client.updateRemoteSkill(existing.remoteSkillId, skill)
    : await client.upsertLocalSkill(skill);
  const binding = {
    localSkillPath: skill.path,
    remoteSkillId: remoteSkill.id,
    remoteUpdatedAt: remoteSkill.updatedAt,
    lastSyncedAt: Date.now(),
    direction: "upload" as const,
  };
  store.upsertSkillSyncBinding(binding);
  return { remoteSkill, binding };
}

async function installRemoteSkillFromSupabase(remoteSkillId: string): Promise<SkillSyncInstallResult> {
  const client = createSkillSyncClient();
  const remoteSkill = await client.getRemoteSkill(remoteSkillId);
  const installed = installRemoteSkillLocally(remoteSkill);
  const binding = {
    localSkillPath: installed.installedPath,
    remoteSkillId: remoteSkill.id,
    remoteUpdatedAt: remoteSkill.updatedAt,
    lastSyncedAt: Date.now(),
    direction: "download" as const,
  };
  store.upsertSkillSyncBinding(binding);
  return {
    remoteSkill,
    binding,
    installedPath: installed.installedPath,
    overwritten: installed.overwritten,
  };
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
let liveNotifyTimer: ReturnType<typeof setInterval> | null = null;
let liveTracker = new Map<string, TrackedLiveSession>();
let registeredGlobalShortcut: string | null = null;
let remoteWatchManager: RemoteWatchManager | null = null;
let remoteEnvironmentLifecycle: RemoteEnvironmentLifecycle | null = null;
let codexChatProxy: CodexChatProxy | null = null;
let codexChatProxySignature: string | null = null;
const remoteDetailLoads = new Map<string, Promise<void>>();

const settingsStore = new Store<AppSettings>({
  defaults: defaultSettings,
});

function getSettings(): AppSettings {
  const settings = mergeAppSettings(defaultSettings, settingsStore.store);
  return {
    ...settings,
    globalShortcut: normalizeGlobalShortcut(settings.globalShortcut),
    defaultTerminal: normalizeTerminal(settings.defaultTerminal),
  };
}

function pruneDisabledOptionalSources(settings: AppSettings): void {
  const disabledSources = OPTIONAL_SOURCE_SETTINGS.flatMap((item) => (settings[item.key] ? [] : item.sources));
  store.deleteSessionsBySource(disabledSources);
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

function isLocalSession(session: SessionSearchResult): boolean {
  return session.environmentKind === "local" || session.environmentId === "local";
}

function sshArgsForSession(session: SessionSearchResult): string[] | undefined {
  if (isLocalSession(session)) return undefined;
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
  if (!isLocalSession(session) && !sshArgs) {
    throw new Error("SSH environment is not available for this remote session.");
  }
  return sshArgs;
}

function requireRemoteSshEnvironment(session: SessionSearchResult): SessionEnvironment | null {
  if (isLocalSession(session)) return null;
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
  if (!session || isLocalSession(session)) return;
  if (hasHydratedRemoteDetails(sessionKey)) return;

  const active = remoteDetailLoads.get(sessionKey);
  if (active) return active;

  const load = (async () => {
    const latest = store.getSession(sessionKey);
    if (!latest || isLocalSession(latest)) return;
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

function getPreferredWindowBounds(): { width: number; height: number; x: number; y: number } {
  const defaultWidth = 1280;
  const defaultHeight = 820;
  const cursorPoint = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursorPoint);
  const width = Math.min(defaultWidth, workArea.width);
  const height = Math.min(defaultHeight, workArea.height);

  return {
    width,
    height,
    x: Math.round(workArea.x + Math.max(0, workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height - height) / 2),
  };
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, "../preload/index.mjs");
  const initialBounds = getPreferredWindowBounds();
  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 860,
    minHeight: 560,
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
  mainWindow.setBounds(getPreferredWindowBounds(), false);
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
      syncEnvironment: (environment) => syncRemoteEnvironment(store, environment).then(() => undefined),
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
      includeCodeBuddyCli: settings.includeCodeBuddyCli,
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

const LIVE_NOTIFY_INTERVAL_MS = 10_000;

const LIVE_FAMILY_LABEL: Record<TrackedLiveSession["family"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  codebuddy: "CodeBuddy",
  trae: "Trae",
};

async function pollLiveSessionsForNotifications(): Promise<void> {
  const settings = getSettings();
  if (!settings.notifyOnSessionComplete) {
    // Reset so re-enabling does not retroactively report sessions that ended while off.
    if (liveTracker.size > 0) liveTracker = new Map();
    return;
  }

  let sessions;
  try {
    const snapshot = await loadLiveSessionSnapshot({ includeTrae: settings.includeTrae });
    if (snapshot.error) return;
    sessions = snapshot.sessions;
  } catch {
    return;
  }

  const { tracker, completed } = updateLiveTracker(liveTracker, sessions, Date.now());
  liveTracker = tracker;
  if (completed.length === 0) return;

  const minDurationMs = settings.notifyMinDurationSeconds * 1000;
  for (const session of completed) {
    if (session.durationMs < minDurationMs) continue;
    const familyLabel = LIVE_FAMILY_LABEL[session.family] ?? session.family;
    const resolved = store?.findByRawId(session.rawId) ?? null;
    const descriptor = resolved?.displayTitle || resolved?.firstQuestion || resolved?.projectPath || "";
    const minutes = Math.max(1, Math.round(session.durationMs / 60_000));
    showDesktopNotification(`${familyLabel} session finished`, descriptor ? truncateNotificationBody(descriptor) : `Ran for ~${minutes} min`);
  }
}

// The app runs as the unsigned Electron binary, so macOS denies UNUserNotification
// (the native Notification fails silently). osascript shows a banner without
// per-app authorization; other platforms use the native API.
function showDesktopNotification(title: string, body: string): void {
  if (process.platform === "darwin") {
    const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    execFile("osascript", ["-e", `display notification "${escape(body)}" with title "${escape(title)}"`], () => {
      // Ignore failures (e.g. notifications disabled for the script runner).
    });
    return;
  }
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.on("click", () => showWindow());
    notification.show();
  }
}

function truncateNotificationBody(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

function startLiveNotifyPolling(): void {
  if (liveNotifyTimer) return;
  liveNotifyTimer = setInterval(() => {
    void pollLiveSessionsForNotifications();
  }, LIVE_NOTIFY_INTERVAL_MS);
}

function stopLiveNotifyPolling(): void {
  if (!liveNotifyTimer) return;
  clearInterval(liveNotifyTimer);
  liveNotifyTimer = null;
  liveTracker = new Map();
}

let summaryBackfillRunning = false;

const SUMMARY_PROVIDER_ERROR =
  "AI summary has no usable provider. Select Codex, Claude Code, or configure a direct summary API provider in Settings.";

function buildCodexExecEndpoint(settings: AppSettings): SummaryEndpoint {
  return {
    baseUrl: "",
    model: "codex",
    apiKey: "",
    apiFormat: "codex_exec",
    command: settings.codexBinary,
    cwd: process.cwd(),
    onTemporarySession: (sessionKey) => {
      try {
        store.deleteSession(sessionKey);
      } catch {
        // Best-effort cleanup if an ephemeral Codex call is indexed before it exits.
      }
    },
  };
}

async function resolveSummaryEndpointFromSettings(): Promise<SummaryEndpoint | null> {
  const settings = await getHydratedSettings();
  if (settings.summarySource === "custom") {
    return resolveSummaryEndpoint([settings.summaryApiConfig]);
  }
  if (settings.summarySource === "claude") {
    return {
      baseUrl: "",
      model: "claude",
      apiKey: "",
      apiFormat: "claude_exec",
      command: settings.claudeBinary,
      cwd: process.cwd(),
      onTemporarySession: (sessionKey) => {
        try {
          store.deleteSession(sessionKey);
        } catch {
          // Best-effort cleanup if a Claude summary session is indexed before it exits.
        }
      },
    };
  }
  return {
    baseUrl: "",
    model: "codex",
    apiKey: "",
    apiFormat: "codex_exec",
    command: settings.codexBinary,
    cwd: process.cwd(),
    onTemporarySession: (sessionKey) => {
      try {
        store.deleteSession(sessionKey);
      } catch {
        // Best-effort cleanup if an ephemeral Codex call is indexed before it exits.
      }
    },
  };
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

function migrationResumeDisplayCommand(target: MigrationAgent, sessionId: string, projectPath: string): string {
  return getMigrationResumeProcessSpec(target, sessionId, projectPath, getSettings()).displayCommand;
}

function quotePosixToken(value: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function fallbackMigrationResumeDisplayCommand(target: MigrationAgent, sessionId: string, projectPath: string): string {
  const settings = getSettings();
  const binary =
    target === "claude" ? settings.claudeBinary : target === "codex" ? settings.codexBinary : settings.codeBuddyBinary;
  const args = target === "codex" ? ["resume", sessionId] : ["--resume", sessionId];
  return `cd ${quotePosixToken(projectPath)} && ${[binary, ...args].map(quotePosixToken).join(" ")}`;
}

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
  ipcMain.handle("search:sessions", (_event, options: SearchOptions) => store.searchSessions(options));
  ipcMain.handle("search:session-page", (_event, options: SearchOptions) => store.searchSessionPage(options));
  ipcMain.handle("session:get", (_event, sessionKey: string) => {
    store.markOpened(sessionKey);
    return store.getSession(sessionKey);
  });
  ipcMain.handle("session:messages", async (_event, sessionKey: string, offset?: number, limit?: number) => {
    const pageOffset = offset ?? 0;
    const pageLimit = limit ?? 120;
    const session = store.getSession(sessionKey);
    if (session && !isLocalSession(session) && !hasHydratedRemoteDetails(sessionKey)) {
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
    if (session && !isLocalSession(session) && !hasHydratedRemoteDetails(sessionKey)) return [];
    await ensureRemoteSessionDetailsLoaded(sessionKey);
    return store.getTraceEvents(sessionKey, options);
  });
  ipcMain.handle("sessions:live", () => loadLiveSessionSnapshot({ includeTrae: getSettings().includeTrae }));
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
        const sessions = store.searchSessions({ query, limit: 12 });
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
          const sessions = store.searchSessions({
            query,
            source: source as SearchOptions["source"],
            projectPath,
            limit,
          });
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
          const projects = store.listProjects();
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
  ipcMain.handle("stats:get", (_event, options?: SessionStatsOptions) => store.getStats(options));
  ipcMain.handle("quota:get", () => {
    const settings = getSettings();
    return loadUsageQuotaSnapshot({
      hideCodexQuota: settings.hideCodexQuota,
      hideClaudeQuota: settings.hideClaudeQuota,
    });
  });
  ipcMain.handle("tags:list", () => store.listTags());
  ipcMain.handle("projects:list", () => store.listProjects());
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
  ipcMain.handle("title:set", (_event, sessionKey: string, title: string | null) => store.setCustomTitle(sessionKey, title));
  ipcMain.handle("tag:add", (_event, sessionKey: string, tagName: string) => store.addTag(sessionKey, tagName));
  ipcMain.handle("tag:remove", (_event, sessionKey: string, tagName: string) => store.removeTag(sessionKey, tagName));
  ipcMain.handle("tag:delete", (_event, tagName: string) => store.deleteTag(tagName));
  ipcMain.handle("favorite:set", (_event, sessionKey: string, favorited: boolean) => store.setFavorited(sessionKey, favorited));
  ipcMain.handle("pin:set", (_event, sessionKey: string, pinned: boolean) => store.setPinned(sessionKey, pinned));
  ipcMain.handle("hide:set", (_event, sessionKey: string, hidden: boolean) => store.setHidden(sessionKey, hidden));
  ipcMain.handle("session:delete", (_event, sessionKey: string) => store.deleteSession(sessionKey));
  ipcMain.handle("index:refresh", () => runIndexSync());
  ipcMain.handle("index:status", () => indexStatus);
  ipcMain.handle("settings:get", () => getHydratedSettings());
  ipcMain.handle("codex-profile:apply", (_event, apiConfig: Partial<ApiConfig>) => applyCodexApiConfigWithProxy(apiConfig));
  ipcMain.handle("claude-profile:apply", (_event, apiConfig: Partial<ClaudeApiConfig>) => applyClaudeApiConfig({ apiConfig }));
  ipcMain.handle("codex-chat-proxy:status", () => codexChatProxy?.getStatus() ?? null);
  ipcMain.handle("codex-chat-proxy:stop", async () => {
    await stopCodexChatProxy();
    return null;
  });
  ipcMain.handle("settings:set", (_event, settings: AppSettingsUpdate) => {
    const previous = getSettings();
    const next = mergeAppSettings(previous, settings);
    if (next.globalShortcut !== previous.globalShortcut && !registerAppGlobalShortcut(next.globalShortcut)) {
      throw new Error(
        `Shortcut ${globalShortcutLabel(next.globalShortcut)} could not be registered. It may be used by another app.`,
      );
    }
    persistApiProviderKeysFromUpdate(settings, next);
    settingsStore.set(withoutApiProviderKeys(next));
    pruneDisabledOptionalSources(next);
    return withStoredApiProviderKeys(next);
  });
  ipcMain.handle("api-provider-key:get", (_event, target: unknown, providerId: string) =>
    store.getApiProviderKey(normalizeApiProviderKeyTarget(target), providerId),
  );
  ipcMain.handle("skills:list", () => buildSkillsSnapshot());
  ipcMain.handle("skills:refresh-usage", () => refreshSkillUsageIndex());
  ipcMain.handle("skills:sync-snapshot", () => buildSkillSyncSnapshot());
  ipcMain.handle("skills:sync-upload", (_event, skillPath: string) => uploadLocalSkillToSupabase(skillPath));
  ipcMain.handle("skills:sync-install", (_event, remoteSkillId: string) => installRemoteSkillFromSupabase(remoteSkillId));
  ipcMain.handle("skills:sync-copy-setup-sql", () => {
    clipboard.writeText(buildSkillSyncSetupSql());
  });
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
    if (!isLocalSession(session)) {
      await ensureRemoteResumePreflight(session);
      await openResumeInTerminal(session, getSettings(), { sshArgs });
      store.markResumed(sessionKey);
      return { route: "resume" as const };
    }
    const snapshot = await loadLiveSessionSnapshot({ includeTrae: getSettings().includeTrae });
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
  ipcMain.handle("session:migrate", async (event, sessionKey: string, target: MigrationAgent) => {
    const session = store.getSession(sessionKey);
    if (!session) throw new Error("Session not found.");

    const endpoint = await resolveSummaryEndpointFromSettings();
    const compressor = endpoint ? createMigrationCompressor(endpoint) : null;
    const result = await migrateSession({
      source: session,
      messages: store.getAllMessages(sessionKey),
      target,
      deps: {
        inspectCli: (migrationTarget) => inspectMigrationCli(migrationTarget, getSettings()),
        prepare: (portable) => applyMigrationLengthPolicy(portable, compressor),
        write: (migrationTarget, portable) => writeMigratedSession({ target: migrationTarget, session: portable }),
        record: (record) => store.recordSessionMigration(record),
        refreshIndex: async (migrationTarget, writtenFilePath) => {
          const status = indexMigratedSessionFile(store, migrationTarget, writtenFilePath);
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
    return result;
  });
  ipcMain.handle("command:open-app", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return false;
    if (!isLocalSession(session)) return false;
    await openNativeApp(session.source);
    return true;
  });
  ipcMain.handle("command:reveal", async (_event, sessionKey: string) => {
    const session = store.getSession(sessionKey);
    if (!session) return false;
    if (!isLocalSession(session)) return false;
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

app.whenReady().then(() => {
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
  const shortcut = getSettings().globalShortcut;
  if (!registerAppGlobalShortcut(shortcut)) {
    console.error(`Global shortcut ${globalShortcutLabel(shortcut)} could not be registered.`);
  }
  ensureRemoteEnvironmentLifecycle().startEnabledEnvironments();
  void restoreCodexChatProxyFromSettings();
  setTimeout(() => void runIndexSync(), INITIAL_INDEX_DELAY_MS);
  startAutoIndexRefresh();
  startAutoSkillUsageRefresh();
  startLiveNotifyPolling();
});

app.on("window-all-closed", () => {
  // Keep the menu bar app alive; users can quit from the tray/menu.
});

app.on("activate", () => {
  showWindow();
});

app.on("before-quit", () => {
  stopAutoIndexRefresh();
  stopAutoSkillUsageRefresh();
  stopLiveNotifyPolling();
  remoteEnvironmentLifecycle?.stopAll();
  void stopCodexChatProxy();
  globalShortcut.unregisterAll();
  store?.close();
});
