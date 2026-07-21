import { describe, expect, test, vi } from "vitest";
import type { CodexRpcClient } from "../../../../agents/codex/codex-rpc";
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
      { tool: "workflow_validate" },
    );
    expect(respond).toHaveBeenCalledWith(3, { decision: "accept" });
  });
});
