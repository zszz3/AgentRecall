import { describe, expect, test, vi } from "vitest";
import type { CodexRpcClient } from "../../../../agents/codex/codex-rpc";
import { RuntimeApprovalBroker } from "../../../../approvals/runtime-approval-broker";
import type { AgentEvent } from "../../../../../shared/types";
import { fileWriteOperationFromCodexPermissions, respondToCodexRuntimeServerRequest } from "./codex-server-request";

describe("respondToCodexRuntimeServerRequest", () => {
  test("fails closed when no approval broker is attached", () => {
    const respond = vi.fn();
    respondToCodexRuntimeServerRequest({ respond } as unknown as CodexRpcClient, 1, "execCommandApproval", { command: "rm file" });
    expect(respond).toHaveBeenCalledWith(1, { decision: "decline" });
  });

  test("maps a user approve-once decision to the native request", async () => {
    const respond = vi.fn();
    const request = vi.fn(async () => "approved" as const);
    respondToCodexRuntimeServerRequest(
      { respond } as unknown as CodexRpcClient,
      2,
      "item/commandExecution/requestApproval",
      { command: "npm test" },
      { ownerId: "chat-1", emit: vi.fn(), request, cwd: "C:/repo" },
    );
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(2, { decision: "accept" }));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "chat-1", provider: "codex" }));
  });

  test("keeps the native command request pending until the user resolves approval", async () => {
    const respond = vi.fn();
    const events: AgentEvent[] = [];
    const broker = new RuntimeApprovalBroker(1_000);
    respondToCodexRuntimeServerRequest(
      { respond } as unknown as CodexRpcClient,
      6,
      "item/commandExecution/requestApproval",
      { command: "git diff" },
      { ownerId: "task-approval", emit: (event) => events.push(event), request: broker.request, cwd: "C:/repo" },
    );
    const request = events.find((event) => event.type === "approval_request");
    if (request?.type !== "approval_request") throw new Error("Expected a live approval request");

    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();

    expect(broker.resolve({ ownerId: "task-approval", requestId: request.requestId, decision: "approved" })).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(6, { decision: "accept" }));
  });

  test("normalizes only write-scoped Codex permission paths", () => {
    expect(fileWriteOperationFromCodexPermissions({
      permissions: {
        fileSystem: {
          read: ["secrets/token.txt"],
          writableRoots: ["outputs/wf/run/report.md"],
        },
      },
    }, "C:/repo")).toEqual({
      kind: "file_write",
      cwd: "C:/repo",
      paths: ["outputs/wf/run/report.md"],
    });
  });

  test("keeps trusted workflow authoring MCP calls available", () => {
    const respond = vi.fn();
    respondToCodexRuntimeServerRequest(
      { respond } as unknown as CodexRpcClient,
      3,
      "item/mcpToolCall/requestApproval",
      { serverName: "agent_recall", toolName: "workflow_update" },
      undefined,
      "planning",
    );
    expect(respond).toHaveBeenCalledWith(3, { decision: "accept" });
  });

  test("does not auto-approve lifecycle or unrelated MCP tools", () => {
    const respond = vi.fn();
    const client = { respond } as unknown as CodexRpcClient;
    respondToCodexRuntimeServerRequest(client, 4, "item/mcpToolCall/requestApproval", {
      serverName: "agent_recall",
      toolName: "workflow_run",
    }, undefined, "planning");
    respondToCodexRuntimeServerRequest(client, 5, "item/mcpToolCall/requestApproval", {
      serverName: "filesystem",
      toolName: "workflow_update",
    }, undefined, "planning");
    expect(respond).toHaveBeenNthCalledWith(1, 4, { decision: "decline" });
    expect(respond).toHaveBeenNthCalledWith(2, 5, { decision: "decline" });
  });
});
