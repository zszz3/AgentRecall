import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
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
import { OPENVIKING_EXTRACTION_REASONING_EFFORTS } from "../../../../core/openviking-settings";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";

const SUMMARY_API_PROVIDER_PRESETS = API_PROVIDER_PRESETS.filter((preset) => preset.id !== "codexzh");

function summaryFromCustomCodex(config: ApiConfig | undefined, base: ApiConfig): ApiConfig | null {
  if (
    config?.activeProvider !== "custom" ||
    (!config.customBaseUrl.trim() && !config.customModel.trim() && !config.customApiKey.trim())
  ) {
    return null;
  }
  return {
    ...base,
    ...config,
    activeProvider: "custom",
    customProviderId: "custom",
  };
}

function summaryFromCustomClaude(config: ClaudeApiConfig | undefined, base: ApiConfig): ApiConfig | null {
  if (
    config?.activeProvider !== "custom" ||
    (!config.customBaseUrl.trim() && !config.customModel.trim() && !config.customApiKey.trim())
  ) {
    return null;
  }
  return {
    ...base,
    activeProvider: "custom",
    customProviderId: "custom",
    customProviderName: config.customProviderName.trim() || "Custom Claude",
    customBaseUrl: config.customBaseUrl,
    customApiKey: config.customApiKey,
    customModel: config.customModel,
    customApiFormat:
      config.customApiFormat === "openai_chat" || config.customApiFormat === "openai_responses"
        ? config.customApiFormat
        : "openai_chat",
  };
}

function buildSummaryDraftFromSettings(settings: AppSettings | null): ApiConfig {
  return settings?.summaryApiConfig ?? { ...defaultApiConfig };
}

function buildSummarySourceFromSettings(settings: AppSettings | null): AppSettings["summarySource"] {
  return settings?.summarySource ?? "codex";
}

