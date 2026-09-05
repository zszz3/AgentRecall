import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Check, ChevronDown, Eye, EyeOff, X } from "lucide-react";
import {
  API_PROVIDER_PRESETS,
  CLAUDE_API_PROVIDER_PRESETS,
  defaultApiConfig,
  defaultClaudeApiConfig,
  type ApiConfig,
  type ApiProviderPresetId,
  type ClaudeApiConfig,
  type ClaudeApiProviderPresetId,
} from "../../../../core/api-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { ClaudeConfigSnapshot } from "../../../../core/claude-profile";
import type { CodexConfigSnapshot } from "../../../../core/codex-profile";
import { SUMMARY_REASONING_EFFORTS, type SummaryReasoningEffort } from "../../../../core/summary-settings";
import type { SummaryProviderConnectionRequest } from "../../../../shared/ipc/providers";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";

// The summary route is a plain OpenAI-compatible route just like the Codex one, so it
// offers the same presets; only the stored credential differs.
const SUMMARY_API_PROVIDER_PRESETS = API_PROVIDER_PRESETS;

// A Custom route only counts as configured once it carries any of baseUrl/model/apiKey.
function hasSavedCustomRoute(
  config: { activeProvider: string; customBaseUrl: string; customModel: string; customApiKey: string } | null | undefined,
): boolean {
  return config?.activeProvider === "custom"
    && Boolean(config.customBaseUrl.trim() || config.customModel.trim() || config.customApiKey.trim());
}

function providerTargetMatches(
  config: Pick<ApiConfig | ClaudeApiConfig, "activeProvider" | "customProviderId" | "customBaseUrl"> | null | undefined,
  providerId: string,
  baseUrl: string,
): boolean {
  return config?.activeProvider === "custom"
    && config.customProviderId === providerId
    && normalizeProviderBaseUrl(config.customBaseUrl) === normalizeProviderBaseUrl(baseUrl);
}

function buildSummaryDraftFromSettings(settings: AppSettings | null): ApiConfig {
  return settings?.summaryApiConfig ?? { ...defaultApiConfig };
}

function buildSummarySourceFromSettings(settings: AppSettings | null): AppSettings["summarySource"] {
  return settings?.summarySource ?? "codex";
}

