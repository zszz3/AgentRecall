import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type Options,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "../../../shared/types";
import type { RuntimeApprovalOperation, RuntimeApprovalRequester } from "../../approvals/runtime-approval-broker";
import { createClaudeStreamState, normalizeClaudeStreamEvent } from "./claude-stream";

export interface ClaudeAgentSdkRunInput {
  prompt: string;
  cwd: string;
  modelId?: string;
  developerInstructions?: string;
  resumeSessionId?: string;
  mcpServers?: Options["mcpServers"];
  onEvent: (event: AgentEvent) => void;
  abortController?: AbortController;
  env?: NodeJS.ProcessEnv;
  approvalOwnerId?: string;
  requestApproval?: RuntimeApprovalRequester;
}

export class ClaudeAgentSdkAdapter {
  constructor(
    private readonly options: {
      queryImpl?: typeof query;
    } = {},
  ) {}

  async runOneShot(input: ClaudeAgentSdkRunInput): Promise<void> {
    const queryImpl = this.options.queryImpl ?? query;
    const state = createClaudeStreamState();

    for await (const message of queryImpl({
      prompt: input.prompt,
      options: createClaudeSdkQueryOptions(input),
    })) {
      for (const event of normalizeClaudeStreamEvent(message, state)) {
        input.onEvent(event);
      }
    }
  }
}

export function createClaudeSdkQueryOptions(input: {
  cwd: string;
  modelId?: string;
  developerInstructions?: string;
  resumeSessionId?: string;
  mcpServers?: Options["mcpServers"];
  onEvent: (event: AgentEvent) => void;
  abortController?: AbortController;
  env?: NodeJS.ProcessEnv;
  approvalOwnerId?: string;
  requestApproval?: RuntimeApprovalRequester;
}): Options {
  const systemPrompt =
    input.developerInstructions?.trim()
      ? {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: input.developerInstructions.trim(),
        }
      : {
          type: "preset" as const,
          preset: "claude_code" as const,
        };

  return {
    cwd: input.cwd,
    ...(input.modelId ? { model: input.modelId } : {}),
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    systemPrompt,
    permissionMode: "default",
    canUseTool: createClaudeSdkPermissionHandler(input.onEvent, input.approvalOwnerId, input.requestApproval, input.abortController?.signal, input.cwd),
    onElicitation: createClaudeSdkElicitationHandler(input.onEvent),
    ...(input.abortController ? { abortController: input.abortController } : {}),
    ...(input.env ? { env: input.env } : {}),
  };
}

export function createClaudeSdkPermissionHandler(
  onEvent: (event: AgentEvent) => void,
  approvalOwnerId?: string,
  requestApproval?: RuntimeApprovalRequester,
  signal?: AbortSignal,
  cwd?: string,
): CanUseTool {
  return async (toolName, toolInput, options) => {
    const trustedWorkflowAuthoringTool = approvalOwnerId?.startsWith("workflow-draft:")
      && ["workflow_create", "workflow_validate", "workflow_context_append"].some((name) => toolName.toLowerCase().includes(name));
    if (trustedWorkflowAuthoringTool) {
      return { behavior: "allow", toolUseID: options.toolUseID };
    }
    if (approvalOwnerId?.startsWith("workflow-")) {
      return { behavior: "deny", message: "Runtime tool permissions are unavailable on this workflow surface.", toolUseID: options.toolUseID };
    }
    const decision = approvalOwnerId && requestApproval
      ? await requestApproval({
          ownerId: approvalOwnerId,
          provider: "claude",
          content: options.title ?? `Claude wants to use ${toolName}.`,
          metadata: {
            toolName,
            toolInput,
            nativeRequestId: options.requestId || options.toolUseID,
          },
          emit: onEvent,
          ...(signal ? { signal } : {}),
          ...claudeFileWriteOperation(toolName, toolInput, cwd),
        })
      : "rejected";
    if (decision === "approved") {
      return { behavior: "allow", toolUseID: options.toolUseID };
    }
    return {
      behavior: "deny",
      message: "Permission rejected by user or unavailable approval host.",
      toolUseID: options.toolUseID,
    };
  };
}

function claudeFileWriteOperation(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string | undefined,
): { operation: RuntimeApprovalOperation } | Record<string, never> {
  const normalizedTool = toolName.toLowerCase().split("__").at(-1) ?? "";
  if (!cwd || !["write", "edit", "multiedit", "notebookedit"].includes(normalizedTool)) return {};
  const candidate = [toolInput.file_path, toolInput.path, toolInput.notebook_path]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return candidate
    ? { operation: { kind: "file_write", cwd, paths: [candidate] } }
    : {};
}

export function createClaudeSdkElicitationHandler(
  onEvent: (event: AgentEvent) => void,
): (request: ElicitationRequest) => Promise<ElicitationResult> {
  return async (request) => {
    const requestId = request.elicitationId ?? `elicitation:${randomUUID()}`;
    onEvent({
      type: "user_input_request",
      requestId,
      content: request.title ?? request.message,
    });
    onEvent({
      type: "user_input_response",
      requestId,
      content: "Declined automatically by desktop host.",
    });
    return { action: "decline" };
  };
}

export type { Query };
