import type {
  AgentRecallMcpContext,
  AgentChannel,
  ConfiguredAgent,
  RuntimeConversation,
  RuntimeInvocationRequest,
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
    input: {
      configuredAgentId: string;
      prompt: string;
      workDir?: string;
      developerInstructions?: string;
      workflowExecution?: {
        workflowId: string;
        runId: string;
        nodeId: string;
        executionId: string;
      };
      invocation: RuntimeInvocationRequest;
    },
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<{
    output: string;
    durationMs: number;
    executionReference?: WorkflowAgentResponse["executionReference"];
  }> {
    const result = await this.executeConfiguredAgent(input, false, onEvent, signal);
    return {
      output: result.output,
      durationMs: result.durationMs,
      // The reference is what links a one-shot run to the session it created.
      // Dropping it here left evaluation runs with no way back to their session.
      ...(result.executionReference ? { executionReference: result.executionReference } : {}),
    };
  }

  async runConversation(
    input: {
      configuredAgentId: string;
      prompt: string;
      workDir?: string;
      runtimeConversation?: RuntimeConversation;
      developerInstructions?: string;
      agentRecallMcp?: AgentRecallMcpContext;
      invocation: RuntimeInvocationRequest;
    },
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<{
    output: string;
    durationMs: number;
    runtimeConversation?: RuntimeConversation;
    executionReference?: WorkflowAgentResponse["executionReference"];
  }> {
    return this.executeConfiguredAgent(input, true, onEvent, signal);
  }

  private async executeConfiguredAgent(
    input: {
      configuredAgentId: string;
      prompt: string;
      workDir?: string;
      runtimeConversation?: RuntimeConversation;
      developerInstructions?: string;
      agentRecallMcp?: AgentRecallMcpContext;
      invocation: RuntimeInvocationRequest;
      workflowExecution?: {
        workflowId: string;
        runId: string;
        nodeId: string;
        executionId: string;
      };
    },
    allowContinuation: boolean,
    onEvent?: (event: WorkflowAgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<{
    output: string;
    durationMs: number;
    runtimeConversation?: RuntimeConversation;
    executionReference?: WorkflowAgentResponse["executionReference"];
  }> {
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
      ...(input.developerInstructions?.trim()
        ? { developerInstructions: input.developerInstructions.trim() }
        : {}),
      ...(input.agentRecallMcp ? { agentRecallMcp: { ...input.agentRecallMcp } } : {}),
      invocation: structuredClone(input.invocation),
      ...(input.workflowExecution ? {
        planningWorkflowId: input.workflowExecution.workflowId,
        workflowRunId: input.workflowExecution.runId,
        workflowNodeId: input.workflowExecution.nodeId,
        workflowNodeExecutionId: input.workflowExecution.executionId,
      } : {}),
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
      ...(response.executionReference
        ? { executionReference: { ...response.executionReference } }
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
