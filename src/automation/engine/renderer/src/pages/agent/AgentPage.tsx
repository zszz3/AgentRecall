import { Plus, Save } from "lucide-react";
import { agentAccent, agentLabel, resolveConfiguredAgentChannel } from "../../app/agents";
import type { Language } from "../../app/language";
import { DEFAULT_MODEL_ID } from "../../../../shared/models";
import type { AgentChannel, ConfiguredAgent } from "../../../../shared/types";

type MaybePromise = void | Promise<void>;

interface AgentPageProps {
  language?: Language;
  channels: AgentChannel[];
  configuredAgents: ConfiguredAgent[];
  selectedConfiguredAgentId: string;
  status: string;
  onSave: () => Promise<void>;
  onAddConfiguredAgent: () => MaybePromise;
  onSelectConfiguredAgent: (agentId: string) => void;
  onUpdateConfiguredAgent: (agentId: string, updater: (agent: ConfiguredAgent) => ConfiguredAgent) => void;
}

function configTextFor(language: Language) {
  return language === "zh"
    ? {
        title: "Agent 组装",
        description: "组装 Agent 的名称、描述、执行配置和标签。",
        save: "保存",
        name: "名称",
        config: "配置",
        runtime: "Runtime",
        model: "模型",
        reasoning: "推理强度",
        tags: "标签",
        descriptionField: "描述",
        emptyAgent: "新建 Agent 后可编辑名称、描述、执行配置和标签。",
        newAgent: "新建 Agent",
      }
    : {
        title: "Agent Assembly",
        description: "Assemble agent profiles, execution config, and tags.",
        save: "Save",
        name: "Name",
        config: "Config",
        runtime: "Runtime",
        model: "Model",
        reasoning: "Reasoning",
        tags: "Tags",
        descriptionField: "Description",
        emptyAgent: "Create an agent to edit its profile, execution config, and tags.",
        newAgent: "New agent",
      };
}

function withReasoningEffort(agent: ConfiguredAgent, reasoningEffort: string | undefined): ConfiguredAgent {
  const next = { ...agent };
  if (reasoningEffort) next.reasoningEffort = reasoningEffort;
  else delete next.reasoningEffort;
  return next;
}

