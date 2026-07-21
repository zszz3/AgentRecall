import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatEventMessage, chatEventDisplayContent } from "./chat-event-display";

describe("chatEventDisplayContent", () => {
  test("renders approval requests and responses with explicit state", () => {
    expect(
      chatEventDisplayContent({
        id: "evt-1",
        type: "approval_request",
        content: "Allow Bash to run `git status`?",
        requestId: "approval-1",
        requestState: "live",
        timestamp: 0,
        metadata: { toolName: "Bash" },
      }),
    ).toContain("approval pending\nAllow Bash to run `git status`?\n{");

    expect(
      chatEventDisplayContent({
        id: "evt-2",
        type: "approval_response",
        content: "Approved by user",
        requestId: "approval-1",
        decision: "approved",
        timestamp: 1,
      }),
    ).toBe("approval approved\nApproved by user");
  });

  test("renders expired user-input requests honestly", () => {
    expect(
      chatEventDisplayContent({
        id: "evt-3",
        type: "user_input_request",
        content: "Provide PROD_API_KEY",
        requestId: "input-1",
        requestState: "expired",
        timestamp: 2,
      }),
    ).toBe("input request expired\nProvide PROD_API_KEY");
  });

  test("renders approve-once and reject controls only for live approvals", () => {
    const html = renderToStaticMarkup(
      <ChatEventMessage
        ownerId="chat-1"
        onResolveApproval={() => undefined}
        event={{
          id: "evt-live",
          type: "approval_request",
          content: "Run command?",
          requestId: "approval-live",
          requestState: "live",
          timestamp: 0,
        }}
      />,
    );
    expect(html).toContain("Approve once");
    expect(html).toContain("Reject");
  });
});
