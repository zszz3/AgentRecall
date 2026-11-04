import { describe, expect, test, vi } from "vitest";
import { emitOneShotAgentApprovalEvent } from "./oneshot-shared";

describe("one-shot agent approval events", () => {
  test("maps runtime approval identity without replacing the one-shot request identity", () => {
    const onEvent = vi.fn();
    expect(emitOneShotAgentApprovalEvent({ requestId: "oneshot-request", onEvent }, {
      type: "approval_request",
      requestId: "runtime-approval:1",
      content: "Allow MCP tool?",
      metadata: { provider: "codex" },
    })).toBe(true);
    expect(onEvent).toHaveBeenCalledWith({
      requestId: "oneshot-request",
      type: "approval_request",
      approvalRequestId: "runtime-approval:1",
      content: "Allow MCP tool?",
      metadata: { provider: "codex" },
    });
  });
});
