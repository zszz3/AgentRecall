import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { API_PROVIDER_PRESETS, defaultApiConfig, type ApiConfig, type ApiProviderPresetId } from "../../../../core/api-config";
import type { AppSettings, AppSettingsUpdate } from "../../../../core/platform";
import type { CodexConfigSnapshot } from "../../../../core/codex-profile";
import type { SettingsFeedback } from "../../app-types";
import { localize, type LanguageMode } from "../../language";
import {
  ApiKeyInput,
  ConfigDirectoryInput,
  DetectedModelCombo,
  ProviderFormFrame,
  normalizeProviderBaseUrl,
  providerTargetMatches,
  useDraftCheck,
} from "./provider-form-shared";

export function CodexProviderForm({ settings, language, feedback, onSettingsChange }: {
  settings: AppSettings | null;
  language: LanguageMode;
  feedback: SettingsFeedback;
  onSettingsChange: (settings: AppSettingsUpdate) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const disabled = !settings || feedback?.kind === "running";
  const [showCodexApiKey, setShowCodexApiKey] = useState(false);
  const [draftApiConfig, setDraftApiConfig] = useState<ApiConfig>(() => settings?.apiConfig ?? { ...defaultApiConfig });
  const [codexConfig, setCodexConfig] = useState<CodexConfigSnapshot | null>(null);
  const [codexConfigError, setCodexConfigError] = useState("");
  const [selectedCodexConfigProviderId, setSelectedCodexConfigProviderId] = useState("");
  const [codexModelOptions, setCodexModelOptions] = useState<string[]>([]);
  const [codexModelMenuOpen, setCodexModelMenuOpen] = useState(false);
  // Typing a config-directory path keeps several reads in flight. Only the newest one may touch
  // the snapshot or the draft, or a slower earlier read drags the form back to the directory
  // the user already left.
  const codexConfigReadVersionRef = useRef(0);
  const updateDraftApiConfig = (next: Partial<ApiConfig>) => setDraftApiConfig((current) => ({ ...current, ...next }));
  const connectionSignature = JSON.stringify(draftApiConfig);
  const modelProbe = useDraftCheck(connectionSignature);
  const connectionTest = useDraftCheck(connectionSignature);
  const selectedPreset = API_PROVIDER_PRESETS.find((preset) => preset.id === draftApiConfig.customProviderId);
  const customName = selectedPreset?.label ?? (draftApiConfig.customProviderName || "Custom");

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
      setDraftApiConfig((current) => ({ ...current, activeProvider: "official", customApiKey: "", customModel: snapshot.activeModel || "" }));
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

  const selectApiPreset = (presetId: ApiProviderPresetId) => {
    const preset = API_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? API_PROVIDER_PRESETS[0];
    setSelectedCodexConfigProviderId("");
    if (preset.id === "custom") {
      setDraftApiConfig((current) => {
        const reusableKey = providerTargetMatches(current, preset.id, current.customBaseUrl)
          ? current.customApiKey
          : providerTargetMatches(settings?.apiConfig, preset.id, current.customBaseUrl)
            ? settings?.apiConfig.customApiKey ?? ""
            : "";
        return {
          ...current,
          activeProvider: "custom",
          customProviderId: preset.id,
          customProviderName: current.customProviderName || preset.providerName,
          customApiKey: reusableKey,
          customModel: codexConfig?.activeModel || current.customModel,
          customApiFormat: current.customApiFormat || preset.apiFormat,
        };
      });
    } else {
      setDraftApiConfig((current) => ({
        ...current,
        activeProvider: "custom",
        customProviderId: preset.id,
        customProviderName: preset.providerName,
        customBaseUrl: preset.baseUrl,
        // Each saved configuration carries its own key; a preset never borrows the key stored for
        // another configuration of the same provider.
        customApiKey: "",
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
    const requestVersion = ++codexConfigReadVersionRef.current;
    try {
      const snapshot = await window.sessionSearch.getCodexConfig({ configDir: draftApiConfig.customConfigDir || undefined });
      if (codexConfigReadVersionRef.current !== requestVersion) return;
      setCodexConfig(snapshot);
    } catch (error) {
      if (codexConfigReadVersionRef.current !== requestVersion) return;
      setCodexConfigError(error instanceof Error ? error.message : String(error));
    }
  };

  const pickConfigDirectory = async () => {
    const selected = await window.sessionSearch.pickConfigDirectory("codex", draftApiConfig.customConfigDir || undefined);
    if (!selected) return;
    updateDraftApiConfig({ customConfigDir: selected });
    const requestVersion = ++codexConfigReadVersionRef.current;
    const snapshot = await window.sessionSearch.getCodexConfig({ configDir: selected });
    if (codexConfigReadVersionRef.current !== requestVersion) return;
    setCodexConfig(snapshot);
    hydrateDraftFromCodexConfig(snapshot);
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
    if (!draftApiConfig.customApiKey.trim()) {
      modelProbe.setStatus({ kind: "error", message: l("Enter this provider's API key before detecting models.", "请填写这套服务配置的 API Key 后再探测模型。") });
      return;
    }
    await modelProbe.run(
      l("Detecting models...", "正在探测模型..."),
      () => {
        const configuredProviderId = selectedCodexConfigProviderId || codexConfig?.activeProviderId;
        const configuredProvider = codexConfig?.providers.find((provider) => provider.id === configuredProviderId);
        const providerId = configuredProvider
          && normalizeProviderBaseUrl(configuredProvider.baseUrl) === normalizeProviderBaseUrl(draftApiConfig.customBaseUrl)
          ? configuredProvider.id
          : draftApiConfig.customProviderId;
        return window.sessionSearch.probeCodexModels({
          baseUrl: draftApiConfig.activeProvider === "official" ? "" : draftApiConfig.customBaseUrl,
          apiKey: draftApiConfig.activeProvider === "official" ? "" : draftApiConfig.customApiKey,
          providerId: draftApiConfig.activeProvider === "official" ? "openai" : providerId,
          codexHome: draftApiConfig.customConfigDir || undefined,
          keyTarget: "codex",
        });
      },
      (result) => {
        setCodexModelOptions(result.models);
        setCodexModelMenuOpen(result.models.length > 0);
        return l(`Found ${result.models.length} models from ${result.endpoint}.`, `已从 ${result.endpoint} 找到 ${result.models.length} 个模型。`);
      },
    );
  };

  const testCodexConnection = async () => {
    if (draftApiConfig.activeProvider === "custom" && !draftApiConfig.customApiKey.trim()) {
      connectionTest.setStatus({ kind: "error", message: l("Enter this provider's API key before testing.", "请填写这套服务配置的 API Key 后再测试。") });
      return;
    }
    await connectionTest.run(
      l("Testing Codex connection...", "正在测试 Codex 连接..."),
      () => window.sessionSearch.testProviderConnection({
        target: "codex",
        apiConfig: { ...draftApiConfig },
      }),
      (result) => l(
        `Codex connection succeeded in ${result.elapsedMs} ms using ${result.credentialSource}.`,
        `Codex 连接成功，使用 ${result.credentialSource}，耗时 ${result.elapsedMs} 毫秒。`,
      ),
    );
  };

  // Every save hands back a freshly built settings object, so comparing by identity would
  // discard the draft the user is still editing. Compare by value instead.
  const settingsSignature = JSON.stringify(settings?.apiConfig);
  useEffect(() => {
    setDraftApiConfig(settings?.apiConfig ?? { ...defaultApiConfig });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsSignature]);

  useEffect(() => {
    // Re-read whenever the directory changes, otherwise the pane keeps showing the config
    // of the previously typed path. Debounced so typing a path is not one fetch per key.
    const timer = window.setTimeout(() => void refreshCodexConfig(), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftApiConfig.customConfigDir]);

  return (
    <ProviderFormFrame
      language={language}
      saved
      title={l("Codex providers", "Codex 供应商")}
      description={l(
        "Switch Codex between the official account and common OpenAI-compatible routes.",
        "在 Codex 官网账号和常用 OpenAI-compatible 路径之间切换。",
      )}
      feedback={feedback}
      connection={{ target: "codex", status: connectionTest.status, disabled, onTest: () => void testCodexConnection() }}
      actions={
        <button type="button" disabled={disabled} onClick={() => onSettingsChange({ apiConfig: draftApiConfig })}>
          {l("Save provider", "保存服务商")}
        </button>
      }
    >
      <div className="codex-config-visualizer">
        <div>
          <span>{l("Active config", "当前配置")}</span>
          <strong>{codexConfig?.activeProviderId ?? "openai"}</strong>
          <em>{codexConfig?.activeModel || l("Default model", "默认模型")}</em>
        </div>
        <div>
          <span>{l("Config file", "配置文件")}</span>
          <strong title={codexConfig?.configPath ?? "~/.codex/config.toml"}>{codexConfig?.configPath ?? "~/.codex/config.toml"}</strong>
          <em>{codexConfigError || (codexConfig?.exists ? l(`${codexConfig.providers.length} providers`, `${codexConfig.providers.length} 个供应商`) : l("Not created yet", "尚未创建"))}</em>
        </div>
      </div>
      <details className="provider-advanced"><summary>{l("Config directory", "配置目录")}</summary><label className="settings-field">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Config directory", "配置目录")}</span>
          <span className="settings-field-sub">{l("Leave empty to use ~/.codex.", "留空使用 ~/.codex。")}</span>
        </div>
        <ConfigDirectoryInput
          language={language}
          value={draftApiConfig.customConfigDir}
          placeholder="~/.codex"
          disabled={disabled}
          onChange={(customConfigDir) => updateDraftApiConfig({ customConfigDir })}
          onBrowse={() => void pickConfigDirectory()}
        />
      </label></details>
      <label className="settings-field">
        <span className="settings-field-title">{l("Preset", "服务模板")}</span>
        <select
          disabled={disabled}
          value={draftApiConfig.activeProvider === "official" ? "official" : draftApiConfig.customProviderId}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "official") updateDraftApiConfig({ activeProvider: "official", customModel: codexConfig?.activeProviderId === "openai" ? codexConfig.activeModel : "" });
            else selectApiPreset(value);
          }}
        >
          <option value="official">{l("Official account", "官方账号")}</option>
          {!API_PROVIDER_PRESETS.some((preset) => preset.id === draftApiConfig.customProviderId) && <option value={draftApiConfig.customProviderId}>{l("Existing custom configuration", "现有自定义配置")}</option>}
          {API_PROVIDER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </label>
      {draftApiConfig.activeProvider === "official" ? (
        <div className="api-config-note">
          {l(
            "Apply switches to the official route, saves the selected default model, and preserves existing authentication.",
            "应用时切换到官网路径、保存所选默认模型，并保留现有登录认证。",
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
                disabled={disabled}
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
              <span className="settings-field-title">Base URL</span>
              <span className="settings-field-sub">
                {l("OpenAI-compatible endpoint, usually ending in /v1.", "OpenAI-compatible 接口地址，通常以 /v1 结尾。")}
              </span>
            </div>
            <input
              type="text"
              value={draftApiConfig.customBaseUrl}
              disabled={disabled}
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
                  : l("Enter the API key for this saved configuration.", "填写这套服务配置专用的 API Key。")}
              </span>
            </div>
            <ApiKeyInput
              language={language}
              value={draftApiConfig.customApiKey}
              shown={showCodexApiKey}
              disabled={disabled}
              onToggle={() => setShowCodexApiKey((current) => !current)}
              onChange={(customApiKey) => updateDraftApiConfig({ customApiKey })}
            />
          </label>
          <details className="provider-advanced"><summary>{l("API format", "接口协议")}</summary><label className="settings-field">
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
              disabled={disabled}
              onChange={(event) => updateDraftApiConfig({ customApiFormat: event.currentTarget.value as ApiConfig["customApiFormat"] })}
            >
              <option value="openai_chat">OpenAI Chat Completions</option>
              <option value="openai_responses">OpenAI Responses API</option>
            </select>
          </label></details>
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
      <div className="settings-field codex-model-detect-field">
        <div className="settings-field-text">
          <span className="settings-field-title">{l("Model", "模型")}</span>
          <span className="settings-field-sub">{draftApiConfig.activeProvider === "official"
            ? l("Set the official default model. Runtime Agents can override it. Detected models still require a connection test.", "设置官网默认模型；Runtime Agent 可单独覆盖。探测列表不代表账号可用，请测试连接。")
            : l("Type a model name, or detect /v1/models and choose one.", "手动输入模型名称，或探测 /v1/models 后选择。")}</span>
        </div>
        <div className="codex-model-input">
          <DetectedModelCombo
            language={language}
            value={draftApiConfig.customModel}
            options={codexModelOptions}
            open={codexModelMenuOpen}
            disabled={disabled}
            placeholder="gpt-5.5"
            onChange={(customModel) => updateDraftApiConfig({ customModel })}
            onOpenChange={setCodexModelMenuOpen}
          />
          <button
            type="button"
            className="codex-model-detect-button"
            disabled={disabled || modelProbe.status?.kind === "running"}
            onClick={() => void detectCodexModels()}
          >
            {l("Detect models", "探测模型")}
          </button>
        </div>
        {modelProbe.status ? <div className={`api-config-status ${modelProbe.status.kind}`}>{modelProbe.status.message}</div> : null}
      </div>
    </ProviderFormFrame>
  );
}
