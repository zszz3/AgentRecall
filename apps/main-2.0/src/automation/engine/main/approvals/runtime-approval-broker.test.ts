import { describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../../shared/types";
import { RuntimeApprovalBroker } from "./runtime-approval-broker";

describe("RuntimeApprovalBroker", () => {
  test("binds an approve-once decision to its owner and request", async () => {
    const events: AgentEvent[] = [];
    const broker = new RuntimeApprovalBroker();
    const decision = broker.request({
      ownerId: "chat-1",
      provider: "codex",
      content: "Run command",
      metadata: { authorization: "Bearer private", command: "npm test" },
      emit: (event) => events.push(event),
    });
    const request = events[0];
    expect(request).toMatchObject({
      type: "approval_request",
      metadata: { provider: "codex", approvalMode: "once", authorization: "[REDACTED]", command: "npm test" },
    });
    if (request?.type !== "approval_request") throw new Error("Missing request event");
    expect(broker.resolve({ ownerId: "chat-2", requestId: request.requestId, decision: "approved" })).toBe(false);
    expect(broker.resolve({ ownerId: "chat-1", requestId: request.requestId, decision: "approved" })).toBe(true);
    await expect(decision).resolves.toBe("approved");
    expect(broker.resolve({ ownerId: "chat-1", requestId: request.requestId, decision: "approved" })).toBe(false);
  });

  test("cancels all pending requests for a stopped owner", async () => {
    const emit = vi.fn();
    const broker = new RuntimeApprovalBroker();
    const first = broker.request({ ownerId: "chat-1", provider: "acp", content: "one", emit });
    const second = broker.request({ ownerId: "chat-1", provider: "claude", content: "two", emit });
    broker.cancelOwner("chat-1");
    await expect(Promise.all([first, second])).resolves.toEqual(["rejected", "rejected"]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "approval_response", decision: "rejected" }));
  });
});
