import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { loadActiveCodexSummaryEndpointDefaults } from "../core/codex-profile";
import { mergeCodexDesktopProjects, readCodexDesktopProjects } from "../core/codex-projects";
import type { CodexRequestFidelity } from "../core/codex-request-export";
import { indexMigratedSessionFile, syncDefaultSessionsInBatches, type IndexStatus } from "../core/indexer";
import { createIndexRunCoordinator } from "../core/index-run-coordinator";
import { createIndexProgressPublisher } from "./index-progress";
import { createSessionIndexFailureLogger } from "./session-index-failure-log";
import { LocalLiveSessionService } from "./services/local-live-session-service";
import { createStartupTaskScheduler } from "./startup-tasks";
import { createInterfaceZoomController } from "./interface-zoom";
import {
  type SessionJsonExportFormat,
} from "../core/format-session";
import { normalizeExternalLink } from "../core/external-link";
import {
  defaultSettings,
  getMigrationResumeProcessSpec,
  getSafeMigrationResumeCommand,
  inspectMigrationCli,
  mergeAppSettings,
  normalizeTerminal,
  getResumeCommand,
  openResumeInTerminal,
  openMigrationResumeInTerminal,
  revealInFileManager,
} from "../core/platform";
import { DEEPSEEK_WEB_URL, openDeepSeekWebSessionPage } from "./deepseek-web-session";
import { loadUsageQuotaSnapshot } from "../core/quota";
import { repairLegacyAgentRecallCodexRollouts } from "../core/codex-migration-repair";
import { setLiveSessionTerminalTitle } from "../core/session-focus";
import { setSessionCustomTitleAndSyncTerminal } from "../core/session-title-sync";
import { createCachedLiveSessionSnapshotLoader } from "../core/session-activity";
import { loadRemoteLiveSessions } from "../core/remote-session-activity";
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
import { collectMigrationDescendants, migrateSession, portableSessionFrom, sshMigrationTarget } from "../core/session-migration";
import {
  loadLocalSessionMigrationSource,
  runLocalSessionMigration,
} from "./local-session-migration";
import {
  targetFilePathForRemoteEnvironment,
  writeMigratedSession,
} from "../core/session-migration-writers";
import { assertMigrationTargetEnabled, migrationTargetDescriptor } from "../core/migration-targets";
import {
  writeDatabaseUrlPointer,
  writeOpenVikingManifestPointer,
  writeSkillLibraryPointer,
} from "../core/app-paths";
import { PostgresDatabase } from "../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../core/postgres/schema";
import { diagnoseRemoteEnvironment } from "../core/remote-health";
import {
  buildRemoteSyncSshArgs,
  fetchRemoteSessionFilePayload,
  fetchRemoteSessionMessagePage,
  syncRemoteEnvironment,
} from "../core/remote-sync";
import { REMOTE_PROCESS_EXEC_OPTIONS, runRemoteCommand, runRemoteCommandWithInput } from "../core/remote-process";
import { loadWslSessionDetailPayload } from "../core/remote-session-loader";
import { restoreRemotePortableSession, type RemoteSessionRestoreDependencies } from "../core/remote-session-restore";
import { RemoteEnvironmentLifecycle } from "../core/remote-environment-lifecycle";
import { RemoteWatchManager } from "../core/remote-watch";
import { WslSessionIndexer } from "../core/wsl-session-indexer";
import { SessionStore } from "../core/session-store";
import { buildCombinedSupabaseSetupSql, supabaseSqlEditorUrl } from "../core/supabase-setup";
import { readUserSshConfig } from "../core/ssh-config";
import { listWslDistributions } from "../core/wsl";
import {
  AUTO_INDEX_REFRESH_INTERVAL_MS,
  INITIAL_INDEX_DELAY_MS,
  INITIAL_OPENVIKING_RUNTIME_DELAY_MS,
  INITIAL_PROVIDER_RESTORE_DELAY_MS,
  INITIAL_SESSION_SYNC_QUEUE_START_DELAY_MS,
} from "../core/refresh-policy";
import { globalShortcutLabel, normalizeGlobalShortcut } from "../core/shortcuts";
import { remoteSessionKey } from "../core/session-environment";
import {
  OPTIONAL_SESSION_SOURCE_DESCRIPTORS,
  sessionSourcesForOptionalSetting,
} from "../core/session-sources";
import type { AppSettings, AppSettingsUpdate } from "../core/platform";
import { APP_UPDATE_EVENTS } from "../shared/ipc/app-update";
import { QUOTA_EVENTS } from "../shared/ipc/quota";
import type { OpenVikingRuntimeInstallProgress } from "../core/openviking-memory";
import { registerOpenVikingMemoryIpc } from "./ipc/openviking-memory";
import { registerAutomationIpc } from "./ipc/automation";
import { registerTeamChatIpc } from "./ipc/team-chat";
import { registerAppUpdateIpc } from "./ipc/app-update";
import { registerQuotaIpc } from "./ipc/quota";
import { registerProvidersIpc } from "./ipc/providers";
import { resolveOpenVikingExtractionConfig } from "./services/openviking-extraction-config";
import {
  openVikingExtractionSettingsChanged,
  restartOpenVikingForExtractionSettings,
} from "./services/openviking-settings-lifecycle";
import { registerRemoteSessionsIpc } from "./ipc/remote-sessions";
import { registerMemoriesIpc, type MemoriesIpcService } from "./ipc/memories";
import { registerDiscoveryIpc, type DiscoveryIpcService } from "./ipc/discovery";
import { registerRulesIpc, type RulesIpcService } from "./ipc/rules";
import { registerSkillsIpc } from "./ipc/skills";
import { registerSessionCatalogIpc } from "./ipc/session-catalog";
import { registerSessionCommandIpc } from "./ipc/session-commands";
import {
  AppUpdateService,
  InstalledRuntimeMonitor,
  launchDetachedAppUpdateInstaller,
  type AppUpdateClient,
} from "./services/app-update-service";
import { AutoStartingOpenVikingClient } from "./services/openviking-auto-client";
import {
  OPENVIKING_RUNTIME_VERSION,
  resolveOpenVikingRuntimeManifest,
} from "./services/openviking-artifact-resolver";
import { resolveOpenVikingRuntimeArchitecture } from "./services/openviking-runtime-architecture";
import { OpenVikingGateway } from "./services/openviking-client";
import { OpenVikingControlService } from "./services/openviking-control-service";
import { OpenVikingHookManifestService } from "./services/openviking-hook-manifest";
import { OpenVikingHookStateFlusher } from "./services/openviking-hook-state-flusher";
import { SshCommandService } from "./services/ssh-command-service";
import { SshCredentialService } from "./services/ssh-credential-service";
import {
  OpenVikingMemoryService,
  OpenVikingWorkspaceCredentialStore,
} from "./services/openviking-memory-service";
import { ensureOpenVikingMemoryTemplates } from "./services/openviking-memory-templates";
import {
  BUILTIN_OPENVIKING_MODEL_MANIFEST,
  OpenVikingLocalModelManager,
} from "./services/openviking-model-manager";
import {
  OpenVikingRuntimeService,
  type OpenVikingRuntimeManifest,
} from "./services/openviking-runtime-service";
import { NativeAutomationService } from "./services/automation-service";
import {
  BuiltinSessionSearchServer,
  BuiltinSkillMcpServer,
} from "../automation/engine/main/mcp-builtin-server";
import type { McpBuiltinRuntime } from "../automation/engine/main/mcp-builtin-server";
import { createLocalTextFilePreviewUnderRoots } from "../automation/engine/main/platform/local-file-preview";
import { ProviderService } from "./services/provider-service";
import {
  codexAuthPath,
  createQuotaCache,
  QuotaService,
  readCodexAuthIdentity,
  watchQuotaAuthFile,
} from "./services/quota-service";
import {
  RemoteSessionService,
  type SessionSyncHookSetup,
} from "./services/remote-session-service";
import { buildMemoriesSyncSetupSql, memoryIdentity, scanLocalMemories, SupabaseMemoriesSyncClient } from "../core/memories-sync";
import { buildRulesSyncSetupSql, restoreRules, ruleIdentity, scanLocalRules, SupabaseRulesSyncClient } from "../core/rules-sync";
import { SkillService, type SkillUsageHookSetup } from "./services/skill-service";
import { SessionCatalogService } from "./services/session-catalog-service";
import { SessionCommandService } from "./services/session-command-service";
import { RemoteSessionAccess } from "./services/remote-session-access";
import { V1SessionImportService } from "./services/v1-session-import-service";
import { bootstrapApplicationPaths } from "./app-path-bootstrap";
import { startPostgresRuntime, type PostgresRuntime } from "./postgres/managed-postgres";
import { WORKFLOW_PORTABLE_MAX_BYTES } from "../automation/engine/main/hub/workflow/workflow-portable-file";
import { writeWorkflowExportFileAtomically } from "./services/workflow-portable-filesystem";
import type {
  EnvironmentUpsertInput,
  MigrationAgent,
  MigrationTarget,
  PortableSession,
  ProjectQueryOptions,
  ProjectSummary,
  SearchOptions,
  SessionEnvironment,
  SessionMigrationProgress,
  SessionMigrationRequest,
  SessionSearchResult,
  SessionSource,
  SessionStatsOptions,
} from "../core/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_NAME = "agent-recall-v2";
const TRAY_ICON_RELATIVE_PATH = path.join("assets", "tray-iconTemplate.png");
const APP_ICON_RELATIVE_PATH = path.join("assets", "app-icon.png");
const releaseUpdateRuntime = process.env.AGENT_RECALL_RELEASE_BUILD === "1";
const openVikingRuntimeArch = resolveOpenVikingRuntimeArchitecture();

const OPTIONAL_SOURCE_SETTINGS = OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map((descriptor) => ({
  key: descriptor.optionalSetting,
  sources: sessionSourcesForOptionalSetting(descriptor.optionalSetting),
}));

// The skill-usage hook installer is a self-contained CommonJS script in bin/
// (sibling of out/), shared with the global-install path. Load it lazily via a
// runtime require so the bundler leaves it as an external dependency, and the
// hook command it writes points back at bin/skill-usage-record.cjs.
const requireCjs = createRequire(import.meta.url);
const SKILL_USAGE_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-skill-usage-hook.cjs");
function loadSkillUsageHookSetup(): SkillUsageHookSetup {
  return requireCjs(SKILL_USAGE_HOOK_SETUP_PATH) as SkillUsageHookSetup;
}

const SESSION_SYNC_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-session-sync-hook.cjs");
function loadSessionSyncHookSetup(): SessionSyncHookSetup {
  return requireCjs(SESSION_SYNC_HOOK_SETUP_PATH) as SessionSyncHookSetup;
}

interface OpenVikingMemoryHookSetup {
  reconcileOpenVikingMemoryHooks(options: {
    homeDir: string;
    hookScriptPath: string;
    openCodePluginPath: string;
    manifestPath: string;
    nodePath: string;
    platform: NodeJS.Platform;
    integrations: { claude: boolean; codex: boolean; opencode: boolean };
  }): { status: "configured" | "error"; detail?: string };
}

const OPENVIKING_MEMORY_HOOK_SETUP_PATH = path.join(__dirname, "../../bin/setup-openviking-memory-hooks.cjs");
const OPENVIKING_MEMORY_HOOK_SCRIPT_PATH = path.join(__dirname, "../../bin/openviking-memory-hook.cjs");
const OPENVIKING_OPENCODE_PLUGIN_PATH = path.join(__dirname, "../../bin/openviking-opencode-plugin.mjs");
const OPENVIKING_RUNTIME_BUILD_SCRIPT_PATH = path.join(__dirname, "../../scripts/build-openviking-runtime.mjs");

const DEVELOPMENT_PYTHON_RUNTIMES: Readonly<Record<string, { url: string; sha256: string }>> = {
  "darwin-arm64": {
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.12.13%2B20260510-aarch64-apple-darwin-install_only_stripped.tar.gz",
    sha256: "55bc1a5edbc8ac4da0081f4f5731ed2d1ed10c57cb37a820b2a0dbc7cad742e9",
  },
  "darwin-x64": {
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.12.13%2B20260510-x86_64-apple-darwin-install_only_stripped.tar.gz",
    sha256: "6bab7fa97d4f2ddba86da0e05acff66c53b5edaca1df8edcf00ddca785a9c59b",
  },
  "win32-x64": {
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.12.13%2B20260510-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
    sha256: "24168aff2e7d93784c6a436124c4ebb79b076a4e289bde4902c08333507b71d0",
  },
};

interface DevelopmentRuntimeArtifactRecord {
  version?: unknown;
  platform?: unknown;
  arch?: unknown;
  sha256?: unknown;
  archiveType?: unknown;
  executablePath?: unknown;
  file?: unknown;
}

