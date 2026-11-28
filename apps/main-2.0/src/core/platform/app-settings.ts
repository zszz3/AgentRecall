import { defaultAgentModelConfig, normalizeAgentModelConfig, type AgentModelConfig } from "../agent-model-config";
import {
  defaultApiConfig,
  defaultClaudeApiConfig,
  normalizeApiConfig,
  normalizeClaudeApiConfig,
  type ApiConfig,
  type ClaudeApiConfig,
} from "../api-config";
import { DEFAULT_GLOBAL_SHORTCUT, normalizeGlobalShortcut, type GlobalShortcut } from "../shortcuts";
import {
  type TerminalChoice,
  defaultTerminalFor,
  normalizeTerminal,
} from "../terminal-options";
import { normalizeSummaryReasoningEffort, type SummaryReasoningEffort } from "../summary-settings";

export interface AppSettings {
  defaultTerminal: TerminalChoice;
  globalShortcut: GlobalShortcut;
  claudeBinary: string;
  codexBinary: string;
  stepcodeBinary: string;
  codeBuddyBinary: string;
  codeWizBinary: string;
  cursorBinary: string;
  tclaudeBinary: string;
  tcodexBinary: string;
  includeStepcode: boolean;
  deepseekBinary: string;
  antigravityCliBinary: string;
  ompBinary: string;
  includeTclaude: boolean;
  includeTcodex: boolean;
  includeCodeBuddyCli: boolean;
  includeWorkBuddy: boolean;
  includeCodeWizCli: boolean;
  includeOpenClaw: boolean;
  includeHermes: boolean;
  includeOpenCode: boolean;
  includeZcode: boolean;
  includeCursorAgent: boolean;
  includeTrae: boolean;
  includeQoder: boolean;
  includeQoderIde: boolean;
  includePi: boolean;
  includeKimiCli: boolean;
  includeQwenCode: boolean;
  includeGeminiCli: boolean;
  includeDeepSeekCli: boolean;
  includeAntigravity: boolean;
  includeAntigravityCli: boolean;
  includeOmp: boolean;
  evalEnabled: boolean;
  hideCodexQuota: boolean;
  hideClaudeQuota: boolean;
  autoCheckUpdates: boolean;
  showInDock: boolean;
  islandEnabled: boolean;
  islandSoundEnabled: boolean;
  islandSuppressWhenFocused: boolean;
  islandAutoCollapseSeconds: number;
  summaryAutoBackfill: boolean;
  summaryMaxAgeDays: number;
  compressionConcurrency: number;
  migrationCompleteTokenLimit: number;
  summarySource: "codex" | "claude" | "custom";
  /** Only meaningful for `summarySource === "custom"`: reuse the Codex tab's route or keep a separate one. */
  summaryApiConfigMode: "inherit_codex" | "custom";
  summaryCodexModel: string;
  summaryClaudeModel: string;
  /**
   * The Codex/Claude summary sources spawn a CLI, so the only lever they have is which config
   * directory it reads. Empty means "follow the machine's own `~/.codex` / `~/.claude`".
   */
  summaryCodexConfigDir: string;
  summaryClaudeConfigDir: string;
  /** Reasoning effort for the summary run itself. */
  summaryReasoningEffort: SummaryReasoningEffort;
  sessionSearchMcpEnabled: boolean;
  skillMcpEnabled: boolean;
  evalMcpEnabled: boolean;
  /**
   * Whether an evaluation script judge may spawn an external command. Inline JS
   * judges run sandboxed and are always allowed; a command is a real process with
   * the user's own privileges, so it stays off until it is turned on.
   */
  evalScriptCommandsEnabled: boolean;
  /** The model AgentRecall calls for its own tasks: experience cards and AI Skill exploration. */
  agentModel: AgentModelConfig;
  /** Background extraction of experience cards from completed Turns; it calls a model, so it starts off. */
  experienceCardsEnabled: boolean;
  /**
   * ISO time extraction was last turned on; only Turns started after it are extracted.
   * Written by the main process when the switch turns on, never by renderer updates.
   */
  experienceCardsEnabledAt: string;
  skillSyncEnabled: boolean;
  skillSyncSupabaseUrl: string;
  skillSyncSupabaseAnonKey: string;
  remoteSyncEnabled: boolean;
  syncSessionAttachments: boolean;
  /** Polling fallback interval for WSL/SSH watchers, in milliseconds. */
  wslPollingIntervalMs: number;
  remoteSyncSupabaseUrl: string;
  remoteSyncSupabaseAnonKey: string;
  apiConfig: ApiConfig;
  claudeApiConfig: ClaudeApiConfig;
  summaryApiConfig: ApiConfig;
}

export type AppSettingsUpdate = Partial<Omit<AppSettings, "apiConfig" | "claudeApiConfig" | "summaryApiConfig" | "experienceCardsEnabledAt">> & {
  apiConfig?: Partial<ApiConfig>;
  claudeApiConfig?: Partial<ClaudeApiConfig>;
  summaryApiConfig?: Partial<ApiConfig>;
};

