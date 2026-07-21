import { useMemo, useState } from "react";
import { CheckCircle2, Eye, EyeOff, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { selectConfigChannelsForDisplay } from "../../../../shared/config-channels";
import { DEFAULT_MODEL_ID } from "../../../../shared/models";
import {
  AGENT_PROVIDER_PRESETS,
  CLAUDE_LOCAL_DEFAULT_PRESET_ID,
  CODEX_LOCAL_DEFAULT_PRESET_ID,
  OPENCODE_DEFAULT_PRESET_ID,
  OPENCLAW_DEFAULT_PRESET_ID,
  type AgentProviderPreset,
} from "../../../../shared/provider-presets";
import { RUNTIME_IDS, runtimeDefinition } from "../../../../shared/runtime-catalog";
import type {
  AgentChannel,
  ClaudeDefaultConfig,
  AgentId,
  AgentModelOption,
  CodexDefaultConfig,
  CodexPluginCatalogItem,
  ProviderBalanceResult,
} from "../../../../shared/types";
import { agentAccent, agentLabel } from "../../app/agents";
import { formatDuration } from "../../app/format";
import type { Language } from "../../app/language";
import type { AgentTestUiState } from "./runtime-types";
import {
  addPluginToChannel,
  agentTestEventLabel,
  applyCodexDefaultConfigToChannel,
  applyClaudeDefaultConfigToChannel,
  applyProviderApiKeyToChannel,
  apiKeyFromChannelHeaders,
  applyProviderPresetToChannel,
  formatBalanceDetail,
  formatBalanceValue,
  loadCodexDefaultConfigFromRuntimeApi,
  providerKeyValue,
  resolveProviderPresetId,
  rememberProviderKeyFromChannel,
  removePluginAt,
  updatePluginAt,
} from "./runtime-utils";
import { RuntimeProviderFields } from "./RuntimeProviderFields";
import { agentRecallAutomationService } from "../../app/services/agent-recall-service";

const AGENTS: AgentId[] = [...RUNTIME_IDS];
const PROVIDER_CATEGORY_ORDER = ["local", "official", "cn_official", "cloud_provider", "aggregator", "third_party", "custom"];

function providerCategoryLabel(category: string, language: Language): string {
  const labels: Record<string, [string, string]> = {
    local: ["本地配置", "Local config"],
    official: ["官方", "Official"],
    cn_official: ["国内官方 / Coding Plan", "China official / Coding plan"],
    cloud_provider: ["云服务商", "Cloud providers"],
    aggregator: ["聚合服务", "Aggregators"],
    third_party: ["第三方", "Third party"],
    custom: ["自定义", "Custom"],
  };
  const label = labels[category] ?? ["其他", "Other"];
  return language === "zh" ? label[0] : label[1];
}

const CONFIG_TEXT = {
  zh: {
    save: "保存配置",
    cliHelp: "选择要配置的 CLI 执行器。",
    providerHelp: "选择 Provider，会自动填充",
    apiKey: "API Key",
    usedByAll: "用于所有",
    advancedProvider: "高级 Provider 配置",
    plugins: "Codex 插件",
    loadCatalog: "加载目录",
    manual: "手动添加",
    catalog: "插件库",
    selectPlugin: "选择插件",
    noPluginsAvailable: "暂无可添加插件",
    noPluginsConfigured: "尚未配置插件",
    enabled: "启用",
    models: "模型",
    addModel: "添加模型",
    refreshModels: "刷新模型目录",
  },
  en: {
    save: "Save config",
    cliHelp: "Pick the CLI executor to configure.",
    providerHelp: "Select a provider to fill defaults for",
    apiKey: "API Key",
    usedByAll: "Used by all",
    advancedProvider: "Advanced provider config",
    plugins: "Codex Plugins",
    loadCatalog: "Load catalog",
    manual: "Manual",
    catalog: "Catalog",
    selectPlugin: "Select plugin",
    noPluginsAvailable: "No plugins available",
    noPluginsConfigured: "No plugins configured",
    enabled: "Enabled",
    models: "Models",
    addModel: "Add model",
    refreshModels: "Refresh models",
  },
} as const;

interface RuntimePageProps {
  embedded?: boolean;
  language?: Language;
  channels: AgentChannel[];
  selectedChannelId: string;
  selectedRuntimeId: AgentId;
  providerKeys: Record<string, string>;
  codexPluginCatalog: CodexPluginCatalogItem[];
  pluginCatalogStatus: string;
  agentTestResults: Record<string, AgentTestUiState>;
  testingAgentId: string | undefined;
  agentTestTick: number;
  balanceResults?: Record<string, ProviderBalanceResult>;
  balanceLoadingChannelId?: string | undefined;
  onUpdateChannel: (channelId: string, updater: (channel: AgentChannel) => AgentChannel) => void;
  onAddModel: (channelId: string) => void;
  onUpdateModel: (channelId: string, modelIndex: number, updater: (model: AgentModelOption) => AgentModelOption) => void;
  onRemoveModel: (channelId: string, modelIndex: number) => void;
  onRefreshModels?: (channelId: string) => Promise<void>;
  onSave: () => Promise<void>;
  onLoadCodexPluginCatalog: () => Promise<void>;
  onSelectChannel: (channelId: string) => void | Promise<void>;
  onSelectRuntime: (runtimeId: AgentId) => void;
  onAddConfig: () => void;
  onImportLocalConfig?: (runtimeId: AgentId, channelId?: string) => Promise<void>;
  onDeleteConfig: (channelId: string) => void;
  onTestChannel: (channelId: string) => Promise<void>;
  onQueryBalance?: (channelId: string) => Promise<void>;
  onUpdateProviderKey: (presetId: string, value: string) => void;
  onLoadCodexDefaultConfig?: () => Promise<CodexDefaultConfig>;
  onLoadClaudeDefaultConfig?: () => Promise<ClaudeDefaultConfig>;
  onReplaceChannelAndPersist?: (channelId: string, nextChannel: AgentChannel) => Promise<void>;
  status?: string;
  onStatusChange?: (message: string) => void;
}

export function RuntimePage({
  embedded = false,
  language = "en",
  channels,
  selectedChannelId,
  selectedRuntimeId,
  providerKeys,
  codexPluginCatalog,
  pluginCatalogStatus,
  agentTestResults,
  testingAgentId,
  agentTestTick,
  balanceResults = {},
  balanceLoadingChannelId,
  onUpdateChannel,
  onAddModel,
  onUpdateModel,
  onRemoveModel,
  onRefreshModels,
  onSave,
  onLoadCodexPluginCatalog,
  onSelectChannel,
  onSelectRuntime,
  onAddConfig,
  onImportLocalConfig,
  onDeleteConfig,
  onTestChannel,
  onQueryBalance,
  onUpdateProviderKey,
  onLoadCodexDefaultConfig,
  onLoadClaudeDefaultConfig,
  onReplaceChannelAndPersist,
  status = "",
  onStatusChange,
}: RuntimePageProps) {
  const configText = CONFIG_TEXT[language];
  const [showProviderKey, setShowProviderKey] = useState(false);
  const runtimeTitle = language === "zh" ? "配置" : "Config";
  const runtimeDescription =
    language === "zh"
      ? "管理 Codex / Claude / API / Hermes / OpenCode / OpenClaw 执行器、Provider、API Key、插件和模型。"
      : "Manage Codex / Claude / API / Hermes / OpenCode / OpenClaw executors, providers, API keys, plugins, and models.";
  const channelTitle = language === "zh" ? "配置" : "Config";
  const selectConfigText = language === "zh" ? "选择配置" : "Select config";
  const addConfigText = language === "zh" ? "新增配置" : "Add config";
  const deleteConfigText = language === "zh" ? "删除配置" : "Delete config";
  const runtimeConfigReady = language === "zh" ? "配置可用" : "Config works";
  const runtimeConfigTesting = language === "zh" ? "测试中" : "Testing";
  const runtimeConfigTest = language === "zh" ? "测试" : "Test";
  const runtimeConfigTestFailed = language === "zh" ? "测试失败" : "Test failed";
  const runtimeConfigTestRunning = language === "zh" ? "正在测试配置" : "Testing config";
  const runtimeExecutorLabel = language === "zh" ? "执行器" : "Executor";
  const balanceTitle = language === "zh" ? "余额" : "Balance";
  const refreshBalanceText = language === "zh" ? "刷新余额" : "Refresh balance";
  const balanceRefreshingText = language === "zh" ? "查询中" : "Checking";
  const balanceIdleText = language === "zh" ? "点击刷新查询当前 Provider 余额。" : "Refresh to query the current provider balance.";
  const balanceNoDataText = language === "zh" ? "Provider 没有返回余额明细。" : "The provider did not return balance details.";
  const visibleRuntimeChannels = useMemo(() => selectConfigChannelsForDisplay(channels), [channels]);
  const selectedRuntimeChannels = useMemo(
    () => visibleRuntimeChannels.filter((channel) => channel.agentId === selectedRuntimeId),
    [selectedRuntimeId, visibleRuntimeChannels],
  );
  const selectedRuntimeChannelRecord = useMemo(
    () => selectedRuntimeChannels.find((channel) => channel.id === selectedChannelId) ?? selectedRuntimeChannels[0],
    [selectedChannelId, selectedRuntimeChannels],
  );
  const selectedRuntimeChannelId = selectedRuntimeChannelRecord?.id ?? "";
  const configuredPluginIds = useMemo(() => new Set((selectedRuntimeChannelRecord?.plugins ?? []).map((plugin) => plugin.id)), [selectedRuntimeChannelRecord]);
  const availableCodexPlugins = useMemo(() => codexPluginCatalog.filter((plugin) => !configuredPluginIds.has(plugin.id)), [codexPluginCatalog, configuredPluginIds]);
  const selectedRuntime = selectedRuntimeId;
  const localConfigImportSupported = runtimeDefinition(selectedRuntime).localConfigImport;
  const runtimeProviderPresets = useMemo(() => AGENT_PROVIDER_PRESETS.filter((preset) => preset.runtimeAgentId === selectedRuntime), [selectedRuntime]);
  const runtimeProviderCategories = useMemo(() => {
    const categories = new Set(runtimeProviderPresets.map((preset) => preset.category ?? (preset.id.includes("custom") ? "custom" : "third_party")));
    return [...categories].sort((left, right) => {
      const leftIndex = PROVIDER_CATEGORY_ORDER.indexOf(left);
      const rightIndex = PROVIDER_CATEGORY_ORDER.indexOf(right);
      return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
    });
  }, [runtimeProviderPresets]);
  const updateSelectedRuntimeChannel = (updater: (channel: AgentChannel) => AgentChannel): void => {
    if (!selectedRuntimeChannelRecord) return;
    onUpdateChannel(selectedRuntimeChannelRecord.id, updater);
  };
  const selectedRuntimePresetId = resolveProviderPresetId(selectedRuntimeChannelRecord, runtimeProviderPresets);
  const selectedRuntimePreset = useMemo(
    () => (selectedRuntimePresetId ? AGENT_PROVIDER_PRESETS.find((preset) => preset.id === selectedRuntimePresetId) : undefined),
    [selectedRuntimePresetId],
  );
  const selectedProviderKey = providerKeyValue(providerKeys, selectedRuntimePreset, selectedRuntimeChannelRecord);
  const presetModelIds = useMemo(() => new Set(selectedRuntimePreset?.models.map((model) => model.id) ?? []), [selectedRuntimePreset]);
  const selectedRuntimeCustomModelId =
    selectedRuntimeChannelRecord?.models.filter((model) => model.id !== DEFAULT_MODEL_ID && !presetModelIds.has(model.id)).at(-1)?.id ?? "";
  const selectedChannelTestResult = selectedRuntimeChannelRecord ? agentTestResults[selectedRuntimeChannelRecord.id] : undefined;
  const selectedChannelTesting = Boolean(selectedRuntimeChannelRecord && testingAgentId === selectedRuntimeChannelRecord.id);
  const selectedBalanceResult = selectedRuntimeChannelRecord ? balanceResults[selectedRuntimeChannelRecord.id] : undefined;
  const selectedBalanceLoading = Boolean(selectedRuntimeChannelRecord && balanceLoadingChannelId === selectedRuntimeChannelRecord.id);
  const selectedChannelTestElapsedMs =
    selectedChannelTestResult?.state === "running"
      ? Date.now() - selectedChannelTestResult.startedAt + agentTestTick * 0
      : (selectedChannelTestResult?.elapsedMs ?? 0);
  const selectedChannelTestModelLabel = selectedChannelTestResult
    ? (selectedRuntimeChannelRecord?.models.find((model) => model.id === selectedChannelTestResult.modelId)?.label ?? selectedChannelTestResult.modelId)
    : "";

  const applyRuntimePreset = async (preset: AgentProviderPreset): Promise<void> => {
    if (!selectedRuntimeChannelRecord) return;
    if (preset.id === CODEX_LOCAL_DEFAULT_PRESET_ID) {
      try {
        onStatusChange?.("");
        const config = onLoadCodexDefaultConfig
          ? await onLoadCodexDefaultConfig()
          : await loadCodexDefaultConfigFromRuntimeApi(agentRecallAutomationService());
        onUpdateProviderKey(CODEX_LOCAL_DEFAULT_PRESET_ID, config.apiKey ?? "");
        const nextChannel = applyCodexDefaultConfigToChannel(selectedRuntimeChannelRecord, config);
        if (onReplaceChannelAndPersist) await onReplaceChannelAndPersist(selectedRuntimeChannelRecord.id, nextChannel);
        else updateSelectedRuntimeChannel(() => nextChannel);
      } catch (error) {
        onStatusChange?.(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (preset.id === CLAUDE_LOCAL_DEFAULT_PRESET_ID) {
      try {
        onStatusChange?.("");
        const config = onLoadClaudeDefaultConfig
          ? await onLoadClaudeDefaultConfig()
          : await agentRecallAutomationService().loadClaudeDefaultConfig();
        onUpdateProviderKey(CLAUDE_LOCAL_DEFAULT_PRESET_ID, config.apiKey ?? "");
        const nextChannel = applyClaudeDefaultConfigToChannel(selectedRuntimeChannelRecord, config);
        if (onReplaceChannelAndPersist) await onReplaceChannelAndPersist(selectedRuntimeChannelRecord.id, nextChannel);
        else updateSelectedRuntimeChannel(() => nextChannel);
      } catch (error) {
        onStatusChange?.(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (preset.id === OPENCODE_DEFAULT_PRESET_ID || preset.id === OPENCLAW_DEFAULT_PRESET_ID) {
      if (!onImportLocalConfig) {
        onStatusChange?.("Local default import requires a full app restart.");
        return;
      }
      await onImportLocalConfig(selectedRuntime, selectedRuntimeChannelRecord.id);
      return;
    }
    const cachedProviderKeys = rememberProviderKeyFromChannel(providerKeys, selectedRuntimePreset, selectedRuntimeChannelRecord);
    const cachedSelectedProviderKey = selectedRuntimePreset ? cachedProviderKeys[selectedRuntimePreset.id] : undefined;
    if (selectedRuntimePreset?.usesApiKey && cachedSelectedProviderKey && cachedSelectedProviderKey !== providerKeys[selectedRuntimePreset.id]) {
      onUpdateProviderKey(selectedRuntimePreset.id, cachedSelectedProviderKey);
    }
    const apiKey = cachedProviderKeys[preset.id] ?? (preset.id === selectedRuntimePresetId ? apiKeyFromChannelHeaders(selectedRuntimeChannelRecord, preset) : "");
    updateSelectedRuntimeChannel((channel) => applyProviderPresetToChannel(channel, preset, apiKey));
  };
  const updateSelectedProviderKey = (value: string): void => {
    if (!selectedRuntimePreset) return;
    onUpdateProviderKey(selectedRuntimePreset.id, value);
    updateSelectedRuntimeChannel((channel) =>
      selectedRuntimePreset.id === CODEX_LOCAL_DEFAULT_PRESET_ID ||
      selectedRuntimePreset.id === CLAUDE_LOCAL_DEFAULT_PRESET_ID ||
      selectedRuntimePreset.id === OPENCODE_DEFAULT_PRESET_ID
        ? applyProviderApiKeyToChannel(channel, selectedRuntimePreset, value)
        : applyProviderPresetToChannel(channel, selectedRuntimePreset, value),
    );
  };
  const updateSelectedProviderModelId = (value: string): void => {
    const modelId = value.trim();
    const previousModelId = selectedRuntimeCustomModelId;
    updateSelectedRuntimeChannel((channel) => ({
      ...channel,
      models: modelId
        ? channel.models.some((model) => model.id === previousModelId)
          ? channel.models
              .map((model) => (model.id === previousModelId ? { id: modelId, label: modelId } : model))
              .filter((model, index, models) => models.findIndex((item) => item.id === model.id) === index)
          : channel.models.some((model) => model.id === modelId)
            ? channel.models.map((model) => (model.id === modelId ? { ...model, label: model.label || modelId } : model))
            : [...channel.models, { id: modelId, label: modelId }]
        : channel.models.filter((model) => model.id !== previousModelId),
    }));
  };

  return (
    <section className="runtime-page">
      {!embedded ? <header className="config-header runtime-header">
        <div>
          <h2>{runtimeTitle}</h2>
          <p>{runtimeDescription}</p>
        </div>
        <button className="control-btn compact" type="button" onClick={() => void onSave()}>
          <Save size={13} />
          <span>{configText.save}</span>
        </button>
      </header> : null}

      <div className="runtime-layout">
        <div className="runtime-config-toolbar">
          <label className="runtime-config-picker">
            <span>{channelTitle}</span>
            <select
              aria-label={selectConfigText}
              value={selectedRuntimeChannelId}
              disabled={visibleRuntimeChannels.length === 0}
              onChange={(event) => void onSelectChannel(event.target.value)}
            >
              {visibleRuntimeChannels.map((channel) => {
                const label = channel.label || channel.id;
                const provider = channel.providerName ?? channel.modelProvider ?? channel.id;
                return <option key={channel.id} value={channel.id}>{`${agentLabel(channel.agentId)} · ${label} · ${provider}`}</option>;
              })}
            </select>
          </label>
          <div className="runtime-config-toolbar-actions">
            <button className="control-btn compact secondary" type="button" onClick={onAddConfig}>
              <Plus size={13} />
              <span>{addConfigText}</span>
            </button>
            <button
              className="icon-btn"
              type="button"
              aria-label={deleteConfigText}
              title={deleteConfigText}
              disabled={!selectedRuntimeChannelId || visibleRuntimeChannels.length <= 1}
              onClick={() => onDeleteConfig(selectedRuntimeChannelId)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        <section className="config-form runtime-editor">
          <section className="agent-provider-presets runtime-selector">
            <div className="agent-provider-presets-head">
              <h3>CLI</h3>
              <span>{configText.cliHelp}</span>
            </div>
            <div className="agent-provider-preset-list">
              {AGENTS.map((agentId) => (
                <button
                  type="button"
                  key={agentId}
                  className={`agent-provider-preset ${selectedRuntime === agentId ? "is-active" : ""}`}
                  title={agentLabel(agentId)}
                  onClick={() => onSelectRuntime(agentId)}
                >
                  <span className={`runtime-choice-dot ${agentAccent(agentId)}`} aria-hidden="true" />
                  <strong>{agentLabel(agentId)}</strong>
                </button>
              ))}
            </div>
          </section>
          {selectedRuntimeChannelRecord ? (
            <>
              <div className="runtime-editor-actions">
                <div>
                  <span className={`agent-badge mini ${agentAccent(selectedRuntime)}`}>{agentLabel(selectedRuntime)}</span>
                  <strong>{selectedRuntimeChannelRecord.label || selectedRuntimeChannelRecord.id}</strong>
                </div>
                <div className="config-plugin-actions">
                  {localConfigImportSupported && onImportLocalConfig ? (
                    <button
                      type="button"
                      className="control-btn compact secondary"
                      onClick={() => void onImportLocalConfig(selectedRuntime, selectedRuntimeChannelRecord.id)}
                    >
                      <RefreshCw size={13} />
                      <span>{language === "zh" ? "导入本地默认配置" : "Import local defaults"}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="control-btn compact secondary"
                    onClick={() => void onTestChannel(selectedRuntimeChannelRecord.id)}
                    disabled={selectedChannelTesting}
                  >
                    <RefreshCw size={13} />
                    <span>{selectedChannelTesting ? runtimeConfigTesting : runtimeConfigTest}</span>
                  </button>
                </div>
              </div>
              {status ? <div className="config-status runtime-config-status">{status}</div> : null}
              {selectedChannelTestResult ? (
                selectedChannelTestResult.state === "passed" ? (
                  <section className="agent-test-result passed collapsed">
                    <div className="agent-test-success-icon" aria-hidden="true">
                      <CheckCircle2 size={16} />
                    </div>
                    <div className="agent-test-success-copy">
                      <strong>{runtimeConfigReady}</strong>
                      <span>{`${selectedChannelTestResult.providerLabel} · ${selectedChannelTestModelLabel}`}</span>
                    </div>
                    <span className="agent-test-success-duration">{formatDuration(selectedChannelTestElapsedMs)}</span>
                  </section>
                ) : (
                  <section className={`agent-test-result ${selectedChannelTestResult.state}`}>
                    <div className="agent-test-result-head">
                      <div>
                        <strong>{selectedChannelTestResult.state === "running" ? runtimeConfigTestRunning : runtimeConfigTestFailed}</strong>
                        <span>{selectedChannelTestResult.phase}</span>
                      </div>
                      <span>{formatDuration(selectedChannelTestElapsedMs)}</span>
                    </div>
                    {selectedChannelTestResult.state === "running" ? <div className="agent-test-progress" aria-hidden="true" /> : null}
                    <dl className="agent-test-meta">
                      <div>
                        <dt>{runtimeExecutorLabel}</dt>
                        <dd>{agentLabel(selectedChannelTestResult.runtimeAgentId)}</dd>
                      </div>
                      <div>
                        <dt>Provider</dt>
                        <dd>{selectedChannelTestResult.providerLabel}</dd>
                      </div>
                      <div>
                        <dt>Model</dt>
                        <dd>{selectedChannelTestResult.modelId}</dd>
                      </div>
                    </dl>
                    <p>{selectedChannelTestResult.message}</p>
                    {selectedChannelTestResult.transcript.length > 0 ? (
                      <div className="agent-test-transcript" aria-label="Config test interaction">
                        {selectedChannelTestResult.transcript.map((item) => (
                          <div key={item.id} className={`agent-test-transcript-row ${item.type}`}>
                            <span>{agentTestEventLabel(item.type)}</span>
                            <pre>{item.content}</pre>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {selectedChannelTestResult.output ? <pre>{selectedChannelTestResult.output}</pre> : null}
                  </section>
                )
              ) : null}
              <section className={`provider-balance-panel ${selectedBalanceResult?.status ?? "idle"}`}>
                <div className="provider-balance-head">
                  <div>
                    <h3>{balanceTitle}</h3>
                    <span>{selectedBalanceResult?.providerName ?? selectedRuntimeChannelRecord.providerName ?? selectedRuntimeChannelRecord.label}</span>
                  </div>
                  <button
                    type="button"
                    className="control-btn compact secondary"
                    onClick={() => void onQueryBalance?.(selectedRuntimeChannelRecord.id)}
                    disabled={selectedBalanceLoading || !onQueryBalance}
                  >
                    <RefreshCw size={13} />
                    <span>{selectedBalanceLoading ? balanceRefreshingText : refreshBalanceText}</span>
                  </button>
                </div>
                {selectedBalanceResult ? (
                  <div className="provider-balance-body">
                    {selectedBalanceResult.items.length > 0 ? (
                      selectedBalanceResult.items.map((item, index) => {
                        const detail = formatBalanceDetail(item, language);
                        return (
                          <div key={`${item.label ?? "balance"}:${index}`} className={`provider-balance-item ${item.isValid === false ? "is-invalid" : ""}`}>
                            <span>{item.label ?? selectedBalanceResult.providerName ?? balanceTitle}</span>
                            <strong>{formatBalanceValue(item)}</strong>
                            {detail ? <small>{detail}</small> : null}
                          </div>
                        );
                      })
                    ) : (
                      <p>{selectedBalanceResult.status === "success" ? balanceNoDataText : selectedBalanceResult.message}</p>
                    )}
                  </div>
                ) : (
                  <p className="provider-balance-idle">{selectedBalanceLoading ? balanceRefreshingText : balanceIdleText}</p>
                )}
              </section>
              <details className="agent-provider-presets agent-provider-disclosure" open>
                <summary className="agent-provider-presets-head">
                  <h3>Provider</h3>
                  <span>{selectedRuntimePreset?.label ?? agentLabel(selectedRuntime)}</span>
                </summary>
                <div className="agent-provider-catalog" aria-label="Provider presets">
                  {runtimeProviderCategories.map((category) => (
                    <section className="agent-provider-category" key={category}>
                      <span className="agent-provider-category-label">{providerCategoryLabel(category, language)}</span>
                      <div className="agent-provider-option-grid">
                        {runtimeProviderPresets
                          .filter((preset) => (preset.category ?? (preset.id.includes("custom") ? "custom" : "third_party")) === category)
                          .map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              className={`agent-provider-option ${selectedRuntimePresetId === preset.id ? "is-active" : ""}`}
                              aria-pressed={selectedRuntimePresetId === preset.id}
                              title={preset.label}
                              onClick={() => void applyRuntimePreset(preset)}
                            >
                              {preset.label}
                            </button>
                          ))}
                      </div>
                    </section>
                  ))}
                </div>
                {selectedRuntimePreset?.usesApiKey ? (
                  <label className="agent-provider-key-field">
                    <span>{configText.apiKey}</span>
                    <div className="agent-provider-key-input">
                      <input
                        aria-label="Provider API key"
                        type={showProviderKey ? "text" : "password"}
                        value={selectedProviderKey}
                        placeholder={`${configText.usedByAll} ${selectedRuntimePreset.label} agents`}
                        onChange={(event) => updateSelectedProviderKey(event.currentTarget.value)}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={showProviderKey ? "Hide provider API key" : "Show provider API key"}
                        title={showProviderKey ? "Hide" : "Show"}
                        onClick={() => setShowProviderKey((visible) => !visible)}
                      >
                        {showProviderKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </label>
                ) : null}
                {selectedRuntimePreset?.configurableModelId ? (
                  <label className="agent-provider-key-field">
                    <span>{selectedRuntimePreset.configurableModelLabel ?? "Model ID"}</span>
                    <input
                      aria-label="Provider endpoint or model id"
                      value={selectedRuntimeCustomModelId}
                      placeholder={selectedRuntimePreset.configurableModelPlaceholder ?? "model-or-endpoint-id"}
                      onChange={(event) => updateSelectedProviderModelId(event.currentTarget.value)}
                    />
                  </label>
                ) : null}
              </details>

              <details className="agent-advanced-panel">
                <summary>{configText.advancedProvider}</summary>
                <RuntimeProviderFields
                  channel={selectedRuntimeChannelRecord}
                  language={language}
                  onChange={updateSelectedRuntimeChannel}
                />
              </details>

              {selectedRuntime === "codex" ? (
                <section className="agent-channel-models">
                  <div className="config-models-header">
                    <h3>{configText.plugins}</h3>
                    <div className="config-plugin-actions">
                      <button
                        className="control-btn compact secondary"
                        type="button"
                        onClick={() => void onLoadCodexPluginCatalog()}
                        aria-label="Load Codex plugin catalog"
                      >
                        <RefreshCw size={13} />
                        <span>{configText.loadCatalog}</span>
                      </button>
                      <button
                        className="control-btn compact secondary"
                        type="button"
                        onClick={() =>
                          updateSelectedRuntimeChannel((channel) => ({
                            ...channel,
                            plugins: [...(channel.plugins ?? []), { id: "plugin@marketplace", enabled: true }],
                          }))
                        }
                        aria-label="Add manual plugin"
                      >
                        <Plus size={13} />
                        <span>{configText.manual}</span>
                      </button>
                    </div>
                  </div>
                  <label className="config-field config-plugin-catalog">
                    <span>{configText.catalog}</span>
                    <select
                      aria-label="Codex plugin catalog"
                      value=""
                      onChange={(event) => {
                        const pluginId = event.currentTarget.value;
                        if (!pluginId) return;
                        updateSelectedRuntimeChannel((channel) => addPluginToChannel(channel, pluginId));
                      }}
                      disabled={availableCodexPlugins.length === 0}
                    >
                      <option value="">{availableCodexPlugins.length > 0 ? configText.selectPlugin : configText.noPluginsAvailable}</option>
                      {availableCodexPlugins.map((plugin) => {
                        const state = plugin.enabled ? "enabled" : plugin.installed ? "installed" : "available";
                        return (
                          <option key={plugin.id} value={plugin.id}>
                            {`${plugin.id} (${state})`}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  {pluginCatalogStatus ? <div className="config-plugin-catalog-status">{pluginCatalogStatus}</div> : null}
                  <div className="config-plugin-list">
                    {(selectedRuntimeChannelRecord.plugins ?? []).length === 0 ? (
                      <div className="empty-state config-empty">{configText.noPluginsConfigured}</div>
                    ) : (
                      (selectedRuntimeChannelRecord.plugins ?? []).map((plugin, index) => (
                        <div key={`${plugin.id}:${index}`} className="config-plugin-row">
                          <input
                            aria-label="Plugin id"
                            value={plugin.id}
                            onChange={(event) =>
                              updateSelectedRuntimeChannel((channel) => updatePluginAt(channel, index, (item) => ({ ...item, id: event.currentTarget.value })))
                            }
                          />
                          <label className="config-plugin-toggle">
                            <input
                              type="checkbox"
                              checked={plugin.enabled}
                              onChange={(event) =>
                                updateSelectedRuntimeChannel((channel) =>
                                  updatePluginAt(channel, index, (item) => ({ ...item, enabled: event.currentTarget.checked })),
                                )
                              }
                            />
                            <span>{configText.enabled}</span>
                          </label>
                          <button className="icon-btn danger" type="button" onClick={() => updateSelectedRuntimeChannel((channel) => removePluginAt(channel, index))}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              ) : null}

              <section className="agent-channel-models">
                <div className="config-models-header">
                  <h3>{configText.models}</h3>
                  <div className="config-plugin-actions">
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label="Refresh model catalog"
                      title={configText.refreshModels}
                      disabled={!onRefreshModels}
                      onClick={() => void onRefreshModels?.(selectedRuntimeChannelRecord.id)}
                    >
                      <RefreshCw size={13} />
                    </button>
                    <button className="control-btn compact secondary" onClick={() => onAddModel(selectedRuntimeChannelRecord.id)}>
                      <Plus size={13} />
                      <span>{configText.addModel}</span>
                    </button>
                  </div>
                </div>
                <div className="config-model-list">
                  {selectedRuntimeChannelRecord.models.map((model, index) => (
                    <div key={`${model.id}:${index}`} className="config-model-row">
                      <input
                        aria-label="Agent model id"
                        value={model.id}
                        onChange={(event) => onUpdateModel(selectedRuntimeChannelRecord.id, index, (item) => ({ ...item, id: event.currentTarget.value }))}
                      />
                      <input
                        aria-label="Agent model label"
                        value={model.label}
                        onChange={(event) => onUpdateModel(selectedRuntimeChannelRecord.id, index, (item) => ({ ...item, label: event.currentTarget.value }))}
                      />
                      <button
                        className="icon-btn danger"
                        onClick={() => onRemoveModel(selectedRuntimeChannelRecord.id, index)}
                        disabled={model.id === DEFAULT_MODEL_ID}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="empty-state config-empty runtime-empty-config">
              <strong>{agentLabel(selectedRuntime)}</strong>
              <span>{language === "zh" ? "尚无本地配置" : "No local config yet"}</span>
              <div className="config-plugin-actions">
                {localConfigImportSupported && onImportLocalConfig ? (
                  <button className="control-btn compact secondary" type="button" onClick={() => void onImportLocalConfig(selectedRuntime)}>
                    <RefreshCw size={13} />
                    <span>{language === "zh" ? "一键导入本地默认配置" : "Import local defaults"}</span>
                  </button>
                ) : null}
                <button className="control-btn compact secondary" type="button" onClick={onAddConfig}>
                  <Plus size={13} />
                  <span>{language === "zh" ? "新建配置" : "Create config"}</span>
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
