import { Bot, Cpu, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createConfiguredAgent } from "../../../../automation/engine/renderer/src/app/app-state";
import { AgentPage } from "../../../../automation/engine/renderer/src/pages/agent/AgentPage";
import { RuntimePage } from "../../../../automation/engine/renderer/src/pages/runtime/RuntimePage";
import { useRuntimeConfigManager } from "../../../../automation/engine/renderer/src/pages/runtime/hooks/useRuntimeConfigManager";
import type { ConfiguredAgent } from "../../../../automation/contracts";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";
import { AutomationPageState } from "./automation-page-state";
import { useAutomationDetails } from "./automation-provider";

const PROVIDER_KEYS_STORAGE_KEY = "agent-recall-automation-provider-keys";
type RuntimeUnsavedDecision = "save" | "discard" | "cancel";

function readProviderKeys(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROVIDER_KEYS_STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function reconcileEditableAgentsAfterChannelSave(
  editableAgents: ConfiguredAgent[],
  previousAgents: ConfiguredAgent[],
  savedAgents: ConfiguredAgent[],
): ConfiguredAgent[] {
  const previousIds = new Set(previousAgents.map((agent) => agent.id));
  const editableIds = new Set(editableAgents.map((agent) => agent.id));
  const generatedAgents = savedAgents.filter((agent) => agent.managed && !previousIds.has(agent.id) && !editableIds.has(agent.id));
  return generatedAgents.length > 0 ? [...editableAgents, ...generatedAgents] : editableAgents;
}

export function RuntimeFeaturePage({
  language,
  initialChannelId,
  onInitialChannelConsumed,
  onNavigationGuardChange,
}: {
  language: LanguageMode;
  initialChannelId?: string;
  onInitialChannelConsumed?: () => void;
  onNavigationGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
}): ReactElement {
  const { api, snapshot, setSnapshot, detailsLoaded, loading, error, refresh } = useAutomationDetails();
  const [view, setView] = useState<"channels" | "agents">("channels");
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>(readProviderKeys);
  const [editableAgents, setEditableAgents] = useState<ConfiguredAgent[]>(snapshot.configuredAgents);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentDirty, setAgentDirty] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  const [unsavedPrompt, setUnsavedPrompt] = useState("");
  const editableAgentsRef = useRef(editableAgents);
  const agentDirtyRef = useRef(agentDirty);
  const unsavedDecisionRef = useRef<((decision: RuntimeUnsavedDecision) => void) | null>(null);
  const onChannelsSaved = useCallback((previous: typeof snapshot, next: typeof snapshot): void => {
    if (!agentDirtyRef.current) {
      editableAgentsRef.current = next.configuredAgents;
      setEditableAgents(next.configuredAgents);
      return;
    }
    const reconciled = reconcileEditableAgentsAfterChannelSave(editableAgentsRef.current, previous.configuredAgents, next.configuredAgents);
    editableAgentsRef.current = reconciled;
    setEditableAgents(reconciled);
  }, []);
  const manager = useRuntimeConfigManager({ chatApi: api, snapshot, setSnapshot, runtimeViewActive: true, onChannelsSaved });

  useEffect(() => {
    if (!initialChannelId || !detailsLoaded) return;
    if (manager.configChannels.some((channel) => channel.id === initialChannelId)) {
      setView("channels");
      manager.selectConfigChannel(initialChannelId);
    }
    onInitialChannelConsumed?.();
  }, [detailsLoaded, initialChannelId, manager.configChannels, manager.selectConfigChannel, onInitialChannelConsumed]);

  const requestUnsavedDecision = useCallback((message: string): Promise<RuntimeUnsavedDecision> => (
    new Promise((resolve) => {
      unsavedDecisionRef.current?.("cancel");
      unsavedDecisionRef.current = resolve;
      setUnsavedPrompt(message);
    })
  ), []);

  const resolveUnsavedDecision = useCallback((decision: RuntimeUnsavedDecision): void => {
    const resolve = unsavedDecisionRef.current;
    unsavedDecisionRef.current = null;
    setUnsavedPrompt("");
    resolve?.(decision);
  }, []);

  useEffect(() => () => {
    unsavedDecisionRef.current?.("cancel");
    unsavedDecisionRef.current = null;
  }, []);

  const saveAgents = useCallback(async (): Promise<void> => {
    setAgentStatus("");
    try {
      const next = await api.saveConfiguredAgents(editableAgentsRef.current);
      setSnapshot(next);
      editableAgentsRef.current = next.configuredAgents;
      setEditableAgents(next.configuredAgents);
      agentDirtyRef.current = false;
      setAgentDirty(false);
      setAgentStatus(localize(language, "Saved", "已保存"));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setAgentStatus(message);
      throw cause;
    }
  }, [api, language, setSnapshot]);

  useEffect(() => {
    if (!agentDirty) {
      editableAgentsRef.current = snapshot.configuredAgents;
      setEditableAgents(snapshot.configuredAgents);
    }
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
      if (manager.configDirty && !(await manager.confirmSaveBeforeSwitch(() => requestUnsavedDecision(localize(
        language,
        "Runtime configuration has unsaved changes.",
        "Runtime 配置有尚未保存的修改。",
      ))))) return false;
      if (agentDirty) await saveAgents();
      return true;
    });
    return () => onNavigationGuardChange(null);
  }, [agentDirty, language, manager.configDirty, manager.confirmSaveBeforeSwitch, onNavigationGuardChange, requestUnsavedDecision, saveAgents]);

  const switchView = async (next: "channels" | "agents"): Promise<void> => {
    if (view === next) return;
    if (view === "channels" && manager.configDirty && !(await manager.confirmSaveBeforeSwitch(() => requestUnsavedDecision(localize(
      language,
      "Runtime configuration has unsaved changes.",
      "Runtime 配置有尚未保存的修改。",
    ))))) return;
    if (view === "agents" && agentDirty) await saveAgents();
    setView(next);
  };

  const addAgent = (): void => {
    const agent = createConfiguredAgent(snapshot.channels, editableAgentsRef.current.map((item) => item.id));
    const next = [...editableAgentsRef.current, agent];
    editableAgentsRef.current = next;
    setEditableAgents(next);
    setSelectedAgentId(agent.id);
    agentDirtyRef.current = true;
    setAgentDirty(true);
    setAgentStatus("");
  };

  const updateAgent = (agentId: string, updater: (agent: ConfiguredAgent) => ConfiguredAgent): void => {
    const next = editableAgentsRef.current.map((agent) => {
      if (agent.id !== agentId) return agent;
      const { managed: _managed, ...editable } = updater(agent);
      return { ...editable, updatedAt: Date.now() };
    });
    editableAgentsRef.current = next;
    setEditableAgents(next);
    agentDirtyRef.current = true;
    setAgentDirty(true);
    setAgentStatus("");
  };

  const deleteAgent = async (agentId: string): Promise<void> => {
    const remaining = editableAgentsRef.current.filter((agent) => agent.id !== agentId);
    setAgentStatus("");
    if (!snapshot.configuredAgents.some((agent) => agent.id === agentId)) {
      editableAgentsRef.current = remaining;
      setEditableAgents(remaining);
      if (selectedAgentId === agentId) setSelectedAgentId(remaining[0]?.id ?? "");
      agentDirtyRef.current = true;
      setAgentDirty(true);
      return;
    }

    const hadUnsavedChanges = agentDirtyRef.current;
    try {
      const next = await api.deleteConfiguredAgent(agentId);
      setSnapshot(next);
      const nextEditableAgents = hadUnsavedChanges ? remaining : next.configuredAgents;
      editableAgentsRef.current = nextEditableAgents;
      setEditableAgents(nextEditableAgents);
      if (selectedAgentId === agentId) setSelectedAgentId(nextEditableAgents[0]?.id ?? "");
      agentDirtyRef.current = hadUnsavedChanges;
      setAgentDirty(hadUnsavedChanges);
      setAgentStatus(localize(language, "Deleted", "已删除"));
    } catch (cause) {
      setAgentStatus(cause instanceof Error ? cause.message : String(cause));
    }
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
              onDeleteConfiguredAgent={deleteAgent}
            />
          )}
        </div>
      </AutomationPageState>
      {unsavedPrompt ? (
        <div className="runtime-unsaved-backdrop" role="presentation">
          <section className="runtime-unsaved-dialog" role="dialog" aria-modal="true" aria-labelledby="runtime-unsaved-title">
            <header>
              <strong id="runtime-unsaved-title">{localize(language, "Unsaved Runtime configuration", "Runtime 配置尚未保存")}</strong>
              <span>{unsavedPrompt}</span>
            </header>
            <footer>
              <button type="button" onClick={() => resolveUnsavedDecision("cancel")}>{localize(language, "Cancel", "取消")}</button>
              <button type="button" onClick={() => resolveUnsavedDecision("discard")}>{localize(language, "Don't save", "不保存")}</button>
              <button type="button" className="automation-control-button is-primary" onClick={() => resolveUnsavedDecision("save")}>
                <Save size={13} />{localize(language, "Save", "保存")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
