// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowAgentNode, WorkflowDefinition, WorkflowRun } from "../../../../automation/engine/shared/workflow/model";

const api = vi.hoisted(() => ({
  getWorkflowCore: vi.fn(),
  onWorkflowRunStream: vi.fn(() => () => undefined),
  pickDirectory: vi.fn(),
  chooseWorkDir: vi.fn(),
  saveWorkflowDefinition: vi.fn(),
}));

vi.mock("../../../../automation/engine/renderer/src/app/services/agent-recall-service", () => ({
  agentRecallAutomationService: () => api,
}));

vi.mock("./automation-provider", () => ({
  useAutomationStoreSnapshot: () => ({
    configuredAgents: [{ id: "agent-1", name: "Claude Code" }],
    workDir: "/workspace/project",
  }),
}));

vi.mock("./workflow-graph-canvas", () => ({
  WorkflowGraphCanvas: ({ onSelectNode }: { onSelectNode: (nodeId: string) => void }) => (
    <button type="button" data-testid="workflow-graph" onClick={() => onSelectNode("inspect-code")}>Workflow graph</button>
  ),
}));

import { WorkflowFeaturePage } from "./workflow-feature-page";

function runningWorkflow(): { definition: WorkflowDefinition; run: WorkflowRun } {
  const node: WorkflowAgentNode = {
    id: "inspect-code",
    kind: "agent",
    title: "检查代码",
    goal: "理解代码结构",
    inputs: [],
    outputs: [{ key: "summary", name: "摘要", description: "代码摘要", type: "text", required: true }],
    acceptanceCriteria: ["给出摘要"],
    agentId: "agent-1",
    instructions: ["检查工作目录"],
    constraints: [],
  };
  const definition: WorkflowDefinition = {
    id: "workflow-1",
    name: "代码检查",
    description: "检查当前代码",
    inputs: [],
    nodes: [node],
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    definition,
    run: {
      id: "run-1",
      workflowId: definition.id,
      definition,
      inputs: {},
      status: "running",
      nodeRuns: {
        [node.id]: {
          nodeId: node.id,
          status: "running",
          attempt: 1,
          resolvedInputs: { existingResume: "很长的输入内容".repeat(400) },
          startedAt: 2,
        },
      },
      events: [{ sequence: 1, type: "node_started", timestamp: 2, nodeId: node.id, attempt: 1 }],
      startedAt: 2,
    },
  };
}

function completedWorkflow(): { definition: WorkflowDefinition; run: WorkflowRun } {
  const snapshot = runningWorkflow();
  const node = snapshot.definition.nodes[0] as WorkflowAgentNode;
  node.outputs = [
    { key: "architecture", name: "现有架构", description: "架构摘要", type: "text", required: true },
    { key: "constraints", name: "实现约束", description: "约束列表", type: "list", required: true },
    { key: "extensionPoints", name: "可复用扩展点", description: "扩展点列表", type: "list", required: true },
  ];
  snapshot.run.status = "completed";
  snapshot.run.finishedAt = 4;
  snapshot.run.nodeRuns[node.id] = {
    nodeId: node.id,
    status: "completed",
    attempt: 1,
    resolvedInputs: { requirement: "分析当前项目" },
    outputs: {
      architecture: "第一段架构说明。\n\n第二段架构说明。",
      constraints: ["第一项", "第二项"],
      extensionPoints: [{ point: "新增会话来源", evidence: "types.ts" }],
    },
    startedAt: 2,
    finishedAt: 4,
  };
  snapshot.run.events = [
    { sequence: 1, type: "node_started", timestamp: 2, nodeId: node.id, attempt: 1 },
    { sequence: 2, type: "node_completed", timestamp: 4, nodeId: node.id, attempt: 1, durationMs: 2 },
  ];
  return snapshot;
}

