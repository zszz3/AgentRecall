import type {
  AgentChannel,
  ConfiguredAgent,
  WorkflowAgentEvent,
  WorkflowAgentRequest,
  WorkflowAgentResponse,
} from "../../shared/types";
import { defaultModelForAgent, isModelForChannel } from "../../shared/models";

export interface ConfiguredAgentExecutionTarget {
  runtimeId: WorkflowAgentRequest["runtimeId"];
  modelId: string;
  reasoningEffort?: string;
}

export class ConfiguredAgentExecutionService {
  constructor(private readonly dependencies: {
    agents: () => ConfiguredAgent[];
    channels: () => AgentChannel[];
    execute: (
      request: WorkflowAgentRequest,
      onEvent?: (event: WorkflowAgentEvent) => void,
      signal?: AbortSignal,
    ) => Promise<WorkflowAgentResponse>;
    defaultWorkDir: () => string;
  }) {}

  async runOneShot(
    input: { configuredAgentId: string; prompt: string; workDir?: string },
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ output: string; durationMs: number }> {
    const target = this.resolve(input.configuredAgentId);
    if (!target) throw new Error(`Configured agent not found: ${input.configuredAgentId}`);
    const startedAt = Date.now();
    const request: WorkflowAgentRequest = {
      configuredAgentId: input.configuredAgentId,
      prompt: input.prompt,
      runtimeId: target.runtimeId,
      runtimeConfig: { model: target.modelId, ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}) },
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      workDir: input.workDir ?? this.dependencies.defaultWorkDir(),
    };
    const response = onEvent || signal
      ? await this.dependencies.execute(request, onEvent, signal)
      : await this.dependencies.execute(request);
    return { output: response.content, durationMs: Date.now() - startedAt };
  }

  private resolve(configuredAgentId: string): ConfiguredAgentExecutionTarget | undefined {
    const agent = this.dependencies.agents().find((item) => item.id === configuredAgentId);
    if (!agent) return undefined;
    const channels = this.dependencies.channels();
    const channel = channels.find((item) => item.id === agent.channelId && item.agentId === agent.runtimeAgentId) ?? channels.find((item) => item.agentId === agent.runtimeAgentId);
    if (!channel) return undefined;
    const modelId = isModelForChannel(channel.agentId, channel.id, agent.modelId, channels) ? agent.modelId : defaultModelForAgent(channel.agentId);
    return { runtimeId: channel.agentId, modelId, ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}) };
  }
}
