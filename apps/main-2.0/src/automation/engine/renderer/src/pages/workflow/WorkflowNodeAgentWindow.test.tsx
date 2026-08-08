import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { TaskRun } from "../../../../shared/types";
import { WorkflowNodeAgentWindow } from "./WorkflowNodeAgentWindow";

describe("WorkflowNodeAgentWindow Review Gate pane", () => {
  test("opens the attached Review Gate pane and exposes a live approval", () => {
    const reviewTask = {
      id: "review-task-1",
      status: "running",
      modelId: "review-model",
      messages: [{
        id: "message-1",
        role: "assistant",
        content: "",
        timestamp: 1,
        events: [{
          id: "approval-event-1",
          type: "approval_request",
          requestId: "approval-1",
          requestState: "live",
          content: "Codex requests permission to call an MCP tool.",
          timestamp: 1,
        }],
      }],
    } as TaskRun;

    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow
      nodeTitle="Research"
      reviewEnabled
      reviewTask={reviewTask}
      onClose={() => undefined}
      onResolveRuntimeApproval={() => undefined}
    />);

    expect(html).toContain("Execution");
    expect(html).toContain("Review Gate");
    expect(html).toContain("Approval required");
    expect(html).toContain("Approve once");
    expect(html).toContain("Reject");
    expect(html.indexOf("Research")).toBeLessThan(html.indexOf('aria-label="Node activity"'));
    expect(html.indexOf('aria-label="Node activity"')).toBeLessThan(html.indexOf("Approve once"));
  });

  test("keeps the editable Agent prompt compact", () => {
    const html = renderToStaticMarkup(<WorkflowNodeAgentWindow
      nodeTitle="Research"
      prompt="Research the supplied question."
      editable
      onSavePrompt={() => undefined}
      onClose={() => undefined}
    />);

    expect(html).toContain('class="workflow-node-prompt-editor"');
    expect(html).toContain("Edit prompt");
  });
});