export const defaultSummaryApiConfig: ApiConfig = {
  ...defaultApiConfig,
  activeProvider: "custom",
  customProviderId: "custom",
  customProviderName: "Custom Codex",
  customApiFormat: "openai_responses",
};

export const defaultSettings: AppSettings = {
  defaultTerminal: defaultTerminalFor(),
  globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
  claudeBinary: "claude",
  codexBinary: "codex",
  stepcodeBinary: "stepcode",
  codeBuddyBinary: "codebuddy",
  codeWizBinary: "codewiz",
  cursorBinary: "cursor-agent",
  tclaudeBinary: "tclaude",
  tcodexBinary: "tcodex",
  includeStepcode: false,
  deepseekBinary: "dsh",
  antigravityCliBinary: "agy",
  ompBinary: "omp",
  includeTclaude: false,
  includeTcodex: false,
  includeCodeBuddyCli: false,
  includeWorkBuddy: false,
  includeCodeWizCli: false,
  includeOpenClaw: false,
  includeHermes: false,
  includeOpenCode: false,
  includeZcode: true,
  includeCursorAgent: false,
  includeTrae: false,
  includeQoder: false,
  includeQoderIde: false,
  includePi: true,
  includeKimiCli: false,
  includeQwenCode: false,
  includeGeminiCli: true,
  includeDeepSeekCli: true,
  includeAntigravity: false,
  includeAntigravityCli: false,
  includeOmp: false,
  evalEnabled: false,
  hideCodexQuota: false,
  hideClaudeQuota: false,
  autoCheckUpdates: true,
  showInDock: true,
  islandEnabled: false,
  islandSoundEnabled: true,
  islandSuppressWhenFocused: true,
  islandAutoCollapseSeconds: 6,
  summaryAutoBackfill: false,
  summaryMaxAgeDays: 30,
  compressionConcurrency: 8,
  migrationCompleteTokenLimit: 100_000,
  summarySource: "codex",
  summaryApiConfigMode: "inherit_codex",
  summaryCodexModel: "",
  summaryClaudeModel: "",
  summaryCodexConfigDir: "",
  summaryClaudeConfigDir: "",
  summaryReasoningEffort: "medium",
  sessionSearchMcpEnabled: true,
  skillMcpEnabled: true,
  evalMcpEnabled: false,
  evalScriptCommandsEnabled: false,
  agentModel: defaultAgentModelConfig,
  experienceCardsEnabled: false,
  experienceCardsEnabledAt: "",
  skillSyncEnabled: false,
  skillSyncSupabaseUrl: "",
  skillSyncSupabaseAnonKey: "",
  remoteSyncEnabled: false,
  syncSessionAttachments: true,
  wslPollingIntervalMs: 60_000,
  remoteSyncSupabaseUrl: "",
  remoteSyncSupabaseAnonKey: "",
  apiConfig: defaultApiConfig,
  claudeApiConfig: defaultClaudeApiConfig,
  summaryApiConfig: defaultSummaryApiConfig,
};

/**
 * Stamps the extraction start time when experience cards turn on. Turns made
 * while extraction was off are never extracted, so turning it on again restarts
 * from the new time.
 */
export function stampExperienceCardsEnabledAt(previous: AppSettings, next: AppSettings, now: Date): AppSettings {
  if (!next.experienceCardsEnabled) return next;
  if (previous.experienceCardsEnabled && previous.experienceCardsEnabledAt) {
    return { ...next, experienceCardsEnabledAt: previous.experienceCardsEnabledAt };
  }
  return { ...next, experienceCardsEnabledAt: now.toISOString() };
}

