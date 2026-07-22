import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WorkflowDraftState, WorkflowRunState } from "../../automation/engine/shared/types";
import { selectWorkbenchWorkflows } from "./features/automation/workbench-workflows";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const automationStyleSource = readFileSync(new URL("./styles/automation.css", import.meta.url), "utf8");

function workflow(workflowId: string, updatedAt: number): WorkflowDraftState {
  return {
    workflowId,
    title: workflowId,
    status: "draft",
    revision: 1,
    configuredAgentId: "agent",
    modelId: "default",
    reviewerConfiguredAgentId: "agent",
    reviewerModelId: "default",
    objective: "",
    definition: { workflowId, graphVersion: 1, objective: "", nodes: [], edges: [] },
    messages: [],
    reply: "",
    error: undefined,
    runProgress: [],
    runContextDocument: "",
    contextDocument: "",
    runIds: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

function run(workflowId: string, status: WorkflowRunState["status"], startedAt: number): WorkflowRunState {
  return {
    runId: `${workflowId}-run`,
    workflowId,
    status,
    workflowV2Plan: {} as WorkflowRunState["workflowV2Plan"],
    progress: [],
    events: [],
    contextDocument: "",
    startedAt,
    finishedAt: undefined,
    lastError: undefined,
  };
}

describe("native automation UI", () => {
  it("exposes Workflow, Runtime, and MCP as first-class AgentRecall pages", () => {
    expect(appSource).toContain('data-page="workflows"');
    expect(appSource).toContain('data-page="runtimes"');
    expect(appSource).toContain('data-page="mcp"');
    expect(appSource).toContain("<WorkflowFeaturePage");
    expect(appSource).toContain("<RuntimeFeaturePage");
    expect(appSource).toContain("<McpFeaturePage");
    expect(mainSource).toContain("<AutomationProvider>");
  });

  it("exposes Evaluation as a first-class page backed by the Automation API", () => {
    const featureUrl = new URL("./features/automation/evaluation-feature-page.tsx", import.meta.url);

    expect(appSource).toContain('data-page="evaluation"');
    expect(appSource).toContain("<EvaluationFeaturePage");
    expect(existsSync(featureUrl)).toBe(true);
    if (!existsSync(featureUrl)) return;

    const featureSource = readFileSync(featureUrl, "utf8");
    expect(featureSource).toContain("snapshot.configuredAgents");
    expect(featureSource).toContain("snapshot.channels");
    expect(featureSource).toContain("api={api}");
  });

  it("prioritizes waiting and running workflows before recent inactive workflows", () => {
    const selected = selectWorkbenchWorkflows(
      [workflow("recent", 40), workflow("running", 10), workflow("waiting", 5), workflow("older", 20)],
      [run("running", "running", 30), run("waiting", "waiting_for_user", 25)],
      3,
    );

    expect(selected.map((item) => [item.workflow.workflowId, item.status])).toEqual([
      ["waiting", "waiting_for_user"],
      ["running", "running"],
      ["recent", "draft"],
    ]);
  });

  it("keeps workflow header actions inside the detail pane when space is constrained", () => {
    const headerRule = automationStyleSource.match(
      /\.automation-workflow-detail \.workflow-chat-header\s*\{([^}]*)\}/,
    )?.[1];
    const actionsRule = automationStyleSource.match(
      /\.automation-workflow-detail \.workflow-page-actions\s*\{([^}]*)\}/,
    )?.[1];

    expect(headerRule).toContain("display: flex");
    expect(headerRule).toContain("flex-wrap: wrap");
    expect(actionsRule).toContain("max-width: 100%");
    expect(actionsRule).toContain("align-self: center");
    expect(actionsRule).toContain("flex-wrap: wrap");
  });

  it("lets the Runtime editor fill the page after removing the global config toolbar", () => {
    const runtimeLayoutRule = automationStyleSource.match(
      /\.automation-runtime-content \.runtime-layout\s*\{([^}]*)\}/,
    )?.[1];

    expect(runtimeLayoutRule).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(runtimeLayoutRule).not.toContain("auto minmax(0, 1fr)");
  });

  it("keeps Runtime configuration in an edge-aligned two-column workspace", () => {
    const contentRule = automationStyleSource.match(
      /\.automation-runtime-content\.is-channels\s*\{([^}]*)\}/,
    )?.[1];
    const workspaceRule = automationStyleSource.match(
      /\.automation-runtime-content \.runtime-config-workspace\s*\{([^}]*)\}/,
    )?.[1];
    const sidebarRule = automationStyleSource.match(
      /\.automation-runtime-content \.runtime-config-sidebar\s*\{([^}]*)\}/,
    )?.[1];
    const summaryRule = automationStyleSource.match(
      /\.automation-runtime-content \.runtime-config-summary\s*\{([^}]*)\}/,
    )?.[1];

    expect(contentRule).toContain("padding: 0");
    expect(workspaceRule).toContain("grid-template-columns: 190px minmax(0, 1fr)");
    expect(workspaceRule).toContain("gap: 0");
    expect(sidebarRule).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(sidebarRule).toContain("border-right: 1px solid var(--border)");
    expect(summaryRule).toContain("grid-template-columns");
  });
});
