import { Bot, Cpu, Save } from "lucide-react";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { createConfiguredAgent } from "../../../../automation/engine/renderer/src/app/app-state";
import { AgentPage } from "../../../../automation/engine/renderer/src/pages/agent/AgentPage";
import { RuntimePage } from "../../../../automation/engine/renderer/src/pages/runtime/RuntimePage";
import { useRuntimeConfigManager } from "../../../../automation/engine/renderer/src/pages/runtime/hooks/useRuntimeConfigManager";
import type { ConfiguredAgent } from "../../../../automation/contracts";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";
import { AutomationPageState } from "./automation-page-state";
import { useAutomation } from "./automation-provider";

const PROVIDER_KEYS_STORAGE_KEY = "agent-recall-automation-provider-keys";

function readProviderKeys(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROVIDER_KEYS_STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function RuntimeFeaturePage({
  language,
  onNavigationGuardChange,
}: {
  language: LanguageMode;
  onNavigationGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
}): ReactElement {
  const { api, snapshot, setSnapshot, loading, error, refresh } = useAutomation();
  const [view, setView] = useState<"channels" | "agents">("channels");
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>(readProviderKeys);
  const [editableAgents, setEditableAgents] = useState<ConfiguredAgent[]>(snapshot.configuredAgents);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentDirty, setAgentDirty] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  const manager = useRuntimeConfigManager({ chatApi: api, snapshot, setSnapshot, runtimeViewActive: true });

  const saveAgents = useCallback(async (): Promise<void> => {
    setAgentStatus("");
    try {
      const next = await api.saveConfiguredAgents(editableAgents);
      setSnapshot(next);
      setEditableAgents(next.configuredAgents);
      setAgentDirty(false);
      setAgentStatus(localize(language, "Saved", "已保存"));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setAgentStatus(message);
      throw cause;
    }
  }, [api, editableAgents, language, setSnapshot]);

  useEffect(() => {
    if (!agentDirty) setEditableAgents(snapshot.configuredAgents);
  }, [agentDirty, snapshot.configuredAgents]);

  useEffect(() => {
    const fallbackId = editableAgents[0]?.id ?? "";
    if (!editableAgents.some((agent) => agent.id === selectedAgentId)) setSelectedAgentId(fallbackId);
  }, [editableAgents, selectedAgentId]);

  useEffect(() => {
    if (!onNavigationGuardChange) return undefined;
    if (!manager.configDirty && !agentDirty) {
      onNavigationGuardChange(null);
      return () => onNavigationGuardChange(null);
    }
    onNavigationGuardChange(async () => {
      if (manager.configDirty && !(await manager.confirmSaveBeforeSwitch(localize(
        language,
        "Runtime configuration has unsaved changes. Save before leaving?",
        "Runtime 配置尚未保存，离开前保存吗？",
      )))) return false;
      if (agentDirty) await saveAgents();
      return true;
    });
    return () => onNavigationGuardChange(null);
  }, [agentDirty, language, manager.configDirty, manager.confirmSaveBeforeSwitch, onNavigationGuardChange, saveAgents]);

  const switchView = async (next: "channels" | "agents"): Promise<void> => {
    if (view === next) return;
    if (view === "channels" && manager.configDirty && !(await manager.confirmSaveBeforeSwitch(localize(
      language,
      "Runtime configuration has unsaved changes. Save before switching?",
      "Runtime 配置尚未保存，切换前保存吗？",
    )))) return;
    if (view === "agents" && agentDirty) await saveAgents();
    setView(next);
  };

  const addAgent = (): void => {
    const agent = createConfiguredAgent(snapshot.channels, editableAgents.map((item) => item.id));
    setEditableAgents((current) => [...current, agent]);
    setSelectedAgentId(agent.id);
    setAgentDirty(true);
    setAgentStatus("");
  };

  const updateAgent = (agentId: string, updater: (agent: ConfiguredAgent) => ConfiguredAgent): void => {
    setEditableAgents((current) => current.map((agent) => {
      if (agent.id !== agentId) return agent;
      const { managed: _managed, ...editable } = updater(agent);
      return { ...editable, updatedAt: Date.now() };
    }));
    setAgentDirty(true);
    setAgentStatus("");
  };

  return (
    <div className="automation-page automation-runtime-page" data-page="runtimes" onClick={() => manager.setConfigContextMenu(undefined)}>
      <header className="app-page-head automation-page-head">
        <div>
          <h2>Runtime</h2>
          <p>{localize(language, "Configure executors, providers, models, plugins, and reusable Agent profiles.", "配置执行器、Provider、模型、插件与可复用 Agent。")}</p>
        </div>
        <button
          className="automation-control-button is-primary"
          type="button"
          onClick={() => void (view === "channels" ? manager.saveChannelConfig() : saveAgents())}
        >
          <Save size={13} />{localize(language, "Save", "保存")}
        </button>
      </header>
      <nav className="automation-tabs" aria-label={localize(language, "Runtime views", "Runtime 视图")}>
        <button className={view === "channels" ? "is-active" : ""} type="button" onClick={() => void switchView("channels")}>
          <Cpu size={14} />{localize(language, "Execution configs", "执行配置")}<small>{snapshot.channels.length}</small>
        </button>
        <button className={view === "agents" ? "is-active" : ""} type="button" onClick={() => void switchView("agents")}>
          <Bot size={14} />Agent<small>{snapshot.configuredAgents.length}</small>
        </button>
      </nav>
      <AutomationPageState loading={loading} error={error} language={language} onRetry={() => void refresh()}>
        <div className={`automation-runtime-content ${view === "channels" ? "is-channels" : "is-agents"}`}>
          {view === "channels" ? (
            <RuntimePage
              embedded
              language={language}
              channels={manager.configChannels}
              selectedChannelId={manager.selectedConfigChannelId}
              selectedRuntimeId={manager.selectedRuntimeId}
              providerKeys={providerKeys}
              codexPluginCatalog={manager.codexPluginCatalog}
              pluginCatalogStatus={manager.pluginCatalogStatus}
              agentTestResults={manager.agentTestResults}
              testingAgentId={manager.testingAgentId}
              agentTestTick={manager.agentTestTick}
              balanceResults={manager.balanceResults}
              balanceLoadingChannelId={manager.balanceLoadingChannelId}
              status={manager.configStatus}
              onUpdateChannel={manager.updateConfigChannel}
              onAddModel={manager.addConfigModel}
              onUpdateModel={manager.updateConfigModel}
              onRemoveModel={manager.removeConfigModel}
              onRefreshModels={manager.refreshModelCatalog}
              onSave={manager.saveChannelConfig}
              onLoadCodexPluginCatalog={manager.loadCodexPluginCatalog}
              onSelectChannel={manager.selectConfigChannel}
              onSelectRuntime={manager.selectRuntime}
              onAddConfig={manager.addConfigChannel}
              onImportLocalConfig={manager.importLocalConfig}
              onDeleteConfig={manager.deleteConfigChannel}
              onTestChannel={manager.testRuntimeChannel}
              onQueryBalance={manager.queryRuntimeChannelBalance}
              onUpdateProviderKey={(presetId, value) => manager.updateProviderKey(PROVIDER_KEYS_STORAGE_KEY, setProviderKeys, presetId, value)}
              onLoadCodexDefaultConfig={api.loadCodexDefaultConfig}
              onLoadClaudeDefaultConfig={api.loadClaudeDefaultConfig}
              onReplaceChannelAndPersist={manager.replaceConfigChannelAndPersist}
              onStatusChange={manager.setConfigStatus}
            />
          ) : (
            <AgentPage
              language={language}
              channels={snapshot.channels}
              configuredAgents={editableAgents}
              selectedConfiguredAgentId={selectedAgentId}
              status={agentStatus}
              onSave={saveAgents}
              onAddConfiguredAgent={addAgent}
              onSelectConfiguredAgent={setSelectedAgentId}
              onUpdateConfiguredAgent={updateAgent}
            />
          )}
        </div>
      </AutomationPageState>
    </div>
  );
}
