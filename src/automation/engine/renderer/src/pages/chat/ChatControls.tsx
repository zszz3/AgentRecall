import { FolderOpen } from "lucide-react";
import {
  agentAccent,
  configuredAgentById,
  configuredAgentModel,
  configuredAgentRuntimeId,
  fallbackRuntime,
  resolveConfiguredAgentChannel,
  runtimeStatus,
} from "../../app/agents";
import { DEFAULT_MODEL_ID } from "../../../../shared/models";
import type { AgentChannel, AgentRuntime, ConfiguredAgent } from "../../../../shared/types";

type MaybePromise = void | Promise<void>;

interface ChatControlsProps {
  configuredAgentId: string;
  modelId?: string;
  configuredAgents?: ConfiguredAgent[];
  channels: AgentChannel[];
  locked: boolean;
  running: boolean;
  workDir: string;
  runtimes: AgentRuntime[];
  onSelectConfiguredAgent: (configuredAgentId: string) => MaybePromise;
  onSelectModel?: (modelId: string) => MaybePromise;
  onChooseWorkDir: () => MaybePromise;
}

export function ChatControls({
  configuredAgentId,
  modelId,
  configuredAgents = [],
  channels,
  locked,
  running,
  workDir,
  runtimes,
  onSelectConfiguredAgent,
  onSelectModel = () => undefined,
  onChooseWorkDir,
}: ChatControlsProps) {
  const runtimeMap = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const selectedAgent = configuredAgentById(configuredAgentId, configuredAgents);
  const selectedChannel = resolveConfiguredAgentChannel(selectedAgent, channels);
  const runtimeId = configuredAgentRuntimeId(selectedAgent, selectedChannel);
  const runtime = runtimeMap.get(runtimeId) ?? fallbackRuntime(runtimeId);
  const selectedModel = configuredAgentModel(selectedAgent, selectedChannel, modelId);
  const modelOptions = selectedChannel?.models.length ? selectedChannel.models : [{ id: DEFAULT_MODEL_ID, label: "Default" }];
  const selectedModelId = selectedModel?.id ?? DEFAULT_MODEL_ID;
  const selectsDisabled = locked || running;
  const configTitle = [
    selectedAgent?.name,
    selectedChannel?.label ?? "No config",
    selectedModel?.label ?? selectedAgent?.modelId ?? DEFAULT_MODEL_ID,
    runtimeStatus(runtime),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="composer-controls">
      <label className="composer-select-wrap" title={configTitle}>
        <span className={`runtime-dot ${agentAccent(runtimeId)}`} />
        <select
          className="composer-select"
          aria-label="Configured agent"
          value={selectedAgent?.id ?? ""}
          disabled={selectsDisabled || configuredAgents.length === 0}
          onChange={(event) => void onSelectConfiguredAgent(event.currentTarget.value)}
        >
          {configuredAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name || agent.id}
            </option>
          ))}
        </select>
      </label>
      <label className="composer-select-wrap" title={configTitle}>
        <select
          className="composer-select"
          aria-label="Agent model"
          value={selectedModelId}
          disabled={selectsDisabled || !selectedChannel}
          onChange={(event) => void onSelectModel(event.currentTarget.value)}
        >
          {modelOptions.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label || model.id}
            </option>
          ))}
        </select>
      </label>
      <button
        className="workdir-picker composer-workdir-picker"
        onClick={() => void onChooseWorkDir()}
        title={workDir || "Choose workdir"}
        aria-label="Choose work directory"
        disabled={selectsDisabled}
      >
        <FolderOpen size={14} />
        <span>{workDir || "Choose workdir"}</span>
      </button>
    </div>
  );
}