export function AgentPage({
  language = "en",
  channels,
  configuredAgents,
  selectedConfiguredAgentId,
  status,
  onSave,
  onAddConfiguredAgent,
  onSelectConfiguredAgent,
  onUpdateConfiguredAgent,
}: AgentPageProps) {
  const configText = configTextFor(language);
  const selectedConfiguredAgent =
    configuredAgents.find((agent) => agent.id === selectedConfiguredAgentId) ?? configuredAgents[0];
  const selectedAgentChannel = selectedConfiguredAgent ? resolveConfiguredAgentChannel(selectedConfiguredAgent, channels) : undefined;
  const selectedAgentModels =
    selectedAgentChannel && selectedAgentChannel.models.length > 0 ? selectedAgentChannel.models : [{ id: DEFAULT_MODEL_ID, label: "Default" }];
  const selectedAgentModelId = selectedConfiguredAgent && selectedAgentModels.some((model) => model.id === selectedConfiguredAgent.modelId)
    ? selectedConfiguredAgent.modelId
    : DEFAULT_MODEL_ID;
  const selectedAgentModel = selectedAgentModels.find((model) => model.id === selectedAgentModelId);
  const reasoningEfforts = selectedAgentModel?.reasoningEfforts ?? [];
  const runtimes = [...new Set(channels.map((channel) => channel.agentId))];
  const runtimeChannels = selectedConfiguredAgent
    ? channels.filter((channel) => channel.agentId === selectedConfiguredAgent.runtimeAgentId)
    : [];

  return (
    <section className="agent-page">
      <header className="config-header">
        <div>
          <h2>{configText.title}</h2>
          <p>{configText.description}</p>
        </div>
      </header>

      <div className="config-grid">
        <section className="config-form">
          <section className="configured-agent-panel">
            <section className="configured-agent-browser">
              <div className="configured-agent-toolbar">
                <div>
                  <h3>Agents</h3>
                </div>
                <button className="icon-btn" type="button" onClick={() => void onAddConfiguredAgent()} aria-label={configText.newAgent}>
                  <Plus size={14} />
                </button>
              </div>
              <div className="configured-agent-list">
                {configuredAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className={`configured-agent-pick ${agent.id === selectedConfiguredAgent?.id ? "is-active" : ""}`}
                    onClick={() => onSelectConfiguredAgent(agent.id)}
                  >
                    <span className={`agent-badge mini ${agentAccent(agent.runtimeAgentId)}`}>{agentLabel(agent.runtimeAgentId)}</span>
                    <strong>{agent.name || agent.id}</strong>
                    <span>{channels.find((channel) => channel.id === agent.channelId)?.label ?? agent.channelId}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="configured-agent-editor">
              {selectedConfiguredAgent ? (
                <>
                  <div className="configured-agent-editor-head">
                    <div>
                      <h3>{selectedConfiguredAgent.name || "Untitled Agent"}</h3>
                      <span>{selectedConfiguredAgent.id}</span>
                    </div>
                    <div className="configured-agent-editor-actions">
                      <button className="control-btn compact" onClick={() => void onSave()}>
                        <Save size={13} />
                        <span>{configText.save}</span>
                      </button>
                    </div>
                  </div>
                  {status ? <div className="config-status">{status}</div> : null}

                  <div className="config-field-grid">
                    <label className="config-field">
                      <span>{configText.name}</span>
                      <input
                        aria-label="Agent name"
                        value={selectedConfiguredAgent.name}
                        onChange={(event) => {
                          const nextName = event.currentTarget.value;
                          onUpdateConfiguredAgent(selectedConfiguredAgent.id, (item) => ({ ...item, name: nextName }));
                        }}
                      />
                    </label>
                    <label className="config-field">
                      <span>ID</span>
                      <div className="configured-agent-runtime-readonly"><strong>{selectedConfiguredAgent.id}</strong></div>
                    </label>
                    <label className="config-field">
                      <span>{configText.runtime}</span>
                      <select
                        aria-label="Agent runtime"
                        value={selectedConfiguredAgent.runtimeAgentId}
                        onChange={(event) => {
                          const runtimeAgentId = event.currentTarget.value as AgentChannel["agentId"];
                          const channel = channels.find((item) => item.agentId === runtimeAgentId);
                          if (!channel) return;
                          onUpdateConfiguredAgent(selectedConfiguredAgent.id, (item) => withReasoningEffort({
                            ...item,
                            runtimeAgentId,
                            channelId: channel.id,
                            modelId: DEFAULT_MODEL_ID,
                          }, undefined));
                        }}
                      >
                        {runtimes.map((runtime) => (
                          <option key={runtime} value={runtime}>{agentLabel(runtime)}</option>
                        ))}
                      </select>
                    </label>
                    <label className="config-field">
                      <span>{configText.config}</span>
                      <select
                        aria-label="Agent execution config"
                        value={selectedAgentChannel?.id ?? ""}
                        onChange={(event) => {
                          const channel = channels.find((item) => item.id === event.currentTarget.value);
                          if (!channel) return;
                          onUpdateConfiguredAgent(selectedConfiguredAgent.id, (item) => withReasoningEffort({
                            ...item,
                            runtimeAgentId: channel.agentId,
                            channelId: channel.id,
                            modelId: DEFAULT_MODEL_ID,
                          }, undefined));
                        }}
                      >
                        {runtimeChannels.map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            {`${channel.label || channel.id} · ${agentLabel(channel.agentId)}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="config-field">
                      <span>{configText.model}</span>
                      <select
                        aria-label="Agent model"
                        value={selectedAgentModelId}
                        disabled={!selectedConfiguredAgent || !selectedAgentChannel}
                        onChange={(event) => {
                          const modelId = event.currentTarget.value;
                          const model = selectedAgentModels.find((candidate) => candidate.id === modelId);
                          onUpdateConfiguredAgent(selectedConfiguredAgent.id, (item) => withReasoningEffort({
                            ...item,
                            modelId,
                          }, model?.reasoningEfforts?.includes(item.reasoningEffort ?? "") ? item.reasoningEffort : undefined));
                        }}
                      >
                        {selectedAgentModels.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label || model.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedConfiguredAgent.runtimeAgentId === "codex" && reasoningEfforts.length > 0 ? (
                      <label className="config-field">
                        <span>{configText.reasoning}</span>
                        <select
                          aria-label="Agent reasoning effort"
                          value={selectedConfiguredAgent.reasoningEffort ?? ""}
                          onChange={(event) => {
                            const reasoningEffort = event.currentTarget.value || undefined;
                            onUpdateConfiguredAgent(selectedConfiguredAgent.id, (item) => withReasoningEffort(item, reasoningEffort));
                          }}
                        >
                          <option value="">{`Default${selectedAgentModel?.defaultReasoningEffort ? ` (${selectedAgentModel.defaultReasoningEffort})` : ""}`}</option>
                          {reasoningEfforts.map((effort) => (
                            <option key={effort} value={effort}>{effort === "xhigh" ? "XHigh" : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label className="config-field">
                      <span>{configText.tags}</span>
                      <input
                        aria-label="Agent tags"
                        value={selectedConfiguredAgent.tags.join(", ")}
                        onChange={(event) =>
                          onUpdateConfiguredAgent(selectedConfiguredAgent.id, (item) => ({
                            ...item,
                            tags: event.currentTarget.value
                              .split(",")
                              .map((tag) => tag.trim())
                              .filter(Boolean),
                          }))
                        }
                      />
                    </label>
                    <label className="config-field config-field-wide">
                      <span>{configText.descriptionField}</span>
                      <input
                        aria-label="Agent description"
                        value={selectedConfiguredAgent.description}
                        onChange={(event) =>
                          onUpdateConfiguredAgent(selectedConfiguredAgent.id, (item) => ({ ...item, description: event.currentTarget.value }))
                        }
                      />
                    </label>
                  </div>
                </>
              ) : (
                <div className="empty-state config-empty configured-agent-empty">
                  <span>{configText.emptyAgent}</span>
                  <button className="control-btn compact" onClick={() => void onAddConfiguredAgent()}>
                    <Plus size={13} />
                    <span>{configText.newAgent}</span>
                  </button>
                </div>
              )}
            </section>
          </section>
        </section>
      </div>
    </section>
  );
}
