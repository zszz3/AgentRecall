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
  showAgentControls?: boolean;
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
  showAgentControls = true,
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
  const modelOptions = selectedChannel?.models.length ? selectedChannel.models : [{ id: "", label: "Select Agent first" }];
  const selectedModelId = selectedModel?.id ?? "";
  const selectsDisabled = locked || running;
  const configTitle = [
    selectedAgent?.name,
    selectedChannel?.label ?? "No Agent selected",
    selectedModel?.label ?? selectedAgent?.modelId,
    runtimeStatus(runtime),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="composer-controls">
      {showAgentControls ? <><label className="composer-select-wrap" title={configTitle}>
        {selectedAgent ? <span className={`runtime-dot ${agentAccent(runtimeId)}`} /> : null}
        <select
          className="composer-select"
          aria-label="Configured agent"
          value={selectedAgent?.id ?? ""}
          disabled={selectsDisabled || configuredAgents.length === 0}
          onChange={(event) => void onSelectConfiguredAgent(event.currentTarget.value)}
        >
          <option value="" disabled>Select Agent</option>
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
      </label></> : null}
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