export function ApiConfigDialog({
  settings,
  language,
  feedback,
  onSettingsChange,
  onApplyToCodex,
  onApplyToClaude,
  onClose,
}: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onApplyToCodex: (apiConfig: ApiConfig) => void;
  onApplyToClaude: (claudeApiConfig: ClaudeApiConfig) => void;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const saving = feedback?.kind === "running";
  const [apiTarget, setApiTarget] = useState<"codex" | "claude" | "summary">("codex");
  const [showCodexApiKey, setShowCodexApiKey] = useState(false);
  const [showClaudeApiKey, setShowClaudeApiKey] = useState(false);
  const [showSummaryApiKey, setShowSummaryApiKey] = useState(false);
  const [draftApiConfig, setDraftApiConfig] = useState<ApiConfig>(() => settings?.apiConfig ?? { ...defaultApiConfig });
  const [draftClaudeApiConfig, setDraftClaudeApiConfig] = useState<ClaudeApiConfig>(
    () => settings?.claudeApiConfig ?? { ...defaultClaudeApiConfig },
  );
  const [draftSummaryApiConfig, setDraftSummaryApiConfig] = useState<ApiConfig>(() => buildSummaryDraftFromSettings(settings));
  const [draftSummaryApiConfigMode, setDraftSummaryApiConfigMode] = useState<AppSettings["summaryApiConfigMode"]>(
    () => settings?.summaryApiConfigMode ?? "inherit_codex",
  );
  const [draftSummarySource, setDraftSummarySource] = useState<AppSettings["summarySource"]>(() => buildSummarySourceFromSettings(settings));
  const [draftSummaryCodexModel, setDraftSummaryCodexModel] = useState(() => settings?.summaryCodexModel ?? "");
  const [draftSummaryClaudeModel, setDraftSummaryClaudeModel] = useState(() => settings?.summaryClaudeModel ?? "");
  // The Codex and Claude summary sources spawn a CLI, so the only route they can be pointed at is
  // a config directory. Empty means "follow the machine's own", which is also the default.
  const [draftSummaryCodexConfigDir, setDraftSummaryCodexConfigDir] = useState(() => settings?.summaryCodexConfigDir ?? "");
  const [draftSummaryClaudeConfigDir, setDraftSummaryClaudeConfigDir] = useState(() => settings?.summaryClaudeConfigDir ?? "");
  const [draftSummaryReasoningEffort, setDraftSummaryReasoningEffort] = useState<SummaryReasoningEffort>(
    () => settings?.summaryReasoningEffort ?? "medium",
  );
  const [codexConfig, setCodexConfig] = useState<CodexConfigSnapshot | null>(null);
  const [codexConfigError, setCodexConfigError] = useState("");
  const [claudeConfig, setClaudeConfig] = useState<ClaudeConfigSnapshot | null>(null);
  const [claudeConfigError, setClaudeConfigError] = useState("");
  const [selectedCodexConfigProviderId, setSelectedCodexConfigProviderId] = useState("");
  const [selectedClaudeConfigRoute, setSelectedClaudeConfigRoute] = useState("");
  const [codexModelOptions, setCodexModelOptions] = useState<string[]>([]);
  const [codexModelMenuOpen, setCodexModelMenuOpen] = useState(false);
  const [codexModelProbeStatus, setCodexModelProbeStatus] = useState<SettingsFeedback>(null);
  const [codexConnectionStatus, setCodexConnectionStatus] = useState<SettingsFeedback>(null);
  const [claudeModelOptions, setClaudeModelOptions] = useState<string[]>([]);
  const [claudeModelMenuOpen, setClaudeModelMenuOpen] = useState(false);
  const [claudeModelProbeStatus, setClaudeModelProbeStatus] = useState<SettingsFeedback>(null);
  const [claudeConnectionStatus, setClaudeConnectionStatus] = useState<SettingsFeedback>(null);
  const [summaryModelOptions, setSummaryModelOptions] = useState<string[]>([]);
  const [summaryModelMenuOpen, setSummaryModelMenuOpen] = useState(false);
  const [summaryModelProbeStatus, setSummaryModelProbeStatus] = useState<SettingsFeedback>(null);
  const [summaryConnectionStatus, setSummaryConnectionStatus] = useState<SettingsFeedback>(null);
  // The summary sources read their own config directories, so they need snapshots of their own:
  // reusing the tab snapshots would show the Codex tab's route under a summary directory.
  const [summaryCodexConfig, setSummaryCodexConfig] = useState<CodexConfigSnapshot | null>(null);
  const [summaryClaudeConfig, setSummaryClaudeConfig] = useState<ClaudeConfigSnapshot | null>(null);
  const [summaryConfigError, setSummaryConfigError] = useState("");
  const apiPresetSelectionRef = useRef(0);
  const claudeApiPresetSelectionRef = useRef(0);
  const summaryApiPresetSelectionRef = useRef(0);
  const codexConfigHydrationRef = useRef("");
  const claudeConfigHydrationRef = useRef("");
  const codexConnectionTestIdRef = useRef(0);
  const claudeConnectionTestIdRef = useRef(0);
  const summaryConnectionTestIdRef = useRef(0);
  const codexModelProbeIdRef = useRef(0);
  const claudeModelProbeIdRef = useRef(0);
  const summaryModelProbeIdRef = useRef(0);
  const updateDraftApiConfig = (next: Partial<ApiConfig>) => setDraftApiConfig((current) => ({ ...current, ...next }));
  const updateDraftClaudeApiConfig = (next: Partial<ClaudeApiConfig>) => setDraftClaudeApiConfig((current) => ({ ...current, ...next }));
  const codexConnectionSignature = JSON.stringify(draftApiConfig);
  const claudeConnectionSignature = JSON.stringify(draftClaudeApiConfig);
  const codexConnectionSignatureRef = useRef(codexConnectionSignature);
  const claudeConnectionSignatureRef = useRef(claudeConnectionSignature);
  codexConnectionSignatureRef.current = codexConnectionSignature;
  claudeConnectionSignatureRef.current = claudeConnectionSignature;
  const updateDraftSummaryApiConfig = (next: Partial<ApiConfig>) => setDraftSummaryApiConfig((current) => ({ ...current, ...next }));
  const selectedPreset = API_PROVIDER_PRESETS.find((preset) => preset.id === draftApiConfig.customProviderId);
  const customName = selectedPreset?.label ?? (draftApiConfig.customProviderName || "Custom");
  const selectedClaudePreset = CLAUDE_API_PROVIDER_PRESETS.find((preset) => preset.id === draftClaudeApiConfig.customProviderId);
  const customClaudeName = selectedClaudePreset?.label ?? (draftClaudeApiConfig.customProviderName || "Claude Code");
  const activeSummarySource = draftSummarySource;

  const hydrateDraftFromCodexConfig = (snapshot: CodexConfigSnapshot) => {
    // An empty or missing config.toml says nothing about the route the user wants; only an
    // explicit official route should pull the draft back to "Codex Official".
    if (!snapshot.exists) {
      setSelectedCodexConfigProviderId("");
      return;
    }
    const activeProvider = snapshot.providers.find((provider) => provider.id === snapshot.activeProviderId);
    if (!activeProvider || snapshot.activeProviderId === "openai") {
      setSelectedCodexConfigProviderId("");
      setDraftApiConfig((current) => ({ ...current, activeProvider: "official", customApiKey: "" }));
      return;
    }
    const preset = API_PROVIDER_PRESETS.find(
      (item) => item.id !== "custom" && (item.id === activeProvider.id || normalizeProviderBaseUrl(item.baseUrl) === normalizeProviderBaseUrl(activeProvider.baseUrl)),
    );
    const nextProviderId = preset?.id ?? activeProvider.id;
    const nextBaseUrl = activeProvider.baseUrl || preset?.baseUrl || "";
    setSelectedCodexConfigProviderId(preset ? "" : activeProvider.id);
    setDraftApiConfig((current) => ({
      ...current,
      activeProvider: "custom",
      // A preset match must keep the preset's own id, otherwise the preset button stops
      // looking selected and the stored key is looked up under the wrong name.
      customProviderId: nextProviderId,
      customProviderName: preset?.providerName ?? activeProvider.name ?? activeProvider.id,
      customBaseUrl: nextBaseUrl || current.customBaseUrl,
      customApiKey: Boolean(nextBaseUrl) && providerTargetMatches(current, nextProviderId, nextBaseUrl)
        ? current.customApiKey
        : "",
      customModel: snapshot.activeModel || preset?.model || current.customModel,
      customApiFormat: activeProvider.wireApi === "chat" ? "openai_chat" : preset?.apiFormat ?? "openai_responses",
    }));
  };

  const codexConfigHydrationKey = (snapshot: CodexConfigSnapshot) =>
    `${snapshot.configPath}:${snapshot.activeProviderId}:${snapshot.activeModel}:${snapshot.providers.map((provider) => `${provider.id}:${provider.baseUrl}`).join("|")}`;

  const claudeConfigHydrationKey = (snapshot: ClaudeConfigSnapshot) =>
    `${snapshot.settingsPath}:${snapshot.route.activeProvider}:${snapshot.route.customProviderId}:${snapshot.route.customBaseUrl}:${snapshot.route.customModel}`;

  const hydrateDraftFromClaudeConfig = (snapshot: ClaudeConfigSnapshot, configDir?: string) => {
    if (snapshot.route.activeProvider !== "custom") return;
    setSelectedClaudeConfigRoute("config");
    setDraftClaudeApiConfig((current) => {
      const nextProviderId = snapshot.route.customProviderId ?? current.customProviderId;
      const nextBaseUrl = snapshot.route.customBaseUrl ?? current.customBaseUrl;
      return {
        ...current,
        ...snapshot.route,
        customConfigDir: configDir ?? current.customConfigDir,
        customApiKey: providerTargetMatches(current, nextProviderId, nextBaseUrl) ? current.customApiKey : "",
      };
    });
  };

  const selectClaudeConfigRoute = (useConfigRoute: boolean) => {
    setClaudeModelOptions([]);
    setClaudeModelMenuOpen(false);
    // The empty option is the manual route: keep whatever the user typed instead of
    // snapping the select back to the settings.json baseline.
    if (!useConfigRoute) {
      setSelectedClaudeConfigRoute("");
      return;
    }
    if (claudeConfig) hydrateDraftFromClaudeConfig(claudeConfig);
  };

  const selectApiPreset = async (presetId: ApiProviderPresetId) => {
    const selectionId = ++apiPresetSelectionRef.current;
    const preset = API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? API_PROVIDER_PRESETS[0];
    const activeProvider = preset.id === "custom"
      ? codexConfig?.providers.find((provider) => provider.id === codexConfig.activeProviderId)
      : undefined;
    const nextProviderId = activeProvider?.id ?? preset.id;
    const apiKey = preset.id === "custom"
      ? ""
      : await window.sessionSearch.getApiProviderKey("codex", preset.id).catch(() => "");
    if (selectionId !== apiPresetSelectionRef.current) return;
    if (preset.id === "custom") {
      setSelectedCodexConfigProviderId(activeProvider?.id ?? "");
      setDraftApiConfig((current) => {
        const nextBaseUrl = activeProvider?.baseUrl || current.customBaseUrl;
        const reusableKey = providerTargetMatches(current, nextProviderId, nextBaseUrl)
          ? current.customApiKey
          : providerTargetMatches(settings?.apiConfig, nextProviderId, nextBaseUrl)
            ? settings?.apiConfig.customApiKey ?? ""
            : "";
        return {
          ...current,
          activeProvider: "custom",
          customProviderId: nextProviderId,
          customProviderName: activeProvider?.name || current.customProviderName || preset.providerName,
          customBaseUrl: nextBaseUrl,
          customApiKey: reusableKey,
          customModel: codexConfig?.activeModel || current.customModel,
          customApiFormat: activeProvider?.wireApi === "chat" ? "openai_chat" : current.customApiFormat || preset.apiFormat,
        };
      });
    } else {
      setSelectedCodexConfigProviderId("");
      setDraftApiConfig((current) => ({
        ...current,
        activeProvider: "custom",
        customProviderId: preset.id,
        customProviderName: preset.providerName,
        customBaseUrl: preset.baseUrl,
        customApiKey: apiKey,
        customModel: preset.model,
        customApiFormat: preset.apiFormat,
      }));
    }
    setShowCodexApiKey(false);
    setCodexModelOptions([]);
    setCodexModelMenuOpen(false);
  };

  const refreshCodexConfig = async () => {
    setCodexConfigError("");
    try {
      const snapshot = await window.sessionSearch.getCodexConfig({ configDir: draftApiConfig.customConfigDir || undefined });
      setCodexConfig(snapshot);
      const hydrationKey = codexConfigHydrationKey(snapshot);
      if (hydrationKey !== codexConfigHydrationRef.current) {
        codexConfigHydrationRef.current = hydrationKey;
        // A Custom route already saved in-app is the draft baseline. Hydrating over it from
        // config.toml would discard settings the user saved but has not applied yet, so the
        // snapshot then only feeds the "Active config" visualizer.
        if (!hasSavedCustomRoute(settings?.apiConfig)) hydrateDraftFromCodexConfig(snapshot);
      }
    } catch (error) {
      setCodexConfigError(error instanceof Error ? error.message : String(error));
    }
  };

  const refreshClaudeConfig = async () => {
    setClaudeConfigError("");
    try {
      const snapshot = await window.sessionSearch.getClaudeConfig({
        configDir: draftClaudeApiConfig.customConfigDir || undefined,
      });
      setClaudeConfig(snapshot);
      // Re-reading the same settings.json must not overwrite edits the user has not saved.
      const hydrationKey = claudeConfigHydrationKey(snapshot);
      if (hydrationKey !== claudeConfigHydrationRef.current) {
        claudeConfigHydrationRef.current = hydrationKey;
        if (!hasSavedCustomRoute(settings?.claudeApiConfig)) hydrateDraftFromClaudeConfig(snapshot);
      }
    } catch (error) {
      setClaudeConfigError(error instanceof Error ? error.message : String(error));
    }
  };

  const pickConfigDirectory = async (target: "codex" | "claude") => {
    const currentPath = target === "codex" ? draftApiConfig.customConfigDir : draftClaudeApiConfig.customConfigDir;
    const selected = await window.sessionSearch.pickConfigDirectory(target, currentPath || undefined);
    if (!selected) return;
    if (target === "codex") {
      updateDraftApiConfig({ customConfigDir: selected });
      const snapshot = await window.sessionSearch.getCodexConfig({ configDir: selected });
      setCodexConfig(snapshot);
      codexConfigHydrationRef.current = codexConfigHydrationKey(snapshot);
      hydrateDraftFromCodexConfig(snapshot);
    } else {
      updateDraftClaudeApiConfig({ customConfigDir: selected });
      const snapshot = await window.sessionSearch.getClaudeConfig({ configDir: selected });
      setClaudeConfig(snapshot);
      claudeConfigHydrationRef.current = claudeConfigHydrationKey(snapshot);
      hydrateDraftFromClaudeConfig(snapshot, selected);
    }
  };

  const selectCodexConfigProvider = (providerId: string) => {
    setCodexModelOptions([]);
    setCodexModelMenuOpen(false);
    // The empty option is the manual route: drop the baseline and keep whatever the user
    // has typed, instead of snapping the select back to the previous provider.
    if (!providerId) {
      setSelectedCodexConfigProviderId("");
      setDraftApiConfig((current) => ({
        ...current,
        activeProvider: "custom",
        customProviderId: "custom",
        customApiKey: providerTargetMatches(current, "custom", current.customBaseUrl) ? current.customApiKey : "",
      }));
      return;
    }
    const provider = codexConfig?.providers.find((item) => item.id === providerId);
    if (!provider) return;
    setSelectedCodexConfigProviderId(provider.id);
    setDraftApiConfig((current) => ({
      ...current,
      activeProvider: "custom",
      // Keep the config's own id so the credential lookup and the applied config.toml
      // section both point at the provider the user just picked.
      customProviderId: provider.id,
      customProviderName: provider.name || provider.id,
      customBaseUrl: provider.baseUrl,
      customApiKey: providerTargetMatches(current, provider.id, provider.baseUrl) ? current.customApiKey : "",
      customApiFormat: provider.wireApi === "chat" ? "openai_chat" : "openai_responses",
    }));
  };

  const detectCodexModels = async () => {
    const probeId = ++codexModelProbeIdRef.current;
    const probedSignature = codexConnectionSignature;
    setCodexModelProbeStatus({ kind: "running", message: l("Detecting models...", "正在探测模型...") });
    try {
      const configuredProviderId = selectedCodexConfigProviderId || codexConfig?.activeProviderId;
      const configuredProvider = codexConfig?.providers.find((provider) => provider.id === configuredProviderId);
      const providerId = configuredProvider
        && normalizeProviderBaseUrl(configuredProvider.baseUrl) === normalizeProviderBaseUrl(draftApiConfig.customBaseUrl)
        ? configuredProvider.id
        : draftApiConfig.customProviderId;
      const result = await window.sessionSearch.probeCodexModels({
        baseUrl: draftApiConfig.customBaseUrl,
        apiKey: draftApiConfig.customApiKey,
        providerId,
        codexHome: draftApiConfig.customConfigDir || undefined,
        keyTarget: "codex",
      });
      if (probeId !== codexModelProbeIdRef.current || probedSignature !== codexConnectionSignatureRef.current) return;
      setCodexModelOptions(result.models);
      setCodexModelMenuOpen(result.models.length > 0);
      setCodexModelProbeStatus({ kind: "success", message: l(`Found ${result.models.length} models from ${result.endpoint}.`, `已从 ${result.endpoint} 找到 ${result.models.length} 个模型。`) });
    } catch (error) {
      if (probeId !== codexModelProbeIdRef.current || probedSignature !== codexConnectionSignatureRef.current) return;
      setCodexModelProbeStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const detectClaudeModels = async () => {
    const probeId = ++claudeModelProbeIdRef.current;
    const probedSignature = claudeConnectionSignature;
    setClaudeModelProbeStatus({ kind: "running", message: l("Detecting models...", "正在探测模型...") });
    try {
      const result = await window.sessionSearch.probeClaudeModels({
        baseUrl: draftClaudeApiConfig.customBaseUrl,
        apiKey: draftClaudeApiConfig.customApiKey,
        providerId: draftClaudeApiConfig.customProviderId,
        claudeHome: draftClaudeApiConfig.customConfigDir || undefined,
        apiFormat: draftClaudeApiConfig.customApiFormat,
        apiKeyField: draftClaudeApiConfig.customApiKeyField,
      });
      if (probeId !== claudeModelProbeIdRef.current || probedSignature !== claudeConnectionSignatureRef.current) return;
      setClaudeModelOptions(result.models);
      setClaudeModelMenuOpen(result.models.length > 0);
      setClaudeModelProbeStatus({
        kind: "success",
        message: l(
          `Found ${result.models.length} models using ${result.credentialSource}.`,
          `使用 ${result.credentialSource} 找到 ${result.models.length} 个模型。`,
        ),
      });
    } catch (error) {
      if (probeId !== claudeModelProbeIdRef.current || probedSignature !== claudeConnectionSignatureRef.current) return;
      setClaudeModelProbeStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const testCodexConnection = async () => {
    const testId = ++codexConnectionTestIdRef.current;
    const testedSignature = codexConnectionSignature;
    setCodexConnectionStatus({ kind: "running", message: l("Testing Codex connection...", "正在测试 Codex 连接...") });
    try {
      const result = await window.sessionSearch.testProviderConnection({
        target: "codex",
        apiConfig: { ...draftApiConfig },
      });
      if (
        testId !== codexConnectionTestIdRef.current
        || testedSignature !== codexConnectionSignatureRef.current
      ) return;
      setCodexConnectionStatus({
        kind: "success",
        message: l(
          `Codex connection succeeded in ${result.elapsedMs} ms using ${result.credentialSource}.`,
          `Codex 连接成功，使用 ${result.credentialSource}，耗时 ${result.elapsedMs} 毫秒。`,
        ),
      });
    } catch (error) {
      if (
        testId !== codexConnectionTestIdRef.current
        || testedSignature !== codexConnectionSignatureRef.current
      ) return;
      setCodexConnectionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const testClaudeConnection = async () => {
    const testId = ++claudeConnectionTestIdRef.current;
    const testedSignature = claudeConnectionSignature;
    setClaudeConnectionStatus({ kind: "running", message: l("Testing Claude Code connection...", "正在测试 Claude Code 连接...") });
    try {
      const result = await window.sessionSearch.testProviderConnection({
        target: "claude",
        apiConfig: { ...draftClaudeApiConfig },
      });
      if (
        testId !== claudeConnectionTestIdRef.current
        || testedSignature !== claudeConnectionSignatureRef.current
      ) return;
      setClaudeConnectionStatus({
        kind: "success",
        message: l(
          `Claude Code connection succeeded in ${result.elapsedMs} ms using ${result.credentialSource}.`,
          `Claude Code 连接成功，使用 ${result.credentialSource}，耗时 ${result.elapsedMs} 毫秒。`,
        ),
      });
    } catch (error) {
      if (
        testId !== claudeConnectionTestIdRef.current
        || testedSignature !== claudeConnectionSignatureRef.current
      ) return;
      setClaudeConnectionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  // "Inherit Codex" probes and tests the Codex route the user is editing on the Codex tab;
  // "custom" keeps the summary route strictly separate, including its own key store.
  const summaryInheritsCodex = draftSummaryApiConfigMode === "inherit_codex";
  const effectiveSummaryApiConfig = summaryInheritsCodex ? draftApiConfig : draftSummaryApiConfig;
  const summaryClaudeRoute = summaryClaudeConfig?.route ?? {};
  // Everything the connection-test request reads, so editing any of it while a test is in
  // flight marks that test's result stale (same guard pattern as the Codex/Claude tabs).
  const summaryConnectionSignature = JSON.stringify([
    activeSummarySource,
    effectiveSummaryApiConfig,
    summaryClaudeRoute.customBaseUrl,
    summaryClaudeRoute.customProviderId,
    summaryClaudeRoute.customModel,
    summaryClaudeRoute.customApiFormat,
    summaryClaudeRoute.customApiKeyField,
    draftSummaryClaudeModel,
    draftSummaryClaudeConfigDir,
    summaryCodexConfig?.activeProvider?.baseUrl,
    summaryCodexConfig?.activeProviderId,
    summaryCodexConfig?.activeModel,
    summaryCodexConfig?.activeProvider?.wireApi,
    draftSummaryCodexModel,
    draftSummaryCodexConfigDir,
  ]);
  const summaryConnectionSignatureRef = useRef(summaryConnectionSignature);
  summaryConnectionSignatureRef.current = summaryConnectionSignature;
  const summaryCodexModelOptions = [...new Set([
    draftSummaryCodexModel.trim(),
    summaryCodexConfig?.activeModel.trim() ?? "",
    ...(summaryCodexConfig?.availableModels ?? []),
  ].filter(Boolean))];

  const refreshSummaryConfig = async () => {
    setSummaryConfigError("");
    try {
      if (activeSummarySource === "claude") {
        setSummaryClaudeConfig(await window.sessionSearch.getClaudeConfig({
          configDir: draftSummaryClaudeConfigDir || undefined,
        }));
        return;
      }
      setSummaryCodexConfig(await window.sessionSearch.getCodexConfig({
        configDir: (activeSummarySource === "codex"
          ? draftSummaryCodexConfigDir
          : effectiveSummaryApiConfig.customConfigDir) || undefined,
      }));
    } catch (error) {
      setSummaryConfigError(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * Separate from `pickConfigDirectory` on purpose: that one hydrates the Codex/Claude tab drafts
   * from the chosen directory, and choosing a directory for summaries must never rewrite the
   * route the user is editing on another tab.
   */
  const pickSummaryConfigDirectory = async () => {
    const current = activeSummarySource === "claude"
      ? draftSummaryClaudeConfigDir
      : activeSummarySource === "codex"
        ? draftSummaryCodexConfigDir
        : draftSummaryApiConfig.customConfigDir;
    const selected = await window.sessionSearch.pickConfigDirectory("summary", current || undefined);
    if (!selected) return;
    if (activeSummarySource === "claude") setDraftSummaryClaudeConfigDir(selected);
    else if (activeSummarySource === "codex") setDraftSummaryCodexConfigDir(selected);
    else updateDraftSummaryApiConfig({ customConfigDir: selected });
  };

  const selectSummarySource = (source: AppSettings["summarySource"]) => {
    setDraftSummarySource(source);
    // Probe results and statuses describe the previous source's route; keeping them on screen
    // would read as if they applied to the one now selected.
    setSummaryModelOptions([]);
    setSummaryModelMenuOpen(false);
    setSummaryModelProbeStatus(null);
    setSummaryConnectionStatus(null);
  };

  const detectSummaryModels = async () => {
    const probeId = ++summaryModelProbeIdRef.current;
    const probedSignature = summaryConnectionSignature;
    setSummaryModelProbeStatus({ kind: "running", message: l("Detecting models...", "正在探测模型...") });
    try {
      const result = activeSummarySource === "claude"
        ? await window.sessionSearch.probeClaudeModels({
            baseUrl: summaryClaudeRoute.customBaseUrl ?? "",
            apiKey: "",
            providerId: summaryClaudeRoute.customProviderId,
            claudeHome: draftSummaryClaudeConfigDir || undefined,
            apiFormat: summaryClaudeRoute.customApiFormat ?? "anthropic",
            apiKeyField: summaryClaudeRoute.customApiKeyField ?? "ANTHROPIC_AUTH_TOKEN",
            keyTarget: "summary",
          })
        : activeSummarySource === "codex"
          ? await window.sessionSearch.probeCodexModels({
              baseUrl: summaryCodexConfig?.activeProvider?.baseUrl ?? "",
              apiKey: "",
              providerId: summaryCodexConfig?.activeProviderId,
              codexHome: draftSummaryCodexConfigDir || undefined,
              keyTarget: "summary",
            })
          : await window.sessionSearch.probeCodexModels({
              baseUrl: effectiveSummaryApiConfig.customBaseUrl,
              apiKey: effectiveSummaryApiConfig.customApiKey,
              providerId: effectiveSummaryApiConfig.customProviderId,
              codexHome: effectiveSummaryApiConfig.customConfigDir || undefined,
              keyTarget: summaryInheritsCodex ? "codex" : "summary",
            });
      if (probeId !== summaryModelProbeIdRef.current || probedSignature !== summaryConnectionSignatureRef.current) return;
      setSummaryModelOptions(result.models);
      setSummaryModelMenuOpen(result.models.length > 0);
      setSummaryModelProbeStatus({
        kind: "success",
        message: l(
          `Found ${result.models.length} models using ${result.credentialSource}.`,
          `使用 ${result.credentialSource} 找到 ${result.models.length} 个模型。`,
        ),
      });
    } catch (error) {
      if (probeId !== summaryModelProbeIdRef.current || probedSignature !== summaryConnectionSignatureRef.current) return;
      setSummaryModelProbeStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const testSummaryConnection = async () => {
    const testId = ++summaryConnectionTestIdRef.current;
    const testedSignature = summaryConnectionSignature;
    setSummaryConnectionStatus({ kind: "running", message: l("Testing connection...", "正在测试连接...") });
    try {
      const config = effectiveSummaryApiConfig;
      const request: SummaryProviderConnectionRequest = activeSummarySource === "claude"
        ? {
            source: "claude",
            baseUrl: summaryClaudeRoute.customBaseUrl ?? "",
            apiKey: "",
            providerId: summaryClaudeRoute.customProviderId,
            model: draftSummaryClaudeModel.trim() || summaryClaudeRoute.customModel || "",
            apiFormat: summaryClaudeRoute.customApiFormat ?? "anthropic",
            apiKeyField: summaryClaudeRoute.customApiKeyField ?? "ANTHROPIC_AUTH_TOKEN",
            configDir: draftSummaryClaudeConfigDir || undefined,
          }
        : activeSummarySource === "codex"
          ? {
              source: "codex",
              baseUrl: summaryCodexConfig?.activeProvider?.baseUrl ?? "",
              apiKey: "",
              providerId: summaryCodexConfig?.activeProviderId,
              model: draftSummaryCodexModel.trim() || summaryCodexConfig?.activeModel || "",
              apiFormat: summaryCodexConfig?.activeProvider?.wireApi === "chat" ? "openai_chat" : "openai_responses",
              configDir: draftSummaryCodexConfigDir || undefined,
            }
          : {
              source: "custom",
              baseUrl: config.customBaseUrl,
              apiKey: config.customApiKey,
              providerId: config.customProviderId,
              model: config.customModel,
              apiFormat: config.customApiFormat,
              codexHome: config.customConfigDir || undefined,
              inherit: summaryInheritsCodex,
            };
      const result = await window.sessionSearch.testSummaryProviderConnection(request);
      if (
        testId !== summaryConnectionTestIdRef.current
        || testedSignature !== summaryConnectionSignatureRef.current
      ) return;
      setSummaryConnectionStatus({
        kind: "success",
        message: l(
          `Connection succeeded in ${result.elapsedMs} ms using ${result.credentialSource}.`,
          `连接成功，使用 ${result.credentialSource}，耗时 ${result.elapsedMs} 毫秒。`,
        ),
      });
    } catch (error) {
      if (
        testId !== summaryConnectionTestIdRef.current
        || testedSignature !== summaryConnectionSignatureRef.current
      ) return;
      setSummaryConnectionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * One shape for all three summary sources so the panel can render a single sequence of rows.
   * The sources differ only in where each row's value lives and whether it is editable: the Codex
   * and Claude sources drive a CLI, whose sole lever is the config directory it reads, so their
   * Base URL / API Key / API format are read-only echoes of that directory rather than fields.
   */
  const summaryView = ((): {
    separate: boolean;
    setSeparate: (separate: boolean) => void;
    followLabel: string;
    separateLabel: string;
    routeHint: string;
    configDir: string;
    setConfigDir: (value: string) => void;
    configDirEditable: boolean;
    configDirPlaceholder: string;
    configPath: string;
    baseUrl: string;
    baseUrlEditable: boolean;
    baseUrlPlaceholder: string;
    model: string;
    setModel: (value: string) => void;
    modelEditable: boolean;
    modelPlaceholder: string;
    modelOptions: string[];
    apiKey: string;
    apiKeyEditable: boolean;
    apiKeyHint: string;
    apiFormat: string;
    apiFormatEditable: boolean;
    apiFormatOptions: Array<{ value: string; label: string }>;
    reasoningEnabled: boolean;
    reasoningHint: string;
  } => {
    const openAiFormats = [
      { value: "openai_chat", label: "OpenAI Chat Completions" },
      { value: "openai_responses", label: "OpenAI Responses API" },
    ];
    const probed = summaryModelOptions;

    if (activeSummarySource === "claude") {
      const separate = Boolean(draftSummaryClaudeConfigDir);
      const resolvedHome = summaryClaudeConfig?.claudeHome || "~/.claude";
      return {
        separate,
        setSeparate: (next) => setDraftSummaryClaudeConfigDir(next ? resolvedHome : ""),
        followLabel: l("Follow this machine's Claude config", "跟随本机 Claude 配置"),
        separateLabel: l("Separate config directory", "独立配置目录"),
        routeHint: separate
          ? l(
              "Summaries run the Claude CLI against the directory below. The Claude Code tab is untouched.",
              "摘要会让 Claude CLI 读取下方目录运行，不影响 Claude Code 标签页。",
            )
          : l(
              "Summaries run the Claude CLI against this machine's own config, exactly as `claude` would.",
              "摘要会让 Claude CLI 使用本机自身配置运行，与直接执行 `claude` 一致。",
            ),
        configDir: draftSummaryClaudeConfigDir,
        setConfigDir: setDraftSummaryClaudeConfigDir,
        configDirEditable: separate,
        configDirPlaceholder: resolvedHome,
        configPath: summaryClaudeConfig?.settingsPath ?? "~/.claude/settings.json",
        baseUrl: summaryClaudeRoute.customBaseUrl ?? "",
        baseUrlEditable: false,
        baseUrlPlaceholder: l("Official Anthropic route", "Anthropic 官方路径"),
        model: draftSummaryClaudeModel,
        setModel: setDraftSummaryClaudeModel,
        modelEditable: true,
        modelPlaceholder: summaryClaudeRoute.customModel || l("Follow the config file", "跟随配置文件"),
        modelOptions: [...new Set([...probed, summaryClaudeRoute.customModel ?? ""].filter(Boolean))],
        apiKey: summaryClaudeConfig?.hasApiKey ? "••••••••••••" : "",
        apiKeyEditable: false,
        apiKeyHint: summaryClaudeConfig?.hasApiKey
          ? l(
              `Resolved from ${summaryClaudeConfig.credentialSource ?? "the config directory"}; never copied into this app.`,
              `由 ${summaryClaudeConfig.credentialSource ?? "配置目录"} 解析，不会复制到本应用。`,
            )
          : l(
              "No key found in that directory or the environment. Configure it on the Claude Code tab.",
              "该目录与环境变量中未找到密钥。请在 Claude Code 标签页配置。",
            ),
        apiFormat: summaryClaudeRoute.customApiFormat ?? "anthropic",
        apiFormatEditable: false,
        apiFormatOptions: [
          { value: "anthropic", label: "Anthropic Messages" },
          ...openAiFormats,
          { value: "gemini_native", label: "Gemini Native" },
        ],
        // Verified against `claudeExecCompletion`: the Claude CLI exposes no reasoning or
        // thinking switch, so offering one here would promise behaviour it cannot deliver.
        reasoningEnabled: false,
        reasoningHint: l(
          "Claude Code has no equivalent parameter, so this is fixed.",
          "Claude Code 没有对应参数，此项固定不可调。",
        ),
      };
    }

    if (activeSummarySource === "codex") {
      const separate = Boolean(draftSummaryCodexConfigDir);
      const resolvedHome = summaryCodexConfig?.codexHome || "~/.codex";
      return {
        separate,
        setSeparate: (next) => setDraftSummaryCodexConfigDir(next ? resolvedHome : ""),
        followLabel: l("Follow this machine's Codex config", "跟随本机 Codex 配置"),
        separateLabel: l("Separate config directory", "独立配置目录"),
        routeHint: separate
          ? l(
              "Summaries run the Codex CLI against the directory below. The Codex tab is untouched.",
              "摘要会让 Codex CLI 读取下方目录运行，不影响 Codex 标签页。",
            )
          : l(
              "Summaries run the Codex CLI against this machine's own config, exactly as `codex` would.",
              "摘要会让 Codex CLI 使用本机自身配置运行，与直接执行 `codex` 一致。",
            ),
        configDir: draftSummaryCodexConfigDir,
        setConfigDir: setDraftSummaryCodexConfigDir,
        configDirEditable: separate,
        configDirPlaceholder: resolvedHome,
        configPath: summaryCodexConfig?.configPath ?? "~/.codex/config.toml",
        baseUrl: summaryCodexConfig?.activeProvider?.baseUrl ?? "",
        baseUrlEditable: false,
        baseUrlPlaceholder: l("Official OpenAI route", "OpenAI 官方路径"),
        model: draftSummaryCodexModel,
        setModel: setDraftSummaryCodexModel,
        modelEditable: true,
        modelPlaceholder: summaryCodexConfig?.activeModel || l("Follow the config file", "跟随配置文件"),
        modelOptions: [...new Set([...probed, ...summaryCodexModelOptions].filter(Boolean))],
        apiKey: summaryCodexConfig?.hasApiKey ? "••••••••••••" : "",
        apiKeyEditable: false,
        apiKeyHint: summaryCodexConfig?.hasApiKey
          ? l(
              `Resolved from ${summaryCodexConfig.credentialSource ?? "the config directory"}; never copied into this app.`,
              `由 ${summaryCodexConfig.credentialSource ?? "配置目录"} 解析，不会复制到本应用。`,
            )
          : l(
              "No key found in that directory or the environment. Configure it on the Codex tab.",
              "该目录与环境变量中未找到密钥。请在 Codex 标签页配置。",
            ),
        apiFormat: summaryCodexConfig?.activeProvider?.wireApi === "chat" ? "openai_chat" : "openai_responses",
        apiFormatEditable: false,
        apiFormatOptions: openAiFormats,
        reasoningEnabled: true,
        reasoningHint: l("Higher levels are slower but analyze more deeply.", "等级越高，分析越深入，但速度也越慢。"),
      };
    }

    return {
      separate: !summaryInheritsCodex,
      setSeparate: (next) => setDraftSummaryApiConfigMode(next ? "custom" : "inherit_codex"),
      followLabel: l("Follow the Codex custom route", "跟随 Codex 自定义路径"),
      separateLabel: l("Separate summary route", "独立的摘要路径"),
      routeHint: summaryInheritsCodex
        ? l(
            "Summaries reuse the Codex tab's base URL, model, and credential, including the keys found in the Codex config. Switch to a separate route to edit the fields below.",
            "摘要会复用 Codex 标签页的 Base URL、模型和凭证（含 Codex 配置里识别到的密钥）。切换为独立路径后才能编辑下方字段。",
          )
        : l(
            "Summaries use only the fields below and their own stored key. The Codex route is left untouched.",
            "摘要只使用下方字段和它自己保存的密钥，不会影响 Codex 路径。",
          ),
      configDir: effectiveSummaryApiConfig.customConfigDir,
      setConfigDir: (value) => updateDraftSummaryApiConfig({ customConfigDir: value }),
      configDirEditable: !summaryInheritsCodex,
      configDirPlaceholder: "~/.codex",
      configPath: summaryCodexConfig?.configPath ?? "~/.codex/config.toml",
      baseUrl: effectiveSummaryApiConfig.customBaseUrl,
      baseUrlEditable: !summaryInheritsCodex,
      baseUrlPlaceholder: "https://api.deepseek.com",
      model: effectiveSummaryApiConfig.customModel,
      setModel: (value) => updateDraftSummaryApiConfig({ customModel: value }),
      modelEditable: !summaryInheritsCodex,
      modelPlaceholder: "deepseek-v4-flash",
      modelOptions: probed,
      apiKey: effectiveSummaryApiConfig.customApiKey,
      apiKeyEditable: !summaryInheritsCodex,
      apiKeyHint: summaryInheritsCodex
        ? l(
            "Resolved from the Codex route, including its config, auth.json, and environment variables.",
            "由 Codex 路径解析，含其配置、auth.json 和环境变量。",
          )
        : l("Stored locally for the summary route only.", "仅为摘要路径保存在本地。"),
      apiFormat: effectiveSummaryApiConfig.customApiFormat,
      apiFormatEditable: !summaryInheritsCodex,
      apiFormatOptions: openAiFormats,
      reasoningEnabled: true,
      reasoningHint: l(
        "Leave on the model default unless the gateway is known to accept a reasoning level.",
        "除非确认网关接受推理参数，否则保持“跟随模型默认”。",
      ),
    };
  })();

  /**
   * `resolveSummaryEndpointFromSettings` silently falls back to Codex when the selected source
   * cannot produce a complete endpoint, so a half-configured route reports no error at all and
   * quietly summarizes with a different provider. Say so here instead.
   */
  const summaryFallbackWarning = activeSummarySource === "custom"
    && !summaryInheritsCodex
    && !(effectiveSummaryApiConfig.customBaseUrl.trim() && effectiveSummaryApiConfig.customModel.trim())
    ? l(
        "This route is incomplete, so summaries will silently fall back to Codex. Fill in both the base URL and the model.",
        "该路径尚未填写完整，摘要会静默回退到 Codex。请同时填写 Base URL 与模型。",
      )
    : "";

  const selectClaudeApiPreset = async (presetId: ClaudeApiProviderPresetId) => {
    const selectionId = ++claudeApiPresetSelectionRef.current;
    const preset = CLAUDE_API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? CLAUDE_API_PROVIDER_PRESETS[0];
    const apiKey = preset.id === "custom"
      ? ""
      : await window.sessionSearch.getApiProviderKey("claude", preset.id).catch(() => "");
    if (selectionId !== claudeApiPresetSelectionRef.current) return;
    setDraftClaudeApiConfig((current) => {
      if (preset.id === "custom") {
        // Seed empty fields from the manual route in ~/.claude/settings.json so a
        // hand-configured third-party provider becomes the Custom baseline.
        const route = claudeConfig?.route.activeProvider === "custom" ? claudeConfig.route : null;
        const nextProviderId = route?.customProviderId ?? "custom";
        const nextBaseUrl = current.customBaseUrl || route?.customBaseUrl || "";
        const reusableKey = providerTargetMatches(current, nextProviderId, nextBaseUrl)
          ? current.customApiKey
          : providerTargetMatches(settings?.claudeApiConfig, nextProviderId, nextBaseUrl)
            ? settings?.claudeApiConfig.customApiKey ?? ""
            : "";
        return {
          ...current,
          activeProvider: "custom",
          customProviderId: nextProviderId,
          customProviderName: current.customProviderName || route?.customProviderName || preset.providerName,
          customBaseUrl: nextBaseUrl,
          customApiKey: reusableKey,
          customModel: current.customModel || route?.customModel || "",
          customHaikuModel: current.customHaikuModel || route?.customHaikuModel || "",
          customSonnetModel: current.customSonnetModel || route?.customSonnetModel || "",
          customOpusModel: current.customOpusModel || route?.customOpusModel || "",
          customApiFormat: route?.customApiFormat ?? current.customApiFormat,
          customApiKeyField: route?.customApiKeyField ?? current.customApiKeyField,
        };
      }
      return {
        ...current,
        activeProvider: "custom",
        customProviderId: preset.id,
        customProviderName: preset.providerName,
        customBaseUrl: preset.baseUrl,
        customApiKey: apiKey,
        customModel: preset.model,
        customHaikuModel: preset.haikuModel,
        customSonnetModel: preset.sonnetModel,
        customOpusModel: preset.opusModel,
        customApiFormat: preset.apiFormat,
        customApiKeyField: preset.apiKeyField,
      };
    });
    setShowClaudeApiKey(false);
    setClaudeModelOptions([]);
    setClaudeModelMenuOpen(false);
    if (preset.id !== "custom") setSelectedClaudeConfigRoute("");
  };

  const selectSummaryPreset = async (presetId: ApiProviderPresetId) => {
    const selectionId = ++summaryApiPresetSelectionRef.current;
    const preset = SUMMARY_API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? SUMMARY_API_PROVIDER_PRESETS[0];
    if (!preset) return;
    const apiKey = await window.sessionSearch.getApiProviderKey("summary", preset.id).catch(() => "");
    if (selectionId !== summaryApiPresetSelectionRef.current) return;
    const current = draftSummaryApiConfig;
    const next: ApiConfig = preset.id === "custom"
      ? {
          ...current,
          activeProvider: "custom",
          customProviderId: "custom",
          customProviderName: current.customProviderName || preset.providerName,
          customApiKey: apiKey || current.customApiKey,
        }
      : {
          ...current,
          activeProvider: "custom",
          customProviderId: preset.id,
          customProviderName: preset.providerName,
          customBaseUrl: preset.baseUrl,
          customApiKey: apiKey,
          customModel: preset.model,
          customApiFormat: preset.apiFormat,
        };
    setDraftSummaryApiConfig(next);
    setDraftSummarySource("custom");
    // Picking a preset here is an explicit statement that the summary route is its own
    // thing; without this the draft keeps inheriting Codex and the fields do nothing.
    setDraftSummaryApiConfigMode("custom");
    setShowSummaryApiKey(false);
    setSummaryModelOptions([]);
    setSummaryModelMenuOpen(false);
    setSummaryModelProbeStatus(null);
    setSummaryConnectionStatus(null);
  };

  // Every save hands back a freshly built settings object, so comparing by identity would
  // discard the draft the user is still editing. Compare by value instead.
  const settingsSignature = JSON.stringify([
    settings?.apiConfig,
    settings?.claudeApiConfig,
    settings?.summaryApiConfig,
    settings?.summaryApiConfigMode,
    settings?.summaryCodexModel,
    settings?.summaryClaudeModel,
    settings?.summaryCodexConfigDir,
    settings?.summaryClaudeConfigDir,
    settings?.summarySource,
    settings?.summaryReasoningEffort,
  ]);
  useEffect(() => {
    setDraftApiConfig(settings?.apiConfig ?? { ...defaultApiConfig });
    setDraftClaudeApiConfig(settings?.claudeApiConfig ?? { ...defaultClaudeApiConfig });
    setDraftSummaryApiConfig(buildSummaryDraftFromSettings(settings));
    setDraftSummaryApiConfigMode(settings?.summaryApiConfigMode ?? "inherit_codex");
    setDraftSummarySource(buildSummarySourceFromSettings(settings));
    setDraftSummaryCodexModel(settings?.summaryCodexModel ?? "");
    setDraftSummaryClaudeModel(settings?.summaryClaudeModel ?? "");
    setDraftSummaryCodexConfigDir(settings?.summaryCodexConfigDir ?? "");
    setDraftSummaryClaudeConfigDir(settings?.summaryClaudeConfigDir ?? "");
    setDraftSummaryReasoningEffort(settings?.summaryReasoningEffort ?? "medium");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsSignature]);

  useEffect(() => {
    codexConnectionTestIdRef.current += 1;
    codexModelProbeIdRef.current += 1;
    setCodexConnectionStatus(null);
    setCodexModelProbeStatus(null);
  }, [codexConnectionSignature]);

  useEffect(() => {
    claudeConnectionTestIdRef.current += 1;
    claudeModelProbeIdRef.current += 1;
    setClaudeConnectionStatus(null);
    setClaudeModelProbeStatus(null);
  }, [claudeConnectionSignature]);

  useEffect(() => {
    summaryConnectionTestIdRef.current += 1;
    summaryModelProbeIdRef.current += 1;
    setSummaryConnectionStatus(null);
    setSummaryModelProbeStatus(null);
  }, [summaryConnectionSignature]);

  useEffect(() => {
    // Re-read whenever the directory changes, otherwise the pane keeps showing the config
    // of the previously typed path. Debounced so typing a path is not one fetch per key.
    const timer = window.setTimeout(() => {
      if (apiTarget === "codex") void refreshCodexConfig();
      if (apiTarget === "claude") void refreshClaudeConfig();
      if (apiTarget === "summary") void refreshSummaryConfig();
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    apiTarget,
    draftApiConfig.customConfigDir,
    draftClaudeApiConfig.customConfigDir,
    activeSummarySource,
    draftSummaryCodexConfigDir,
    draftSummaryClaudeConfigDir,
    draftSummaryApiConfig.customConfigDir,
  ]);

  const runCodexAction = (action: "save" | "apply") => {
    const next = draftApiConfig;
    if (action === "save") {
      onSettingsChange({ apiConfig: next });
    } else {
      onApplyToCodex(next);
      window.setTimeout(() => void refreshCodexConfig(), 600);
    }
  };

  const saveDraft = () => {
    if (apiTarget === "codex") {
      runCodexAction("save");
    } else if (apiTarget === "claude") {
      onSettingsChange({ claudeApiConfig: draftClaudeApiConfig });
    } else {
      onSettingsChange({
        summarySource: draftSummarySource,
        summaryApiConfigMode: draftSummaryApiConfigMode,
        summaryCodexModel: draftSummaryCodexModel,
        summaryClaudeModel: draftSummaryClaudeModel,
        summaryCodexConfigDir: draftSummaryCodexConfigDir,
        summaryClaudeConfigDir: draftSummaryClaudeConfigDir,
        summaryReasoningEffort: draftSummaryReasoningEffort,
        summaryApiConfig: draftSummaryApiConfig,
      });
    }
  };

  const applyDraft = () => {
    if (apiTarget === "codex") {
      runCodexAction("apply");
    } else if (apiTarget === "claude") {
      onApplyToClaude(draftClaudeApiConfig);
      window.setTimeout(() => void refreshClaudeConfig(), 600);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog api-config-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("API configuration", "API 配置")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <div className="api-target-tabs" role="tablist" aria-label={l("API target", "API 目标")}>
          <button type="button" className={apiTarget === "codex" ? "active" : ""} onClick={() => setApiTarget("codex")}>
            Codex
          </button>
          <button type="button" className={apiTarget === "claude" ? "active" : ""} onClick={() => setApiTarget("claude")}>
            Claude Code
          </button>
          <button type="button" className={apiTarget === "summary" ? "active" : ""} onClick={() => setApiTarget("summary")}>
            {l("AI Summary & Search", "AI 摘要与搜索")}
          </button>
        </div>
        <div className="api-config-body">
          {apiTarget === "codex" ? (
            <section className="settings-pane api-settings-form">
              <header className="settings-pane-head">
                <h3>{l("Codex providers", "Codex 供应商")}</h3>
                <p>
                  {l(
                    "Switch Codex between the official account and common OpenAI-compatible routes.",
                    "在 Codex 官网账号和常用 OpenAI-compatible 路径之间切换。",
                  )}
                </p>
              </header>
              <div className="codex-config-visualizer">
                <div>
                  <span>{l("Active config", "当前配置")}</span>
                  <strong>{codexConfig?.activeProviderId ?? "openai"}</strong>
                  <em>{codexConfig?.activeModel || l("Default model", "默认模型")}</em>
                </div>
                <div>
                  <span>{l("Config file", "配置文件")}</span>
                  <strong>{codexConfig?.configPath ?? "~/.codex/config.toml"}</strong>
                  <em>{codexConfigError || (codexConfig?.exists ? l(`${codexConfig.providers.length} providers`, `${codexConfig.providers.length} 个供应商`) : l("Not created yet", "尚未创建"))}</em>
                </div>
              </div>
              <label className="settings-field">
                <div className="settings-field-text">
                  <span className="settings-field-title">{l("Config directory", "配置目录")}</span>
                  <span className="settings-field-sub">{l("Leave empty to use ~/.codex.", "留空使用 ~/.codex。")}</span>
                </div>
                <div className="provider-path-input">
                  <input
                    type="text"
                    value={draftApiConfig.customConfigDir}
                    disabled={!settings || saving}
                    placeholder="~/.codex"
                    onChange={(event) => updateDraftApiConfig({ customConfigDir: event.currentTarget.value })}
                  />
                  <button type="button" disabled={!settings || saving} onClick={() => void pickConfigDirectory("codex")}>
                    {l("Browse", "选择")}
                  </button>
                  <button
                    type="button"
                    disabled={!settings || saving || !draftApiConfig.customConfigDir}
                    onClick={() => updateDraftApiConfig({ customConfigDir: "" })}
                  >
                    {l("Default", "默认")}
                  </button>
                </div>
              </label>
              <div
                className="api-provider-switch codex-provider-switch"
                role="group"
                aria-label={l("Codex provider", "Codex 供应商")}
                data-provider-labels="Codex Official CodexZH DeepSeek GLM LongCat Kimi MiMo Custom"
              >
                <button
                  type="button"
                  className={draftApiConfig.activeProvider === "official" ? "active" : ""}
                  disabled={!settings || saving}
                  onClick={() => {
                    apiPresetSelectionRef.current += 1;
                    updateDraftApiConfig({ activeProvider: "official" });
                  }}
                >
                  <strong>Codex Official</strong>
                  <span>{l("Use existing official Codex auth.", "使用现有 Codex 官网认证。")}</span>
                </button>
                {API_PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={draftApiConfig.activeProvider === "custom" && draftApiConfig.customProviderId === preset.id ? "active" : ""}
                    disabled={!settings || saving}
                    onClick={() => void selectApiPreset(preset.id)}
                  >
                    <strong>{preset.label}</strong>
                    <span>{preset.model || l("Manual route", "手动配置")}</span>
                  </button>
                ))}
              </div>
              {draftApiConfig.activeProvider === "official" ? (
                <div className="api-config-note">
                  {l(
                    "Apply clears Codex route fields in ~/.codex/config.toml so Codex uses its default official route, and preserves auth.json.",
                    "应用时会清理 ~/.codex/config.toml 里的 Codex 路由字段，让 Codex 使用默认官网路由，并保留现有 auth.json。",
                  )}
                </div>
              ) : null}
              {draftApiConfig.activeProvider === "custom" ? (
                <>
                  <div className="api-config-note">
                    {!selectedPreset || selectedPreset.id === "custom"
                      ? l(
                          "Apply writes this custom route into the Codex config.toml and refreshes auth.json with the resolved key.",
                          "应用时会把这个自定义路径写入 Codex config.toml，并用识别到的密钥刷新 auth.json。",
                        )
                      : l(
                          `Apply merges the ${customName} route into the Codex config.toml and refreshes auth.json with the resolved key.`,
                          `应用时会把 ${customName} 路由合并到 Codex config.toml，并用识别到的密钥刷新 auth.json。`,
                        )}
                  </div>
                  {codexConfig?.providers.some((provider) => provider.id !== "openai") ? (
                    <label className="settings-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">{l("Config provider", "配置供应商")}</span>
                        <span className="settings-field-sub">
                          {l("Choose an existing config.toml provider as the baseline, or keep the manual route below.", "选择 config.toml 里的现有供应商作为基线，或保留下方的手动路径。")}
                        </span>
                      </div>
                      <select
                        value={selectedCodexConfigProviderId}
                        disabled={!settings || saving}
                        onChange={(event) => selectCodexConfigProvider(event.currentTarget.value)}
                      >
                        <option value="">{l("Manual custom route", "手动自定义路径")}</option>
                        {codexConfig.providers.filter((provider) => provider.id !== "openai").map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name || provider.id}{provider.baseUrl ? ` · ${provider.baseUrl}` : ""}{provider.envKey ? ` · ${provider.envKey}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Provider name", "供应商名称")}</span>
                      <span className="settings-field-sub">{l("Display name for this custom Codex route.", "这个自定义 Codex 路径的显示名称。")}</span>
                    </div>
                    <input
                      type="text"
                      value={draftApiConfig.customProviderName}
                      disabled={!settings || saving}
                      placeholder="CodexZH"
                      onChange={(event) => updateDraftApiConfig({ customProviderName: event.currentTarget.value })}
                    />
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">Base URL</span>
                      <span className="settings-field-sub">
                        {l("OpenAI-compatible endpoint, usually ending in /v1.", "OpenAI-compatible 接口地址，通常以 /v1 结尾。")}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={draftApiConfig.customBaseUrl}
                      disabled={!settings || saving}
                      placeholder="https://api.example.com/v1"
                      onChange={(event) => {
                        setSelectedCodexConfigProviderId("");
                        updateDraftApiConfig({
                          customProviderId: "custom",
                          customBaseUrl: event.currentTarget.value,
                          customApiKey: "",
                        });
                      }}
                    />
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">API Key</span>
                      <span className="settings-field-sub">
                        {draftApiConfig.customApiKey
                          ? l("Using the key entered here.", "使用此处输入的密钥。")
                          : codexConfig?.hasApiKey
                            ? l(`Detected from ${codexConfig.credentialSource ?? "Codex config"}.`, `已从 ${codexConfig.credentialSource ?? "Codex 配置"} 识别。`)
                            : l("No key detected. AgentRecall also checks Codex config, auth.json, and environment variables.", "未识别到密钥；AgentRecall 还会检查 Codex 配置、auth.json 和环境变量。")}
                      </span>
                    </div>
                    <div className="secret-input">
                      <input
                        type={showCodexApiKey ? "text" : "password"}
                        value={draftApiConfig.customApiKey}
                        disabled={!settings || saving}
                        onChange={(event) => updateDraftApiConfig({ customApiKey: event.currentTarget.value })}
                      />
                      <button
                        type="button"
                        onClick={() => setShowCodexApiKey((current) => !current)}
                        disabled={!settings || saving}
                        aria-label={showCodexApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                        title={showCodexApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                      >
                        {showCodexApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </label>
                  <div className="settings-field codex-model-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Model", "模型")}</span>
                      <span className="settings-field-sub">{l("Type a model name, or detect /v1/models and pick from the suggestions.", "输入模型名称，或探测 /v1/models 后从建议中选择。")}</span>
                    </div>
                    <div
                      className="codex-model-input"
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCodexModelMenuOpen(false);
                      }}
                    >
                      <div className="codex-model-combo">
                        <input
                          type="text"
                          value={draftApiConfig.customModel}
                          disabled={!settings || saving}
                          placeholder="gpt-5.5"
                          onChange={(event) => updateDraftApiConfig({ customModel: event.currentTarget.value })}
                          onFocus={() => {
                            if (codexModelOptions.length > 0) setCodexModelMenuOpen(true);
                          }}
                        />
                        <button
                          type="button"
                          className="codex-model-toggle"
                          disabled={!settings || saving || codexModelOptions.length === 0}
                          aria-label={l("Show detected models", "显示探测到的模型")}
                          aria-expanded={codexModelMenuOpen}
                          onClick={() => setCodexModelMenuOpen((open) => !open)}
                        >
                          <ChevronDown size={15} />
                        </button>
                        {codexModelMenuOpen && codexModelOptions.length > 0 ? (
                          <div className="codex-model-menu" onMouseDown={(event) => event.preventDefault()}>
                            {codexModelOptions.map((model) => (
                              <button
                                type="button"
                                key={model}
                                className={`codex-model-option${model === draftApiConfig.customModel ? " selected" : ""}`}
                                onClick={() => {
                                  updateDraftApiConfig({ customModel: model });
                                  setCodexModelMenuOpen(false);
                                }}
                                title={model}
                              >
                                <span className="codex-model-option-label">{model}</span>
                                {model === draftApiConfig.customModel ? <Check size={14} /> : null}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="codex-model-detect-button"
                        disabled={!settings || saving || codexModelProbeStatus?.kind === "running"}
                        onClick={() => void detectCodexModels()}
                      >
                        {l("Detect models", "探测模型")}
                      </button>
                    </div>
                    {codexModelProbeStatus ? <div className={`api-config-status ${codexModelProbeStatus.kind}`}>{codexModelProbeStatus.message}</div> : null}
                  </div>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("API format", "API 格式")}</span>
                      <span className="settings-field-sub">
                        {l(
                          "Responses routes are applied directly; Chat routes use the local Codex proxy.",
                          "Responses 路径会直连写入；Chat 路径会通过本地 Codex proxy。",
                        )}
                      </span>
                    </div>
                    <select
                      value={draftApiConfig.customApiFormat}
                      disabled={!settings || saving}
                      onChange={(event) => updateDraftApiConfig({ customApiFormat: event.currentTarget.value as ApiConfig["customApiFormat"] })}
                    >
                      <option value="openai_chat">OpenAI Chat Completions</option>
                      <option value="openai_responses">OpenAI Responses API</option>
                    </select>
                  </label>
                  {draftApiConfig.customApiFormat === "openai_chat" ? (
                    <div className="api-config-note">
                      {l(
                        "Applying this provider starts a local proxy at 127.0.0.1:15721 and points Codex at its Responses endpoint.",
                        "应用这个供应商时会启动 127.0.0.1:15721 本地 proxy，并让 Codex 连接它的 Responses 端点。",
                      )}
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : apiTarget === "claude" ? (
            <section className="settings-pane api-settings-form">
              <header className="settings-pane-head">
                <h3>{l("Claude Code providers", "Claude Code 供应商")}</h3>
                <p>
                  {l(
                    "Switch Claude Code between official auth and common Anthropic-compatible routes.",
                    "在 Claude 官方认证和常用 Anthropic-compatible 路径之间切换。",
                  )}
                </p>
              </header>
              <div className="codex-config-visualizer">
                <div>
                  <span>{l("Active route", "当前路由")}</span>
                  <strong>
                    {claudeConfig?.route.activeProvider === "custom"
                      ? claudeConfig.route.customProviderName || l("Custom route", "自定义路径")
                      : l("Official", "官方认证")}
                  </strong>
                  <em>
                    {claudeConfig?.route.activeProvider === "custom"
                      ? claudeConfig.route.customModel || claudeConfig.route.customBaseUrl || ""
                      : l("Default Anthropic route", "默认 Anthropic 路由")}
                  </em>
                </div>
                <div>
                  <span>{l("Config file", "配置文件")}</span>
                  <strong>{claudeConfig?.settingsPath ?? "~/.claude/settings.json"}</strong>
                  <em>{claudeConfigError || (claudeConfig?.exists ? l("Detected", "已检测到") : l("Not created yet", "尚未创建"))}</em>
                </div>
                <div>
                  <span>{l("Credential", "凭证")}</span>
                  <strong>{claudeConfig?.hasApiKey ? l("Detected", "已识别") : l("Not detected", "未识别")}</strong>
                  <em>{claudeConfig?.credentialSource ?? l("Enter a key or choose another directory", "输入密钥或选择其他目录")}</em>
                </div>
              </div>
              <label className="settings-field">
                <div className="settings-field-text">
                  <span className="settings-field-title">{l("Config directory", "配置目录")}</span>
                  <span className="settings-field-sub">{l("Leave empty to use ~/.claude.", "留空使用 ~/.claude。")}</span>
                </div>
                <div className="provider-path-input">
                  <input
                    type="text"
                    value={draftClaudeApiConfig.customConfigDir}
                    disabled={!settings || saving}
                    placeholder="~/.claude"
                    onChange={(event) => updateDraftClaudeApiConfig({ customConfigDir: event.currentTarget.value })}
                  />
                  <button type="button" disabled={!settings || saving} onClick={() => void pickConfigDirectory("claude")}>
                    {l("Browse", "选择")}
                  </button>
                  <button
                    type="button"
                    disabled={!settings || saving || !draftClaudeApiConfig.customConfigDir}
                    onClick={() => updateDraftClaudeApiConfig({ customConfigDir: "" })}
                  >
                    {l("Default", "默认")}
                  </button>
                </div>
              </label>
              <div
                className="api-provider-switch api-provider-switch--compact"
                role="group"
                aria-label={l("Claude Code provider", "Claude Code 供应商")}
                data-provider-labels="Claude Official Custom DeepSeek GLM LongCat Kimi MiMo"
              >
                <button
                  type="button"
                  className={draftClaudeApiConfig.activeProvider === "official" ? "active" : ""}
                  disabled={!settings || saving}
                  onClick={() => {
                    claudeApiPresetSelectionRef.current += 1;
                    updateDraftClaudeApiConfig({ activeProvider: "official" });
                  }}
                >
                  <strong>Claude Official</strong>
                  <span>{l("Use existing Claude Code auth.", "使用现有 Claude Code 官方认证。")}</span>
                </button>
                {CLAUDE_API_PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={draftClaudeApiConfig.activeProvider === "custom" && draftClaudeApiConfig.customProviderId === preset.id ? "active" : ""}
                    disabled={!settings || saving}
                    onClick={() => void selectClaudeApiPreset(preset.id)}
                  >
                    <strong>{preset.label}</strong>
                    <span>{preset.model || l("Manual route", "手动配置")}</span>
                  </button>
                ))}
              </div>
              {draftClaudeApiConfig.activeProvider === "official" ? (
                <div className="api-config-note">
                  {l(
                    "Apply clears third-party route env keys in ~/.claude/settings.json and keeps other Claude settings.",
                    "应用时会清理 ~/.claude/settings.json 里的第三方路由 env，并保留其他 Claude 设置。",
                  )}
                </div>
              ) : null}
              {draftClaudeApiConfig.activeProvider === "custom" ? (
                <>
                  <div className="api-config-note">
                    {l(
                      `Apply writes ${customClaudeName} route env into the Claude settings.json.`,
                      `应用时会把 ${customClaudeName} 路由 env 写入 Claude settings.json。`,
                    )}
                  </div>
                  {claudeConfig?.route.activeProvider === "custom" && claudeConfig.route.customBaseUrl ? (
                    <label className="settings-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">{l("Config route", "配置路径")}</span>
                        <span className="settings-field-sub">
                          {l("Use the route already in settings.json as the baseline, or keep the manual route below.", "使用 settings.json 里的现有路径作为基线，或保留下方的手动路径。")}
                        </span>
                      </div>
                      <select
                        value={selectedClaudeConfigRoute}
                        disabled={!settings || saving}
                        onChange={(event) => selectClaudeConfigRoute(event.currentTarget.value === "config")}
                      >
                        <option value="">{l("Manual custom route", "手动自定义路径")}</option>
                        <option value="config">{claudeConfig.route.customBaseUrl}</option>
                      </select>
                    </label>
                  ) : null}
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Provider name", "供应商名称")}</span>
                      <span className="settings-field-sub">
                        {l("Display name for this Claude Code route.", "这个 Claude Code 路径的显示名称。")}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={draftClaudeApiConfig.customProviderName}
                      disabled={!settings || saving}
                      placeholder="Custom Claude"
                      onChange={(event) => updateDraftClaudeApiConfig({ customProviderName: event.currentTarget.value })}
                    />
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">Base URL</span>
                      <span className="settings-field-sub">
                        {l("Anthropic-compatible endpoint for Claude Code.", "Claude Code 使用的 Anthropic-compatible 接口地址。")}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={draftClaudeApiConfig.customBaseUrl}
                      disabled={!settings || saving}
                      placeholder="https://api.example.com/anthropic"
                      onChange={(event) => {
                        setSelectedClaudeConfigRoute("");
                        updateDraftClaudeApiConfig({
                          customProviderId: "custom",
                          customBaseUrl: event.currentTarget.value,
                          customApiKey: "",
                        });
                      }}
                    />
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">API Key</span>
                      <span className="settings-field-sub">
                        {draftClaudeApiConfig.customApiKey
                          ? l("Using the key entered here.", "使用此处输入的密钥。")
                          : claudeConfig?.hasApiKey
                            ? l(`Detected from ${claudeConfig.credentialSource ?? "Claude settings"}.`, `已从 ${claudeConfig.credentialSource ?? "Claude 设置"} 识别。`)
                            : l("No key detected yet.", "尚未识别到密钥。")}
                      </span>
                    </div>
                    <div className="secret-input">
                      <input
                        type={showClaudeApiKey ? "text" : "password"}
                        value={draftClaudeApiConfig.customApiKey}
                        disabled={!settings || saving}
                        onChange={(event) => updateDraftClaudeApiConfig({ customApiKey: event.currentTarget.value })}
                      />
                      <button
                        type="button"
                        onClick={() => setShowClaudeApiKey((current) => !current)}
                        disabled={!settings || saving}
                        aria-label={showClaudeApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                        title={showClaudeApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                      >
                        {showClaudeApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </label>
                  <div className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Model", "模型")}</span>
                      <span className="settings-field-sub">{l("Primary Claude Code model. Namespaced IDs are preserved.", "Claude Code 主模型；完整保留带命名空间的 ID。")}</span>
                    </div>
                    <div className="codex-model-input">
                      <div className="codex-model-combo">
                        <input
                          type="text"
                          value={draftClaudeApiConfig.customModel}
                          disabled={!settings || saving}
                          placeholder="claude-sonnet-4.6"
                          onFocus={() => setClaudeModelMenuOpen(claudeModelOptions.length > 0)}
                          onBlur={() => window.setTimeout(() => setClaudeModelMenuOpen(false), 100)}
                          onChange={(event) => updateDraftClaudeApiConfig({ customModel: event.currentTarget.value })}
                        />
                        <button
                          type="button"
                          className="codex-model-toggle"
                          disabled={!settings || saving || claudeModelOptions.length === 0}
                          aria-label={l("Show detected models", "显示探测到的模型")}
                          aria-expanded={claudeModelMenuOpen}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => setClaudeModelMenuOpen((current) => !current)}
                        >
                          <ChevronDown size={15} />
                        </button>
                        {claudeModelMenuOpen && claudeModelOptions.length > 0 ? (
                          <div className="codex-model-menu" role="listbox">
                            {claudeModelOptions.map((model) => (
                              <button
                                type="button"
                                key={model}
                                role="option"
                                aria-selected={model === draftClaudeApiConfig.customModel}
                                className={`codex-model-option${model === draftClaudeApiConfig.customModel ? " selected" : ""}`}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  updateDraftClaudeApiConfig({ customModel: model });
                                  setClaudeModelMenuOpen(false);
                                }}
                                title={model}
                              >
                                <span className="codex-model-option-label">{model}</span>
                                {model === draftClaudeApiConfig.customModel ? <Check size={14} /> : null}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="codex-model-detect-button"
                        disabled={!settings || saving || claudeModelProbeStatus?.kind === "running"}
                        onClick={() => void detectClaudeModels()}
                      >
                        {l("Detect models", "探测模型")}
                      </button>
                    </div>
                    {claudeModelProbeStatus ? <div className={`api-config-status ${claudeModelProbeStatus.kind}`}>{claudeModelProbeStatus.message}</div> : null}
                  </div>
                  <div className="api-model-grid">
                    <label className="settings-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">Haiku</span>
                      </div>
                      <input
                        type="text"
                        value={draftClaudeApiConfig.customHaikuModel}
                        disabled={!settings || saving}
                        placeholder={draftClaudeApiConfig.customModel || "haiku model"}
                        onChange={(event) => updateDraftClaudeApiConfig({ customHaikuModel: event.currentTarget.value })}
                      />
                    </label>
                    <label className="settings-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">Sonnet</span>
                      </div>
                      <input
                        type="text"
                        value={draftClaudeApiConfig.customSonnetModel}
                        disabled={!settings || saving}
                        placeholder={draftClaudeApiConfig.customModel || "sonnet model"}
                        onChange={(event) => updateDraftClaudeApiConfig({ customSonnetModel: event.currentTarget.value })}
                      />
                    </label>
                    <label className="settings-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">Opus</span>
                      </div>
                      <input
                        type="text"
                        value={draftClaudeApiConfig.customOpusModel}
                        disabled={!settings || saving}
                        placeholder={draftClaudeApiConfig.customModel || "opus model"}
                        onChange={(event) => updateDraftClaudeApiConfig({ customOpusModel: event.currentTarget.value })}
                      />
                    </label>
                  </div>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("API format", "API 格式")}</span>
                      <span className="settings-field-sub">
                        {l(
                          "Anthropic-compatible relays keep the default; pick another only when the route speaks a different protocol.",
                          "Anthropic-compatible 中转保持默认；只有路径使用其他协议时才需要更改。",
                        )}
                      </span>
                    </div>
                    <select
                      value={draftClaudeApiConfig.customApiFormat}
                      disabled={!settings || saving}
                      onChange={(event) =>
                        updateDraftClaudeApiConfig({ customApiFormat: event.currentTarget.value as ClaudeApiConfig["customApiFormat"] })
                      }
                    >
                      <option value="anthropic">Anthropic Messages</option>
                      <option value="openai_chat">OpenAI Chat Completions</option>
                      <option value="openai_responses">OpenAI Responses API</option>
                      <option value="gemini_native">Gemini Native</option>
                    </select>
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Key env", "Key 环境变量")}</span>
                      <span className="settings-field-sub">
                        {l("Most Claude Code routes use ANTHROPIC_AUTH_TOKEN.", "大多数 Claude Code 路径使用 ANTHROPIC_AUTH_TOKEN。")}
                      </span>
                    </div>
                    <select
                      value={draftClaudeApiConfig.customApiKeyField}
                      disabled={!settings || saving}
                      onChange={(event) =>
                        updateDraftClaudeApiConfig({ customApiKeyField: event.currentTarget.value as ClaudeApiConfig["customApiKeyField"] })
                      }
                    >
                      <option value="ANTHROPIC_AUTH_TOKEN">ANTHROPIC_AUTH_TOKEN</option>
                      <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option>
                    </select>
                  </label>
                </>
              ) : null}
            </section>
          ) : (
            <section className="settings-pane api-settings-form">
              <header className="settings-pane-head">
                <h3>{l("AI summary & search source", "AI 摘要与搜索来源")}</h3>
                <p>
                  {l(
                    "Powers both AI session summaries and the AI session finder. Choose Codex or Claude Code, or call an API provider directly. Direct API providers such as DeepSeek and GLM do not create agent sessions.",
                    "同时驱动 AI 会话摘要和 AI 找会话。选择 Codex / Claude Code，或直接调用 API 供应商。DeepSeek、GLM 等直接 API 不会创建 agent session。",
                  )}
                </p>
              </header>
              <div className="api-provider-switch summary-provider-switch" role="group" aria-label={l("AI summary & search source", "AI 摘要与搜索来源")}>
                <button
                  type="button"
                  className={activeSummarySource === "codex" ? "active" : ""}
                  disabled={!settings || saving}
                  onClick={() => selectSummarySource("codex")}
                >
                  <strong>Codex</strong>
                  <span>{l("Prefer the current local Codex config.", "优先使用当前本机 Codex 配置。")}</span>
                </button>
                <button
                  type="button"
                  className={activeSummarySource === "claude" ? "active" : ""}
                  disabled={!settings || saving}
                  onClick={() => selectSummarySource("claude")}
                >
                  <strong>Claude Code</strong>
                  <span>{l("Fallback to the current local Claude config.", "回退到当前本机 Claude 配置。")}</span>
                </button>
                {SUMMARY_API_PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={activeSummarySource === "custom" && draftSummaryApiConfig.customProviderId === preset.id ? "active" : ""}
                    disabled={!settings || saving}
                    onClick={() => void selectSummaryPreset(preset.id)}
                  >
                    <strong>{preset.label}</strong>
                    <span>{preset.model || l("Manual route", "手动配置")}</span>
                  </button>
                ))}
              </div>
              {/*
                All three sources render the same eight rows in the same order. Only the values,
                placeholders, and which rows are editable differ — see `summaryView`.
              */}
              <label className="settings-field" data-summary-row="route-config">
                <div className="settings-field-text">
                  <span className="settings-field-title">{l("Route config", "路径配置")}</span>
                  <span className="settings-field-sub">{summaryView.routeHint}</span>
                </div>
                <select
                  value={summaryView.separate ? "separate" : "follow"}
                  disabled={!settings || saving}
                  onChange={(event) => summaryView.setSeparate(event.currentTarget.value === "separate")}
                >
                  <option value="follow">{summaryView.followLabel}</option>
                  <option value="separate">{summaryView.separateLabel}</option>
                </select>
              </label>
              <label className="settings-field" data-summary-row="config-dir">
                <div className="settings-field-text">
                  <span className="settings-field-title">{l("Config directory", "配置目录")}</span>
                  <span className="settings-field-sub">{summaryView.configPath}</span>
                </div>
                <div className="provider-path-input">
                  <input
                    type="text"
                    value={summaryView.configDir}
                    disabled={!settings || saving || !summaryView.configDirEditable}
                    placeholder={summaryView.configDirPlaceholder}
                    onChange={(event) => summaryView.setConfigDir(event.currentTarget.value)}
                  />
                  <button
                    type="button"
                    disabled={!settings || saving || !summaryView.configDirEditable}
                    onClick={() => void pickSummaryConfigDirectory()}
                  >
                    {l("Browse", "选择")}
                  </button>
                  <button
                    type="button"
                    disabled={!settings || saving || !summaryView.configDirEditable || !summaryView.configDir}
                    onClick={() => summaryView.setConfigDir("")}
                  >
                    {l("Default", "默认")}
                  </button>
                </div>
              </label>
              <label className="settings-field" data-summary-row="base-url">
                <div className="settings-field-text">
                  <span className="settings-field-title">Base URL</span>
                  <span className="settings-field-sub">
                    {summaryView.baseUrlEditable
                      ? l("OpenAI-compatible endpoint.", "OpenAI-compatible 接口地址。")
                      : l("Read from the config directory above; edit it on that agent's own tab.", "从上方配置目录读取；如需修改请到对应标签页。")}
                  </span>
                </div>
                <input
                  type="text"
                  value={summaryView.baseUrl}
                  disabled={!settings || saving || !summaryView.baseUrlEditable}
                  placeholder={summaryView.baseUrlPlaceholder}
                  onChange={(event) => updateDraftSummaryApiConfig({
                    customProviderId: "custom",
                    customBaseUrl: event.currentTarget.value,
                    customApiKey: "",
                  })}
                />
              </label>
              <div className="settings-field" data-summary-row="model">
                <div className="settings-field-text">
                  <span className="settings-field-title">{l("Model", "模型")}</span>
                  <span className="settings-field-sub">
                    {l(
                      "Used by AI summaries, AI search, and memory extraction.",
                      "用于 AI 摘要、AI 搜索和记忆提取。",
                    )}
                  </span>
                </div>
                <div className="summary-model-control">
                  <div className="codex-model-input">
                    <div className="codex-model-combo">
                      <input
                        type="text"
                        value={summaryView.model}
                        disabled={!settings || saving || !summaryView.modelEditable}
                        placeholder={summaryView.modelPlaceholder}
                        aria-expanded={summaryModelMenuOpen}
                        onFocus={() => setSummaryModelMenuOpen(summaryView.modelOptions.length > 0)}
                        onBlur={() => window.setTimeout(() => setSummaryModelMenuOpen(false), 100)}
                        onChange={(event) => {
                          summaryView.setModel(event.currentTarget.value);
                          setSummaryModelMenuOpen(summaryView.modelOptions.length > 0);
                        }}
                      />
                      <button
                        type="button"
                        className="codex-model-toggle"
                        disabled={!settings || saving || !summaryView.modelEditable || summaryView.modelOptions.length === 0}
                        aria-label={l("Show detected models", "显示探测到的模型")}
                        aria-expanded={summaryModelMenuOpen}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => setSummaryModelMenuOpen((current) => !current)}
                      >
                        <ChevronDown size={15} />
                      </button>
                      {summaryModelMenuOpen && summaryView.modelOptions.length > 0 ? (
                        <div className="codex-model-menu" role="listbox">
                          {summaryView.modelOptions.map((model) => (
                            <button
                              type="button"
                              key={model}
                              role="option"
                              aria-selected={model === summaryView.model}
                              className={`codex-model-option${model === summaryView.model ? " selected" : ""}`}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                summaryView.setModel(model);
                                setSummaryModelMenuOpen(false);
                              }}
                              title={model}
                            >
                              <span className="codex-model-option-label">{model}</span>
                              {model === summaryView.model ? <Check size={14} /> : null}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="provider-model-actions">
                      <button
                        type="button"
                        className="codex-model-detect-button"
                        disabled={!settings || saving || summaryModelProbeStatus?.kind === "running"}
                        onClick={() => void detectSummaryModels()}
                      >
                        {l("Detect models", "探测模型")}
                      </button>
                      <button
                        type="button"
                        className="codex-model-detect-button"
                        disabled={!settings || saving || summaryConnectionStatus?.kind === "running"}
                        onClick={() => void testSummaryConnection()}
                      >
                        {l("Test connection", "测试连接")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <label className="settings-field" data-summary-row="api-key">
                <div className="settings-field-text">
                  <span className="settings-field-title">API Key</span>
                  <span className="settings-field-sub">{summaryView.apiKeyHint}</span>
                </div>
                <div className="secret-input">
                  <input
                    type={showSummaryApiKey ? "text" : "password"}
                    value={summaryView.apiKey}
                    disabled={!settings || saving || !summaryView.apiKeyEditable}
                    onChange={(event) => updateDraftSummaryApiConfig({ customApiKey: event.currentTarget.value })}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSummaryApiKey((current) => !current)}
                    disabled={!settings || saving}
                    aria-label={showSummaryApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                    title={showSummaryApiKey ? l("Hide API key", "隐藏 API Key") : l("Show API key", "显示 API Key")}
                  >
                    {showSummaryApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </label>
              <label className="settings-field" data-summary-row="api-format">
                <div className="settings-field-text">
                  <span className="settings-field-title">{l("API format", "API 格式")}</span>
                  <span className="settings-field-sub">
                    {summaryView.apiFormatEditable
                      ? l("Most direct API providers use Chat Completions.", "大多数直接 API 供应商使用 Chat Completions。")
                      : l("Derived from the config directory above.", "由上方配置目录推导。")}
                  </span>
                </div>
                <select
                  value={summaryView.apiFormat}
                  disabled={!settings || saving || !summaryView.apiFormatEditable}
                  onChange={(event) =>
                    updateDraftSummaryApiConfig({ customApiFormat: event.currentTarget.value as ApiConfig["customApiFormat"] })
                  }
                >
                  {summaryView.apiFormatOptions.map((option) => (
                    <option value={option.value} key={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="settings-field" data-summary-row="reasoning-effort">
                <div className="settings-field-text">
                  <span className="settings-field-title">{l("Reasoning effort", "推理强度")}</span>
                  <span className="settings-field-sub">{summaryView.reasoningHint}</span>
                </div>
                <select
                  value={draftSummaryReasoningEffort}
                  disabled={!settings || saving || !summaryView.reasoningEnabled}
                  onChange={(event) => setDraftSummaryReasoningEffort(event.currentTarget.value as SummaryReasoningEffort)}
                >
                  {SUMMARY_REASONING_EFFORTS.map((effort) => (
                    <option value={effort} key={effort || "model-default"}>
                      {effort || l("Follow the model default", "跟随模型默认")}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings-field" data-summary-row="status">
                <div className="settings-field-text">
                  <span className="settings-field-title">{l("Status", "状态提示")}</span>
                  <span className="settings-field-sub">
                    {l("Results of the last probe and connection test.", "最近一次探测与连接测试的结果。")}
                  </span>
                </div>
                <div className="summary-status-stack" aria-live="polite">
                  {summaryConfigError ? <div className="api-config-status error">{summaryConfigError}</div> : null}
                  {summaryFallbackWarning ? <div className="api-config-status error">{summaryFallbackWarning}</div> : null}
                  {summaryModelProbeStatus ? (
                    <div className={`api-config-status ${summaryModelProbeStatus.kind}`}>{summaryModelProbeStatus.message}</div>
                  ) : null}
                  {summaryConnectionStatus ? (
                    <div className={`api-config-status ${summaryConnectionStatus.kind}`}>{summaryConnectionStatus.message}</div>
                  ) : null}
                  {!summaryConfigError && !summaryFallbackWarning && !summaryModelProbeStatus && !summaryConnectionStatus ? (
                    <div className="api-config-status">{l("Not tested yet.", "尚未测试。")}</div>
                  ) : null}
                </div>
              </div>
            </section>
          )}
        </div>
        <div className="dialog-actions api-config-actions">
          <div className="api-config-feedback" aria-live="polite">
            {feedback ? <span className={`api-config-status ${feedback.kind}`}>{feedback.message}</span> : null}
            {apiTarget === "codex" && codexConnectionStatus ? (
              <span className={`api-config-status ${codexConnectionStatus.kind}`}>{codexConnectionStatus.message}</span>
            ) : null}
            {apiTarget === "claude" && claudeConnectionStatus ? (
              <span className={`api-config-status ${claudeConnectionStatus.kind}`}>{claudeConnectionStatus.message}</span>
            ) : null}
          </div>
          {apiTarget === "codex" ? (
            <button
              type="button"
              data-provider-connection-test="codex"
              disabled={!settings || saving || codexConnectionStatus?.kind === "running"}
              onClick={() => void testCodexConnection()}
            >
              {codexConnectionStatus?.kind === "running"
                ? l("Testing connection...", "正在测试连接...")
                : l("Test connection", "测试连接")}
            </button>
          ) : apiTarget === "claude" ? (
            <button
              type="button"
              data-provider-connection-test="claude"
              disabled={!settings || saving || claudeConnectionStatus?.kind === "running"}
              onClick={() => void testClaudeConnection()}
            >
              {claudeConnectionStatus?.kind === "running"
                ? l("Testing connection...", "正在测试连接...")
                : l("Test connection", "测试连接")}
            </button>
          ) : null}
          <button type="button" className={apiTarget === "summary" ? "primary-action" : ""} disabled={!settings || saving} onClick={saveDraft}>
            {apiTarget === "summary"
              ? l("Save summary settings", "保存摘要设置")
              : apiTarget === "codex"
              ? l("Save in app only", "仅保存到应用")
              : l("Save in app only", "仅保存到应用")}
          </button>
          {apiTarget === "summary" ? null : (
            <button type="button" className="primary-action" disabled={!settings || saving} onClick={applyDraft}>
              {apiTarget === "codex"
                ? l("Write to Codex config", "写入 Codex 配置")
                : l("Write to Claude Code settings", "写入 Claude Code 设置")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}
