import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Eye, EyeOff, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
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
import { RUNTIME_DEFINITIONS, runtimeDefinition } from "../../../../shared/runtime-catalog";
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
import { RuntimeProviderPicker } from "./RuntimeProviderPicker";
import { agentRecallAutomationService } from "../../app/services/agent-recall-service";

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
  onAddConfig: (runtimeId: AgentId) => void;
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
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [providerQuery, setProviderQuery] = useState("");
  const [runtimePickerOpen, setRuntimePickerOpen] = useState(false);
  const firstRuntimeChoiceRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (runtimePickerOpen) firstRuntimeChoiceRef.current?.focus();
  }, [runtimePickerOpen]);
  const runtimeTitle = language === "zh" ? "配置" : "Config";
  const runtimeDescription =
    language === "zh"
      ? "管理 Codex / Claude / API / Hermes / OpenCode / OpenClaw 执行器、Provider、API Key、插件和模型。"
      : "Manage Codex / Claude / API / Hermes / OpenCode / OpenClaw executors, providers, API keys, plugins, and models.";
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
  const balanceNoDataText = language === "zh" ? "Provider 没有返回余额明细。" : "The provider did not return balance details.";
  const balanceNotQueriedText = language === "zh" ? "未查询" : "Not checked";
  const balanceUnavailableText = language === "zh" ? "不可用" : "Unavailable";
  const changeProviderText = language === "zh" ? "更换 Provider" : "Change provider";
  const currentConfigText = language === "zh" ? "当前配置" : "Current config";
  const modelsDescription = language === "zh" ? "管理当前配置可用的模型" : "Manage models available to this config";
  const pluginsDescription = language === "zh" ? "管理 Codex 的扩展能力" : "Manage Codex extensions";
  const advancedDescription = language === "zh" ? "连接、环境变量与请求覆盖" : "Connection, environment, and request overrides";
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
  const selectedBalanceItem = selectedBalanceResult?.items[0];
  const selectedBalanceDetail = selectedBalanceItem ? formatBalanceDetail(selectedBalanceItem, language) : "";
  const selectedBalanceValue = selectedBalanceLoading
    ? balanceRefreshingText
    : selectedBalanceItem
      ? formatBalanceValue(selectedBalanceItem)
      : selectedBalanceResult
        ? selectedBalanceResult.status === "success"
          ? balanceNoDataText
          : balanceUnavailableText
        : balanceNotQueriedText;
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
  const closeProviderPicker = (): void => {
    setProviderPickerOpen(false);
    setProviderQuery("");
  };
  const openRuntimePicker = (): void => {
    closeProviderPicker();
    setRuntimePickerOpen(true);
  };
  const selectRuntimeForNewConfig = (runtimeId: AgentId): void => {
    onAddConfig(runtimeId);
    setRuntimePickerOpen(false);
  };
  const selectRuntimeProvider = async (preset: AgentProviderPreset): Promise<void> => {
    await applyRuntimePreset(preset);
    closeProviderPicker();
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
        <div className="runtime-config-workspace">
          <aside className="runtime-config-sidebar" aria-label={language === "zh" ? "Runtime 配置" : "Runtime configs"}>
            <header>
              <div>
                <strong>{currentConfigText}</strong>
                <small>{visibleRuntimeChannels.length}</small>
              </div>
              <div className="runtime-sidebar-actions">
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={addConfigText}
                  title={addConfigText}
                  aria-haspopup="dialog"
                  aria-expanded={runtimePickerOpen}
                  onClick={openRuntimePicker}
                >
                  <Plus size={13} />
                </button>
                <button
                  className="icon-btn danger"
                  type="button"
                  aria-label={deleteConfigText}
                  title={deleteConfigText}
                  disabled={!selectedRuntimeChannelId || visibleRuntimeChannels.length <= 1}
                  onClick={() => onDeleteConfig(selectedRuntimeChannelId)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </header>
            <nav className="runtime-sidebar-list">
              {visibleRuntimeChannels.map((channel) => (
                <button
                  type="button"
                  key={channel.id}
                  className={`runtime-sidebar-item ${selectedRuntimeChannelId === channel.id ? "is-active" : ""}`}
                  data-runtime={channel.agentId}
                  aria-current={selectedRuntimeChannelId === channel.id ? "true" : undefined}
                  title={`${agentLabel(channel.agentId)} · ${channel.label || channel.id}`}
                  onClick={() => {
                    onSelectRuntime(channel.agentId);
                    void onSelectChannel(channel.id);
                  }}
                >
                  <span className={`runtime-choice-dot ${agentAccent(channel.agentId)}`} aria-hidden="true" />
                  <span>
                    <strong>{agentLabel(channel.agentId)}</strong>
                    <small>{channel.label || channel.id}</small>
                  </span>
                </button>
              ))}
            </nav>
          </aside>

          <section className="config-form runtime-editor">
          {selectedRuntimeChannelRecord ? (
            <>
              <section className="runtime-config-summary" data-runtime={selectedRuntime}>
                <div className="runtime-summary-main">
                  <div className="runtime-summary-config">
                    <span>{runtimeExecutorLabel}</span>
                    <div className="runtime-summary-identity">
                      <span className={`agent-badge mini ${agentAccent(selectedRuntime)}`}>{agentLabel(selectedRuntime)}</span>
                      <strong title={selectedRuntimeChannelRecord.label || selectedRuntimeChannelRecord.id}>
                        {selectedRuntimeChannelRecord.label || selectedRuntimeChannelRecord.id}
                      </strong>
                    </div>
                  </div>

                  <div className="runtime-summary-provider">
                    <span>Provider</span>
                    <strong>{selectedRuntimePreset?.label ?? selectedRuntimeChannelRecord.providerName ?? agentLabel(selectedRuntime)}</strong>
                    <button type="button" className="runtime-summary-link" onClick={() => setProviderPickerOpen(true)}>
                      {changeProviderText}
                    </button>
                  </div>

                  <div className={`runtime-summary-balance ${selectedBalanceResult?.status ?? "idle"}`}>
                    <div>
                      <span>{balanceTitle}</span>
                      <strong>{selectedBalanceValue}</strong>
                      <small>
                        {selectedBalanceItem?.label ?? selectedBalanceResult?.message ?? selectedRuntimeChannelRecord.providerName ?? selectedRuntimeChannelRecord.label}
                        {selectedBalanceDetail ? ` · ${selectedBalanceDetail}` : ""}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={selectedBalanceLoading ? balanceRefreshingText : refreshBalanceText}
                      title={selectedBalanceLoading ? balanceRefreshingText : refreshBalanceText}
                      onClick={() => void onQueryBalance?.(selectedRuntimeChannelRecord.id)}
                      disabled={selectedBalanceLoading || !onQueryBalance}
                    >
                      <RefreshCw size={13} className={selectedBalanceLoading ? "is-spinning" : undefined} />
                    </button>
                  </div>
                </div>

                <div className="runtime-summary-actions">
                  {localConfigImportSupported && onImportLocalConfig ? (
                    <button
                      type="button"
                      className="control-btn compact secondary"
                      onClick={() => void onImportLocalConfig(selectedRuntime, selectedRuntimeChannelRecord.id)}
                    >
                      <RefreshCw size={13} />
                      <span>{language === "zh" ? "导入本地配置" : "Import local config"}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="control-btn compact"
                    onClick={() => void onTestChannel(selectedRuntimeChannelRecord.id)}
                    disabled={selectedChannelTesting}
                  >
                    <RefreshCw size={13} className={selectedChannelTesting ? "is-spinning" : undefined} />
                    <span>{selectedChannelTesting ? runtimeConfigTesting : runtimeConfigTest}</span>
                  </button>
                </div>
              </section>
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
              {selectedRuntimePreset?.usesApiKey || selectedRuntimePreset?.configurableModelId ? (
                <section className="runtime-connection-fields">
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
                </section>
              ) : null}

              {providerPickerOpen ? (
                <RuntimeProviderPicker
                  language={language}
                  presets={runtimeProviderPresets}
                  selectedPresetId={selectedRuntimePresetId}
                  query={providerQuery}
                  onQueryChange={setProviderQuery}
                  onSelect={selectRuntimeProvider}
                  onClose={closeProviderPicker}
                />
              ) : null}

              {selectedRuntime === "codex" ? (
                <details className="runtime-config-disclosure runtime-plugins-disclosure">
                  <summary>
                    <div>
                      <strong>{configText.plugins}</strong>
                      <span>{pluginsDescription}</span>
                    </div>
                    <small>{(selectedRuntimeChannelRecord.plugins ?? []).length}</small>
                  </summary>
                  <div className="runtime-disclosure-content agent-channel-models">
                  <div className="config-models-header">
                    <span>{language === "zh" ? "为当前 Codex 配置添加插件" : "Add plugins to the current Codex config"}</span>
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
                  </div>
                </details>
              ) : null}

              <details className="runtime-config-disclosure runtime-models-disclosure">
                <summary>
                  <div>
                    <strong>{configText.models}</strong>
                    <span>{modelsDescription}</span>
                  </div>
                  <small>{selectedRuntimeChannelRecord.models.length}</small>
                </summary>
                <div className="runtime-disclosure-content agent-channel-models">
                <div className="config-models-header">
                  <span>{language === "zh" ? "模型 ID 与显示名称" : "Model ID and display name"}</span>
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
                </div>
              </details>

              <details className="runtime-config-disclosure runtime-advanced-disclosure">
                <summary>
                  <div>
                    <strong>{configText.advancedProvider}</strong>
                    <span>{advancedDescription}</span>
                  </div>
                  <small>{language === "zh" ? "可选" : "Optional"}</small>
                </summary>
                <div className="runtime-disclosure-content">
                  <RuntimeProviderFields
                    channel={selectedRuntimeChannelRecord}
                    language={language}
                    onChange={updateSelectedRuntimeChannel}
                  />
                </div>
              </details>
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
                <button className="control-btn compact secondary" type="button" onClick={openRuntimePicker}>
                  <Plus size={13} />
                  <span>{language === "zh" ? "新建配置" : "Create config"}</span>
                </button>
              </div>
            </div>
          )}
          </section>
        </div>
      </div>

      <div
        className="runtime-provider-picker-backdrop runtime-type-picker-backdrop"
        role="presentation"
        hidden={!runtimePickerOpen}
        aria-hidden={!runtimePickerOpen}
        onMouseDown={() => setRuntimePickerOpen(false)}
      >
        <section
          className="runtime-provider-picker runtime-type-picker"
          role="dialog"
          aria-modal="true"
          aria-label={language === "zh" ? "选择执行器类型" : "Choose executor type"}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") setRuntimePickerOpen(false);
          }}
        >
          <header className="runtime-provider-picker-head">
            <div>
              <strong>{addConfigText}</strong>
              <span>
                {language === "zh"
                  ? "先选择执行器，创建后再配置 Provider 和模型。"
                  : "Choose an executor first, then configure its provider and models."}
              </span>
            </div>
            <button
              className="icon-btn"
              type="button"
              aria-label={language === "zh" ? "关闭" : "Close"}
              onClick={() => setRuntimePickerOpen(false)}
            >
              <X size={15} />
            </button>
          </header>

          <div className="runtime-provider-picker-body runtime-type-picker-body">
            <div className="runtime-type-picker-options">
              {RUNTIME_DEFINITIONS.map((definition, index) => (
                <button
                  key={definition.id}
                  type="button"
                  className="runtime-type-picker-option"
                  data-runtime-choice={definition.id}
                  ref={index === 0 ? firstRuntimeChoiceRef : undefined}
                  onClick={() => selectRuntimeForNewConfig(definition.id)}
                >
                  <span className={`runtime-choice-dot ${agentAccent(definition.id)}`} aria-hidden="true" />
                  <span>
                    <strong>{definition.label}</strong>
                    <small>
                      {definition.id === "api"
                        ? language === "zh"
                          ? "连接 OpenAI 兼容 HTTP API"
                          : "Connect an OpenAI-compatible HTTP API"
                        : language === "zh"
                          ? `使用 ${definition.executable} CLI`
                          : `Use the ${definition.executable} CLI`}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
