import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { ChevronDown } from "lucide-react";
import {
  CLAUDE_API_PROVIDER_PRESETS,
  defaultClaudeApiConfig,
  type ClaudeApiConfig,
  type ClaudeApiProviderPresetId,
} from "../../../../core/api-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { ClaudeConfigSnapshot } from "../../../../core/claude-profile";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import {
  ApiKeyInput,
  ConfigDirectoryInput,
  ProviderFormFrame,
  providerTargetMatches,
  useDraftCheck,
} from "./provider-form-shared";

export function ClaudeProviderForm({ settings, language, feedback, onSettingsChange }: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const disabled = !settings || feedback?.kind === "running";
  const [showClaudeApiKey, setShowClaudeApiKey] = useState(false);
  const [draftClaudeApiConfig, setDraftClaudeApiConfig] = useState<ClaudeApiConfig>(
    () => settings?.claudeApiConfig ?? { ...defaultClaudeApiConfig },
  );
  const [claudeConfig, setClaudeConfig] = useState<ClaudeConfigSnapshot | null>(null);
  const [claudeConfigError, setClaudeConfigError] = useState("");
  const [selectedClaudeConfigRoute, setSelectedClaudeConfigRoute] = useState("");
  const [claudeModelOptions, setClaudeModelOptions] = useState<string[]>([]);
  const [claudeModelMenuOpen, setClaudeModelMenuOpen] = useState(false);
  // Typing a config-directory path keeps several reads in flight. Only the newest one may touch
  // the snapshot or the draft, or a slower earlier read drags the form back to the directory
  // the user already left.
  const claudeConfigReadVersionRef = useRef(0);
  const updateDraftClaudeApiConfig = (next: Partial<ClaudeApiConfig>) => setDraftClaudeApiConfig((current) => ({ ...current, ...next }));
  const connectionSignature = JSON.stringify(draftClaudeApiConfig);
  const modelProbe = useDraftCheck(connectionSignature);
  const connectionTest = useDraftCheck(connectionSignature);
  const selectedClaudePreset =
    CLAUDE_API_PROVIDER_PRESETS.find((preset) => preset.id === draftClaudeApiConfig.customProviderId);
  const customClaudeName = selectedClaudePreset?.label ?? (draftClaudeApiConfig.customProviderName || "Claude Code");

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

  const refreshClaudeConfig = async () => {
    setClaudeConfigError("");
    const requestVersion = ++claudeConfigReadVersionRef.current;
    try {
      const snapshot = await window.sessionSearch.getClaudeConfig({
        configDir: draftClaudeApiConfig.customConfigDir || undefined,
      });
      if (claudeConfigReadVersionRef.current !== requestVersion) return;
      setClaudeConfig(snapshot);
    } catch (error) {
      if (claudeConfigReadVersionRef.current !== requestVersion) return;
      setClaudeConfigError(error instanceof Error ? error.message : String(error));
    }
  };

  const pickConfigDirectory = async () => {
    const selected = await window.sessionSearch.pickConfigDirectory("claude", draftClaudeApiConfig.customConfigDir || undefined);
    if (!selected) return;
    updateDraftClaudeApiConfig({ customConfigDir: selected });
    const requestVersion = ++claudeConfigReadVersionRef.current;
    const snapshot = await window.sessionSearch.getClaudeConfig({ configDir: selected });
    if (claudeConfigReadVersionRef.current !== requestVersion) return;
    setClaudeConfig(snapshot);
    hydrateDraftFromClaudeConfig(snapshot, selected);
  };

  const detectClaudeModels = async () => {
    if (!draftClaudeApiConfig.customApiKey.trim()) {
      modelProbe.setStatus({ kind: "error", message: l("Enter this provider's API key before detecting models.", "请填写这套服务配置的 API Key 后再探测模型。") });
      return;
    }
    await modelProbe.run(
      l("Detecting models...", "正在探测模型..."),
      () => window.sessionSearch.probeClaudeModels({
        baseUrl: draftClaudeApiConfig.customBaseUrl,
        apiKey: draftClaudeApiConfig.customApiKey,
        providerId: draftClaudeApiConfig.customProviderId,
        claudeHome: draftClaudeApiConfig.customConfigDir || undefined,
        apiFormat: draftClaudeApiConfig.customApiFormat,
        apiKeyField: draftClaudeApiConfig.customApiKeyField,
      }),
      (result) => {
        setClaudeModelOptions(result.models);
        setClaudeModelMenuOpen(result.models.length > 0);
        return l(
          `Found ${result.models.length} models using ${result.credentialSource}.`,
          `使用 ${result.credentialSource} 找到 ${result.models.length} 个模型。`,
        );
      },
    );
  };

  const testClaudeConnection = async () => {
    if (draftClaudeApiConfig.activeProvider === "custom" && !draftClaudeApiConfig.customApiKey.trim()) {
      connectionTest.setStatus({ kind: "error", message: l("Enter this provider's API key before testing.", "请填写这套服务配置的 API Key 后再测试。") });
      return;
    }
    await connectionTest.run(
      l("Testing Claude Code connection...", "正在测试 Claude Code 连接..."),
      () => window.sessionSearch.testProviderConnection({
        target: "claude",
        apiConfig: { ...draftClaudeApiConfig },
      }),
      (result) => l(
        `Claude Code connection succeeded in ${result.elapsedMs} ms using ${result.credentialSource}.`,
        `Claude Code 连接成功，使用 ${result.credentialSource}，耗时 ${result.elapsedMs} 毫秒。`,
      ),
    );
  };

  const selectClaudeApiPreset = (presetId: ClaudeApiProviderPresetId) => {
    const preset = CLAUDE_API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? CLAUDE_API_PROVIDER_PRESETS[0];
    setDraftClaudeApiConfig((current) => {
      if (preset.id === "custom") {
        const nextProviderId = "custom";
        const nextBaseUrl = current.customBaseUrl;
        const reusableKey = providerTargetMatches(current, nextProviderId, nextBaseUrl)
          ? current.customApiKey
          : providerTargetMatches(settings?.claudeApiConfig, nextProviderId, nextBaseUrl)
            ? settings?.claudeApiConfig.customApiKey ?? ""
            : "";
        return {
          ...current,
          activeProvider: "custom",
          customProviderId: nextProviderId,
          customProviderName: current.customProviderName || preset.providerName,
          customApiKey: reusableKey,
        };
      }
      return {
        ...current,
        activeProvider: "custom",
        customProviderId: preset.id,
        customProviderName: preset.providerName,
        customBaseUrl: preset.baseUrl,
        // Each saved configuration carries its own key; a preset never borrows the key stored for
        // another configuration of the same provider.
        customApiKey: "",
        customModel: preset.model,
        customHaikuModel: preset.haikuModel,
        customSonnetModel: preset.sonnetModel,
        customOpusModel: preset.opusModel,
        customApiFormat: preset.apiFormat,
        customApiKeyField: preset.apiKeyField,
      };
    });
    setShowClaudeApiKey(false);
    if (preset.id !== "custom") setSelectedClaudeConfigRoute("");
  };

  // Every save hands back a freshly built settings object, so comparing by identity would
  // discard the draft the user is still editing. Compare by value instead.
  const settingsSignature = JSON.stringify(settings?.claudeApiConfig);
  useEffect(() => {
    setDraftClaudeApiConfig(settings?.claudeApiConfig ?? { ...defaultClaudeApiConfig });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsSignature]);

  useEffect(() => {
    // Re-read whenever the directory changes, otherwise the pane keeps showing the config
    // of the previously typed path. Debounced so typing a path is not one fetch per key.
    const timer = window.setTimeout(() => void refreshClaudeConfig(), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftClaudeApiConfig.customConfigDir]);

  return (
    <ProviderFormFrame
      language={language}
      saved
      title={l("Claude Code providers", "Claude Code 供应商")}
      description={l(
        "Switch Claude Code between official auth and common Anthropic-compatible routes.",
        "在 Claude 官方认证和常用 Anthropic-compatible 路径之间切换。",
      )}
      feedback={feedback}
      connection={{ target: "claude", status: connectionTest.status, disabled, onTest: () => void testClaudeConnection() }}
      actions={
        <button type="button" disabled={disabled} onClick={() => onSettingsChange({ claudeApiConfig: draftClaudeApiConfig })}>
          {l("Save provider", "保存服务商")}
        </button>
      }
    >
      <label className="settings-field">
        <span className="settings-field-title">{l("Preset", "服务模板")}</span>
        <select
          disabled={disabled}
          value={draftClaudeApiConfig.activeProvider === "official" ? "official" : draftClaudeApiConfig.customProviderId}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "official") updateDraftClaudeApiConfig({ activeProvider: "official" });
            else selectClaudeApiPreset(value);
          }}
        >
          <option value="official">{l("Official account", "官方账号")}</option>
          {!CLAUDE_API_PROVIDER_PRESETS.some((preset) => preset.id === draftClaudeApiConfig.customProviderId) && <option value={draftClaudeApiConfig.customProviderId}>{l("Existing custom configuration", "现有自定义配置")}</option>}
          {CLAUDE_API_PROVIDER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </label>
      <div className="codex-config-visualizer">
        <div>
          <span>{l("Config file", "配置文件")}</span>
          <strong title={claudeConfig?.settingsPath ?? "~/.claude/settings.json"}>{claudeConfig?.settingsPath ?? "~/.claude/settings.json"}</strong>
          <em>{claudeConfigError || (claudeConfig?.exists ? l("Loaded", "已读取") : l("Not created yet", "尚未创建"))}</em>
        </div>
        <div>
          <span>{l("Credential", "凭证")}</span>
          <strong>{claudeConfig?.hasApiKey ? l("Detected", "已识别") : l("Not detected", "未识别")}</strong>
          <em>{claudeConfig?.credentialSource ?? l("Enter a key or choose another directory", "输入密钥或选择其他目录")}</em>
        </div>
      </div>
      <details className="provider-advanced"><summary>{l("Config directory", "配置目录")}</summary><label className="settings-field">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Config directory", "配置目录")}</span>
          <span className="settings-field-sub">{l("Leave empty to use ~/.claude.", "留空使用 ~/.claude。")}</span>
        </div>
        <ConfigDirectoryInput
          language={language}
          value={draftClaudeApiConfig.customConfigDir}
          placeholder="~/.claude"
          disabled={disabled}
          onChange={(customConfigDir) => updateDraftClaudeApiConfig({ customConfigDir })}
          onBrowse={() => void pickConfigDirectory()}
        />
      </label></details>
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
                disabled={disabled}
                onChange={(event) => selectClaudeConfigRoute(event.currentTarget.value === "config")}
              >
                <option value="">{l("Manual custom route", "手动自定义路径")}</option>
                <option value="config">{claudeConfig.route.customBaseUrl}</option>
              </select>
            </label>
          ) : null}
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
              disabled={disabled}
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
                  : l("Enter the API key for this saved configuration.", "填写这套服务配置专用的 API Key。")}
              </span>
            </div>
            <ApiKeyInput
              language={language}
              value={draftClaudeApiConfig.customApiKey}
              shown={showClaudeApiKey}
              disabled={disabled}
              onToggle={() => setShowClaudeApiKey((current) => !current)}
              onChange={(customApiKey) => updateDraftClaudeApiConfig({ customApiKey })}
            />
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
                  disabled={disabled}
                  placeholder="claude-sonnet-4.6"
                  onFocus={() => setClaudeModelMenuOpen(claudeModelOptions.length > 0)}
                  onBlur={() => window.setTimeout(() => setClaudeModelMenuOpen(false), 100)}
                  onChange={(event) => updateDraftClaudeApiConfig({ customModel: event.currentTarget.value })}
                />
                <button type="button" className="codex-model-menu-trigger" disabled={disabled || claudeModelOptions.length === 0} onMouseDown={(event) => event.preventDefault()} onClick={() => setClaudeModelMenuOpen((current) => !current)}><ChevronDown size={14} /></button>
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
              <button type="button" className="codex-model-detect-button" disabled={disabled || modelProbe.status?.kind === "running"} onClick={() => void detectClaudeModels()}>{l("Detect models", "探测模型")}</button>
            </div>
            {modelProbe.status ? <div className={`api-config-status ${modelProbe.status.kind}`}>{modelProbe.status.message}</div> : null}
          </div>
          <div className="api-model-grid">
            <label className="settings-field">
              <div className="settings-field-text">
                <span className="settings-field-title">Haiku</span>
              </div>
              <input
                type="text"
                value={draftClaudeApiConfig.customHaikuModel}
                disabled={disabled}
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
                disabled={disabled}
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
                disabled={disabled}
                placeholder={draftClaudeApiConfig.customModel || "opus model"}
                onChange={(event) => updateDraftClaudeApiConfig({ customOpusModel: event.currentTarget.value })}
              />
            </label>
          </div>
          <details className="provider-advanced"><summary>{l("API format", "接口协议")}</summary><label className="settings-field">
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
              disabled={disabled}
              onChange={(event) =>
                updateDraftClaudeApiConfig({ customApiFormat: event.currentTarget.value as ClaudeApiConfig["customApiFormat"] })
              }
            >
              <option value="anthropic">Anthropic Messages</option>
              <option value="openai_chat">OpenAI Chat Completions</option>
              <option value="openai_responses">OpenAI Responses API</option>
              <option value="gemini_native">Gemini Native</option>
            </select>
          </label></details>
          <label className="settings-field">
            <div className="settings-field-text">
              <span className="settings-field-title">{l("Key env", "Key 环境变量")}</span>
              <span className="settings-field-sub">
                {l("Most Claude Code routes use ANTHROPIC_AUTH_TOKEN.", "大多数 Claude Code 路径使用 ANTHROPIC_AUTH_TOKEN。")}
              </span>
            </div>
            <select
              value={draftClaudeApiConfig.customApiKeyField}
              disabled={disabled}
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
    </ProviderFormFrame>
  );
}
