import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { WorkflowSidebarItem } from "../../../../shared/types";
import { WorkflowHistoryPanel } from "./WorkflowHistoryPanel";

function workflow(overrides: Partial<WorkflowSidebarItem> = {}): WorkflowSidebarItem {
  return {
    workflowId: "wf-personal",
    sourceType: "user",
    title: "Personal Workflow",
    status: "draft",
    revision: 1,
    objective: "Answer a question",
    nodeCount: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function renderContextMenu(item: WorkflowSidebarItem): string {
  return renderToStaticMarkup(<WorkflowHistoryPanel
    workflows={[item]}
    contextMenu={{ workflowId: item.workflowId, x: 0, y: 0 }}
    onNewWorkflow={() => undefined}
    onSelectWorkflow={() => undefined}
  />);
}

describe("WorkflowHistoryPanel export eligibility", () => {
  test("disables export for blank drafts and enables it for configured workflows", () => {
    const blank = renderContextMenu(workflow({ objective: "", nodeCount: 0 }));
    const configured = renderContextMenu(workflow());

    expect(blank).toMatch(/<button[^>]*disabled=""[^>]*title="Complete the Workflow objective and graph before export\."[^>]*>.*Export workflow/su);
    expect(configured).toMatch(/<button[^>]*>.*Export workflow/su);
    expect(configured).not.toContain("Complete the Workflow objective and graph before export.");
  });
});
