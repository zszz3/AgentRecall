import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Eye, EyeOff, X } from "lucide-react";
import {
  API_PROVIDER_PRESETS,
  CLAUDE_API_PROVIDER_PRESETS,
  defaultApiConfig,
  defaultClaudeApiConfig,
  type ApiConfig,
  type ApiProviderPresetId,
  type ClaudeApiConfig,
  type ClaudeApiProviderPresetId,
} from "../../../core/api-config";
import type { AppSettings, AppSettingsUpdate } from "../../../core/platform";
import type { SettingsFeedback } from "../app-types";
import { localize, type LanguageMode } from "../language";

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
  const [draftSummaryApiConfig, setDraftSummaryApiConfig] = useState<ApiConfig>(() => settings?.summaryApiConfig ?? { ...defaultApiConfig });
  const apiPresetSelectionRef = useRef(0);
  const claudeApiPresetSelectionRef = useRef(0);
  const summaryApiPresetSelectionRef = useRef(0);
  const updateDraftApiConfig = (next: Partial<ApiConfig>) => setDraftApiConfig((current) => ({ ...current, ...next }));
  const updateDraftClaudeApiConfig = (next: Partial<ClaudeApiConfig>) => setDraftClaudeApiConfig((current) => ({ ...current, ...next }));
  const updateDraftSummaryApiConfig = (next: Partial<ApiConfig>) => setDraftSummaryApiConfig((current) => ({ ...current, ...next }));
  const selectedPreset = API_PROVIDER_PRESETS.find((preset) => preset.id === draftApiConfig.customProviderId) ?? API_PROVIDER_PRESETS[0];
  const customName = selectedPreset?.label ?? (draftApiConfig.customProviderName || "CodexZH");
  const selectedClaudePreset =
    CLAUDE_API_PROVIDER_PRESETS.find((preset) => preset.id === draftClaudeApiConfig.customProviderId) ?? CLAUDE_API_PROVIDER_PRESETS[0];
  const customClaudeName = selectedClaudePreset?.label ?? (draftClaudeApiConfig.customProviderName || "Claude Code");

  const selectApiPreset = async (presetId: ApiProviderPresetId) => {
    const selectionId = ++apiPresetSelectionRef.current;
    const preset = API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? API_PROVIDER_PRESETS[0];
    const apiKey = await window.sessionSearch.getApiProviderKey("codex", preset.id).catch(() => "");
    if (selectionId !== apiPresetSelectionRef.current) return;
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
    setShowCodexApiKey(false);
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
    const preset = API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? API_PROVIDER_PRESETS[0];
    const apiKey = await window.sessionSearch.getApiProviderKey("summary", preset.id).catch(() => "");
    if (selectionId !== summaryApiPresetSelectionRef.current) return;
    setDraftSummaryApiConfig((current) => ({
      ...current,
      activeProvider: "custom",
      customProviderId: preset.id,
      customProviderName: preset.providerName,
      customBaseUrl: preset.baseUrl,
      customApiKey: apiKey,
      customModel: preset.model,
      customApiFormat: preset.apiFormat,
    }));
    setShowSummaryApiKey(false);
  };

  useEffect(() => {
    setDraftApiConfig(settings?.apiConfig ?? { ...defaultApiConfig });
    setDraftClaudeApiConfig(settings?.claudeApiConfig ?? { ...defaultClaudeApiConfig });
    setDraftSummaryApiConfig(settings?.summaryApiConfig ?? { ...defaultApiConfig });
  }, [settings?.apiConfig, settings?.claudeApiConfig, settings?.summaryApiConfig]);

  const saveDraft = () => {
    if (apiTarget === "codex") onSettingsChange({ apiConfig: draftApiConfig });
    else if (apiTarget === "claude") onSettingsChange({ claudeApiConfig: draftClaudeApiConfig });
    else onSettingsChange({ summaryApiConfig: draftSummaryApiConfig });
  };

  const applyDraft = () => {
    if (apiTarget === "codex") onApplyToCodex(draftApiConfig);
    else if (apiTarget === "claude") onApplyToClaude(draftClaudeApiConfig);
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
            {l("AI Summary", "AI 摘要")}
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
              <div
                className="api-provider-switch"
                role="group"
                aria-label={l("Codex provider", "Codex 供应商")}
                data-provider-labels="CodexZH DeepSeek GLM LongCat Kimi MiMo"
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
                    <span>{preset.model}</span>
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
                    {draftApiConfig.customProviderId === "codexzh"
                      ? l(
                          "Apply updates the active ~/.codex/config.toml route and preserves existing auth.json.",
                          "应用时只更新当前 ~/.codex/config.toml 的路由配置，并保留现有 auth.json。",
                        )
                      : l(
                          `Apply merges the ${customName} route into ~/.codex/config.toml and preserves existing auth.json.`,
                          `应用时会把 ${customName} 路由合并到 ~/.codex/config.toml，并保留现有 auth.json。`,
                        )}
                  </div>
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
                        {l(
                          "Stored locally. Applying it to Codex CLI will be a separate explicit action.",
                          "保存在本地；写入 Codex CLI 会作为单独的显式动作。",
                        )}
                      </span>
                    </div>
                    <div className="secret-input">
                      <input
                        type={showCodexApiKey ? "text" : "password"}
                        value={draftApiConfig.customApiKey}
                        disabled={!settings || saving}
                        placeholder="sk-..."
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
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Model", "模型")}</span>
                      <span className="settings-field-sub">{l("Model name for this Codex route.", "这个 Codex 路径使用的模型名称。")}</span>
                    </div>
                    <input
                      type="text"
                      value={draftApiConfig.customModel}
                      disabled={!settings || saving}
                      placeholder="gpt-5.5"
                      onChange={(event) => updateDraftApiConfig({ customModel: event.currentTarget.value })}
                    />
                  </label>
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("API format", "API 格式")}</span>
                      <span className="settings-field-sub">
                        {l("Matches cc-switch's OpenAI Chat / Responses split.", "对应 cc-switch 里的 OpenAI Chat / Responses 区分。")}
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
                className="api-provider-switch"
                role="group"
                aria-label={l("Claude Code provider", "Claude Code 供应商")}
                data-provider-labels="Custom DeepSeek GLM LongCat Kimi MiMo"
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
                        {l("Stored locally and written to Claude Code only when applied.", "保存在本地，只在应用时写入 Claude Code。")}
                      </span>
                    </div>
                    <div className="secret-input">
                      <input
                        type={showClaudeApiKey ? "text" : "password"}
                        value={draftClaudeApiConfig.customApiKey}
                        disabled={!settings || saving}
                        placeholder="sk-..."
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
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Model", "模型")}</span>
                      <span className="settings-field-sub">{l("Primary Claude Code model env.", "Claude Code 的主模型 env。")}</span>
                    </div>
                    <input
                      type="text"
                      value={draftClaudeApiConfig.customModel}
                      disabled={!settings || saving}
                      placeholder="claude-sonnet-4.6"
                      onChange={(event) => updateDraftClaudeApiConfig({ customModel: event.currentTarget.value })}
                    />
                  </label>
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
                <h3>{l("AI summary provider", "AI 摘要供应商")}</h3>
                <p>
                  {l(
                    "Dedicated OpenAI-compatible provider for summaries. On Fallback, the Codex then Claude provider is used — so an Anthropic coding-plan (e.g. GLM coding plan) set up in the Claude Code tab is reused. Saved locally; never written to any CLI config.",
                    "用于生成摘要的专用 OpenAI-compatible 供应商。选「回落」时依次用 Codex、Claude 的供应商——这样在 Claude Code 标签里配置的 Anthropic coding plan(如 GLM coding plan）会被复用。仅本地保存，不写入任何 CLI 配置。",
                  )}
                </p>
              </header>
              <div className="api-provider-switch" role="group" aria-label={l("AI summary provider", "AI 摘要供应商")}>
                <button
                  type="button"
                  className={draftSummaryApiConfig.activeProvider === "official" ? "active" : ""}
                  disabled={!settings || saving}
                  onClick={() => {
                    summaryApiPresetSelectionRef.current += 1;
                    updateDraftSummaryApiConfig({ activeProvider: "official" });
                  }}
                >
                  <strong>{l("Fallback (Codex / Claude)", "回落(Codex / Claude)")}</strong>
                  <span>{l("Reuse the Codex or Claude provider.", "复用 Codex 或 Claude 供应商。")}</span>
                </button>
                {API_PROVIDER_PRESETS.filter((preset) => preset.apiFormat === "openai_chat").map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={draftSummaryApiConfig.activeProvider === "custom" && draftSummaryApiConfig.customProviderId === preset.id ? "active" : ""}
                    disabled={!settings || saving}
                    onClick={() => void selectSummaryPreset(preset.id)}
                  >
                    <strong>{preset.label}</strong>
                    <span>{preset.model}</span>
                  </button>
                ))}
              </div>
              {draftSummaryApiConfig.activeProvider === "custom" ? (
                <>
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
                  <label className="settings-field">
                    <div className="settings-field-text">
                      <span className="settings-field-title">{l("Model", "模型")}</span>
                      <span className="settings-field-sub">{l("A cheap, fast chat model works well.", "选个便宜快速的聊天模型即可。")}</span>
                    </div>
                    <input
                      type="text"
                      value={draftSummaryApiConfig.customModel}
                      disabled={!settings || saving}
                      placeholder="deepseek-v4-flash"
                      onChange={(event) => updateDraftSummaryApiConfig({ customModel: event.currentTarget.value })}
                    />
                  </label>
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
                        placeholder="sk-..."
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
            {l("Save", "保存")}
          </button>
          {apiTarget === "summary" ? null : (
            <button type="button" className="primary-action" disabled={!settings || saving} onClick={applyDraft}>
              {apiTarget === "codex" ? l("Apply to Codex", "应用到 Codex") : l("Apply to Claude Code", "应用到 Claude Code")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