let developmentOpenVikingRuntimeBuild: Promise<OpenVikingRuntimeManifest | null> | null = null;
function loadOpenVikingMemoryHookSetup(): OpenVikingMemoryHookSetup {
  return requireCjs(OPENVIKING_MEMORY_HOOK_SETUP_PATH) as OpenVikingMemoryHookSetup;
}

const MCP_SETUP_PATH = path.join(__dirname, "../../bin/setup-mcp.cjs");
interface McpSetup {
  run(remove: boolean): string[];
  status(): boolean;
  serverDefinition(): { id: string; name: string; command: string; args: string[]; transport: string; env: Record<string, string>; createdAt: number; updatedAt: number };
}
function loadMcpSetup(): McpSetup {
  return requireCjs(MCP_SETUP_PATH) as McpSetup;
}

const UPDATE_CLIENT_PATH = path.join(__dirname, "../../bin/update-client.cjs");
const APPLY_UPDATE_PATH = path.join(__dirname, "../../bin/apply-update.cjs");
const APP_ENTRY_PATH = fileURLToPath(import.meta.url);
const NPM_LAUNCHER_PATH = path.join(__dirname, "../../bin/agent-recall.cjs");
function loadUpdateClient(): AppUpdateClient {
  return requireCjs(UPDATE_CLIENT_PATH) as AppUpdateClient;
}

function ensureAgentRecallMcpPreference(): boolean {
  const setup = loadMcpSetup();
  if (getSettings().sessionSearchMcpEnabled) {
    if (!setup.status()) setup.run(false);
  }
  return setup.status();
}

if (process.env.AGENT_RECALL_USE_MOCK_KEYCHAIN === "1") {
  app.commandLine.appendSwitch("use-mock-keychain");
}
app.setName(PRODUCT_NAME);
app.setAppUserModelId("dev.zszz3.agent-recall-v2");
bootstrapApplicationPaths({
  app,
  productName: PRODUCT_NAME,
  legacyProductNames: [],
});

let mainWindow: BrowserWindow | null = null;
let automationService: NativeAutomationService | null = null;
let disposeAutomationIpc: (() => void) | null = null;
let disposeTeamChatIpc: (() => void) | null = null;
let disposeOpenVikingMemoryIpc: (() => void) | null = null;
let openVikingRuntimeService: OpenVikingRuntimeService | null = null;
let openVikingControlService: OpenVikingControlService | null = null;
let openVikingHookManifestService: OpenVikingHookManifestService | null = null;
let openVikingHookStateFlusher: OpenVikingHookStateFlusher | null = null;
let automationQuitReady = false;
let automationQuitStarted = false;
const startupTasks = createStartupTaskScheduler(() => automationQuitStarted);
let postgresRuntime: PostgresRuntime | null = null;
let postgresRuntimeStartup: Promise<PostgresRuntime> | null = null;
let postgresDatabase: PostgresDatabase | null = null;
let quickSearchWindow: BrowserWindow | null = null;
let deepSeekWebWindow: BrowserWindow | null = null;
const interfaceZoomController = createInterfaceZoomController(() => [mainWindow, quickSearchWindow]);
let tray: Tray | null = null;
let store: SessionStore;
let indexStatus: IndexStatus = { running: false, indexed: 0, skipped: 0, total: 0, lastIndexedAt: null, error: null };
const indexRunCoordinator = createIndexRunCoordinator<IndexStatus>({
  afterRun: () => pruneDisabledOptionalSources(getSettings()),
});
const indexProgressPublisher = createIndexProgressPublisher(
  (status) => mainWindow?.webContents.send("index-status", status),
  { minIntervalMs: 200 },
);
let autoIndexTimer: ReturnType<typeof setInterval> | null = null;
let registeredGlobalShortcut: string | null = null;
let remoteWatchManager: RemoteWatchManager | null = null;
let remoteEnvironmentLifecycle: RemoteEnvironmentLifecycle | null = null;
let wslSessionIndexer: WslSessionIndexer | null = null;
let quotaService: QuotaService;

const settingsStore = new Store<AppSettings>({
  defaults: defaultSettings,
});

// Runtime state (discovered tools, per-tool toggles, last test result) for the
// built-in session-search MCP server. Kept apart from AppSettings so internal
// MCP state never leaks into the user-facing settings shape.
const mcpRuntimeStore = new Store<McpBuiltinRuntime>({
  name: "mcp-runtime",
  defaults: { tools: [], disabledTools: [], status: "untested", createdAt: 0, updatedAt: 0 },
});

const skillMcpRuntimeStore = new Store<McpBuiltinRuntime>({
  name: "skill-mcp-runtime",
  defaults: { tools: [], disabledTools: [], status: "untested", createdAt: 0, updatedAt: 0 },
});