export function ProviderPage({
  settings,
  language,
  feedback,
  onSettingsChange,
  onApplyToCodex,
  onApplyToClaude,
}: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
  onApplyToCodex: (apiConfig: ApiConfig) => void;
  onApplyToClaude: (claudeApiConfig: ClaudeApiConfig) => void;
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
  const [draftSummaryCodexReasoningEffort, setDraftSummaryCodexReasoningEffort] = useState(
    () => settings?.openVikingExtractionReasoningEffort ?? "medium",
  );
  const [codexConfig, setCodexConfig] = useState<CodexConfigSnapshot | null>(null);
  const [codexConfigError, setCodexConfigError] = useState("");
  const [selectedCodexConfigProviderId, setSelectedCodexConfigProviderId] = useState("");
  const [codexModelOptions, setCodexModelOptions] = useState<string[]>([]);
  const [codexModelMenuOpen, setCodexModelMenuOpen] = useState(false);
  const [codexModelProbeStatus, setCodexModelProbeStatus] = useState<SettingsFeedback>(null);
  const [claudeConfig, setClaudeConfig] = useState<ClaudeConfigSnapshot | null>(null);
  const [claudeConfigError, setClaudeConfigError] = useState("");
  const [claudeModelOptions, setClaudeModelOptions] = useState<string[]>([]);
  const [claudeModelMenuOpen, setClaudeModelMenuOpen] = useState(false);
  const [claudeModelProbeStatus, setClaudeModelProbeStatus] = useState<SettingsFeedback>(null);
  const [summaryModelOptions, setSummaryModelOptions] = useState<string[]>([]);
  const [summaryModelMenuOpen, setSummaryModelMenuOpen] = useState(false);
  const [summaryModelProbeStatus, setSummaryModelProbeStatus] = useState<SettingsFeedback>(null);
  const [summaryConnectionStatus, setSummaryConnectionStatus] = useState<SettingsFeedback>(null);
  const apiPresetSelectionRef = useRef(0);
  const claudeApiPresetSelectionRef = useRef(0);
  const summaryApiPresetSelectionRef = useRef(0);
  const codexConfigHydrationRef = useRef("");
  const updateDraftApiConfig = (next: Partial<ApiConfig>) => setDraftApiConfig((current) => ({ ...current, ...next }));
  const updateDraftClaudeApiConfig = (next: Partial<ClaudeApiConfig>) => setDraftClaudeApiConfig((current) => ({ ...current, ...next }));
  const updateDraftSummaryApiConfig = (next: Partial<ApiConfig>) => setDraftSummaryApiConfig((current) => ({ ...current, ...next }));
  const selectedPreset = API_PROVIDER_PRESETS.find((preset) => preset.id === draftApiConfig.customProviderId) ?? API_PROVIDER_PRESETS[0];
  const customName = selectedPreset?.label ?? (draftApiConfig.customProviderName || "CodexZH");
  const selectedClaudePreset =
    CLAUDE_API_PROVIDER_PRESETS.find((preset) => preset.id === draftClaudeApiConfig.customProviderId) ?? CLAUDE_API_PROVIDER_PRESETS[0];
  const customClaudeName = selectedClaudePreset?.label ?? (draftClaudeApiConfig.customProviderName || "Claude Code");
  const activeSummarySource = draftSummarySource;
  const selectedSummaryPreset = useMemo(
    () => SUMMARY_API_PROVIDER_PRESETS.find((preset) => preset.id === draftSummaryApiConfig.customProviderId) ?? SUMMARY_API_PROVIDER_PRESETS[SUMMARY_API_PROVIDER_PRESETS.length - 1],
    [draftSummaryApiConfig.customProviderId],
  );
  const summaryCodexModelOptions = useMemo(
    () => [...new Set([
      draftSummaryCodexModel.trim(),
      codexConfig?.activeModel.trim() ?? "",
      ...(codexConfig?.availableModels ?? []),
    ].filter(Boolean))],
    [codexConfig?.activeModel, codexConfig?.availableModels, draftSummaryCodexModel],
  );

  const hydrateDraftFromCodexConfig = (snapshot: CodexConfigSnapshot) => {
    const activeProvider = snapshot.providers.find((provider) => provider.id === snapshot.activeProviderId);
    if (!activeProvider || snapshot.activeProviderId === "openai") {
      setSelectedCodexConfigProviderId("");
      setDraftApiConfig((current) => ({ ...current, activeProvider: "official" }));
      return;
    }
    const preset = API_PROVIDER_PRESETS.find(
      (item) => item.id !== "custom" && (item.id === activeProvider.id || normalizeProviderBaseUrl(item.baseUrl) === normalizeProviderBaseUrl(activeProvider.baseUrl)),
    );
    setSelectedCodexConfigProviderId(preset ? "" : activeProvider.id);
    setDraftApiConfig((current) => ({
      ...current,
      activeProvider: "custom",
      customProviderId: activeProvider.id,
      customProviderName: preset?.providerName ?? activeProvider.name ?? activeProvider.id,
      customBaseUrl: activeProvider.baseUrl || preset?.baseUrl || current.customBaseUrl,
      customModel: snapshot.activeModel || preset?.model || current.customModel,
      customApiFormat: activeProvider.wireApi === "chat" ? "openai_chat" : preset?.apiFormat ?? "openai_responses",
    }));
  };

  const selectApiPreset = async (presetId: ApiProviderPresetId) => {
    const selectionId = ++apiPresetSelectionRef.current;
    const preset = API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? API_PROVIDER_PRESETS[0];
    const apiKey = await window.sessionSearch.getApiProviderKey("codex", preset.id).catch(() => "");
    if (selectionId !== apiPresetSelectionRef.current) return;
    if (preset.id === "custom") {
      const activeProvider = codexConfig?.providers.find((provider) => provider.id === codexConfig.activeProviderId);
      setSelectedCodexConfigProviderId(activeProvider?.id ?? "");
      setDraftApiConfig((current) => ({
        ...current,
        activeProvider: "custom",
        customProviderId: "custom",
        customProviderName: activeProvider?.name || current.customProviderName || preset.providerName,
        customBaseUrl: activeProvider?.baseUrl || current.customBaseUrl,
        customApiKey: apiKey || current.customApiKey,
        customModel: codexConfig?.activeModel || current.customModel,
        customApiFormat: activeProvider?.wireApi === "chat" ? "openai_chat" : current.customApiFormat || preset.apiFormat,
      }));
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
      const hydrationKey = `${snapshot.configPath}:${snapshot.activeProviderId}:${snapshot.activeModel}:${snapshot.providers.map((provider) => `${provider.id}:${provider.baseUrl}`).join("|")}`;
      if (hydrationKey !== codexConfigHydrationRef.current) {
        codexConfigHydrationRef.current = hydrationKey;
        hydrateDraftFromCodexConfig(snapshot);
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
      if (snapshot.route.activeProvider === "custom") {
        setDraftClaudeApiConfig((current) => ({
          ...current,
          ...snapshot.route,
          customConfigDir: current.customConfigDir,
          customApiKey: current.customApiKey,
        }));
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
      hydrateDraftFromCodexConfig(snapshot);
    } else {
      updateDraftClaudeApiConfig({ customConfigDir: selected });
      const snapshot = await window.sessionSearch.getClaudeConfig({ configDir: selected });
      setClaudeConfig(snapshot);
      if (snapshot.route.activeProvider === "custom") {
        setDraftClaudeApiConfig((current) => ({
          ...current,
          ...snapshot.route,
          customConfigDir: selected,
          customApiKey: current.customApiKey,
        }));
      }
    }
  };

  const selectCodexConfigProvider = (providerId: string) => {
    const provider = codexConfig?.providers.find((item) => item.id === providerId);
    if (!provider) return;
    setSelectedCodexConfigProviderId(provider.id);
    updateDraftApiConfig({
      activeProvider: "custom",
      customProviderId: "custom",
      customProviderName: provider.name || provider.id,
      customBaseUrl: provider.baseUrl,
      customApiFormat: provider.wireApi === "chat" ? "openai_chat" : "openai_responses",
    });
    setCodexModelOptions([]);
    setCodexModelMenuOpen(false);
  };

  const detectCodexModels = async () => {
    setCodexModelProbeStatus({ kind: "running", message: l("Detecting models...", "正在探测模型...") });
    try {
      const result = await window.sessionSearch.probeCodexModels({
        baseUrl: draftApiConfig.customBaseUrl,
        apiKey: draftApiConfig.customApiKey,
        providerId: selectedCodexConfigProviderId || codexConfig?.activeProviderId,
        codexHome: draftApiConfig.customConfigDir || undefined,
        keyTarget: "codex",
      });
      setCodexModelOptions(result.models);
      setCodexModelMenuOpen(result.models.length > 0);
      setCodexModelProbeStatus({ kind: "success", message: l(`Found ${result.models.length} models from ${result.endpoint}.`, `已从 ${result.endpoint} 找到 ${result.models.length} 个模型。`) });
    } catch (error) {
      setCodexModelProbeStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const detectClaudeModels = async () => {
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
      setClaudeModelProbeStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const detectSummaryModels = async () => {
    setSummaryModelProbeStatus({ kind: "running", message: l("Detecting models...", "正在探测模型...") });
    try {
      const inherited = draftSummaryApiConfigMode === "inherit_codex";
      const config = inherited ? draftApiConfig : draftSummaryApiConfig;
      const result = await window.sessionSearch.probeCodexModels({
        baseUrl: config.customBaseUrl,
        apiKey: config.customApiKey,
        providerId: config.customProviderId,
        codexHome: inherited ? config.customConfigDir || undefined : undefined,
        keyTarget: inherited ? "codex" : "summary",
      });
      setSummaryModelOptions(result.models);
      setSummaryModelMenuOpen(result.models.length > 0);
      setSummaryModelProbeStatus({
        kind: "success",
        message: l(
          `Found ${result.models.length} models from ${result.endpoint}.`,
          `已从 ${result.endpoint} 找到 ${result.models.length} 个模型。`,
        ),
      });
    } catch (error) {
      setSummaryModelProbeStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const testSummaryConnection = async () => {
    setSummaryConnectionStatus({ kind: "running", message: l("Testing connection...", "正在测试连接...") });
    try {
      const inherited = draftSummaryApiConfigMode === "inherit_codex";
      const config = inherited ? draftApiConfig : draftSummaryApiConfig;
      const result = await window.sessionSearch.testSummaryProviderConnection({
        baseUrl: config.customBaseUrl,
        apiKey: config.customApiKey,
        providerId: config.customProviderId,
        model: config.customModel,
        apiFormat: config.customApiFormat,
        codexHome: inherited ? config.customConfigDir || undefined : undefined,
        inheritCodex: inherited,
      });
      setSummaryConnectionStatus({
        kind: "success",
        message: l(
          `Connection succeeded in ${result.elapsedMs} ms using ${result.credentialSource}.`,
          `连接成功，使用 ${result.credentialSource}，耗时 ${result.elapsedMs} 毫秒。`,
        ),
      });
    } catch (error) {
      setSummaryConnectionStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const selectClaudeApiPreset = async (presetId: ClaudeApiProviderPresetId) => {
    const selectionId = ++claudeApiPresetSelectionRef.current;
    const preset = CLAUDE_API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? CLAUDE_API_PROVIDER_PRESETS[0];
    const apiKey = await window.sessionSearch.getApiProviderKey("claude", preset.id).catch(() => "");
    if (selectionId !== claudeApiPresetSelectionRef.current) return;
    setDraftClaudeApiConfig((current) => {
      if (preset.id === "custom") {
        return {
          ...current,
          activeProvider: "custom",
          customProviderId: "custom",
          customProviderName: current.customProviderName || preset.providerName,
          customApiKey: apiKey,
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
    setShowSummaryApiKey(false);
    setSummaryModelOptions([]);
    setSummaryModelMenuOpen(false);
    setSummaryModelProbeStatus(null);
    setSummaryConnectionStatus(null);
  };

  useEffect(() => {
    setDraftApiConfig(settings?.apiConfig ?? { ...defaultApiConfig });
    setDraftClaudeApiConfig(settings?.claudeApiConfig ?? { ...defaultClaudeApiConfig });
    setDraftSummaryApiConfig(buildSummaryDraftFromSettings(settings));
    setDraftSummaryApiConfigMode(settings?.summaryApiConfigMode ?? "inherit_codex");
    setDraftSummarySource(buildSummarySourceFromSettings(settings));
    setDraftSummaryCodexModel(settings?.summaryCodexModel ?? "");
    setDraftSummaryCodexReasoningEffort(settings?.openVikingExtractionReasoningEffort ?? "medium");
  }, [
    settings?.apiConfig,
    settings?.claudeApiConfig,
    settings?.summaryApiConfig,
    settings?.summaryApiConfigMode,
    settings?.summaryCodexModel,
    settings?.summarySource,
    settings?.openVikingExtractionReasoningEffort,
  ]);

  useEffect(() => {
    if (apiTarget === "codex" || apiTarget === "summary") void refreshCodexConfig();
    if (apiTarget === "claude") void refreshClaudeConfig();
  }, [apiTarget]);

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
        openVikingExtractionReasoningEffort: draftSummaryCodexReasoningEffort,
        summaryApiConfig: draftSummaryApiConfig,
      });
    }
  };

  const applyDraft = () => {
    if (apiTarget === "codex") {
      runCodexAction("apply");
    } else if (apiTarget === "claude") {
      onApplyToClaude(draftClaudeApiConfig);
    }
  };

  return (
    <section className="provider-page" data-page="providers">
      <header className="app-page-head provider-page-head">
        <div>
          <h2>Provider</h2>
          <p>{l(
            "Configure the routes used by Codex, Claude Code, summaries, and AI search.",
            "配置 Codex、Claude Code、摘要和 AI 搜索使用的服务。",
          )}</p>
        </div>
      </header>
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
                  <input type="text" value={draftApiConfig.customConfigDir} disabled={!settings || saving} placeholder="~/.codex" onChange={(event) => updateDraftApiConfig({ customConfigDir: event.currentTarget.value })} />
                  <button type="button" disabled={!settings || saving} onClick={() => void pickConfigDirectory("codex")}>{l("Browse", "选择")}</button>
                  <button type="button" disabled={!settings || saving || !draftApiConfig.customConfigDir} onClick={() => updateDraftApiConfig({ customConfigDir: "" })}>{l("Default", "默认")}</button>
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
                    {draftApiConfig.customProviderId === "custom"
                      ? l(
                          "Apply writes this custom route into ~/.codex/config.toml and preserves existing auth.json.",
                          "应用时会把这个自定义路径写入 ~/.codex/config.toml，并保留现有 auth.json。",
                        )
                      : draftApiConfig.customProviderId === "codexzh"
                      ? l(
                          "Apply updates the active ~/.codex/config.toml route and preserves existing auth.json.",
                          "应用时只更新当前 ~/.codex/config.toml 的路由配置，并保留现有 auth.json。",
                        )
                      : l(
                          `Apply merges the ${customName} route into ~/.codex/config.toml and preserves existing auth.json.`,
                          `应用时会把 ${customName} 路由合并到 ~/.codex/config.toml，并保留现有 auth.json。`,
                        )}
                  </div>
                  {codexConfig?.providers.some((provider) => provider.id !== "openai") ? (
                    <label className="settings-field">
                      <div className="settings-field-text">
                        <span className="settings-field-title">{l("Config provider", "配置供应商")}</span>
                        <span className="settings-field-sub">
                          {l("Choose an existing ~/.codex/config.toml provider as the Custom baseline.", "选择 ~/.codex/config.toml 里的现有供应商作为 Custom 基线。")}
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
                      onChange={(event) => updateDraftApiConfig({ customBaseUrl: event.currentTarget.value })}
                    />
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">API Key</span>
                      <span className="settings-field-sub">
                        {draftApiConfig.customApiKey
                          ? l("Using the key entered here.", "使用此处输入的密钥。")
                          : codexConfig?.activeProvider?.hasApiKey
                            ? l(`Detected from ${codexConfig.activeProvider.credentialSource ?? "Codex config"}.`, `已从 ${codexConfig.activeProvider.credentialSource ?? "Codex 配置"} 识别。`)
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
                  <div className="settings-field codex-model-detect-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Model", "模型")}</span>
                      <span className="settings-field-sub">{l("Type a model name, or detect /v1/models and choose one.", "手动输入模型名称，或探测 /v1/models 后选择。")}</span>
                    </div>
                    <div className="codex-model-input">
                      <div className="codex-model-combo">
                        <input
                          type="text"
                          value={draftApiConfig.customModel}
                          disabled={!settings || saving}
                          placeholder="gpt-5.5"
                          aria-haspopup="listbox"
                          aria-expanded={codexModelMenuOpen}
                          onFocus={() => setCodexModelMenuOpen(codexModelOptions.length > 0)}
                          onBlur={() => window.setTimeout(() => setCodexModelMenuOpen(false), 100)}
                          onChange={(event) => {
                            updateDraftApiConfig({ customModel: event.currentTarget.value });
                            setCodexModelMenuOpen(codexModelOptions.length > 0);
                          }}
                        />
                        <button
                          type="button"
                          className="codex-model-menu-trigger"
                          disabled={!settings || saving || codexModelOptions.length === 0}
                          aria-label={l("Choose detected model", "选择探测到的模型")}
                          aria-haspopup="listbox"
                          aria-expanded={codexModelMenuOpen}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => setCodexModelMenuOpen((current) => !current)}
                        >
                          <ChevronDown size={14} />
                        </button>
                        {codexModelMenuOpen && codexModelOptions.length > 0 ? (
                          <div className="codex-model-menu" role="listbox">
                            {codexModelOptions.map((model) => (
                              <button
                                type="button"
                                className="codex-model-option"
                                role="option"
                                aria-selected={model === draftApiConfig.customModel}
                                key={model}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  updateDraftApiConfig({ customModel: model });
                                  setCodexModelMenuOpen(false);
                                }}
                              >
                                {model}
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
              <div className="codex-config-visualizer">
                <div>
                  <span>{l("Config file", "配置文件")}</span>
                  <strong>{claudeConfig?.settingsPath ?? "~/.claude/settings.json"}</strong>
                  <em>{claudeConfigError || (claudeConfig?.exists ? l("Loaded", "已读取") : l("Not created yet", "尚未创建"))}</em>
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
                  <input type="text" value={draftClaudeApiConfig.customConfigDir} disabled={!settings || saving} placeholder="~/.claude" onChange={(event) => updateDraftClaudeApiConfig({ customConfigDir: event.currentTarget.value })} />
                  <button type="button" disabled={!settings || saving} onClick={() => void pickConfigDirectory("claude")}>{l("Browse", "选择")}</button>
                  <button type="button" disabled={!settings || saving || !draftClaudeApiConfig.customConfigDir} onClick={() => updateDraftClaudeApiConfig({ customConfigDir: "" })}>{l("Default", "默认")}</button>
                </div>
              </label>
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
                      `Apply writes ${customClaudeName} route env into ~/.claude/settings.json.`,
                      `应用时会把 ${customClaudeName} 路由 env 写入 ~/.claude/settings.json。`,
                    )}
                  </div>
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
                      onChange={(event) => updateDraftClaudeApiConfig({ customBaseUrl: event.currentTarget.value })}
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
                        <button type="button" className="codex-model-menu-trigger" disabled={!settings || saving || claudeModelOptions.length === 0} onMouseDown={(event) => event.preventDefault()} onClick={() => setClaudeModelMenuOpen((current) => !current)}><ChevronDown size={14} /></button>
                        {claudeModelMenuOpen && claudeModelOptions.length > 0 ? (
                          <div className="codex-model-menu" role="listbox">
                            {claudeModelOptions.map((model) => (
                              <button type="button" className="codex-model-option" key={model} onMouseDown={(event) => event.preventDefault()} onClick={() => {
                                updateDraftClaudeApiConfig({ customModel: model });
                                setClaudeModelMenuOpen(false);
                              }}>{model}</button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <button type="button" className="codex-model-detect-button" disabled={!settings || saving || claudeModelProbeStatus?.kind === "running"} onClick={() => void detectClaudeModels()}>{l("Detect models", "探测模型")}</button>
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
                  onClick={() => setDraftSummarySource("codex")}
                >
                  <strong>Codex</strong>
                  <span>{l("Prefer the current local Codex config.", "优先使用当前本机 Codex 配置。")}</span>
                </button>
                <button
                  type="button"
                  className={activeSummarySource === "claude" ? "active" : ""}
                  disabled={!settings || saving}
                  onClick={() => setDraftSummarySource("claude")}
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
              {activeSummarySource === "codex" ? (
                <>
                  <div className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Model", "模型")}</span>
                      <span className="settings-field-sub">
                        {l(
                          "Used by local Codex summaries, AI search, and OpenViking memory extraction.",
                          "用于本机 Codex 摘要、AI 搜索和 OpenViking 记忆提取。",
                        )}
                      </span>
                    </div>
                    <select
                      value={draftSummaryCodexModel}
                      disabled={!settings || saving}
                      onChange={(event) => setDraftSummaryCodexModel(event.currentTarget.value)}
                    >
                      <option value="">
                        {codexConfig?.activeModel
                          ? l(`Follow current Codex (${codexConfig.activeModel})`, `跟随当前 Codex（${codexConfig.activeModel}）`)
                          : l("Follow current Codex model", "跟随当前 Codex 模型")}
                      </option>
                      {summaryCodexModelOptions.map((model) => (
                        <option value={model} key={model}>{model}</option>
                      ))}
                    </select>
                    {codexConfigError ? <div className="api-config-status error">{codexConfigError}</div> : null}
                  </div>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Reasoning effort", "推理强度")}</span>
                      <span className="settings-field-sub">
                        {l("Higher levels are slower but analyze more deeply.", "等级越高，分析越深入，但速度也越慢。")}
                      </span>
                    </div>
                    <select
                      value={draftSummaryCodexReasoningEffort}
                      disabled={!settings || saving}
                      onChange={(event) => setDraftSummaryCodexReasoningEffort(
                        event.currentTarget.value as AppSettings["openVikingExtractionReasoningEffort"],
                      )}
                    >
                      {OPENVIKING_EXTRACTION_REASONING_EFFORTS.map((effort) => (
                        <option value={effort} key={effort}>{effort}</option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
              {activeSummarySource === "custom" ? (
                <>
                  <div className="api-config-note">
                    {selectedSummaryPreset?.id === "custom"
                      ? l(
                          "The Custom draft is filled from your current local Codex config first, then local Claude config if Codex is unavailable. It only saves when you click Save summary settings.",
                          "Custom 草稿会先填充当前本机 Codex 配置；如果没有，再回退到本机 Claude 配置。只有点击“保存摘要设置”才会保存。",
                        )
                      : l(
                          "Preset selection only updates the draft. Click Save summary settings to save it.",
                          "选择供应商后只会更新草稿；点击“保存摘要设置”后才会保存。",
                        )}
                  </div>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">Base URL</span>
                      <span className="settings-field-sub">{l("OpenAI-compatible endpoint.", "OpenAI-compatible 接口地址。")}</span>
                    </div>
                    <input
                      type="text"
                      value={draftSummaryApiConfig.customBaseUrl}
                      disabled={!settings || saving}
                      placeholder="https://api.deepseek.com"
                      onChange={(event) => updateDraftSummaryApiConfig({ customBaseUrl: event.currentTarget.value })}
                    />
                  </label>
                  <div className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Model", "模型")}</span>
                      <span className="settings-field-sub">{l("API model used for summaries and search.", "用于摘要与搜索的 API 模型。")}</span>
                    </div>
                    <div className="summary-model-control">
                      <div className="codex-model-input">
                        <div className="codex-model-combo">
                          <input
                            type="text"
                            value={draftSummaryApiConfig.customModel}
                            disabled={!settings || saving}
                            placeholder="deepseek-v4-flash"
                            aria-haspopup="listbox"
                            aria-expanded={summaryModelMenuOpen}
                            onFocus={() => setSummaryModelMenuOpen(summaryModelOptions.length > 0)}
                            onBlur={() => window.setTimeout(() => setSummaryModelMenuOpen(false), 100)}
                            onChange={(event) => {
                              updateDraftSummaryApiConfig({ customModel: event.currentTarget.value });
                              setSummaryModelMenuOpen(summaryModelOptions.length > 0);
                            }}
                          />
                          <button
                            type="button"
                            className="codex-model-menu-trigger"
                            disabled={!settings || saving || summaryModelOptions.length === 0}
                            aria-label={l("Choose detected model", "选择探测到的模型")}
                            aria-haspopup="listbox"
                            aria-expanded={summaryModelMenuOpen}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => setSummaryModelMenuOpen((current) => !current)}
                          >
                            <ChevronDown size={14} />
                          </button>
                          {summaryModelMenuOpen && summaryModelOptions.length > 0 ? (
                            <div className="codex-model-menu" role="listbox">
                              {summaryModelOptions.map((model) => (
                                <button
                                  type="button"
                                  className="codex-model-option"
                                  role="option"
                                  aria-selected={model === draftSummaryApiConfig.customModel}
                                  key={model}
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    updateDraftSummaryApiConfig({ customModel: model });
                                    setSummaryModelMenuOpen(false);
                                  }}
                                >
                                  {model}
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
                      {summaryModelProbeStatus ? (
                        <div className={`api-config-status ${summaryModelProbeStatus.kind}`}>
                          {summaryModelProbeStatus.message}
                        </div>
                      ) : null}
                      {summaryConnectionStatus ? (
                        <div className={`api-config-status ${summaryConnectionStatus.kind}`}>
                          {summaryConnectionStatus.message}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">API Key</span>
                      <span className="settings-field-sub">{l("Stored locally.", "保存在本地。")}</span>
                    </div>
                    <div className="secret-input">
                      <input
                        type={showSummaryApiKey ? "text" : "password"}
                        value={draftSummaryApiConfig.customApiKey}
                        disabled={!settings || saving}
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
                </>
              ) : null}
            </section>
          )}
        </div>
        <div className="dialog-actions api-config-actions">
          <span className={`api-config-status ${feedback?.kind ?? ""}`} aria-live="polite">
            {feedback?.message ?? ""}
          </span>
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
  );
}

function normalizeProviderBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}
