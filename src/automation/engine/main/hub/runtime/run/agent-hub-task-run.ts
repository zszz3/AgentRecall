import type { ChatMessage } from "../../../../shared/types";
import type { TaskState } from "../../state/agent-hub-state";

export interface TaskRunResolvedAgent {
  agent: { id: string; name: string };
  runtimeAgentId: string;
  runtime: { available: boolean } | undefined;
}

export function failTaskRunStart(input: {
  task: TaskState;
  lastError: string;
  message: string;
  createErrorMessage: (content: string) => ChatMessage;
  now?: number;
}): void {
  input.task.status = "failed";
  input.task.running = false;
  input.task.lastError = input.lastError;
  input.task.messages.push(input.createErrorMessage(input.message));
  input.task.updatedAt = input.now ?? Date.now();
}

export function beginTaskRun(input: {
  task: TaskState;
  now?: number;
}): void {
  input.task.status = "running";
  input.task.progress = "in_progress";
  input.task.running = true;
  input.task.lastError = undefined;
  input.task.pendingAssistantMessageId = undefined;
  input.task.updatedAt = input.now ?? Date.now();
}

export function prepareTaskRunExecution<TResolved extends TaskRunResolvedAgent>(input: {
  task: TaskState;
  resolved: TResolved | undefined;
  createErrorMessage: (content: string) => ChatMessage;
  onUnavailable?: (error: string) => void;
  now?: number;
}): TResolved | undefined {
  if (!input.resolved?.runtime?.available) {
    const error = input.resolved
      ? `${input.resolved.agent.name || input.resolved.agent.id} is not available on this machine.`
      : "No configured agent is selected.";
    failTaskRunStart({
      task: input.task,
      lastError: input.resolved ? `${input.resolved.runtimeAgentId} unavailable` : "No configured agent selected",
      message: error,
      createErrorMessage: input.createErrorMessage,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    input.onUnavailable?.(error);
    return undefined;
  }
  beginTaskRun({ task: input.task, ...(input.now !== undefined ? { now: input.now } : {}) });
  return input.resolved;
}

export function prepareTaskPromptExecution<TResolved extends TaskRunResolvedAgent>(input: {
  task: TaskState;
  resolved: TResolved | undefined;
  createUserMessage: (content: string) => ChatMessage;
  createErrorMessage: (content: string) => ChatMessage;
  onUnavailable?: (error: string) => void;
  now?: number;
}): TResolved | undefined {
  input.task.messages.push(input.createUserMessage(input.task.prompt));
  return prepareTaskRunExecution({
    task: input.task,
    resolved: input.resolved,
    createErrorMessage: input.createErrorMessage,
    ...(input.onUnavailable ? { onUnavailable: input.onUnavailable } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

export function resolveTaskPromptExecution<TResolved extends TaskRunResolvedAgent>(input: {
  task: TaskState;
  resolveConfiguredAgent: (configuredAgentId: string, modelId: string) => TResolved | undefined;
  createUserMessage: (content: string) => ChatMessage;
  createErrorMessage: (content: string) => ChatMessage;
  onUnavailable?: (error: string) => void;
  now?: number;
}): TResolved | undefined {
  return prepareTaskPromptExecution({
    task: input.task,
    resolved: input.resolveConfiguredAgent(input.task.configuredAgentId, input.task.modelId),
    createUserMessage: input.createUserMessage,
    createErrorMessage: input.createErrorMessage,
    ...(input.onUnavailable ? { onUnavailable: input.onUnavailable } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

export function dispatchTaskPromptExecution<TResolved extends TaskRunResolvedAgent>(input: {
  task: TaskState;
  registerTask: (task: TaskState) => void;
  resolveConfiguredAgent: (configuredAgentId: string, modelId: string) => TResolved | undefined;
  createUserMessage: (content: string) => ChatMessage;
  createErrorMessage: (content: string) => ChatMessage;
  onUnavailable?: (error: string) => void;
  emit: () => void;
  run: (task: TaskState, resolved: TResolved) => void;
  now?: number;
}): boolean {
  input.registerTask(input.task);
  const preparedResolved = resolveTaskPromptExecution({
    task: input.task,
    resolveConfiguredAgent: input.resolveConfiguredAgent,
    createUserMessage: input.createUserMessage,
    createErrorMessage: input.createErrorMessage,
    ...(input.onUnavailable ? { onUnavailable: input.onUnavailable } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (!preparedResolved) {
    input.emit();
    return false;
  }
  input.emit();
  input.run(input.task, preparedResolved);
  return true;
}
