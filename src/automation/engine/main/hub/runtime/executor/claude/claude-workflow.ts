import type { WorkflowAgentResponse } from "../../../../../shared/types";
import { claudeCliModelForChannel } from "../../../../agents/claude/claude-env";
import type { ClaudeAgentSdkRunInput } from "../../../../agents/claude/claude-agent-sdk";
import type { RuntimeWorkflowRequestContext } from "../../../../agents/runtime/runtime-driver";
import {
  claudeSessionIdFromConversation,
  cloneClaudeRuntimeConversation,
} from "../agent-executor-conversation";
import {
  developerInstructionsForWorkflowRequest,
  modelFromRuntimeConfig,
  type RuntimeWorkflowExecutionOptions,
} from "../workflow/agent-executor-workflow-shared";
import { claudeWorkflowMcpServers } from "./claude-workflow-mcp";
import { claudeMcpServers } from "../runtime-mcp";

export async function runClaudeWorkflow(
  input: RuntimeWorkflowRequestContext,
  options: RuntimeWorkflowExecutionOptions,
  runClaudeOneShot: (input: ClaudeAgentSdkRunInput) => Promise<void>,
): Promise<WorkflowAgentResponse> {
  const channel = options.channelById(input.channelId);
  const sdkModel =
    claudeCliModelForChannel(channel, modelFromRuntimeConfig(input.runtimeConfig)) ?? modelFromRuntimeConfig(input.runtimeConfig);
  const resumeSessionId = claudeSessionIdFromConversation(input.runtimeConversation);
  let content = "";
  let completedContent: string | undefined;
  let runtimeConversation = input.runtimeConversation ? cloneClaudeRuntimeConversation(input.runtimeConversation) : undefined;
  let errorMessage: string | undefined;
  const mcpServers = {
    ...claudeMcpServers(input.configuredAgentId ? options.mcpServersForAgent?.(input.configuredAgentId) ?? [] : []),
    ...claudeWorkflowMcpServers(options.workflowMcpDiscoveryPath?.(), input.planningWorkflowId, undefined, undefined, options.workflowMcpManagedToken?.()),
  };
  const abortController = new AbortController();
  const abort = () => abortController.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });

  try {
    await runClaudeOneShot({
      prompt: input.prompt,
      cwd: input.workDir,
      ...(sdkModel ? { modelId: sdkModel } : {}),
      developerInstructions: developerInstructionsForWorkflowRequest(input),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      abortController,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      onEvent: (event) => {
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
    throw new Error(errorMessage ?? "Claude workflow completed without assistant text.");
  }
  input.onEvent?.({
    requestId: input.requestId,
    type: "completed",
    content: finalContent,
    ...(runtimeConversation ? { runtimeConversation } : {}),
  });
  return { content: finalContent, ...(runtimeConversation ? { runtimeConversation } : {}) };
}
