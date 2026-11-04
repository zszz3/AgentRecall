import type { AgentChannel, AgentEvent, AgentId, RuntimeRequest } from "../../../../shared/types";
import type { RuntimeOneShotRequest } from "../../../agents/runtime/runtime-driver";
import type { BoundMcpServer } from "./runtime-mcp";
import type { RuntimeApprovalRequester } from "../../../approvals/runtime-approval-broker";

export const ONE_SHOT_AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface RuntimeOneShotExecutionOptions {
  executables: Record<AgentId, string>;
  channelById: (channelId: string) => AgentChannel | undefined;
  mcpServersForAgent?: (configuredAgentId: string) => BoundMcpServer[];
  requestApproval?: RuntimeApprovalRequester;
}

/** Maps a runtime approval event onto the one-shot request without replacing its request identity. */
export function emitOneShotAgentApprovalEvent(
  input: Pick<RuntimeOneShotRequest, "requestId" | "onEvent">,
  event: AgentEvent,
): boolean {
  if (event.type === "approval_request") {
    input.onEvent?.({
      requestId: input.requestId,
      type: "approval_request",
      approvalRequestId: event.requestId,
      content: event.content,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
    return true;
  }
  if (event.type === "approval_response") {
    input.onEvent?.({
      requestId: input.requestId,
      type: "approval_response",
      approvalRequestId: event.requestId,
      decision: event.decision,
      ...(event.content ? { content: event.content } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
    return true;
  }
  return false;
}

export function modelFromRuntimeConfig(runtimeConfig: RuntimeRequest["runtimeConfig"]): string {
  return runtimeConfig.model;
}

export function createOneShotAgentTimeout(input: { timeoutMs: number; onTimeout: () => void }): { refresh: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const refresh = (): void => {
    clear();
    timer = setTimeout(input.onTimeout, input.timeoutMs);
  };
  refresh();
  return { refresh, clear };
}