describe("WorkflowFeaturePage live output", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const snapshot = runningWorkflow();
    api.getWorkflowCore.mockResolvedValue({ definitions: [snapshot.definition], runs: [snapshot.run] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a pre-delta waiting state above long resolved inputs for a running Agent node", async () => {
    await act(async () => {
      root.render(<WorkflowFeaturePage language="zh" globalReviewEnabled runtimeReviewEnabled />);
      await Promise.resolve();
    });
    const runTab = [...container.querySelectorAll<HTMLButtonElement>(".workflow-core-mode button")]
      .find((button) => button.textContent?.includes("Current run"));
    if (!runTab) throw new Error("Current run tab was not rendered");

    await act(async () => {
      runTab.click();
      await Promise.resolve();
    });

    const liveOutput = container.querySelector<HTMLElement>(".workflow-core-live-output");
    const resolvedInputs = container.querySelector<HTMLElement>(".workflow-core-run-data");
    const deleteButton = container.querySelector<HTMLButtonElement>("[aria-label='Delete Workflow']");
    expect(liveOutput).not.toBeNull();
    expect(liveOutput!.textContent).toContain("正在等待 Agent 输出");
    expect(resolvedInputs).not.toBeNull();
    expect(deleteButton?.disabled).toBe(true);
    expect(liveOutput!.compareDocumentPosition(resolvedInputs!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("renders validated outputs as readable paragraphs, lists, and properties", async () => {
    const snapshot = completedWorkflow();
    api.getWorkflowCore.mockResolvedValue({ definitions: [snapshot.definition], runs: [snapshot.run] });
    await act(async () => {
      root.render(<WorkflowFeaturePage language="zh" globalReviewEnabled runtimeReviewEnabled />);
      await Promise.resolve();
    });
    const runTab = [...container.querySelectorAll<HTMLButtonElement>(".workflow-core-mode button")]
      .find((button) => button.textContent?.includes("Current run"));
    if (!runTab) throw new Error("Current run tab was not rendered");
    await act(async () => {
      runTab.click();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='workflow-graph']")?.click();
      await Promise.resolve();
    });

    const output = [...container.querySelectorAll<HTMLDetailsElement>(".workflow-core-run-disclosure")]
      .find((details) => details.querySelector("summary")?.textContent?.includes("输出"));
    if (!output) throw new Error("Output disclosure was not rendered");
    expect(output.querySelector("pre")).toBeNull();
    expect(output.querySelectorAll(".workflow-core-run-paragraph")).toHaveLength(2);
    expect([...output.querySelectorAll(".workflow-core-run-list > li")].map((item) => item.textContent))
      .toEqual(expect.arrayContaining(["第一项", "第二项"]));
    expect(output.textContent).toContain("新增会话来源");
    expect(output.textContent).toContain("types.ts");
  });

  it("checks the right-clicked Workflow before enabling deletion", async () => {
    const selected = runningWorkflow();
    selected.definition.id = "workflow-a";
    selected.definition.name = "Workflow A";
    selected.run.workflowId = selected.definition.id;
    const target = runningWorkflow();
    target.definition.id = "workflow-b";
    target.definition.name = "Workflow B";
    target.run.workflowId = target.definition.id;
    api.getWorkflowCore.mockImplementation(async (workflowId?: string) => workflowId === target.definition.id
      ? { definitions: [selected.definition, target.definition], runs: [target.run] }
      : { definitions: [selected.definition, target.definition], runs: [selected.run] });

    await act(async () => {
      root.render(<WorkflowFeaturePage language="zh" globalReviewEnabled runtimeReviewEnabled />);
      await Promise.resolve();
    });
    const targetButton = [...container.querySelectorAll<HTMLButtonElement>(".workflow-core-list-group > button")]
      .find((button) => button.textContent?.includes("Workflow B"));
    if (!targetButton) throw new Error("Workflow B was not rendered");

    await act(async () => {
      targetButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 30 }));
      await Promise.resolve();
    });

    expect(api.getWorkflowCore).toHaveBeenCalledWith(target.definition.id);
    const deleteButton = [...container.querySelectorAll<HTMLButtonElement>(".workflow-core-context-menu button")]
      .find((button) => button.textContent?.includes("删除"));
    expect(deleteButton?.disabled).toBe(true);
  });

  it("opens the Workflow Core definition requested by the workbench", async () => {
    const first = runningWorkflow();
    first.definition.id = "workflow-a";
    first.definition.name = "Workflow A";
    first.run.workflowId = first.definition.id;
    const requested = runningWorkflow();
    requested.definition.id = "workflow-b";
    requested.definition.name = "Workflow B";
    requested.run.workflowId = requested.definition.id;
    const onInitialRequestConsumed = vi.fn();
    api.getWorkflowCore.mockResolvedValue({
      definitions: [first.definition, requested.definition],
      runs: [first.run, requested.run],
    });

    await act(async () => {
      root.render(
        <WorkflowFeaturePage
          language="zh"
          globalReviewEnabled
          runtimeReviewEnabled
          initialRequest={{ workflowId: requested.definition.id }}
          onInitialRequestConsumed={onInitialRequestConsumed}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getWorkflowCore).toHaveBeenCalledWith(requested.definition.id);
    const activeDefinition = container.querySelector<HTMLButtonElement>(".workflow-core-list-group > button.is-active");
    expect(activeDefinition?.textContent).toContain("Workflow B");
    expect(container.querySelector(".workflow-core-title")?.textContent).toContain("Workflow B");
    expect(onInitialRequestConsumed).toHaveBeenCalledOnce();
  });

  it("falls back to a real definition when a requested Workflow no longer exists", async () => {
    const existing = runningWorkflow();
    api.getWorkflowCore.mockResolvedValue({
      definitions: [existing.definition],
      runs: [existing.run],
    });

    await act(async () => {
      root.render(
        <WorkflowFeaturePage
          language="zh"
          globalReviewEnabled
          runtimeReviewEnabled
          initialRequest={{ workflowId: "deleted-workflow" }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLButtonElement>(".workflow-core-list-group > button.is-active")?.textContent)
      .toContain(existing.definition.name);
  });

  it("creates a new Core draft when requested by the workbench", async () => {
    const existing = runningWorkflow();
    const onInitialRequestConsumed = vi.fn();
    api.chooseWorkDir.mockResolvedValue({ workDir: "/global/next" });
    api.getWorkflowCore.mockResolvedValue({
      definitions: [existing.definition],
      runs: [existing.run],
    });

    await act(async () => {
      root.render(
        <WorkflowFeaturePage
          language="zh"
          globalReviewEnabled
          runtimeReviewEnabled
          initialRequest={{ createNew: true }}
          onInitialRequestConsumed={onInitialRequestConsumed}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const activeDefinition = container.querySelector<HTMLButtonElement>(".workflow-core-list-group > button.is-active");
    expect(activeDefinition?.textContent).toContain("New Workflow");
    expect(container.querySelector(".workflow-core-title")?.textContent).toContain("New Workflow");
    expect(api.getWorkflowCore).toHaveBeenCalledWith(undefined);
    expect(onInitialRequestConsumed).toHaveBeenCalledOnce();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Workflow properties']")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".workflow-core-workspace-actions .control-btn")?.click();
      await Promise.resolve();
    });
    expect(api.chooseWorkDir).toHaveBeenCalledOnce();
    expect(api.pickDirectory).not.toHaveBeenCalled();
  });

  it("persists a selected directory for an existing Workflow, ignores cancel, and clears back to global default", async () => {
    const snapshot = runningWorkflow();
    api.getWorkflowCore.mockResolvedValue({ definitions: [snapshot.definition], runs: [snapshot.run] });
    api.pickDirectory.mockResolvedValue(undefined);
    api.saveWorkflowDefinition.mockImplementation(async (definition: WorkflowDefinition) => definition);
    await act(async () => {
      root.render(<WorkflowFeaturePage language="zh" globalReviewEnabled runtimeReviewEnabled />);
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='Workflow properties']")?.click();
      await Promise.resolve();
    });

    const choose = container.querySelector<HTMLButtonElement>(".workflow-core-workspace-actions .control-btn");
    if (!choose) throw new Error("Workflow directory chooser was not rendered");
    expect(choose.textContent).toContain("选择目录");
    await act(async () => { choose.click(); await Promise.resolve(); });
    expect(api.pickDirectory).toHaveBeenCalledWith("/workspace/project");
    expect(container.querySelector<HTMLElement>(".workflow-core-workspace-summary")?.textContent).toContain("/workspace/project");

    api.pickDirectory.mockResolvedValue("/workflow/project");
    await act(async () => { choose.click(); await Promise.resolve(); });
    expect(api.saveWorkflowDefinition).toHaveBeenCalledWith(expect.objectContaining({ id: snapshot.definition.id, workDir: "/workflow/project" }));
    expect(container.querySelector<HTMLElement>(".workflow-core-workspace-summary")?.textContent).toContain("/workflow/project");

    const clear = container.querySelector<HTMLButtonElement>("[aria-label='清除 Workflow 目录']");
    if (!clear) throw new Error("Workflow directory clear action was not rendered");
    await act(async () => { clear.click(); await Promise.resolve(); });
    expect(api.saveWorkflowDefinition).toHaveBeenLastCalledWith(expect.objectContaining({ id: snapshot.definition.id, workDir: null }));
    expect(container.querySelector<HTMLElement>(".workflow-core-workspace-summary")?.textContent).toContain("/workspace/project");
    expect(api.chooseWorkDir).not.toHaveBeenCalled();
  });

  it("keeps new Workflow directory selection on the global default path", async () => {
    const snapshot = runningWorkflow();
    api.getWorkflowCore.mockResolvedValue({ definitions: [snapshot.definition], runs: [snapshot.run] });
    api.chooseWorkDir.mockResolvedValue({ workDir: "/global/next" });
    await act(async () => {
      root.render(<WorkflowFeaturePage language="zh" globalReviewEnabled runtimeReviewEnabled />);
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[aria-label='New Workflow']")?.click();
      container.querySelector<HTMLButtonElement>("[aria-label='Workflow properties']")?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".workflow-core-workspace-actions .control-btn")?.click();
      await Promise.resolve();
    });
    expect(api.chooseWorkDir).toHaveBeenCalledTimes(1);
    expect(api.pickDirectory).not.toHaveBeenCalled();
  });
});