// Same runtime cache for the built-in workflow MCP server.
const workflowMcpRuntimeStore = new Store<McpBuiltinRuntime>({
  name: "workflow-mcp-runtime",
  defaults: { tools: [], disabledTools: [], status: "untested", createdAt: 0, updatedAt: 0 },
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

const sshCredentialStore = new Store<{ passwords: Record<string, string> }>({
  name: "ssh-credentials",
  defaults: { passwords: {} },
});
const sshCredentialService = new SshCredentialService(sshCredentialStore, safeStorage);
const sshCommandService = new SshCommandService({
  getPassword: (environmentId) => sshCredentialService.getPassword(environmentId),
});

function runSshSessionCommand(environment: SessionEnvironment, remoteCommand: string): Promise<string> {
  return sshCommandService.run(environment, remoteCommand);
}

function runSshHealthCommand(environment: SessionEnvironment, remoteCommand: string): Promise<string> {
  return sshCommandService.run(environment, remoteCommand, {
    maxBuffer: 512 * 1024,
    timeout: 20_000,
  });
}

function getSettings(): AppSettings {
  const settings = mergeAppSettings(defaultSettings, settingsStore.store);
  return {
    ...settings,
    globalShortcut: normalizeGlobalShortcut(settings.globalShortcut),
    defaultTerminal: normalizeTerminal(settings.defaultTerminal),
  };
}

async function applySettingsUpdate(settings: AppSettingsUpdate): Promise<AppSettings> {
  const previous = getSettings();
  const next = mergeAppSettings(previous, settings);
  const openVikingSettingsChanged = [
    "openVikingMemoryEnabled",
    "openVikingClaudeEnabled",
    "openVikingCodexEnabled",
    "openVikingOpenCodeEnabled",
    "openVikingRecallTokenBudget",
  ].some((key) => key in settings);
  const openVikingExtractionChanged = openVikingExtractionSettingsChanged(settings);
  if (next.globalShortcut !== previous.globalShortcut && !registerAppGlobalShortcut(next.globalShortcut)) {
    throw new Error(
      `Shortcut ${globalShortcutLabel(next.globalShortcut)} could not be registered. It may be used by another app.`,
    );
  }
  if ("remoteSyncEnabled" in settings && !next.remoteSyncEnabled) {
    remoteSessionService.disableSync();
  }
  if ("evalEnabled" in settings && next.evalEnabled && !previous.evalEnabled) {
    try {
      if (skillService.getUsageHookStatus()) {
        skillService.uninstallUsageHook();
        skillService.installUsageHook();
      }
    } catch (error) {
      console.error(`Failed to refresh the skill usage hook for Eval: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await providerService.persistKeysFromUpdate(settings, next);
  settingsStore.set(providerService.removeStoredKeys(next));
  if (openVikingSettingsChanged) {
    reconcileOpenVikingMemoryHooks(next);
    if (!next.openVikingMemoryEnabled) await openVikingControlService?.stopRuntime().catch((error) => {
      console.error(
        `Failed to stop OpenViking after Memory was disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    await refreshOpenVikingHookManifest();
    if (!openVikingExtractionChanged) await startConfiguredOpenVikingRuntime(next);
  }
  if (openVikingControlService && openVikingExtractionChanged) {
    const snapshot = await openVikingControlService.snapshot();
    await restartOpenVikingForExtractionSettings({
      update: settings,
      enabled: Object.values(openVikingIntegrations(next)).some(Boolean),
      runtimeState: snapshot.runtime.state,
      stop: () => openVikingControlService!.stopRuntime(),
      start: () => startConfiguredOpenVikingRuntime(next),
    });
  }
  if ("autoCheckUpdates" in settings) await appUpdateService.setAutoCheckEnabled(next.autoCheckUpdates);
  await pruneDisabledOptionalSources(next);
  if ("showInDock" in settings) applyDockVisibility(next.showInDock);
  return providerService.addStoredKeys(next);
}

function bundledAutomationWorkflowsPath(): string {
  const candidates = [
    path.join(app.getAppPath(), "assets", "automation", "bundled-workflows"),
    path.join(app.getAppPath(), "src", "automation", "engine", "shared", "bundled-workflows"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function bundledSkillsPath(): string {
  const candidates = [
    path.join(app.getAppPath(), "assets", "bundled-skills"),
    path.join(app.getAppPath(), "src", "automation", "engine", "shared", "bundled-skills"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function createAutomationService(): NativeAutomationService {
  if (!postgresDatabase) throw new Error("PostgreSQL must be ready before automation starts.");
  return new NativeAutomationService({
    database: postgresDatabase,
    userDataPath: app.getPath("userData"),
    homePath: app.getPath("home"),
    appDataPath: app.getPath("appData"),
    bundledWorkflowsPath: bundledAutomationWorkflowsPath(),
    workflowMcpServerPath: path.join(app.getAppPath(), "out", "mcp", "workflow-entry.js"),
    confirmWorkflowScriptPermissions: async ({ nodeTitle, permissions }) => {
      const result = mainWindow ? await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Allow Workflow Script",
        message: `Allow “${nodeTitle}” to use elevated permissions?`,
        detail: permissions.join(", "),
        buttons: ["Cancel", "Allow once"],
        defaultId: 0,
        cancelId: 0,
      }) : await dialog.showMessageBox({
        type: "warning",
        title: "Allow Workflow Script",
        message: `Allow “${nodeTitle}” to use elevated permissions?`,
        detail: permissions.join(", "),
        buttons: ["Cancel", "Allow once"],
        defaultId: 0,
        cancelId: 0,
      });
      return result.response === 1;
    },
    builtinSessionSearch: new BuiltinSessionSearchServer({
      isEnabled: () => ensureAgentRecallMcpPreference(),
      setEnabled: async (next) => {
        const setup = loadMcpSetup();
        setup.run(!next);
        settingsStore.set("sessionSearchMcpEnabled", next);
        return setup.status();
      },
      launchConfig: () => {
        const definition = loadMcpSetup().serverDefinition();
        return {
          id: definition.id,
          name: "AgentRecall Session Search",
          description: "检索已索引的 Agent 会话、查看上下文，并准备可恢复的迁移。",
          command: definition.command,
          args: definition.args,
        };
      },
      readRuntime: () => mcpRuntimeStore.store,
      writeRuntime: (runtime) => {
        mcpRuntimeStore.store = runtime;
      },
    }),
    builtinSkills: new BuiltinSkillMcpServer({
      isEnabled: () => getSettings().skillMcpEnabled,
      setEnabled: async (next) => {
        settingsStore.set("skillMcpEnabled", next);
        return next;
      },
      launchConfig: () => ({
        id: "agent-recall-skills",
        name: "AgentRecall Skills",
        description: "列出 AgentRecall 已管理的 Skill，并按需读取完整说明。",
        command: "node",
        args: [path.join(app.getAppPath(), "bin", "agent-recall-skill-mcp.mjs")],
      }),
      readRuntime: () => skillMcpRuntimeStore.store,
      writeRuntime: (runtime) => {
        skillMcpRuntimeStore.store = runtime;
      },
    }),
    workflowMcp: {
      isEnabled: () => getSettings().workflowMcpEnabled,
      setEnabled: async (next) => {
        settingsStore.set("workflowMcpEnabled", next);
        return next;
      },
      readRuntime: () => workflowMcpRuntimeStore.store,
      writeRuntime: (runtime) => {
        workflowMcpRuntimeStore.store = runtime;
      },
    },
    chooseWorkflowImportFile: chooseWorkflowImportFile,
    chooseWorkflowExportPath: chooseWorkflowExportPath,
    writeWorkflowExportFile: writeWorkflowExportFileAtomically,
  });
}

async function chooseWorkflowImportFile(): Promise<{ fileName: string; content: string } | undefined> {
  const options: Electron.OpenDialogOptions = {
    title: "Import workflow",
    properties: ["openFile"],
    filters: [{ name: "AgentRecall Workflow", extensions: ["agentrecall-workflow.json"] }],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  const filePath = result.canceled ? undefined : result.filePaths[0];
  if (!filePath) return undefined;
  if (!filePath.toLowerCase().endsWith(".agentrecall-workflow.json")) throw new Error("WORKFLOW_IMPORT_FORMAT_UNSUPPORTED: Choose an .agentrecall-workflow.json file.");
  const stat = await fs.stat(filePath);
  if (stat.size > WORKFLOW_PORTABLE_MAX_BYTES) throw new Error("WORKFLOW_IMPORT_FILE_TOO_LARGE: Workflow file exceeds the 5 MiB limit.");
  return { fileName: path.basename(filePath), content: await fs.readFile(filePath, "utf8") };
}

async function chooseWorkflowExportPath(defaultFileName: string): Promise<string | undefined> {
  const options: Electron.SaveDialogOptions = {
    title: "Export workflow",
    defaultPath: path.join(app.getPath("documents"), defaultFileName),
    filters: [{ name: "AgentRecall Workflow", extensions: ["agentrecall-workflow.json"] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return undefined;
  return result.filePath.toLowerCase().endsWith(".agentrecall-workflow.json") ? result.filePath : `${result.filePath}.agentrecall-workflow.json`;
}

async function pickAutomationDirectory(defaultPath?: string): Promise<string | undefined> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose workflow directory",
    defaultPath: defaultPath || app.getPath("home"),
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

function createQuotaService(): QuotaService {
  const authFile = codexAuthPath(process.env, homedir());
  const cache = createQuotaCache(path.join(app.getPath("userData"), "quota-cache.json"));
  return new QuotaService({
    load: (settings) => loadUsageQuotaSnapshot(settings),
    getSettings: () => {
      const settings = getSettings();
      return {
        hideCodexQuota: settings.hideCodexQuota,
        hideClaudeQuota: settings.hideClaudeQuota,
      };
    },
    authPath: () => authFile,
    identity: readCodexAuthIdentity,
    ...cache,
    publish: (snapshot) => mainWindow?.webContents.send(QUOTA_EVENTS.updated, snapshot),
    delay: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now: () => Date.now(),
    watch: watchQuotaAuthFile,
  });
}
const appUpdateService = new AppUpdateService({
  getClient: loadUpdateClient,
  releaseRuntime: releaseUpdateRuntime,
  getAutoCheckEnabled: () => getSettings().autoCheckUpdates,
  autoCheckDisabled: () => process.env.AGENT_RECALL_NO_UPDATE_CHECK === "1",
  publishStatus: (status) => mainWindow?.webContents.send(APP_UPDATE_EVENTS.status, status),
  publishProgress: (progress) => mainWindow?.webContents.send(APP_UPDATE_EVENTS.progress, progress),
  stageInstaller: (manifest, onProgress) => loadUpdateClient().stageUpdate(manifest, {
    nodePath: process.env.AGENT_RECALL_NODE_PATH,
    onProgress,
  }),
  launchInstaller: (staged) => launchDetachedAppUpdateInstaller(staged, { applyUpdatePath: APPLY_UPDATE_PATH }),
  requestQuit: () => app.quit(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  showMessageBox: (options) => mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options),
  copyText: (text) => clipboard.writeText(text),
  openExternal: (url) => shell.openExternal(url),
  processId: process.pid,
  logError: (message) => console.error(message),
});
const installedRuntimeMonitor = releaseUpdateRuntime && process.env.AGENT_RECALL_NODE_PATH
  ? new InstalledRuntimeMonitor({
      appEntryPath: APP_ENTRY_PATH,
      electronPath: process.execPath,
      launcherPath: NPM_LAUNCHER_PATH,
      nodePath: process.env.AGENT_RECALL_NODE_PATH,
      requestQuit: () => app.quit(),
      logError: (message) => console.error(message),
    })
  : null;

const providerService = new ProviderService({
  getSettings,
  keys: {
    get: (target, providerId) => store.getApiProviderKey(target, providerId),
    set: (target, providerId, apiKey) => store.setApiProviderKey(target, providerId, apiKey),
  },
  settings: {
    has: (settingPath) => settingsStore.has(settingPath as never),
    get: (settingPath) => settingsStore.get(settingPath as never),
    set: (settingPath, value) => settingsStore.set(settingPath as never, value as never),
  },
  logError: (message) => console.error(message),
});

const skillLibraryRoot = path.join(app.getPath("userData"), "skills");

const skillService = new SkillService({
  getStore: () => store,
  getSettings,
  getHookSetup: loadSkillUsageHookSetup,
  getEvaluationService: () => {
    if (!automationService) throw new Error("Runtime is not ready.");
    return automationService.evaluations;
  },
  libraryRoot: skillLibraryRoot,
  skillsShCachePath: path.join(app.getPath("userData"), "cache", "skills-sh.json"),
  homeDir: app.getPath("home"),
  codexHome: process.env.CODEX_HOME,
  executeAiSearch: async (runtimeChannelId, prompt) => {
    if (!automationService) throw new Error("Runtime is not ready.");
    return automationService.runOneShotOnRuntime(runtimeChannelId, prompt);
  },
  copyText: (text) => clipboard.writeText(text),
  revealPath: (targetPath) => revealInFileManager(targetPath),
  now: () => Date.now(),
  logError: (message) => console.error(message),
});

try {
  skillService.ensureBuiltinSkills(bundledSkillsPath());
} catch (error) {
  console.error(`Failed to seed built-in Skills: ${error instanceof Error ? error.message : String(error)}`);
}

const remoteSessionAccess = new RemoteSessionAccess({
  getStore: () => store,
  runSshCommand: runSshSessionCommand,
  runSshHealthCommand,
});

const remoteSessionService = new RemoteSessionService({
  getStore: () => store,
  getSettings,
  getHookSetup: loadSessionSyncHookSetup,
  ensureSessionDetails: (sessionKey) => remoteSessionAccess.ensureDetails(sessionKey),
  runIndexSync,
  chooseLocalProject: chooseLocalProjectDirectory,
  createLocalRestoreDependencies: createLocalRemoteRestoreDependencies,
  createSourceRestoreDependencies: createSourceRemoteRestoreDependencies,
  copyText: (text) => clipboard.writeText(text),
  now: () => Date.now(),
  logError: (message) => console.error(message),
});

function visibleSearchOptions(options: SearchOptions = {}): SearchOptions {
  return { ...options, excludeSubagents: true };
}

function createRulesSyncService(): RulesIpcService {
  const projectDirs = async () =>
    (await listVisibleProjects(visibleProjectOptions())).map((project) => project.path);
  const createClient = () => {
    const settings = getSettings();
    return new SupabaseRulesSyncClient({ url: settings.skillSyncSupabaseUrl, anonKey: settings.skillSyncSupabaseAnonKey });
  };
  return {
    async getSyncSnapshot() {
      const settings = getSettings();
      const localRules = scanLocalRules({ projectDirs: await projectDirs() });
      if (!settings.rulesSyncEnabled || !settings.skillSyncSupabaseUrl || !settings.skillSyncSupabaseAnonKey) {
        return { status: { kind: "unconfigured" as const, setupSql: buildRulesSyncSetupSql() }, localRules, remoteRules: [], scannedAt: Date.now() };
      }
      const client = createClient();
      const status = await client.checkStatus();
      const remoteRules = status.kind === "ready" ? await client.listRemoteRules() : [];
      return { status, localRules, remoteRules, scannedAt: Date.now() };
    },
    async upload(identity) {
      const localRules = scanLocalRules({ projectDirs: await projectDirs() });
      const rule = localRules.find((r) => ruleIdentity(r) === identity);
      if (!rule) throw new Error("Rule not found locally.");
      return createClient().uploadRule(rule);
    },
    async uploadAll() {
      const localRules = scanLocalRules({ projectDirs: await projectDirs() });
      const client = createClient();
      const remoteRules = await client.listRemoteRules();
      let uploaded = 0;
      let skipped = 0;
      for (const rule of localRules) {
        const remote = remoteRules.find((r) => r.agent === rule.agent && r.scope === rule.scope && r.name === rule.name && r.project_path === rule.projectPath);
        if (remote && remote.content_hash === rule.contentHash) {
          skipped++;
          continue;
        }
        await client.uploadRule(rule);
        uploaded++;
      }
      return { uploaded, skipped };
    },
    async deleteRemote(remoteId) {
      return createClient().deleteRule(remoteId);
    },
    copySetupSql() {
      clipboard.writeText(buildRulesSyncSetupSql());
    },
    async restore() {
      const client = createClient();
      const remoteRules = await client.listRemoteRules();
      return restoreRules(remoteRules, { projectDirs: await projectDirs() });
    },
  };
}

function createMemoriesSyncService(): MemoriesIpcService {
  const createClient = () => {
    const settings = getSettings();
    return new SupabaseMemoriesSyncClient({ url: settings.skillSyncSupabaseUrl, anonKey: settings.skillSyncSupabaseAnonKey });
  };
  return {
    async getSyncSnapshot() {
      const settings = getSettings();
      const localMemories = scanLocalMemories();
      if (!settings.memoriesSyncEnabled || !settings.skillSyncSupabaseUrl || !settings.skillSyncSupabaseAnonKey) {
        return { status: { kind: "unconfigured" as const, setupSql: buildMemoriesSyncSetupSql() }, localMemories, remoteMemories: [], scannedAt: Date.now() };
      }
      const client = createClient();
      const status = await client.checkStatus();
      const remoteMemories = status.kind === "ready" ? await client.listRemoteMemories() : [];
      return { status, localMemories, remoteMemories, scannedAt: Date.now() };
    },
    async upload(identity) {
      const localMemories = scanLocalMemories();
      const memory = localMemories.find((m) => memoryIdentity(m) === identity);
      if (!memory) throw new Error("Memory not found locally.");
      return createClient().uploadMemory(memory);
    },
    async uploadAll() {
      const localMemories = scanLocalMemories();
      const client = createClient();
      const remoteMemories = await client.listRemoteMemories();
      let uploaded = 0;
      let skipped = 0;
      for (const memory of localMemories) {
        const remote = remoteMemories.find((r) => r.agent === memory.agent && r.scope === memory.scope && r.name === memory.name && r.project_path === memory.projectPath);
        if (remote && remote.content_hash === memory.contentHash) {
          skipped++;
          continue;
        }
        await client.uploadMemory(memory);
        uploaded++;
      }
      return { uploaded, skipped };
    },
    async deleteRemote(remoteId) {
      return createClient().deleteMemory(remoteId);
    },
    copySetupSql() {
      clipboard.writeText(buildMemoriesSyncSetupSql());
    },
  };
}

function createDiscoveryService(): DiscoveryIpcService {
  return {
    listSavedSearches: () => store.listSavedSearches(),
    createSavedSearch: (name, options) => store.createSavedSearch(name, options),
    deleteSavedSearch: (id) => store.deleteSavedSearch(id),
    touchSavedSearch: (id) => store.touchSavedSearch(id),
    listRecentSearches: (limit) => store.listRecentSearches(limit),
    searchHistory: (query, limit) => store.searchHistory(query, limit),
    clearSearchHistory: () => store.clearSearchHistory(),
    recordSearch: (query, resultCount, options) => store.recordSearch(query, resultCount, options),
    getSessionFamily: (sessionKey) => store.getSessionFamily(sessionKey),
  };
}

function visibleStatsOptions(options: SessionStatsOptions = {}): SessionStatsOptions {
  return { ...options, excludeSubagents: true };
}

function visibleProjectOptions(): { excludeSubagents: boolean } {
  return { excludeSubagents: true };
}

function codexDesktopHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(app.getPath("home"), ".codex");
}

async function listVisibleProjects(options: ProjectQueryOptions = {}): Promise<ProjectSummary[]> {
  const indexed = await store.listProjects(options);
  if (options.environmentId && options.environmentId !== "all" && options.environmentId !== "local") return indexed;
  return mergeCodexDesktopProjects(indexed, await readCodexDesktopProjects(codexDesktopHome()));
}

async function pruneDisabledOptionalSources(settings: AppSettings): Promise<void> {
  const disabledSources = OPTIONAL_SOURCE_SETTINGS.flatMap((item) => (settings[item.key] ? [] : item.sources));
  await store.deleteSessionsBySource(disabledSources);
}

function enabledRemoteOptionalSources(settings: AppSettings): SessionSource[] {
  return OPTIONAL_SESSION_SOURCE_DESCRIPTORS
    .filter((descriptor) => descriptor.remoteCollectorOptional && settings[descriptor.optionalSetting])
    .map((descriptor) => descriptor.id);
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

async function chooseJsonExportFormat(): Promise<SessionJsonExportFormat | null> {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: "Export JSON",
    message: "Choose an API request format",
    detail: "Codex exports use an exact captured request when available, otherwise a reconstructed request. Other sessions use normalized messages.",
    buttons: ["OpenAI Chat Completions", "OpenAI Responses", "Anthropic Messages", "Cancel"],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  };
  const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  return (["openai_chat", "openai_responses", "anthropic"] as const)[result.response] ?? null;
}

async function chooseJsonExportPath(defaultFileName: string): Promise<string | null> {
  const options = {
    title: "Export JSON",
    defaultPath: path.join(app.getPath("documents"), defaultFileName),
    filters: [{ name: "JSON", extensions: ["json"] }],
  };
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  return path.extname(result.filePath) ? result.filePath : `${result.filePath}.json`;
}

async function showJsonExportNotice(
  exportPath: string,
  fidelity: CodexRequestFidelity,
): Promise<void> {
  const fidelityMessage = fidelity === "exact-trace"
    ? "Exact Codex request body captured from CODEX_ROLLOUT_TRACE_ROOT."
    : fidelity === "reconstructed"
      ? "Request body reconstructed from the Codex rollout history."
      : "Request body exported in normalized message format.";
  const fidelityMessageZh = fidelity === "exact-trace"
    ? "已从 CODEX_ROLLOUT_TRACE_ROOT 导出 Codex 原始请求体。"
    : fidelity === "reconstructed"
      ? "已根据 Codex rollout 历史重建请求体。"
      : "已按标准消息格式导出请求体。";
  const notice: Electron.MessageBoxOptions = {
    type: "info",
    title: "JSON Export Complete",
    message: fidelityMessage,
    detail: `${fidelityMessageZh}\n\n${exportPath}`,
    buttons: ["OK"],
    noLink: true,
  };
  if (mainWindow) await dialog.showMessageBox(mainWindow, notice);
  else await dialog.showMessageBox(notice);
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

async function chooseProviderConfigDirectory(
  target: "codex" | "claude" | "summary",
  defaultPath?: string,
): Promise<string | null> {
  const label = target === "claude" ? "Claude Code" : target === "summary" ? "summary Provider" : "Codex";
  const options: Electron.OpenDialogOptions = {
    title: `Choose ${label} config directory`,
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath?.trim() ? { defaultPath: defaultPath.trim() } : {}),
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

async function chooseOpenVikingMemoryDirectory(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a directory for managed memory",
    properties: ["openDirectory"],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

function buildDevelopmentOpenVikingRuntime(
  rootDir: string,
  onProgress: (progress: OpenVikingRuntimeInstallProgress) => void,
): Promise<OpenVikingRuntimeManifest | null> {
  if (!developmentOpenVikingRuntimeBuild) {
    developmentOpenVikingRuntimeBuild = buildDevelopmentOpenVikingRuntimeArtifact(rootDir, onProgress)
      .catch((error) => {
        developmentOpenVikingRuntimeBuild = null;
        throw error;
      });
  }
  return developmentOpenVikingRuntimeBuild;
}

async function buildDevelopmentOpenVikingRuntimeArtifact(
  rootDir: string,
  onProgress: (progress: OpenVikingRuntimeInstallProgress) => void,
): Promise<OpenVikingRuntimeManifest | null> {
  const pythonRuntime = DEVELOPMENT_PYTHON_RUNTIMES[`${process.platform}-${openVikingRuntimeArch}`];
  if (!pythonRuntime) return null;

  const buildRoot = path.join(rootDir, "development-runtime-build");
  const buildHome = path.join(buildRoot, "home");
  const outputDir = path.join(buildRoot, "artifacts");
  const artifactName = `openviking-runtime-${OPENVIKING_RUNTIME_VERSION}-${process.platform}-${openVikingRuntimeArch}.tar.gz`;
  const archivePath = path.join(outputDir, artifactName);
  const manifestPath = `${archivePath}.json`;
  await fs.mkdir(buildHome, { recursive: true, mode: 0o700 });
  await fs.mkdir(outputDir, { recursive: true });

  try {
    await Promise.all([fs.access(archivePath), fs.access(manifestPath)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, [
        OPENVIKING_RUNTIME_BUILD_SCRIPT_PATH,
        "--version",
        OPENVIKING_RUNTIME_VERSION,
        "--platform",
        process.platform,
        "--arch",
        openVikingRuntimeArch,
        "--build-home",
        buildHome,
        "--output-dir",
        outputDir,
        "--python-url",
        pythonRuntime.url,
        "--python-sha256",
        pythonRuntime.sha256,
      ], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      }, (buildError, _stdout, stderr) => {
        if (!buildError) {
          resolve();
          return;
        }
        const detail = stderr.trim();
        reject(new Error(
          detail
            ? `Could not build the OpenViking development runtime: ${detail}`
            : "Could not build the OpenViking development runtime.",
          { cause: buildError },
        ));
      });
      let bufferedOutput = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        bufferedOutput += chunk;
        const lines = bufferedOutput.split(/\r?\n/u);
        bufferedOutput = lines.pop() ?? "";
        for (const line of lines) reportDevelopmentRuntimeBuildProgress(line, onProgress);
      });
    });
  }

  onProgress({ phase: "verifying-runtime" });
  const record = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as DevelopmentRuntimeArtifactRecord;
  if (
    record.version !== OPENVIKING_RUNTIME_VERSION
    || record.platform !== process.platform
    || record.arch !== openVikingRuntimeArch
    || record.file !== artifactName
    || record.archiveType !== "tar.gz"
    || typeof record.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.sha256)
    || typeof record.executablePath !== "string"
  ) {
    throw new Error("The locally built OpenViking runtime manifest is invalid.");
  }
  return {
    version: OPENVIKING_RUNTIME_VERSION,
    platform: process.platform,
    arch: openVikingRuntimeArch,
    url: pathToFileURL(archivePath).href,
    sha256: record.sha256,
    executablePath: record.executablePath,
    archiveType: "tar.gz",
  };
}

function reportDevelopmentRuntimeBuildProgress(
  line: string,
  onProgress: (progress: OpenVikingRuntimeInstallProgress) => void,
): void {
  try {
    const message = JSON.parse(line) as {
      type?: unknown;
      progress?: {
        phase?: unknown;
        downloadedBytes?: unknown;
        totalBytes?: unknown;
        bytesPerSecond?: unknown;
      };
    };
    const progress = message.progress;
    if (
      message.type !== "progress"
      || !progress
      || ![
        "downloading-python",
        "building-runtime",
        "packaging-runtime",
      ].includes(String(progress.phase))
    ) {
      return;
    }
    onProgress({
      phase: progress.phase as OpenVikingRuntimeInstallProgress["phase"],
      ...(typeof progress.downloadedBytes === "number"
        ? { downloadedBytes: progress.downloadedBytes }
        : {}),
      ...(typeof progress.totalBytes === "number"
        ? { totalBytes: progress.totalBytes }
        : {}),
      ...(typeof progress.bytesPerSecond === "number"
        ? { bytesPerSecond: progress.bytesPerSecond }
        : {}),
    });
  } catch {
    // pip and Python write ordinary log lines beside the structured progress records.
  }
}

function initializeOpenVikingMemory(): void {
  const rootDir = path.join(app.getPath("userData"), "openviking");
  const codexAuthBootstrapPath = codexAuthPath(process.env, app.getPath("home"));
  const codexHome = path.dirname(codexAuthBootstrapPath);
  const runtime = new OpenVikingRuntimeService({
    rootDir,
    codexAuthBootstrapPath,
    version: OPENVIKING_RUNTIME_VERSION,
    arch: openVikingRuntimeArch,
    allowLocalRuntime: !releaseUpdateRuntime,
  });
  const model = new OpenVikingLocalModelManager({
    rootDir,
    resolveManifest: async () => BUILTIN_OPENVIKING_MODEL_MANIFEST,
  });
  let control: OpenVikingControlService;
  const client = new AutoStartingOpenVikingClient({
    ensureRunning: async () => {
      await control.startRuntime();
    },
    getConnection: () => runtime.getConnection(),
    createClient: (connection) => new OpenVikingGateway(connection),
  });
  const credentials = new OpenVikingWorkspaceCredentialStore(rootDir);
  const memory = new OpenVikingMemoryService({
    store,
    client,
    credentials,
  });
  const hookManifest = new OpenVikingHookManifestService({
    rootDir,
    credentials,
    control: store,
    realpath: fs.realpath,
  });
  const resolveExtractionState = async () => {
    const settings = await providerService.hydrateSettings();
    const codex = await providerService.getCodexConfig();
    // The bootstrap path is only the default location; extraction must read the same
    // Codex directory the user configured, or it falls back to an unauthenticated route.
    const configuredCodexHome = settings.apiConfig.customConfigDir.trim() || codexHome;
    // The Codex summary source has a directory of its own, and when it is set the summary run
    // reads that one. Extraction has to follow it or the two disagree about which route is live.
    const summaryCodexHome = settings.summaryCodexConfigDir.trim() || codexHome;
    const codexEndpoint = settings.summarySource === "codex"
      ? await loadActiveCodexSummaryEndpointDefaults(summaryCodexHome)
      : settings.summarySource === "custom" && settings.summaryApiConfigMode === "inherit_codex"
        ? await loadActiveCodexSummaryEndpointDefaults(configuredCodexHome)
        : null;
    return {
      settings,
      vlm: resolveOpenVikingExtractionConfig({ settings, codex, codexEndpoint }),
    };
  };
  openVikingRuntimeService = runtime;
  openVikingHookManifestService = hookManifest;
  openVikingHookStateFlusher = new OpenVikingHookStateFlusher({
    stateDir: hookManifest.stateDir(),
    client,
    credentials,
    control: store,
    snapshot: async () => {
      const { settings, vlm } = await resolveExtractionState();
      return {
        modelSnapshot: {
          provider: vlm.provider,
          model: vlm.model,
          reasoningEffort: vlm.reasoning_effort ?? null,
        },
        policySnapshot: {
          runtimeVersion: OPENVIKING_RUNTIME_VERSION,
          recallTokenBudget: settings.openVikingRecallTokenBudget,
          ingestion: "directory-online-turns",
          memoryTypes: [
            "profile",
            "preferences",
            "entities",
            "events",
            "cases",
            "trajectories",
            "experiences",
            "skills",
            "tools",
            "decisions",
            "open_loops",
          ],
        },
      };
    },
    onStateChanged: refreshOpenVikingHookManifest,
  });
  openVikingHookStateFlusher.start();
  control = new OpenVikingControlService({
    runtime,
    model,
    memory,
    control: store,
    getSettings,
    chooseDirectory: chooseOpenVikingMemoryDirectory,
    resolveRuntimeManifest: (onProgress) => resolveOpenVikingRuntimeManifest({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: openVikingRuntimeArch,
      releaseBaseUrl: process.env.AGENT_RECALL_OPENVIKING_RELEASE_BASE_URL,
      developmentFallback: releaseUpdateRuntime
        ? undefined
        : () => buildDevelopmentOpenVikingRuntime(rootDir, onProgress),
    }),
    serverConfig: async () => {
      const { vlm } = await resolveExtractionState();
      return {
        embedding: {
          dense: {
            provider: "local",
            model: "bge-small-zh-v1.5-f16",
            dimension: 512,
            model_path: await model.getModelPath(),
          },
        },
        vlm,
        memory: {
          custom_templates_dir: await ensureOpenVikingMemoryTemplates(rootDir),
        },
      };
    },
    onStateChanged: refreshOpenVikingHookManifest,
  });
  openVikingControlService = control;
  store.setOpenVikingControlChangedHandler(refreshOpenVikingHookManifest);
  console.info(`OpenViking ${OPENVIKING_RUNTIME_VERSION} control plane is ready.`);
}

function openVikingIntegrations(settings: AppSettings): { claude: boolean; codex: boolean; opencode: boolean } {
  return {
    claude: settings.openVikingMemoryEnabled && settings.openVikingClaudeEnabled,
    codex: settings.openVikingMemoryEnabled && settings.openVikingCodexEnabled,
    opencode: settings.openVikingMemoryEnabled && settings.openVikingOpenCodeEnabled,
  };
}

async function refreshOpenVikingHookManifest(): Promise<void> {
  if (!openVikingHookManifestService || !openVikingRuntimeService) return;
  const runtimeStatus = await openVikingRuntimeService.getStatus();
  let baseUrl: string | null = null;
  if (runtimeStatus.state === "running") {
    baseUrl = (await openVikingRuntimeService.getConnection()).baseUrl;
  }
  const manifestPath = await openVikingHookManifestService.write({
    baseUrl,
    integrations: openVikingIntegrations(getSettings()),
    workspaces: await store.listOpenVikingWorkspaces(),
    recallTokenBudget: getSettings().openVikingRecallTokenBudget,
  });
  writeOpenVikingManifestPointer(manifestPath);
}

function reconcileOpenVikingMemoryHooks(settings: AppSettings): void {
  if (!openVikingHookManifestService) return;
  const result = loadOpenVikingMemoryHookSetup().reconcileOpenVikingMemoryHooks({
    homeDir: app.getPath("home"),
    hookScriptPath: OPENVIKING_MEMORY_HOOK_SCRIPT_PATH,
    openCodePluginPath: OPENVIKING_OPENCODE_PLUGIN_PATH,
    manifestPath: openVikingHookManifestService.manifestPath(),
    nodePath: process.env.AGENT_RECALL_NODE_PATH || process.env.npm_node_execpath || "node",
    platform: process.platform,
    integrations: openVikingIntegrations(settings),
  });
  if (result.status === "error") throw new Error(result.detail || "Could not configure OpenViking memory hooks.");
}

async function startConfiguredOpenVikingRuntime(settings: AppSettings): Promise<void> {
  if (!openVikingControlService || !Object.values(openVikingIntegrations(settings)).some(Boolean)) return;
  const snapshot = await openVikingControlService.snapshot();
  const hasActiveWorkspace = snapshot.workspaces.some((workspace) => workspace.managed);
  if (!hasActiveWorkspace) return;
  if (snapshot.runtime.state === "stopped" && snapshot.model.installed) {
    await openVikingControlService.startRuntime();
  }
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

  mainWindow.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error("[renderer]", details.message, `${details.sourceId}:${details.lineNumber}`);
    else console.log("[renderer]", details.message);
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

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

function createQuickSearchWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, "../preload/index.mjs");
  const window = new BrowserWindow({
    width: 560,
    height: 430,
    minWidth: 560,
    minHeight: 430,
    maxWidth: 560,
    maxHeight: 430,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("did-finish-load", () => interfaceZoomController.applyTo(window));
  window.on("blur", () => window.hide());
  window.on("closed", () => {
    if (quickSearchWindow === window) quickSearchWindow = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(new URL("quick-search.html", process.env.ELECTRON_RENDERER_URL).toString());
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/quick-search.html"));
  }
  return window;
}

function getDeepSeekWebWindow(): BrowserWindow {
  if (deepSeekWebWindow && !deepSeekWebWindow.isDestroyed()) return deepSeekWebWindow;
  const allowedOrigin = new URL(DEEPSEEK_WEB_URL).origin;
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: "DeepSeek Harness",
    backgroundColor: "#0a0b0d",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:deepseek-harness-web",
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = normalizeExternalLink(url);
    if (externalUrl) void shell.openExternal(externalUrl);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === allowedOrigin) return;
    } catch {
      // Invalid URLs are denied below.
    }
    event.preventDefault();
    const externalUrl = normalizeExternalLink(url);
    if (externalUrl) void shell.openExternal(externalUrl);
  });
  window.on("closed", () => {
    if (deepSeekWebWindow === window) deepSeekWebWindow = null;
  });
  deepSeekWebWindow = window;
  return window;
}

async function showDeepSeekWebSession(sessionId: string): Promise<void> {
  const window = getDeepSeekWebWindow();
  window.hide();
  await openDeepSeekWebSessionPage({
    loadURL: (url) => window.loadURL(url),
    executeJavaScript: (script) => window.webContents.executeJavaScript(script),
    show: () => window.show(),
    focus: () => window.focus(),
  }, sessionId);
}

function showQuickSearch(): void {
  if (!quickSearchWindow || quickSearchWindow.isDestroyed()) {
    quickSearchWindow = createQuickSearchWindow();
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = quickSearchWindow.getBounds();
  quickSearchWindow.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - bounds.width) / 2),
    Math.round(display.workArea.y + Math.min(72, display.workArea.height * 0.08)),
  );
  quickSearchWindow.show();
  quickSearchWindow.focus();
}

function applyDockVisibility(showInDock: boolean): void {
  if (process.platform !== "darwin" || !app.dock) return;
  if (showInDock) app.dock.show();
  else app.dock.hide();
}
function toggleWindow(): void {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  showWindow({ focusSearch: true });
}

function showWindow(options: { focusSearch?: boolean } = {}): void {
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  if (options.focusSearch) mainWindow.webContents.send("focus-search");
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
      { label: `Open ${PRODUCT_NAME}`, click: () => showWindow() },
      { label: "快速搜索会话…", click: showQuickSearch },
      { label: "Refresh Now", click: () => void runIndexSync() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => showWindow());
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

function emitEnvironmentsUpdated(environments?: SessionEnvironment[]): void {
  if (environments) {
    mainWindow?.webContents.send("environments-updated", environments);
    return;
  }
  void store.listEnvironments().then((next) => {
    mainWindow?.webContents.send("environments-updated", next);
  });
}

function remoteSyncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureRemoteWatchManager(): RemoteWatchManager {
  if (!remoteWatchManager) {
    remoteWatchManager = new RemoteWatchManager({
      startWatcher: (environment, onEvent, onUnavailable) =>
        sshCommandService.watch(environment, onEvent, onUnavailable),
      syncEnvironment: (environment) => ensureRemoteEnvironmentLifecycle().syncFromWatcher(environment),
      onSyncError: (environment, error) => {
        void store.updateEnvironmentSyncState(
          environment.id,
          "error",
          { lastError: remoteSyncErrorMessage(error) },
        ).then(() => store.listEnvironments())
          .then(emitEnvironmentsUpdated)
          .catch(() => undefined);
      },
    });
  }
  return remoteWatchManager;
}

function ensureWslSessionIndexer(): WslSessionIndexer {
  if (!wslSessionIndexer) {
    wslSessionIndexer = new WslSessionIndexer({
      store,
      fetchSessionFile: (environment, session) => fetchRemoteSessionFilePayload(environment, session),
      loadSession: (environment, payload, summary) =>
        loadWslSessionDetailPayload(environment, payload, summary, { includeTraceEvents: true }),
      onComplete: (_environment, result) => {
        if (result.indexed > 0) emitEnvironmentsUpdated();
      },
      onSessionError: (session, error) => {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        console.warn(
          `Could not build the WSL search index for ${session.sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
          cause instanceof Error ? cause.stack : undefined,
        );
      },
    });
  }
  return wslSessionIndexer;
}

function ensureRemoteEnvironmentLifecycle(): RemoteEnvironmentLifecycle {
  if (!remoteEnvironmentLifecycle) {
    remoteEnvironmentLifecycle = new RemoteEnvironmentLifecycle({
      store,
      syncEnvironment: async (environment) => {
        await syncRemoteEnvironment(store, environment, {
          ...(environment.kind === "ssh" ? { runSsh: runSshSessionCommand } : {}),
          enabledOptionalSources: enabledRemoteOptionalSources(getSettings()),
        });
        if (environment.kind === "wsl") {
          void ensureWslSessionIndexer().request(environment).catch((error) => {
            console.warn(`WSL full-text indexing failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
      watchManager: ensureRemoteWatchManager(),
      onEnvironmentSaved: (environment, input) => sshCredentialService.saveForEnvironment(environment, input),
      onEnvironmentDeleted: (environmentId) => sshCredentialService.deletePassword(environmentId),
      onEnvironmentsUpdated: emitEnvironmentsUpdated,
    });
  }
  return remoteEnvironmentLifecycle;
}

function runIndexSync(): Promise<IndexStatus> {
  return indexRunCoordinator.request(async () => {
    const settings = getSettings();
    await pruneDisabledOptionalSources(settings);
    indexStatus = { ...indexStatus, running: true, error: null };
    indexProgressPublisher.publish(indexStatus, true);
    const indexFailureLogger = createSessionIndexFailureLogger(app.getPath("userData"));

    return syncDefaultSessionsInBatches(store, {
      batchSize: 50,
      timeBudgetMs: 8,
      loadOptions: {
        includeStepcode: settings.includeStepcode,
        includeTclaude: settings.includeTclaude,
        includeTcodex: settings.includeTcodex,
        includeCodeBuddyCli: settings.includeCodeBuddyCli,
        includeWorkBuddy: settings.includeWorkBuddy,
        includeCodeWizCli: settings.includeCodeWizCli,
        includeOpenClaw: settings.includeOpenClaw,
        includeHermes: settings.includeHermes,
        includeOpenCode: settings.includeOpenCode,
        includeZcode: settings.includeZcode,
        includePi: settings.includePi,
        includeKimiCli: settings.includeKimiCli,
        includeCursorAgent: settings.includeCursorAgent,
        includeTrae: settings.includeTrae,
        includeQoder: settings.includeQoder,
        includeDeepSeekCli: settings.includeDeepSeekCli,
      },
      indexFailureLogPath: indexFailureLogger.logPath,
      logIndexFailure: indexFailureLogger.write,
      onEnvironmentsChanged: emitEnvironmentsUpdated,
      onProgress: (status) => {
        indexStatus = { ...status, lastIndexedAt: indexStatus.lastIndexedAt };
        indexProgressPublisher.publish(indexStatus);
      },
    })
      .then((status) => {
        indexStatus = status;
        indexProgressPublisher.publish(indexStatus, true);
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
        indexProgressPublisher.publish(indexStatus, true);
        return indexStatus;
      })
      .finally(() => {
        void ensureRemoteEnvironmentLifecycle().startEnabledEnvironments();
      });
  });
}

// V2 catalog and statistics reads already use asynchronous PostgreSQL APIs;
// only local process and session-file inspection needs a worker here.
const localLiveSessionService = new LocalLiveSessionService(
  path.join(__dirname, "live-session-worker.js"),
);
const loadCachedLocalLiveSessionSnapshot = createCachedLiveSessionSnapshotLoader({
  load: (options) => localLiveSessionService.load(options),
});
const loadCachedLiveSessionSnapshot = createCachedLiveSessionSnapshotLoader({
  load: async (options) => {
    const [snapshot, remoteSnapshot] = await Promise.all([
      loadCachedLocalLiveSessionSnapshot(options),
      Promise.resolve()
        .then(async () => loadRemoteLiveSessions(
          await store.listEnvironments(),
          (environment, remoteCommand) => environment.kind === "wsl"
            ? runRemoteCommand(environment, remoteCommand, { maxBuffer: 512 * 1024, timeout: 10_000 })
            : sshCommandService.run(environment, remoteCommand, { maxBuffer: 512 * 1024, timeout: 10_000 }),
          { includePasswordAuthenticated: options?.fresh === true },
        ))
        .then((sessions) => ({ sessions, error: null as string | null }))
        .catch((error) => ({
          sessions: [],
          error: error instanceof Error ? error.message : String(error),
        })),
    ]);
    return {
      ...snapshot,
      sessions: [...snapshot.sessions, ...remoteSnapshot.sessions],
      ...(snapshot.error || remoteSnapshot.error ? { error: snapshot.error ?? remoteSnapshot.error ?? undefined } : {}),
    };
  },
});

let summaryBackfillRunning = false;

const SUMMARY_PROVIDER_ERROR =
  "AI summary has no usable provider. Select Codex, Claude Code, or configure a direct summary API provider in Settings.";

function buildCodexExecEndpoint(settings: AppSettings): SummaryEndpoint {
  return buildCodexExecEndpointShared(settings, {
    onTemporarySession: (sessionKey) => {
      void store.deleteSession(sessionKey).catch(() => undefined);
    },
  });
}

async function resolveSummaryEndpointFromSettings(): Promise<SummaryEndpoint | null> {
  const settings = await providerService.hydrateSettings();
  const onTemporarySession = (sessionKey: string): void => {
    void store.deleteSession(sessionKey).catch(() => undefined);
  };
  if (settings.summarySource === "custom") {
    const summaryApiConfig = await providerService.resolveSummaryApiConfig(settings);
    const endpoint = resolveSummaryEndpointFromSettingsShared({
      ...settings,
      summaryApiConfigMode: "custom",
      summaryApiConfig,
    }, {});
    if (endpoint) return endpoint;
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
  const count = await store.getMessageCount(sessionKey);
  let excerpt;
  if (count <= SUMMARY_FULL_THRESHOLD) {
    excerpt = {
      head: await store.getMessages(sessionKey, 0, SUMMARY_FULL_THRESHOLD),
      tail: [],
      omittedCount: 0,
    };
  } else {
    excerpt = {
      head: await store.getMessages(sessionKey, 0, SUMMARY_HEAD_MESSAGES),
      tail: await store.getMessages(sessionKey, count - SUMMARY_TAIL_MESSAGES, SUMMARY_TAIL_MESSAGES),
      omittedCount: count - SUMMARY_HEAD_MESSAGES - SUMMARY_TAIL_MESSAGES,
    };
  }
  const result = await summarizeSession(excerpt, endpoint);
  await store.setAiSummary(sessionKey, result.summary, endpoint.model);
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

async function createLocalRemoteRestoreDependencies(
  onProgress: (progress: SessionMigrationProgress) => void,
): Promise<RemoteSessionRestoreDependencies> {
  const settings = await providerService.hydrateSettings();
  const endpoint = await resolveSummaryEndpointFromSettings();
  const compressor = endpoint
    ? createMigrationCompressor(
        endpoint,
        undefined,
        settings.compressionConcurrency,
        settings.migrationCompleteTokenLimit,
      )
    : null;

  return {
    inspectCli: (target) => inspectMigrationCli(target, getSettings()),
    prepare: (session, listener) => applyMigrationLengthPolicy(
      session,
      compressor,
      listener,
      settings.migrationCompleteTokenLimit,
    ),
    write: (target, session, targetSessionId) => writeMigratedSession({ target, session, sessionId: targetSessionId }),
    record: (record) => store.recordSessionMigration(record),
    refreshIndex: async (target, writtenFilePath, targetSessionId) => {
      indexStatus = await indexMigratedSessionFile(store, target, writtenFilePath, targetSessionId);
      mainWindow?.webContents.send("index-status", indexStatus);
    },
    launch: (target, targetSessionId, projectPath) =>
      openMigrationResumeInTerminal(target, targetSessionId, projectPath, getSettings()),
    resumeCommand: migrationResumeDisplayCommand,
    fallbackResumeCommand: fallbackMigrationResumeDisplayCommand,
    onProgress,
    idFactory: () => randomUUID(),
    targetSessionIdFactory: () => randomUUID(),
    now: () => Date.now(),
    projectPathExists: pathExists,
    projectPathIsDirectory: pathIsDirectory,
  };
}

async function createSourceRemoteRestoreDependencies(
  environment: SessionEnvironment,
  onProgress: (progress: SessionMigrationProgress) => void,
): Promise<RemoteSessionRestoreDependencies> {
  const settings = await providerService.hydrateSettings();
  const endpoint = await resolveSummaryEndpointFromSettings();
  const compressor = endpoint
    ? createMigrationCompressor(
        endpoint,
        undefined,
        settings.compressionConcurrency,
        settings.migrationCompleteTokenLimit,
      )
    : null;

  return {
    inspectCli: (target) =>
      environment.kind === "ssh" ? inspectSshMigrationCli(environment, target) : inspectWslMigrationCli(environment, target),
    prepare: (session, listener) => applyMigrationLengthPolicy(
      session,
      compressor,
      listener,
      settings.migrationCompleteTokenLimit,
    ),
    write: (target, session, targetSessionId) =>
      writeMigratedSessionToSshEnvironment(environment, target, session, targetSessionId),
    record: (record) => store.recordSessionMigration(record),
    refreshIndex: async () => {
      await syncRemoteEnvironment(store, environment, {
        ...(environment.kind === "ssh" ? { runSsh: runSshSessionCommand } : {}),
        enabledOptionalSources: enabledRemoteOptionalSources(getSettings()),
      });
      mainWindow?.webContents.send("environments-updated", await store.listEnvironments());
    },
    launch: async (target, targetSessionId, projectPath) => {
      const session = migrationLaunchSession(environment, target, targetSessionId, projectPath);
      if (environment.kind === "wsl") {
        await openResumeInTerminal(
          session,
          getSettings(),
          await remoteSessionAccess.requireWslResumeOptions(session),
        );
        return;
      }
      const sshArgs = buildRemoteSyncSshArgs(environment, "").slice(0, -1);
      await openResumeInTerminal(session, getSettings(), { sshArgs });
    },
    resumeCommand: (target, targetSessionId, projectPath) =>
      remoteMigrationResumeDisplayCommand(environment, target, targetSessionId, projectPath),
    fallbackResumeCommand: (target, targetSessionId, projectPath) =>
      remoteMigrationResumeDisplayCommand(environment, target, targetSessionId, projectPath),
    onProgress,
    idFactory: () => randomUUID(),
    targetSessionIdFactory: () => randomUUID(),
    now: () => Date.now(),
    projectPathExists: (projectPath) => remotePathExists(environment, projectPath),
    projectPathIsDirectory: (projectPath) => remotePathIsDirectory(environment, projectPath),
  };
}

async function inspectWslMigrationCli(environment: SessionEnvironment, target: MigrationAgent): Promise<void> {
  const settings = getSettings();
  await inspectMigrationCli(
    target,
    { ...settings, claudeBinary: "claude", codexBinary: "codex" },
    async (command, args) => runRemoteCommand(environment, [command, ...args].join(" ")),
    { platform: "linux" },
  );
}

async function inspectSshMigrationCli(environment: SessionEnvironment, target: MigrationAgent): Promise<void> {
  const settings = getSettings();
  await inspectMigrationCli(
    target,
    { ...settings, claudeBinary: "claude", codexBinary: "codex" },
    (command, args) => runSshSessionCommand(
      environment,
      [command, ...args].map(quotePosixToken).join(" "),
    ),
    { platform: "linux" },
  );
}

function migrationLaunchSession(
  environment: SessionEnvironment,
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
): SessionSearchResult {
  const source = migrationTargetDescriptor(target).source;
  return {
    sessionKey: remoteSessionKey(environment, migrationTargetDescriptor(target).source, sessionId),
    rawId: sessionId,
    source,
    projectPath,
    filePath: "",
    originalTitle: sessionId,
    firstQuestion: "",
    displayTitle: sessionId,
    timestamp: Date.now(),
    fileMtimeMs: 0,
    fileSize: 0,
    prUrl: null,
    prNumber: null,
    gitBranch: null,
    isSubagent: false,
    parentSessionId: null,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    environmentId: environment.id,
    environmentKind: environment.kind,
    environmentLabel: environment.label,
    customTitle: null,
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 0,
    messageCount: 0,
    aiSummary: null,
    aiSummaryStale: false,
  };
}

function remoteMigrationResumeDisplayCommand(
  environment: SessionEnvironment,
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
): string {
  if (environment.kind === "wsl") {
    if (!environment.wslDistribution) {
      throw new Error("WSL distribution is not configured for this remote session.");
    }
    return getResumeCommand(
      migrationLaunchSession(environment, target, sessionId, projectPath),
      getSettings(),
      { wslDistribution: environment.wslDistribution },
    );
  }
  const remoteCommand = getMigrationResumeProcessSpec(target, sessionId, projectPath, getSettings(), { platform: "linux" }).displayCommand;
  return ["ssh", ...buildRemoteSyncSshArgs(environment, remoteCommand).map(quotePosixToken)].join(" ");
}

function localSessionMigrationRuntime(event: IpcMainInvokeEvent) {
  return {
    // Falling back to the local Codex exec route keeps migration compression working when
    // no summary Provider is configured, instead of silently skipping compression.
    resolveSummaryEndpoint: async () => (await resolveSummaryEndpointFromSettings())
      ?? buildCodexExecEndpoint(await providerService.hydrateSettings()),
    createCompressor: (
      endpoint: SummaryEndpoint,
      concurrency: number,
      completeTokenLimit: number,
    ) => createMigrationCompressor(endpoint, undefined, concurrency, completeTokenLimit),
    migrate: migrateSession,
    inspectCli: (migrationTarget: MigrationTarget, snapshot: AppSettings) => inspectMigrationCli(migrationTarget, snapshot),
    prepare: (
      portable: PortableSession,
      onProgress: Parameters<typeof applyMigrationLengthPolicy>[2],
      compressor: ReturnType<typeof createMigrationCompressor> | null,
      completeTokenLimit: number,
    ) => applyMigrationLengthPolicy(portable, compressor, onProgress, completeTokenLimit),
    write: (migrationTarget: MigrationTarget, portable: PortableSession, targetSessionId?: string) =>
      writeMigratedSession({
        target: migrationTarget,
        session: portable,
        sessionId: targetSessionId,
        // Test/sandboxed launches may redirect the migration home so writes
        // to ~/.codex, ~/.dsh, ... never hit a TCC-protected real home.
        ...process.env.AGENT_RECALL_MIGRATION_HOME
          ? { homeDir: process.env.AGENT_RECALL_MIGRATION_HOME }
          : {},
      }),
    record: (record: Parameters<SessionStore["recordSessionMigration"]>[0]) => store.recordSessionMigration(record),
    refreshIndex: async (migrationTarget: MigrationTarget, writtenFilePath: string, targetSessionId: string) => {
      const status = await indexMigratedSessionFile(store, migrationTarget, writtenFilePath, targetSessionId);
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
    targetSessionIdFactory: () => randomUUID(),
    now: () => Date.now(),
    projectPathExists: pathExists,
    projectPathIsDirectory: pathIsDirectory,
  };
}

async function writeMigratedSessionToSshEnvironment(
  environment: SessionEnvironment,
  target: MigrationAgent,
  session: PortableSession,
  targetSessionId?: string,
): Promise<{ sessionId: string; filePath: string }> {
  const now = new Date();
  const tempHome = await fs.mkdtemp(path.join(app.getPath("temp"), "agent-session-remote-restore-"));
  try {
    const remoteHome = await remoteHomeDir(environment);
    const written = await writeMigratedSession({
      target,
      session,
      sessionId: targetSessionId,
      homeDir: tempHome,
      now,
      codexRuntimeCwd: session.projectPath || remoteHome,
    });
    const remotePath = targetFilePathForRemoteEnvironment(target, session.projectPath, written.sessionId, remoteHome, now);
    const content = await fs.readFile(written.filePath);
    await runRemotePython(environment, REMOTE_WRITE_FILE_SCRIPT, {
      path: remotePath,
      contentBase64: content.toString("base64"),
    });
    if (target === "codex") {
      await updateRemoteCodexSessionIndex(environment, remoteHome, session, written.sessionId, now);
      await updateRemoteCodexAppState(environment, remoteHome, remotePath, session, written.sessionId, now);
    }
    return { sessionId: written.sessionId, filePath: remotePath };
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

async function updateRemoteCodexSessionIndex(
  environment: SessionEnvironment,
  remoteHome: string,
  session: PortableSession,
  sessionId: string,
  now: Date,
): Promise<void> {
  const indexPath = `${remoteHome.replace(/[\\/]+$/, "")}/.codex/session_index.jsonl`;
  const title = session.title || session.messages.find((message) => message.role === "user")?.content || sessionId;
  await runRemotePython(environment, REMOTE_UPDATE_CODEX_INDEX_SCRIPT, {
    path: indexPath,
    id: sessionId,
    threadName: title,
    updatedAt: now.toISOString(),
  });
}

async function updateRemoteCodexAppState(
  environment: SessionEnvironment,
  remoteHome: string,
  rolloutPath: string,
  session: PortableSession,
  sessionId: string,
  now: Date,
): Promise<void> {
  try {
    const title = session.title || session.messages.find((message) => message.role === "user")?.content || sessionId;
    const firstUserMessage = session.messages.find((message) => message.role === "user")?.content || "";
    await runRemotePython(environment, REMOTE_UPDATE_CODEX_STATE_SCRIPT, {
      home: remoteHome,
      id: sessionId,
      rolloutPath,
      cwd: session.projectPath || remoteHome,
      title,
      firstUserMessage,
      createdAtMs: new Date(session.startedAt).getTime(),
      updatedAtMs: now.getTime(),
      modelProvider: "openai",
    });
  } catch {
    // The Codex app-server may hold its state database open. The rollout file
    // and session index remain authoritative when this display update fails.
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
  return runRemoteWithInput(environment, remoteCommand, `${JSON.stringify(payload)}\n`);
}

function runSshWithInput(environment: SessionEnvironment, remoteCommand: string, input: string): Promise<string> {
  return sshCommandService.run(environment, remoteCommand, {
    input,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 90_000,
  });
}

function runRemoteWithInput(environment: SessionEnvironment, remoteCommand: string, input: string): Promise<string> {
  return environment.kind === "wsl"
    ? runRemoteCommandWithInput(environment, remoteCommand, input, REMOTE_PROCESS_EXEC_OPTIONS)
    : runSshWithInput(environment, remoteCommand, input);
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

const REMOTE_UPDATE_CODEX_INDEX_SCRIPT = [
  "import json, os, sys, uuid",
  "from pathlib import Path",
  "payload = json.load(sys.stdin)",
  "index = Path(payload['path'])",
  "rows = []",
  "if index.exists():",
  "    for line in index.read_text(encoding='utf-8').splitlines():",
  "        if line.strip(): rows.append(json.loads(line))",
  "rows = [row for row in rows if not isinstance(row, dict) or row.get('id') != payload['id']]",
  "rows.append({'id': payload['id'], 'thread_name': payload['threadName'], 'updated_at': payload['updatedAt']})",
  "index.parent.mkdir(parents=True, exist_ok=True)",
  "tmp = index.with_name(index.name + '.tmp-' + uuid.uuid4().hex)",
  "tmp.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\\n' for row in rows), encoding='utf-8')",
  "os.chmod(tmp, 0o600)",
  "os.replace(tmp, index)",
  "print(str(index))",
].join("\n");

const REMOTE_UPDATE_CODEX_STATE_SCRIPT = [
  "import json, sqlite3, sys",
  "from pathlib import Path",
  "payload = json.load(sys.stdin)",
  "home = Path(payload['home'])",
  "candidates = sorted((home / '.codex').glob('state_*.sqlite'), key=lambda item: item.stat().st_mtime, reverse=True)",
  "if not candidates: print('Codex state database not found'); sys.exit(0)",
  "db = sqlite3.connect(str(candidates[0]), timeout=5)",
  "db.row_factory = sqlite3.Row",
  "columns = {row[1] for row in db.execute('PRAGMA table_info(threads)')}",
  "required = {'id', 'rollout_path', 'created_at', 'updated_at', 'source', 'model_provider', 'cwd', 'title', 'sandbox_policy', 'approval_mode'}",
  "if not required.issubset(columns): db.close(); print('Codex state database schema not supported'); sys.exit(0)",
  "existing = db.execute('SELECT * FROM threads WHERE id = ?', (payload['id'],)).fetchone()",
  "order_column = 'updated_at_ms' if 'updated_at_ms' in columns else 'updated_at'",
  "template = existing or db.execute(f'SELECT * FROM threads ORDER BY {order_column} DESC LIMIT 1').fetchone()",
  "def value(name, fallback=None): return existing[name] if existing and name in existing.keys() and existing[name] is not None else (template[name] if template and name in template.keys() and template[name] is not None else fallback)",
  "created_ms = int(payload['createdAtMs'])",
  "updated_ms = int(payload['updatedAtMs'])",
  "values = {",
  "  'id': payload['id'], 'rollout_path': payload['rolloutPath'],",
  "  'created_at': value('created_at', created_ms // 1000), 'updated_at': updated_ms // 1000,",
  "  'source': 'vscode', 'model_provider': value('model_provider', payload['modelProvider']),",
  "  'cwd': payload['cwd'], 'title': payload['title'],",
  "  'sandbox_policy': value('sandbox_policy', '{}'), 'approval_mode': value('approval_mode', 'on-request'),",
  "  'tokens_used': value('tokens_used', 0), 'has_user_event': 1, 'archived': value('archived', 0),",
  "  'cli_version': 'migration', 'first_user_message': payload['firstUserMessage'],",
  "  'memory_mode': value('memory_mode', 'enabled'), 'model': value('model'), 'reasoning_effort': value('reasoning_effort'),",
  "  'agent_path': value('agent_path'), 'created_at_ms': value('created_at_ms', created_ms), 'updated_at_ms': updated_ms,",
  "  'thread_source': 'user', 'preview': payload['title'], 'recency_at': updated_ms // 1000, 'recency_at_ms': updated_ms,",
  "  'history_mode': 'legacy'",
  "}",
  "values = {key: value for key, value in values.items() if key in columns}",
  "if existing:",
  "    assignments = ', '.join(f'{key} = ?' for key in values if key != 'id')",
  "    params = [values[key] for key in values if key != 'id'] + [payload['id']]",
  "    db.execute(f'UPDATE threads SET {assignments} WHERE id = ?', params)",
  "else:",
  "    names = ', '.join(values)",
  "    placeholders = ', '.join('?' for _ in values)",
  "    db.execute(f'INSERT INTO threads ({names}) VALUES ({placeholders})', list(values.values()))",
  "db.commit()",
  "db.close()",
  "print(str(candidates[0]))",
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
    const candidates = await store.listSessionsNeedingSummary(Date.now(), maxAgeMs, 25);
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

function registerIpc(): void {
  if (!automationService) throw new Error("Automation service must be created before IPC registration.");
  if (!openVikingControlService) {
    throw new Error("OpenViking memory must be initialized before IPC registration.");
  }
  disposeAutomationIpc = registerAutomationIpc({
    ipc: ipcMain,
    service: automationService,
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    pickDirectory: pickAutomationDirectory,
    readLocalFile: (filePath, allowedRoots) =>
      createLocalTextFilePreviewUnderRoots(filePath, allowedRoots, app.getPath("home")),
    revealPath: async (filePath) => {
      const resolvedPath = path.resolve(filePath);
      await createLocalTextFilePreviewUnderRoots(
        resolvedPath,
        automationService?.workflows.allowedFileRoots() ?? [],
        app.getPath("home"),
      );
      shell.showItemInFolder(resolvedPath);
      return resolvedPath;
    },
  });
  disposeTeamChatIpc = registerTeamChatIpc({
    ipc: ipcMain,
    service: automationService.teamChat,
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    ensureReady: () => automationService!.requireReady(),
  });
  ipcMain.handle("markdown:open-external", (_event, value: unknown) => {
    const url = normalizeExternalLink(value);
    if (!url) throw new Error("Only HTTP, HTTPS, and mailto links can be opened externally.");
    return shell.openExternal(url);
  });
  registerSessionCatalogIpc(ipcMain, new SessionCatalogService({
    store,
    listProjects: listVisibleProjects,
    visibleSearchOptions,
    visibleStatsOptions,
    visibleProjectOptions,
    ensureRemoteDetails: (sessionKey) => remoteSessionAccess.ensureDetails(sessionKey),
    hasRemoteDetails: (sessionKey) => remoteSessionAccess.hasHydratedDetails(sessionKey),
    requireWslEnvironment: (session) => remoteSessionAccess.requireWslEnvironment(session),
    requireSshEnvironment: (session) => remoteSessionAccess.requireRemoteSshEnvironment(session),
    fetchRemoteMessages: (environment, session, offset, limit) =>
      fetchRemoteSessionMessagePage(environment, session, offset, limit, {
        ...(environment.kind === "ssh" ? { runSsh: runSshSessionCommand } : {}),
      }),
    loadLiveSessions: (fresh = false) => loadCachedLiveSessionSnapshot({
      fresh,
      includeTrae: getSettings().includeTrae,
      includeQoder: getSettings().includeQoder,
      includeOpenClaw: getSettings().includeOpenClaw,
      includeHermes: getSettings().includeHermes,
      includeOpenCode: getSettings().includeOpenCode,
      includeZcode: getSettings().includeZcode,
      includeCursor: getSettings().includeCursorAgent,
      includeCodeBuddy: getSettings().includeCodeBuddyCli,
      includeCodeWiz: getSettings().includeCodeWizCli,
    }),
    refreshIndex: runIndexSync,
    getIndexStatus: () => indexStatus,
    setCustomTitle: (sessionKey, title) =>
      setSessionCustomTitleAndSyncTerminal(sessionKey, title, {
        getSession: (key) => store.getSession(key),
        setCustomTitle: (key, customTitle) => store.setCustomTitle(key, customTitle),
        loadLiveSessions: () => loadCachedLocalLiveSessionSnapshot({
          includeTrae: getSettings().includeTrae,
          includeQoder: getSettings().includeQoder,
          includeOpenClaw: getSettings().includeOpenClaw,
          includeHermes: getSettings().includeHermes,
          includeOpenCode: getSettings().includeOpenCode,
          includeZcode: getSettings().includeZcode,
          includeCursor: getSettings().includeCursorAgent,
          includeCodeBuddy: getSettings().includeCodeBuddyCli,
          includeCodeWiz: getSettings().includeCodeWizCli,
        }),
        setLiveTerminalTitle: (pid, displayTitle) => setLiveSessionTerminalTitle(pid, displayTitle),
        onSyncError: (error) => console.warn(
          "[terminal-title] Could not synchronize live terminal title.",
          error,
        ),
      }),
  }));
  ipcMain.handle("attachment:preview", async (_event, sessionKey: string, attachmentId: string) => {
    const attachment = await store.getAttachmentFile(sessionKey, attachmentId);
    if (!attachment) throw new Error("Attachment is unavailable.");
    if (attachment.previewKind === "image") {
      const bytes = await fs.readFile(attachment.cachePath);
      return { kind: "image", data: `data:${attachment.mimeType};base64,${bytes.toString("base64")}` };
    }
    if (attachment.previewKind === "text") {
      const text = await fs.readFile(attachment.cachePath, "utf8");
      return { kind: "text", data: text.slice(0, 256 * 1024) };
    }
    const error = await shell.openPath(attachment.cachePath);
    if (error) throw new Error(error);
    return { kind: "external" };
  });
  ipcMain.handle("attachment:open", async (_event, sessionKey: string, attachmentId: string) => {
    const attachment = await store.getAttachmentFile(sessionKey, attachmentId);
    if (!attachment) throw new Error("Attachment is unavailable.");
    const error = await shell.openPath(attachment.cachePath);
    if (error) throw new Error(error);
  });
  ipcMain.handle("session:summarize", async (_event, sessionKey: string) => {
    await remoteSessionAccess.ensureDetails(sessionKey);
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
    const candidates = await store.listSessionsNeedingSummary(Date.now(), maxAgeMs, 500);
    const total = candidates.length;
    let processed = 0;
    let failed = 0;
    let next = 0;
    const sendProgress = (): void => {
      try {
        event.sender.send("summary:progress", { processed, failed, total });
      } catch {
        // The window can be destroyed mid-batch; progress delivery must not abort it.
      }
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
    const endpoint = (await resolveSummaryEndpointFromSettings()) ?? buildCodexExecEndpoint(await providerService.hydrateSettings());

    // Local CLI providers (codex exec / claude) can't do HTTP function calling.
    // Fall back to: keyword-search the store with the user's words, then let the
    // CLI write a grounded answer over the hits.
    if (isLocalCliEndpoint(endpoint)) {
      const search = async (query: string): Promise<FallbackSessionHit[]> => {
        const sessions = await store.searchSessions(visibleSearchOptions({ query, limit: 12 }));
        return sessions.map((session) => ({
          sessionKey: session.sessionKey,
          title: session.displayTitle,
          source: session.source,
          project: session.projectPath,
          summary: session.aiSummary ?? session.firstQuestion ?? null,
        }));
      };
      const { reply, sessionKeys } = await runAiAssistantFallback(endpoint, messages, search);
      const sessions = (await Promise.all(sessionKeys
        .map((key) => store.getSession(key))))
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
          const sessions = await store.searchSessions(visibleSearchOptions({
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
          const projects = await listVisibleProjects(visibleProjectOptions());
          return {
            result: projects.map((project) => ({ project: project.path, sessions: project.sessionCount })),
            sessionKeys: [],
          };
        }
        case "list_tags": {
          return { result: await store.listTags(), sessionKeys: [] };
        }
        case "get_session": {
          const sessionKey = typeof args.sessionKey === "string" ? args.sessionKey : "";
          if (!sessionKey) return { result: { error: "sessionKey is required." }, sessionKeys: [] };
          await remoteSessionAccess.ensureDetails(sessionKey);
          const session = await store.getSession(sessionKey);
          if (!session) return { result: { error: "Session not found." }, sessionKeys: [] };
          const maxMessages = typeof args.maxMessages === "number" ? Math.max(1, Math.min(200, Math.floor(args.maxMessages))) : 40;
          const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
          const messageList = await store.getMessages(sessionKey, offset, maxMessages);
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
    const sessions = (await Promise.all(sessionKeys
      .map((key) => store.getSession(key))))
      .filter((session): session is SessionSearchResult => session !== null);
    return { reply, sessions };
  });
  ipcMain.handle("mcp:status", () => {
    try {
      return ensureAgentRecallMcpPreference();
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
  ipcMain.handle("mcp-workflow:status", () => getSettings().workflowMcpEnabled);
  ipcMain.handle("mcp-workflow:set-enabled", async (_event, enabled: boolean) => {
    if (automationService) {
      // setWorkflowEnabled flips the settings flag AND bulk-registers codex
      // agents through the built-in workflow server's toggle.
      await automationService.mcp.setWorkflowEnabled(enabled).catch(() => undefined);
    } else {
      settingsStore.set("workflowMcpEnabled", enabled);
    }
    return getSettings().workflowMcpEnabled;
  });
  ipcMain.handle("ssh-config:list-hosts", () => readUserSshConfig());
  ipcMain.handle("wsl:list-distributions", () => listWslDistributions());
  ipcMain.handle("environment:save", (_event, input: EnvironmentUpsertInput) =>
    ensureRemoteEnvironmentLifecycle().saveEnvironment(input),
  );
  ipcMain.handle("environment:delete", (_event, environmentId: string) =>
    ensureRemoteEnvironmentLifecycle().deleteEnvironment(environmentId),
  );
  ipcMain.handle("environment:refresh", (_event, environmentId: string) =>
    ensureRemoteEnvironmentLifecycle().refreshEnvironment(environmentId),
  );
  ipcMain.handle("environment:diagnose", async (_event, environmentId: string) => {
    const environment = await store.getEnvironment(environmentId);
    if (environment?.kind === "wsl") return diagnoseRemoteEnvironment(environment);
    return diagnoseRemoteEnvironment(
      await remoteSessionAccess.requireSshEnvironment(environmentId),
      { runSsh: runSshHealthCommand },
    );
  });
  registerAppUpdateIpc(ipcMain, appUpdateService);
  registerQuotaIpc(ipcMain, quotaService);
  disposeOpenVikingMemoryIpc = registerOpenVikingMemoryIpc(ipcMain, openVikingControlService);
  ipcMain.handle("quick-search:open-session", async (_event, sessionKey: string) => {
    const session = await store.getSession(sessionKey);
    if (!session) throw new Error("Session was not found.");
    await store.markOpened(sessionKey);
    quickSearchWindow?.hide();
    showWindow();
    mainWindow?.webContents.send("open-session", sessionKey);
  });
  ipcMain.handle("settings:get", () => providerService.hydrateSettings());
  ipcMain.handle("interface-zoom:set", (_event, factor: unknown) => interfaceZoomController.set(factor));
  registerProvidersIpc(ipcMain, providerService, chooseProviderConfigDirectory);
  ipcMain.handle("settings:set", (_event, settings: AppSettingsUpdate) => applySettingsUpdate(settings));
  ipcMain.handle("v1-import:run", async () => {
    const result = await new V1SessionImportService({
      store,
      appDataPath: app.getPath("appData"),
      v2UserDataPath: app.getPath("userData"),
      applySettings: async (update) => {
        await applySettingsUpdate(update);
      },
    }).importData();
    emitEnvironmentsUpdated();
    return result;
  });
  registerSkillsIpc(ipcMain, skillService);
  registerRulesIpc(ipcMain, createRulesSyncService());
  registerMemoriesIpc(ipcMain, createMemoriesSyncService());
  registerDiscoveryIpc(ipcMain, createDiscoveryService());
  ipcMain.handle("supabase:copy-combined-setup-sql", () => {
    clipboard.writeText(buildCombinedSupabaseSetupSql());
  });
  ipcMain.handle("supabase:open-sql-editor", (_event, target: unknown) => {
    const settings = getSettings();
    const projectUrl = target === "skills" ? settings.skillSyncSupabaseUrl : settings.remoteSyncSupabaseUrl;
    return shell.openExternal(supabaseSqlEditorUrl(projectUrl));
  });
  registerRemoteSessionsIpc(ipcMain, remoteSessionService);
  registerSessionCommandIpc(ipcMain, new SessionCommandService({
    store,
    remoteAccess: remoteSessionAccess,
    getSettings,
    loadLiveSessions: () => loadCachedLocalLiveSessionSnapshot({
      includeTrae: getSettings().includeTrae,
      includeQoder: getSettings().includeQoder,
    }),
    copyText: (text) => clipboard.writeText(text),
    openExternal: (url) => shell.openExternal(url),
    openDeepSeekWebSession: showDeepSeekWebSession,
    chooseMarkdownPath: chooseMarkdownExportPath,
    chooseJsonFormat: chooseJsonExportFormat,
    chooseJsonPath: chooseJsonExportPath,
    writeTextFile: (filePath, content) => fs.writeFile(filePath, content, "utf-8"),
    showJsonExportNotice,
  }));
  ipcMain.handle("session:migrate", async (event, request: SessionMigrationRequest) => {
    const source = await store.getSession(request.sessionKey);
    if (source?.environmentKind === "wsl" || source?.environmentKind === "ssh") {
      await remoteSessionAccess.ensureDetails(request.sessionKey);
      const descendants = collectMigrationDescendants(
        source,
        await store.searchSessions({ limit: 100_000, excludeSubagents: false }),
      );
      for (const child of descendants) await remoteSessionAccess.ensureDetails(child.sessionKey);
    }
    const migrationSource = await loadLocalSessionMigrationSource(store, request);
    const settings = Object.freeze(await providerService.hydrateSettings());
    if (migrationSource.source.environmentKind === "wsl" || migrationSource.source.environmentKind === "ssh") {
      assertMigrationTargetEnabled(request.target, settings);
      if (migrationSource.source.environmentKind === "ssh"
        && request.target !== sshMigrationTarget(migrationSource.source.source)) {
        throw new Error("SSH sessions can only migrate between Claude Code and Codex on the same host.");
      }
      if (migrationSource.source.environmentKind === "wsl"
        && !["claude", "codex", "codebuddy", "codewiz", "cursor"].includes(request.target)) {
        throw new Error(`Migration target ${request.target} is not supported in WSL.`);
      }
      const environment = migrationSource.source.environmentKind === "wsl"
        ? await remoteSessionAccess.requireWslEnvironment(migrationSource.source)
        : await remoteSessionAccess.requireRemoteSshEnvironment(migrationSource.source);
      if (!environment) throw new Error("SSH environment is not available for this remote session.");
      const portable = portableSessionFrom(
        migrationSource.source,
        migrationSource.messages,
        {
          turnSourceMessageIndexes: migrationSource.turnSourceMessageIndexes,
          allowSsh: migrationSource.source.environmentKind === "ssh",
        },
      );
      if (migrationSource.subagents.length > 0) portable.subagents = migrationSource.subagents;
      const progress = (item: SessionMigrationProgress): void => event.sender.send("session:migration-progress", item);
      const deps = await createSourceRemoteRestoreDependencies(environment, progress);
      return restoreRemotePortableSession({
        remoteId: request.sessionKey,
        portable,
        target: request.target as MigrationAgent,
        localProjectPath: portable.projectPath,
        deps,
      });
    }

    return runLocalSessionMigration({
      ...migrationSource,
      target: request.target,
      targetProjectPath: request.targetProjectPath,
      settings,
    }, localSessionMigrationRuntime(event));
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

app.whenReady().then(async () => {
  await appUpdateService.registerRunningProcess();
  void installedRuntimeMonitor?.start();
  postgresRuntimeStartup = startPostgresRuntime({ userDataPath: app.getPath("userData") });
  postgresRuntime = await postgresRuntimeStartup;
  if (automationQuitStarted) return;
  postgresDatabase = PostgresDatabase.connect(postgresRuntime.connectionUrl, {
    migrations: POSTGRES_MIGRATIONS,
  });
  await postgresDatabase.initialize();
  store = new SessionStore(
    postgresDatabase,
    Promise.resolve(),
    path.join(app.getPath("userData"), "session-attachments"),
  );
  quotaService = createQuotaService();
  initializeOpenVikingMemory();
  try {
    reconcileOpenVikingMemoryHooks(getSettings());
  } catch (error) {
    console.error(`Failed to refresh OpenViking memory hooks during startup: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Publish the live endpoint so standalone MCP clients use the same store.
  try {
    writeDatabaseUrlPointer(postgresRuntime.connectionUrl);
  } catch {
    // Non-fatal: the MCP server can still use AGENT_RECALL_DATABASE_URL.
  }
  try {
    writeSkillLibraryPointer(skillLibraryRoot);
  } catch {
    // Non-fatal: the MCP server can still use AGENT_RECALL_SKILL_LIBRARY.
  }
  try {
    ensureAgentRecallMcpPreference();
  } catch (error) {
    console.error(`Failed to configure session search MCP: ${error instanceof Error ? error.message : String(error)}`);
  }
  await providerService.migrateLegacyKeys();
  await pruneDisabledOptionalSources(getSettings());
  if (automationQuitStarted) return;
  automationService = createAutomationService();
  registerIpc();
  quotaService.start();
  createApplicationMenu();
  createWindow();
  createTray();
  applyDockVisibility(getSettings().showInDock);
  if (process.platform === "darwin" && app.dock) {
    const dockIconPath = resolveAssetPath(APP_ICON_RELATIVE_PATH);
    if (dockIconPath) {
      const dockIcon = nativeImage.createFromPath(dockIconPath);
      if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
    }
  }
  void appUpdateService.showPreviousUpdateResult();
  const shortcut = getSettings().globalShortcut;
  if (!registerAppGlobalShortcut(shortcut)) {
    console.error(`Global shortcut ${globalShortcutLabel(shortcut)} could not be registered.`);
  }
  const initialIndexSettled = new Promise<void>((resolve) => {
    startupTasks.schedule(INITIAL_INDEX_DELAY_MS, () => {
      void (async () => {
        try {
          const repair = await repairLegacyAgentRecallCodexRollouts(homedir());
          if (repair.failedFiles > 0) {
            console.warn(`[session-migration] ${repair.failedFiles} legacy Codex rollout(s) could not be repaired; they will be retried on the next startup.`);
          }
        } catch (error) {
          console.warn("[session-migration] Legacy Codex rollout repair failed; startup indexing will continue.", error);
        }
        await runIndexSync();
      })().then(() => resolve(), () => resolve());
    });
  });
  startAutoIndexRefresh();
  startupTasks.whenSettled(initialIndexSettled, () => skillService.startUsageRefresh());
  startupTasks.schedule(INITIAL_SESSION_SYNC_QUEUE_START_DELAY_MS, () => {
    startupTasks.whenSettled(initialIndexSettled, () => remoteSessionService.startQueue());
  });
  startupTasks.schedule(INITIAL_PROVIDER_RESTORE_DELAY_MS, () => {
    startupTasks.whenSettled(initialIndexSettled, () => providerService.restoreCodexChatProxy());
  });
  startupTasks.schedule(INITIAL_OPENVIKING_RUNTIME_DELAY_MS, () => {
    startupTasks.whenSettled(initialIndexSettled, async () => {
      try {
        await refreshOpenVikingHookManifest();
        await startConfiguredOpenVikingRuntime(getSettings());
      } catch (error) {
        console.error(`Failed to start the OpenViking runtime: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });
  startupTasks.whenSettled(initialIndexSettled, () => appUpdateService.scheduleInitialCheck());
}).catch(async (error) => {
  console.error(`Failed to start AgentRecall: ${error instanceof Error ? error.message : String(error)}`);
  await postgresDatabase?.close().catch(() => undefined);
  await postgresRuntime?.stop().catch(() => undefined);
  postgresDatabase = null;
  postgresRuntime = null;
  app.quit();
});

app.on("window-all-closed", () => {
  // Keep the menu bar app alive; users can quit from the tray/menu.
});

app.on("activate", () => {
  showWindow();
});

app.on("before-quit", (event) => {
  if (automationQuitReady) return;
  event.preventDefault();
  if (automationQuitStarted) return;
  automationQuitStarted = true;
  startupTasks.cancelAll();
  installedRuntimeMonitor?.stop();
  openVikingHookStateFlusher?.stop();
  stopAutoIndexRefresh();
  localLiveSessionService.stop();
  skillService.stopUsageRefresh();
  remoteSessionService.stopQueue();
  quotaService?.stop();
  remoteEnvironmentLifecycle?.stopAll();
  disposeAutomationIpc?.();
  disposeAutomationIpc = null;
  disposeTeamChatIpc?.();
  disposeTeamChatIpc = null;
  disposeOpenVikingMemoryIpc?.();
  disposeOpenVikingMemoryIpc = null;
  globalShortcut.unregisterAll();
  void Promise.allSettled([
    appUpdateService.clearRunningProcess(),
    automationService?.shutdown() ?? Promise.resolve(),
    providerService.stopCodexChatProxy(),
    openVikingHookManifestService?.clear() ?? Promise.resolve(),
    openVikingRuntimeService?.stop() ?? Promise.resolve(),
  ]).then(async () => {
    // Quit can land while startPostgresRuntime is still in flight; adopt the
    // pending startup so the embedded database is stopped instead of orphaned.
    if (!postgresRuntime && postgresRuntimeStartup) {
      postgresRuntime = await postgresRuntimeStartup.catch(() => null);
    }
    await postgresDatabase?.close().catch((error) => {
      console.error(`Failed to close AgentRecall data store: ${error instanceof Error ? error.message : String(error)}`);
    });
    postgresDatabase = null;
    await postgresRuntime?.stop().catch((error) => {
      console.error(`Failed to stop AgentRecall PostgreSQL: ${error instanceof Error ? error.message : String(error)}`);
    });
    postgresRuntime = null;
  }).finally(() => {
    automationQuitReady = true;
    app.quit();
  });
});
