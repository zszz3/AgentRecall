import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  API_PROVIDER_PRESETS,
  defaultApiConfig,
  type ApiConfig,
  type ApiProviderPresetId,
} from "../../../../core/api-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { ClaudeConfigSnapshot } from "../../../../core/claude-profile";
import type { CodexConfigSnapshot } from "../../../../core/codex-profile";
import { SUMMARY_REASONING_EFFORTS, type SummaryReasoningEffort } from "../../../../core/summary-settings";
import type { SummaryProviderConnectionRequest } from "../../../../shared/ipc/providers";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import { ApiKeyInput, ConfigDirectoryInput, DetectedModelCombo, ProviderFormFrame, useDraftCheck } from "./provider-form-shared";

// The summary route is a plain OpenAI-compatible route just like the Codex one, so it
// offers the same presets; only the stored credential differs.
const SUMMARY_API_PROVIDER_PRESETS = API_PROVIDER_PRESETS;

function buildSummaryDraftFromSettings(settings: AppSettings | null): ApiConfig {
  return settings?.summaryApiConfig ?? { ...defaultApiConfig };
}

function buildSummarySourceFromSettings(settings: AppSettings | null): AppSettings["summarySource"] {
  return settings?.summarySource ?? "codex";
}

export function SummaryProviderForm({ settings, language, feedback, onSettingsChange }: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const disabled = !settings || feedback?.kind === "running";
  const [showSummaryApiKey, setShowSummaryApiKey] = useState(false);
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
  const [summaryModelOptions, setSummaryModelOptions] = useState<string[]>([]);
  const [summaryModelMenuOpen, setSummaryModelMenuOpen] = useState(false);
  // Read from the summary's own config directories, never from the client routes that the Codex
  // and Claude Code provider forms edit.
  const [summaryCodexConfig, setSummaryCodexConfig] = useState<CodexConfigSnapshot | null>(null);
  const [summaryClaudeConfig, setSummaryClaudeConfig] = useState<ClaudeConfigSnapshot | null>(null);
  const [summaryConfigError, setSummaryConfigError] = useState("");
  const summaryApiPresetSelectionRef = useRef(0);
  // Typing a config-directory path keeps several reads in flight. Only the newest one may touch
  // the snapshot, or a slower earlier read shows the directory the user already left.
  const summaryConfigReadVersionRef = useRef(0);
  const updateDraftSummaryApiConfig = (next: Partial<ApiConfig>) => setDraftSummaryApiConfig((current) => ({ ...current, ...next }));
  const summaryCodexModelOptions = useMemo(
    () => [...new Set([
      draftSummaryCodexModel.trim(),
      summaryCodexConfig?.activeModel.trim() ?? "",
      ...(summaryCodexConfig?.availableModels ?? []),
    ].filter(Boolean))],
    [summaryCodexConfig?.activeModel, summaryCodexConfig?.availableModels, draftSummaryCodexModel],
  );

  // "Inherit Codex" probes and tests the saved Codex client route; "custom" keeps the summary
  // route strictly separate, including its own key store.
  const summaryInheritsCodex = draftSummaryApiConfigMode === "inherit_codex";
  const effectiveSummaryApiConfig = summaryInheritsCodex ? settings?.apiConfig ?? defaultApiConfig : draftSummaryApiConfig;
  const summaryClaudeRoute = summaryClaudeConfig?.route ?? {};
  // Everything the probe and connection-test requests read, so editing any of it while one is in
  // flight marks that result stale.
  const connectionSignature = JSON.stringify([
    draftSummarySource,
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
  const modelProbe = useDraftCheck(connectionSignature);
  const connectionTest = useDraftCheck(connectionSignature);

  const refreshSummaryConfig = async () => {
    setSummaryConfigError("");
    const requestVersion = ++summaryConfigReadVersionRef.current;
    try {
      if (draftSummarySource === "claude") {
        const snapshot = await window.sessionSearch.getClaudeConfig({
          configDir: draftSummaryClaudeConfigDir || undefined,
        });
        if (summaryConfigReadVersionRef.current !== requestVersion) return;
        setSummaryClaudeConfig(snapshot);
        return;
      }
      const snapshot = await window.sessionSearch.getCodexConfig({
        configDir: (draftSummarySource === "codex"
          ? draftSummaryCodexConfigDir
          : effectiveSummaryApiConfig.customConfigDir) || undefined,
      });
      if (summaryConfigReadVersionRef.current !== requestVersion) return;
      setSummaryCodexConfig(snapshot);
    } catch (error) {
      if (summaryConfigReadVersionRef.current !== requestVersion) return;
      setSummaryConfigError(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * Only records the chosen directory: unlike the Codex and Claude Code provider forms, picking a
   * directory for summaries never hydrates a route from it.
   */
  const pickSummaryConfigDirectory = async () => {
    const current = draftSummarySource === "claude"
      ? draftSummaryClaudeConfigDir
      : draftSummarySource === "codex"
        ? draftSummaryCodexConfigDir
        : draftSummaryApiConfig.customConfigDir;
    const selected = await window.sessionSearch.pickConfigDirectory("summary", current || undefined);
    if (!selected) return;
    if (draftSummarySource === "claude") setDraftSummaryClaudeConfigDir(selected);
    else if (draftSummarySource === "codex") setDraftSummaryCodexConfigDir(selected);
    else updateDraftSummaryApiConfig({ customConfigDir: selected });
  };

  const resetSummaryProbeState = () => {
    setSummaryModelOptions([]);
    setSummaryModelMenuOpen(false);
    modelProbe.setStatus(null);
    connectionTest.setStatus(null);
  };

  const selectSummarySource = (source: AppSettings["summarySource"]) => {
    setDraftSummarySource(source);
    // Probe results and statuses describe the previous source's route; keeping them on screen
    // would read as if they applied to the one now selected.
    resetSummaryProbeState();
  };

  const detectSummaryModels = async () => {
    await modelProbe.run(
      l("Detecting models...", "正在探测模型..."),
      async () => draftSummarySource === "claude"
        ? await window.sessionSearch.probeClaudeModels({
            baseUrl: summaryClaudeRoute.customBaseUrl ?? "",
            apiKey: "",
            providerId: summaryClaudeRoute.customProviderId,
            claudeHome: draftSummaryClaudeConfigDir || undefined,
            apiFormat: summaryClaudeRoute.customApiFormat ?? "anthropic",
            apiKeyField: summaryClaudeRoute.customApiKeyField ?? "ANTHROPIC_AUTH_TOKEN",
            keyTarget: "summary",
          })
        : draftSummarySource === "codex"
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
            }),
      (result) => {
        setSummaryModelOptions(result.models);
        setSummaryModelMenuOpen(result.models.length > 0);
        return l(
          `Found ${result.models.length} models using ${result.credentialSource}.`,
          `使用 ${result.credentialSource} 找到 ${result.models.length} 个模型。`,
        );
      },
    );
  };

  const testSummaryConnection = async () => {
    await connectionTest.run(
      l("Testing connection...", "正在测试连接..."),
      () => {
        const config = effectiveSummaryApiConfig;
        const request: SummaryProviderConnectionRequest = draftSummarySource === "claude"
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
          : draftSummarySource === "codex"
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
        return window.sessionSearch.testSummaryProviderConnection(request);
      },
      (result) => l(
        `Connection succeeded in ${result.elapsedMs} ms using ${result.credentialSource}.`,
        `连接成功，使用 ${result.credentialSource}，耗时 ${result.elapsedMs} 毫秒。`,
      ),
    );
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

    if (draftSummarySource === "claude") {
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
        modelOptions: [...new Set([...summaryModelOptions, summaryClaudeRoute.customModel ?? ""].filter(Boolean))],
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

    if (draftSummarySource === "codex") {
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
        modelOptions: [...new Set([...summaryModelOptions, ...summaryCodexModelOptions].filter(Boolean))],
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
      modelOptions: summaryModelOptions,
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
  const summaryFallbackWarning = draftSummarySource === "custom"
    && !summaryInheritsCodex
    && !(effectiveSummaryApiConfig.customBaseUrl.trim() && effectiveSummaryApiConfig.customModel.trim())
    ? l(
        "This route is incomplete, so summaries will silently fall back to Codex. Fill in both the base URL and the model.",
        "该路径尚未填写完整，摘要会静默回退到 Codex。请同时填写 Base URL 与模型。",
      )
    : "";

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
    resetSummaryProbeState();
  };

  // Every save hands back a freshly built settings object, so comparing by identity would
  // discard the draft the user is still editing. Compare by value instead.
  const settingsSignature = JSON.stringify([
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
    // Re-read whenever the directory changes, otherwise the pane keeps showing the config
    // of the previously typed path. Debounced so typing a path is not one fetch per key.
    const timer = window.setTimeout(() => void refreshSummaryConfig(), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draftSummarySource,
    draftSummaryCodexConfigDir,
    draftSummaryClaudeConfigDir,
    draftSummaryApiConfig.customConfigDir,
    settings?.apiConfig.customConfigDir,
  ]);

  return (
    <ProviderFormFrame
      language={language}
      title={l("AI summary & search source", "AI 摘要与搜索来源")}
      description={l(
        "Powers both AI session summaries and the AI session finder. Choose Codex or Claude Code, or call an API provider directly. Direct API providers such as DeepSeek and GLM do not create agent sessions.",
        "同时驱动 AI 会话摘要和 AI 找会话。选择 Codex / Claude Code，或直接调用 API 供应商。DeepSeek、GLM 等直接 API 不会创建 agent session。",
      )}
      feedback={feedback}
      actions={
        <button
          type="button"
          className="primary-action"
          disabled={disabled}
          onClick={() => onSettingsChange({
            summarySource: draftSummarySource,
            summaryApiConfigMode: draftSummaryApiConfigMode,
            summaryCodexModel: draftSummaryCodexModel,
            summaryClaudeModel: draftSummaryClaudeModel,
            summaryCodexConfigDir: draftSummaryCodexConfigDir,
            summaryClaudeConfigDir: draftSummaryClaudeConfigDir,
            summaryReasoningEffort: draftSummaryReasoningEffort,
            summaryApiConfig: draftSummaryApiConfig,
          })}
        >
          {l("Save summary settings", "保存摘要设置")}
        </button>
      }
    >
      <div className="api-provider-switch summary-provider-switch" role="group" aria-label={l("AI summary & search source", "AI 摘要与搜索来源")}>
        <button
          type="button"
          className={draftSummarySource === "codex" ? "active" : ""}
          disabled={disabled}
          onClick={() => selectSummarySource("codex")}
        >
          <strong>Codex</strong>
          <span>{l("Prefer the current local Codex config.", "优先使用当前本机 Codex 配置。")}</span>
        </button>
        <button
          type="button"
          className={draftSummarySource === "claude" ? "active" : ""}
          disabled={disabled}
          onClick={() => selectSummarySource("claude")}
        >
          <strong>Claude Code</strong>
          <span>{l("Fallback to the current local Claude config.", "回退到当前本机 Claude 配置。")}</span>
        </button>
        {SUMMARY_API_PROVIDER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={draftSummarySource === "custom" && draftSummaryApiConfig.customProviderId === preset.id ? "active" : ""}
            disabled={disabled}
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
          disabled={disabled}
          onChange={(event) => summaryView.setSeparate(event.currentTarget.value === "separate")}
        >
          <option value="follow">{summaryView.followLabel}</option>
          <option value="separate">{summaryView.separateLabel}</option>
        </select>
      </label>
      <label className="settings-field" data-summary-row="config-dir">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Config directory", "配置目录")}</span>
          <span className="settings-field-sub" title={summaryView.configPath}>{summaryView.configPath}</span>
        </div>
        <ConfigDirectoryInput
          language={language}
          value={summaryView.configDir}
          placeholder={summaryView.configDirPlaceholder}
          disabled={disabled || !summaryView.configDirEditable}
          onChange={summaryView.setConfigDir}
          onBrowse={() => void pickSummaryConfigDirectory()}
        />
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
          disabled={disabled || !summaryView.baseUrlEditable}
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
              "Used by AI summaries and AI search.",
              "用于 AI 摘要和 AI 搜索。",
            )}
          </span>
        </div>
        <div className="summary-model-control">
          <div className="codex-model-input">
            <DetectedModelCombo
              language={language}
              value={summaryView.model}
              options={summaryView.modelOptions}
              open={summaryModelMenuOpen}
              disabled={disabled || !summaryView.modelEditable}
              placeholder={summaryView.modelPlaceholder}
              onChange={summaryView.setModel}
              onOpenChange={setSummaryModelMenuOpen}
            />
            <div className="provider-model-actions">
              <button
                type="button"
                className="codex-model-detect-button"
                disabled={disabled || modelProbe.status?.kind === "running"}
                onClick={() => void detectSummaryModels()}
              >
                {l("Detect models", "探测模型")}
              </button>
              <button
                type="button"
                className="codex-model-detect-button"
                disabled={disabled || connectionTest.status?.kind === "running"}
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
        <ApiKeyInput
          language={language}
          value={summaryView.apiKey}
          shown={showSummaryApiKey}
          disabled={disabled}
          editable={summaryView.apiKeyEditable}
          onToggle={() => setShowSummaryApiKey((current) => !current)}
          onChange={(customApiKey) => updateDraftSummaryApiConfig({ customApiKey })}
        />
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
          disabled={disabled || !summaryView.apiFormatEditable}
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
          disabled={disabled || !summaryView.reasoningEnabled}
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
          {modelProbe.status ? (
            <div className={`api-config-status ${modelProbe.status.kind}`}>{modelProbe.status.message}</div>
          ) : null}
          {connectionTest.status ? (
            <div className={`api-config-status ${connectionTest.status.kind}`}>{connectionTest.status.message}</div>
          ) : null}
          {!summaryConfigError && !summaryFallbackWarning && !modelProbe.status && !connectionTest.status ? (
            <div className="api-config-status">{l("Not tested yet.", "尚未测试。")}</div>
          ) : null}
        </div>
      </div>
    </ProviderFormFrame>
  );
}
