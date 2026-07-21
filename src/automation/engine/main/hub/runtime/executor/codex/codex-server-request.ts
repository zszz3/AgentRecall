import type { CodexRpcClient } from "../../../../agents/codex/codex-rpc";
import type { AgentEvent } from "../../../../../shared/types";
import type { RuntimeApprovalOperation, RuntimeApprovalRequester } from "../../../../approvals/runtime-approval-broker";

function isWorkflowMcpRequest(params: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(params).toLowerCase();
  return ["workflow_create", "workflow_validate", "workflow_context_append"].some((name) => serialized.includes(name));
}

export function fileWriteOperationFromCodexPermissions(
  params: Record<string, unknown>,
  cwd: string,
): RuntimeApprovalOperation | undefined {
  const paths: string[] = [];
  const visit = (value: unknown, writeContext: boolean): void => {
    if (typeof value === "string") {
      if (writeContext && /[\\/]/.test(value)) paths.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, writeContext);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      visit(item, writeContext || /write|writable/i.test(key));
    }
  };
  visit(params.permissions, false);
  return paths.length > 0 ? { kind: "file_write", cwd, paths: [...new Set(paths)] } : undefined;
}

export function respondToCodexRuntimeServerRequest(
  client: CodexRpcClient,
  id: number,
  method: string,
  params: Record<string, unknown>,
  approval?: {
    ownerId: string;
    emit: (event: AgentEvent) => void;
    request: RuntimeApprovalRequester;
    cwd: string;
  },
): void {
  if (method === "item/tool/requestUserInput") {
    client.respond(id, { answers: {} });
    return;
  }
  if (method === "mcpServer/elicitation/request") {
    client.respond(id, isWorkflowMcpRequest(params)
      ? { action: "accept", content: {}, _meta: null }
      : { action: "decline", content: null, _meta: null });
    return;
  }
  if (method === "item/tool/call" || method === "mcp/dynamicToolCall") {
    client.respond(id, {
      contentItems: [{ type: "inputText", text: "AgentRecall does not handle Codex tool calls in this surface." }],
      success: false,
    });
    return;
  }

  const commandApproval = method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
  const mcpApproval = method === "item/mcpToolCall/requestApproval"
    || method === "mcpServer/toolCall/requestApproval"
    || method === "mcp/tool/requestApproval";
  const permissionsApproval = method === "item/permissions/requestApproval";
  if (!commandApproval && !mcpApproval && !permissionsApproval) {
    client.respond(id, {});
    return;
  }
  if (mcpApproval && isWorkflowMcpRequest(params)) {
    client.respond(id, { decision: "accept" });
    return;
  }
  if (!approval) {
    client.respond(id, permissionsApproval ? { permissions: {}, scope: "turn" } : { decision: "decline" });
    return;
  }

  void approval.request({
    ownerId: approval.ownerId,
    provider: "codex",
    content: commandApproval
      ? "Codex requests permission to execute a command."
      : permissionsApproval
        ? "Codex requests additional permissions."
        : "Codex requests permission to call an MCP tool.",
    metadata: { method, nativeRequestId: id, request: params },
    emit: approval.emit,
    ...(permissionsApproval && fileWriteOperationFromCodexPermissions(params, approval.cwd)
      ? { operation: fileWriteOperationFromCodexPermissions(params, approval.cwd)! }
      : {}),
  }).then((decision) => {
    if (permissionsApproval) {
      client.respond(id, decision === "approved"
        ? { permissions: params.permissions ?? {}, scope: "turn" }
        : { permissions: {}, scope: "turn" });
      return;
    }
    client.respond(id, { decision: decision === "approved" ? "accept" : "decline" });
  });
}
