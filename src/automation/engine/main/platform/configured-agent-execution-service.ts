import type {
  AgentChannel,
  ConfiguredAgent,
  RuntimeConversation,
  WorkflowAgentEvent,
  WorkflowAgentRequest,
  WorkflowAgentResponse,
} from "../../shared/types";
import { defaultModelForAgent, isModelForChannel } from "../../shared/models";

const CONTINUABLE_WORKFLOW_RUNTIMES = new Set<WorkflowAgentRequest["runtimeId"]>(["codex", "claude"]);

export function supportsConfiguredAgentConversation(runtimeId: WorkflowAgentRequest["runtimeId"]): boolean {
  return CONTINUABLE_WORKFLOW_RUNTIMES.has(runtimeId);
}

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
    const result = await this.executeConfiguredAgent(input, false, onEvent, signal);
    return { output: result.output, durationMs: result.durationMs };
  }

  async runConversation(
    input: {
      configuredAgentId: string;
      prompt: string;
      workDir?: string;
      runtimeConversation?: RuntimeConversation;
    },
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ output: string; durationMs: number; runtimeConversation?: RuntimeConversation }> {
    return this.executeConfiguredAgent(input, true, onEvent, signal);
  }

  private async executeConfiguredAgent(
    input: {
      configuredAgentId: string;
      prompt: string;
      workDir?: string;
      runtimeConversation?: RuntimeConversation;
    },
    allowContinuation: boolean,
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ output: string; durationMs: number; runtimeConversation?: RuntimeConversation }> {
    const target = this.resolve(input.configuredAgentId);
    if (!target) throw new Error(`Configured agent not found: ${input.configuredAgentId}`);
    const startedAt = Date.now();
    const runtimeConversation =
      allowContinuation &&
      input.runtimeConversation?.runtimeId === target.runtimeId &&
      supportsConfiguredAgentConversation(target.runtimeId)
        ? structuredClone(input.runtimeConversation)
        : undefined;
    const request: WorkflowAgentRequest = {
      configuredAgentId: input.configuredAgentId,
      prompt: input.prompt,
      runtimeId: target.runtimeId,
      runtimeConfig: { model: target.modelId, ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}) },
      executionMode: "oneshot",
      continuationPolicy: runtimeConversation ? "resume-preferred" : "fresh",
      ...(runtimeConversation ? { runtimeConversation } : {}),
      workDir: input.workDir ?? this.dependencies.defaultWorkDir(),
    };
    const response = onEvent || signal
      ? await this.dependencies.execute(request, onEvent, signal)
      : await this.dependencies.execute(request);
    return {
      output: response.content,
      durationMs: Date.now() - startedAt,
      ...(allowContinuation && response.runtimeConversation
        ? { runtimeConversation: structuredClone(response.runtimeConversation) }
        : {}),
    };
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
