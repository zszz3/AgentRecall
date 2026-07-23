import type {
  AgentEvent,
  AgentId,
  AgentRuntime,
  ConfiguredAgent,
  RuntimeContinuationPolicy,
  RuntimeConversation,
  RuntimeExecutionMode,
} from "../../../../shared/types";
import type { AgentExecutorFactory } from "../executor/agent-executor";
import type { ChatState, TaskState } from "../../state/agent-hub-state";

export type HubRunState = ChatState | TaskState;

export interface ResolvedHubRunAgent {
  agent: ConfiguredAgent;
  runtimeAgentId: AgentId;
  channel: { id: string };
  modelId: string;
  reasoningEffort?: string;
  runtime: AgentRuntime | undefined;
}

export async function runAgentExecution(input: {
  run: HubRunState;
  prompt: string;
  resolved: ResolvedHubRunAgent;
  workDir: string;
  chatDeveloperInstructions: string;
  taskDeveloperInstructions: string;
  executorFactory: AgentExecutorFactory;
  selectExecutionMode: (
    runtimeId: AgentId,
    surface: "chat" | "task",
    preferred: RuntimeExecutionMode,
  ) => RuntimeExecutionMode;
  defaultContinuationPolicy: (
    runtimeId: AgentId,
    surface: "chat" | "task",
    executionMode: RuntimeExecutionMode,
  ) => RuntimeContinuationPolicy;
  cloneConversationForPolicy: (
    continuationPolicy: RuntimeContinuationPolicy,
    runtimeConversation: RuntimeConversation | undefined,
  ) => RuntimeConversation | undefined;
  handleAgentEvent: (run: HubRunState, event: AgentEvent) => void;
  markRunExited: (run: HubRunState) => void;
  markRunFailed: (run: HubRunState, error: string) => void;
  registerStop: (runId: string, stop: () => Promise<void> | void) => void;
  clearStop: (runId: string) => void;
  emit: () => void;
}): Promise<void> {
  const runtime = input.resolved.runtime;
  if (!runtime?.available) {
    input.markRunFailed(input.run, `${input.resolved.agent.name || input.resolved.agent.id} is not available on this machine.`);
    return;
  }
  const developerInstructions = input.run.kind === "task"
    ? [
      input.taskDeveloperInstructions,
      input.resolved.agent.instructions,
      input.run.developerInstructions,
      input.run.contextDocument ? `# Runtime context\n${input.run.contextDocument}` : undefined,
    ].filter(Boolean).join("\n\n")
    : [input.chatDeveloperInstructions, input.resolved.agent.instructions]
      .filter(Boolean)
      .join("\n\n");
  const executionMode =
    input.run.kind === "chat"
      ? input.selectExecutionMode(input.resolved.runtimeAgentId, "chat", "oneshot")
      : "oneshot";
  const continuationPolicy =
    input.run.kind === "chat"
      ? input.defaultContinuationPolicy(input.resolved.runtimeAgentId, "chat", executionMode)
      : input.run.continuationPolicy;
  const runtimeConversation = input.cloneConversationForPolicy(continuationPolicy, input.run.runtimeConversation);
  const executor = input.executorFactory.create({
    runId: input.run.id,
    runKind: input.run.kind,
    configuredAgentId: input.resolved.agent.id,
    runtimeId: input.resolved.runtimeAgentId,
    executionMode,
    continuationPolicy,
    runtimeConfig: {
      model: input.resolved.modelId,
      ...(input.resolved.reasoningEffort ? { reasoningEffort: input.resolved.reasoningEffort } : {}),
    },
    ...(runtimeConversation ? { runtimeConversation } : {}),
    ...(input.run.kind === "task" && input.run.planningWorkflowId ? { planningWorkflowId: input.run.planningWorkflowId } : {}),
    ...(input.run.kind === "task" && input.run.workflowRunId ? { workflowRunId: input.run.workflowRunId } : {}),
    ...(input.run.kind === "task" && input.run.workflowNodeId ? { workflowNodeId: input.run.workflowNodeId } : {}),
    runtime,
    channelId: input.resolved.channel.id,
    prompt: input.prompt,
    workDir: input.workDir,
    developerInstructions,
    emit: (event) => input.handleAgentEvent(input.run, event),
    onExit: () => {
      input.markRunExited(input.run);
      input.run.updatedAt = Date.now();
      input.clearStop(input.run.id);
      input.emit();
    },
  });
  input.registerStop(input.run.id, () => executor.stop());

  try {
    await executor.start();
  } catch (error) {
    input.markRunFailed(input.run, error instanceof Error ? error.message : String(error));
  }
}
