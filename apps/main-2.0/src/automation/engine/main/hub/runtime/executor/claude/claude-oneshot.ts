import type { AgentOneShotResponse } from "../../../../../shared/types";
import { claudeCliModelForChannel } from "../../../../agents/claude/claude-env";
import type { ClaudeAgentSdkRunInput } from "../../../../agents/claude/claude-agent-sdk";
import type { RuntimeOneShotRequest } from "../../../../agents/runtime/runtime-driver";
import {
  claudeSessionIdFromConversation,
  cloneClaudeRuntimeConversation,
} from "../agent-executor-conversation";
import {
  emitOneShotAgentApprovalEvent,
  modelFromRuntimeConfig,
  type RuntimeOneShotExecutionOptions,
} from "../oneshot-shared";
import { claudeMcpServers } from "../runtime-mcp";
import { combineDeveloperInstructions } from "../runtime-instructions";

export async function runClaudeOneShot(
  input: RuntimeOneShotRequest,
  options: RuntimeOneShotExecutionOptions,
  runClaudeOneShot: (input: ClaudeAgentSdkRunInput) => Promise<void>,
): Promise<AgentOneShotResponse> {
  const channel = options.channelById(input.channelId);
  const sdkModel =
    claudeCliModelForChannel(channel, modelFromRuntimeConfig(input.runtimeConfig)) ?? modelFromRuntimeConfig(input.runtimeConfig);
  const resumeSessionId = claudeSessionIdFromConversation(input.runtimeConversation);
  let content = "";
  let completedContent: string | undefined;
  let runtimeConversation = input.runtimeConversation ? cloneClaudeRuntimeConversation(input.runtimeConversation) : undefined;
  let errorMessage: string | undefined;
  const mcpServers = claudeMcpServers(input.configuredAgentId ? options.mcpServersForAgent?.(input.configuredAgentId) ?? [] : []);
  const abortController = new AbortController();
  const abort = () => abortController.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });

  try {
    await runClaudeOneShot({
      prompt: input.prompt,
      cwd: input.workDir,
      ...(sdkModel ? { modelId: sdkModel } : {}),
      developerInstructions: combineDeveloperInstructions(input.developerInstructions),
      ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      abortController,
      approvalOwnerId: `oneshot:${input.requestId}`,
      ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      onEvent: (event) => {
        if (emitOneShotAgentApprovalEvent(input, event)) return;
        if (event.type === "delta") {
          content += event.content;
          input.onEvent?.({ requestId: input.requestId, type: "delta", content: event.content });
          return;
        }
        if (event.type === "completed" && event.content) {
          completedContent = event.content;
          if (!content) content = event.content;
          return;
        }
        if (event.type === "runtime_conversation") {
          runtimeConversation = cloneClaudeRuntimeConversation(event.runtimeConversation);
          const sessionId = claudeSessionIdFromConversation(runtimeConversation);
          if (sessionId) input.reportExecutionReference?.({ sessionId });
          return;
        }
        if (event.type === "tool_call" || event.type === "tool_result") {
          input.onEvent?.({
            requestId: input.requestId,
            type: event.type,
            content: event.content,
            ...(event.name ? { name: event.name } : {}),
            ...(event.metadata ? { metadata: event.metadata } : {}),
          });
          return;
        }
        if (event.type === "error") {
          errorMessage = event.error;
          input.onEvent?.({ requestId: input.requestId, type: "error", error: event.error });
        }
      },
    });
  } catch (error) {
    throw errorMessage
      ? new Error(errorMessage)
      : error instanceof Error
        ? error
        : new Error(String(error));
  } finally { input.signal?.removeEventListener("abort", abort); }

  const finalContent = completedContent?.trim() || content.trim();
  if (!finalContent) {
    throw new Error(errorMessage ?? "Claude agent completed without assistant text.");
  }
  input.onEvent?.({
    requestId: input.requestId,
    type: "completed",
    content: finalContent,
    ...(runtimeConversation ? { runtimeConversation } : {}),
  });
  const sessionId = claudeSessionIdFromConversation(runtimeConversation);
  return {
    content: finalContent,
    ...(runtimeConversation ? { runtimeConversation } : {}),
    ...(sessionId ? { executionReference: { sessionId } } : {}),
  };
}
