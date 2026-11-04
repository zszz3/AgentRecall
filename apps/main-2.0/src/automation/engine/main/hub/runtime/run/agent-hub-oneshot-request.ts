import type { AgentId, AgentOneShotRequest, RuntimeConversation } from "../../../../shared/types";

/** Resolves a one-shot request against its explicitly selected configured Agent. */
export function buildOneShotAgentExecution<TResolved extends {
  agent: { id: string; name: string; instructions?: string };
  runtimeAgentId: AgentId;
  runtime: { available: boolean } | undefined;
  channel: { id: string };
}>(input: {
  request: AgentOneShotRequest;
  resolveConfiguredAgent: (configuredAgentId: string, modelId?: string, channelId?: string) => TResolved | undefined;
  cloneConversationForPolicy: (
    continuationPolicy: AgentOneShotRequest["continuationPolicy"],
    runtimeConversation: RuntimeConversation | undefined,
  ) => RuntimeConversation | undefined;
  defaultWorkDir: string;
  createRequestId: () => string;
}): {
  requestId: string;
  configuredAgentId: string;
  developerInstructions: string;
  runtimeId: AgentId;
  executionMode: AgentOneShotRequest["executionMode"];
  continuationPolicy: AgentOneShotRequest["continuationPolicy"];
  runtimeConfig: AgentOneShotRequest["runtimeConfig"];
  runtimeConversation?: RuntimeConversation;
  invocationId?: string;
  environmentId?: string;
  invocation: AgentOneShotRequest["invocation"];
  prompt: string;
  runtime: NonNullable<TResolved["runtime"]>;
  channelId: string;
  workDir: string;
} {
  const prompt = input.request.prompt.trim();
  if (!prompt) throw new Error("Agent prompt is required");

  const resolved = input.resolveConfiguredAgent(input.request.configuredAgentId, input.request.runtimeConfig.model);
  if (!resolved) throw new Error("No configured agent is selected.");
  if (resolved.runtimeAgentId !== input.request.runtimeId) {
    throw new Error(`Configured agent ${resolved.agent.id} does not match runtime ${input.request.runtimeId}.`);
  }
  if (!resolved.runtime?.available) {
    throw new Error(`${resolved.agent.name || resolved.agent.id} is not available on this machine.`);
  }

  const runtimeConversation = input.cloneConversationForPolicy(
    input.request.continuationPolicy,
    input.request.runtimeConversation,
  );

  return {
    requestId: input.request.requestId ?? input.createRequestId(),
    configuredAgentId: resolved.agent.id,
    developerInstructions: [
      resolved.agent.instructions?.trim(),
      input.request.developerInstructions?.trim(),
    ].filter(Boolean).join("\n\n"),
    runtimeId: input.request.runtimeId,
    executionMode: input.request.executionMode,
    continuationPolicy: input.request.continuationPolicy,
    runtimeConfig: input.request.runtimeConfig,
    ...(runtimeConversation ? { runtimeConversation } : {}),
    ...(input.request.invocationId ? { invocationId: input.request.invocationId } : {}),
    ...(input.request.environmentId ? { environmentId: input.request.environmentId } : {}),
    invocation: structuredClone(input.request.invocation),
    prompt,
    runtime: resolved.runtime,
    channelId: resolved.channel.id,
    workDir: input.request.workDir?.trim() || input.defaultWorkDir,
  };
}
