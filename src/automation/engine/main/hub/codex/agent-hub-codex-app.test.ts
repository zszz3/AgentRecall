import { describe, expect, it, vi } from "vitest";
import { respondToCodexServerRequest } from "./agent-hub-codex-app";

describe("respondToCodexServerRequest MCP approvals", () => {
  it.each(["item/mcpToolCall/requestApproval", "mcpServer/toolCall/requestApproval", "mcp/tool/requestApproval"])("accepts %s", (method) => {
    const respond = vi.fn();
    respondToCodexServerRequest({ respond } as never, 7, method, { toolName: "workflow_create" });
    expect(respond).toHaveBeenCalledWith(7, expect.objectContaining({ decision: "accept" }));
  });

  it("accepts workflow MCP elicitation instead of declining it", () => {
    const respond = vi.fn();
    respondToCodexServerRequest({ respond } as never, 8, "mcpServer/elicitation/request", { toolName: "workflow_validate" });
    expect(respond).toHaveBeenCalledWith(8, expect.objectContaining({ action: "accept" }));
  });

  it("does not auto-approve unrelated MCP tools", () => {
    const respond = vi.fn();
    respondToCodexServerRequest({ respond } as never, 9, "item/mcpToolCall/requestApproval", { toolName: "filesystem_delete" });
    expect(respond).toHaveBeenCalledWith(9, expect.objectContaining({ decision: "decline" }));
  });
});