export function mergeAppSettings(previous: AppSettings, updates: AppSettingsUpdate): AppSettings {
  const {
    hideSubagentSessions: _legacySubagentVisibility,
    // The named provider library is owned by ProviderService, not generic settings updates.
    providerLibrary: _providerLibrary,
    // Runtime channels these features used before they called the AgentRecall model.
    skillAiRuntimeId: _legacySkillAiRuntime,
    experienceCardsChannelId: _legacyExperienceCardsChannel,
    ...combined
  } = { ...previous, ...updates } as AppSettings & {
    hideSubagentSessions?: unknown;
    providerLibrary?: unknown;
    skillAiRuntimeId?: unknown;
    experienceCardsChannelId?: unknown;
  };
  // Settings files written while directory Memory existed still carry its `openViking*` keys.
  // They are dropped here so the next save no longer persists them.
  const legacyMemoryExtractionEffort = (combined as Record<string, unknown>).openVikingExtractionReasoningEffort;
  const merged = Object.fromEntries(
    Object.entries(combined).filter(([key]) => !key.startsWith("openViking")),
  ) as typeof combined;
  return {
    ...merged,
    defaultTerminal: normalizeTerminal(merged.defaultTerminal),
    globalShortcut: normalizeGlobalShortcut(merged.globalShortcut),
    antigravityCliBinary: String(merged.antigravityCliBinary ?? "").trim() || defaultSettings.antigravityCliBinary,
    ompBinary: String(merged.ompBinary ?? "").trim() || defaultSettings.ompBinary,
    summaryMaxAgeDays: normalizeSummaryMaxAgeDays(merged.summaryMaxAgeDays),
    compressionConcurrency: normalizeCompressionConcurrency(merged.compressionConcurrency),
    migrationCompleteTokenLimit: normalizeMigrationCompleteTokenLimit(merged.migrationCompleteTokenLimit),
    autoCheckUpdates: Boolean(merged.autoCheckUpdates),
    evalEnabled: Boolean(merged.evalEnabled),
    evalScriptCommandsEnabled: Boolean(merged.evalScriptCommandsEnabled),
    showInDock: merged.showInDock !== false,
    islandEnabled: Boolean(merged.islandEnabled),
    islandSoundEnabled: merged.islandSoundEnabled !== false,
    islandSuppressWhenFocused: merged.islandSuppressWhenFocused !== false,
    islandAutoCollapseSeconds: normalizeIslandAutoCollapseSeconds(merged.islandAutoCollapseSeconds),
    summarySource: merged.summarySource === "claude" || merged.summarySource === "custom" ? merged.summarySource : "codex",
    summaryApiConfigMode: merged.summaryApiConfigMode === "custom" ? "custom" : "inherit_codex",
    summaryCodexModel: String(merged.summaryCodexModel ?? "").trim(),
    summaryClaudeModel: String(merged.summaryClaudeModel ?? "").trim(),
    summaryCodexConfigDir: String(merged.summaryCodexConfigDir ?? "").trim(),
    summaryClaudeConfigDir: String(merged.summaryClaudeConfigDir ?? "").trim(),
    // Summaries used to ride on the retired memory-extraction effort. A settings file that
    // predates `summaryReasoningEffort` seeds it from that legacy key once.
    summaryReasoningEffort: normalizeSummaryReasoningEffort(
      merged.summaryReasoningEffort ?? legacyMemoryExtractionEffort,
    ),
    agentModel: normalizeAgentModelConfig(merged.agentModel),
    experienceCardsEnabled: Boolean(merged.experienceCardsEnabled),
    experienceCardsEnabledAt: String(merged.experienceCardsEnabledAt ?? ""),
    skillSyncEnabled: Boolean(merged.skillSyncEnabled),
    skillSyncSupabaseUrl: normalizeSupabaseSettingUrl(merged.skillSyncSupabaseUrl),
    skillSyncSupabaseAnonKey: String(merged.skillSyncSupabaseAnonKey ?? "").trim(),
    remoteSyncEnabled: Boolean(merged.remoteSyncEnabled),
    syncSessionAttachments: merged.syncSessionAttachments !== false,
    wslPollingIntervalMs: normalizeWslPollingIntervalMs(merged.wslPollingIntervalMs),
    remoteSyncSupabaseUrl: normalizeSupabaseSettingUrl(merged.remoteSyncSupabaseUrl),
    remoteSyncSupabaseAnonKey: String(merged.remoteSyncSupabaseAnonKey ?? "").trim(),
    apiConfig: normalizeApiConfig({ ...previous.apiConfig, ...(updates.apiConfig ?? {}) }),
    claudeApiConfig: normalizeClaudeApiConfig({ ...previous.claudeApiConfig, ...(updates.claudeApiConfig ?? {}) }),
    summaryApiConfig: normalizeApiConfig({ ...previous.summaryApiConfig, ...(updates.summaryApiConfig ?? {}) }),
  };
}

function normalizeSupabaseSettingUrl(value: string | undefined): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function normalizeSummaryMaxAgeDays(value: number): number {
  if (!Number.isFinite(value) || value < 1) return defaultSettings.summaryMaxAgeDays;
  return Math.min(3650, Math.round(value));
}

function normalizeCompressionConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1) return defaultSettings.compressionConcurrency;
  return Math.min(32, Math.round(value));
}

export function normalizeWslPollingIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return defaultSettings.wslPollingIntervalMs;
  return Math.min(3_600_000, Math.max(5_000, Math.round(value)));
}

function normalizeMigrationCompleteTokenLimit(value: number): number {
  if (!Number.isFinite(value)) return defaultSettings.migrationCompleteTokenLimit;
  return Math.max(10_000, Math.min(1_000_000, Math.round(value)));
}

function normalizeIslandAutoCollapseSeconds(value: number): number {
  if (!Number.isFinite(value)) return defaultSettings.islandAutoCollapseSeconds;
  return Math.max(2, Math.min(30, Math.round(value)));
}
