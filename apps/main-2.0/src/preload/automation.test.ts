import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_CHANNELS } from "../shared/ipc/automation";
import { createAutomationApi } from "./automation";

describe("createAutomationApi", () => {
  it("maps Runtime, MCP, and Workflow calls to prefixed channels", async () => {
    const ipc = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const api = createAutomationApi(ipc as never);

    await api.saveModelChannels([]);
    await api.listMcpServers();
    await api.createWorkflowDraft({ title: "Ship" });

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, AUTOMATION_CHANNELS.runtimeSaveChannels, []);
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, AUTOMATION_CHANNELS.mcpList);
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, AUTOMATION_CHANNELS.workflowDraftCreate, { title: "Ship" });
  });

  it("deletes one concrete Agent by its persisted id", async () => {
    const ipc = { invoke: vi.fn(async () => ({ configuredAgents: [] })), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);

    await api.deleteConfiguredAgent("agent-1");

    expect(ipc.invoke).toHaveBeenCalledWith(AUTOMATION_CHANNELS.runtimeDeleteAgent, "agent-1");
  });

  it("updates one external MCP client connection through its dedicated channel", async () => {
    const ipc = { invoke: vi.fn(async () => ({ clients: [] })), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);
    const request = { clientId: "codex" as const, enabled: true };

    await api.setMcpClientConnection(request);

    expect(ipc.invoke).toHaveBeenCalledWith(AUTOMATION_CHANNELS.mcpClientSet, request);
  });

  it("loads the lightweight Workflow sidebar through its own channel", async () => {
    const ipc = { invoke: vi.fn(async () => ({ workflows: [] })), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);

    await api.getWorkflowSidebar();

    expect(ipc.invoke).toHaveBeenCalledWith(AUTOMATION_CHANNELS.workflowSidebar);
  });

  it("loads the Workflow Core workbench summary through its own channel", async () => {
    const snapshot = { workflows: [], totalCount: 0, activeCount: 0 };
    const ipc = { invoke: vi.fn(async () => snapshot), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);

    await expect(api.getWorkflowWorkbench()).resolves.toBe(snapshot);

    expect(ipc.invoke).toHaveBeenCalledWith(AUTOMATION_CHANNELS.workflowWorkbench);
  });

  it("maps the structured Workflow API without legacy draft operations", async () => {
    const ipc = { invoke: vi.fn(async () => ({ definitions: [], runs: [] })), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);
    const definition = { id: "workflow" } as never;

    const planning = { requestId: "planning", agentId: "agent", definition, message: "Goal", intent: "interview" as const };
    await api.replyWorkflowPlanning(planning);
    await api.cancelWorkflowPlanning("planning");
    await api.getWorkflowCore();
    await api.saveWorkflowDefinition(definition);
    await api.startWorkflowRun("workflow", { source: "resume" });
    await api.pauseWorkflowRun("run");
    await api.resumeWorkflowRun("run");
    await api.retryWorkflowNode("run", "node");
    await api.resolveWorkflowApproval("run", "approval", { decision: "yes" });
    await api.cancelWorkflowRun("run");
    await api.deleteWorkflowDefinition("workflow");

    expect(ipc.invoke.mock.calls).toEqual([
      [AUTOMATION_CHANNELS.workflowPlanningReply, planning],
      [AUTOMATION_CHANNELS.workflowPlanningCancel, "planning"],
      [AUTOMATION_CHANNELS.workflowCoreGet, undefined],
      [AUTOMATION_CHANNELS.workflowDefinitionSave, definition],
      [AUTOMATION_CHANNELS.workflowRunStart, { workflowId: "workflow", inputs: { source: "resume" } }],
      [AUTOMATION_CHANNELS.workflowRunPause, { runId: "run" }],
      [AUTOMATION_CHANNELS.workflowRunResume, { runId: "run" }],
      [AUTOMATION_CHANNELS.workflowNodeRetry, { runId: "run", nodeId: "node" }],
      [AUTOMATION_CHANNELS.workflowApprovalResolve, { runId: "run", nodeId: "approval", outputs: { decision: "yes" } }],
      [AUTOMATION_CHANNELS.workflowRunCancel, { runId: "run" }],
      [AUTOMATION_CHANNELS.workflowDefinitionDelete, { workflowId: "workflow" }],
    ]);
  });

  it("keeps portable Workflow file contents behind explicit IPC calls", async () => {
    const ipc = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);
    const request = { previewToken: "workflow_import_1", agentMappings: { missing: "agent-1" } };

    await api.cloneOfficialWorkflow("official-1");
    await api.beginWorkflowImport();
    await api.confirmWorkflowImport(request);
    await api.cancelWorkflowImport("workflow_import_2");
    await api.exportWorkflow("personal-1");

    expect(ipc.invoke.mock.calls).toEqual([
      [AUTOMATION_CHANNELS.workflowCloneOfficial, "official-1"],
      [AUTOMATION_CHANNELS.workflowImportBegin],
      [AUTOMATION_CHANNELS.workflowImportConfirm, request],
      [AUTOMATION_CHANNELS.workflowImportCancel, { previewToken: "workflow_import_2" }],
      [AUTOMATION_CHANNELS.workflowExport, "personal-1"],
    ]);
  });

  it("unsubscribes snapshot listeners with the same callback", () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);
    const unsubscribe = api.onSnapshot(() => undefined);
    const listener = ipc.on.mock.calls[0]?.[1];

    unsubscribe();

    expect(ipc.removeListener).toHaveBeenCalledWith(AUTOMATION_CHANNELS.snapshotChanged, listener);
  });

  it("unsubscribes incremental change listeners with the same callback", () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);
    const unsubscribe = api.onChange(() => undefined);
    const listener = ipc.on.mock.calls[0]?.[1];

    unsubscribe();

    expect(ipc.removeListener).toHaveBeenCalledWith(AUTOMATION_CHANNELS.change, listener);
  });

  it("forwards Workflow Runtime stream events and removes the exact listener", () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);
    const callback = vi.fn();
    const event = {
      runId: "run-1",
      nodeId: "agent-1",
      type: "delta" as const,
      content: "hello",
      timestamp: 10,
    };

    const unsubscribe = api.onWorkflowRunStream(callback);
    const listener = ipc.on.mock.calls[0]?.[1];
    listener?.({}, event);

    expect(ipc.on).toHaveBeenCalledWith(AUTOMATION_CHANNELS.workflowRunStream, listener);
    expect(callback).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith(AUTOMATION_CHANNELS.workflowRunStream, listener);
  });

  it("maps the complete Evaluation API to prefixed channels", async () => {
    const ipc = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);
    const dataset = { id: "dataset-1" } as never;
    const evaluator = { id: "evaluator-1" } as never;
    const experiment = { id: "experiment-1" } as never;

    await api.listEvaluationDatasets();
    await api.saveEvaluationDataset(dataset);
    await api.deleteEvaluationDataset("dataset-1");
    await api.listEvaluationEvaluators();
    await api.saveEvaluationEvaluator(evaluator);
    await api.deleteEvaluationEvaluator("evaluator-1");
    await api.listEvaluationExperiments();
    await api.saveEvaluationExperiment(experiment);
    await api.deleteEvaluationExperiment("experiment-1");
    await api.listEvaluationRuns({ experimentId: "experiment-1", limit: 25 });
    await api.getEvaluationRun("run-1");
    await api.deleteEvaluationRun("run-1");
    await api.openEvaluationArtifactFile("run-1", "result-1");
    await api.runEvaluationExperiment("experiment-1");

    expect(ipc.invoke.mock.calls).toEqual([
      [AUTOMATION_CHANNELS.evaluationDatasetList],
      [AUTOMATION_CHANNELS.evaluationDatasetSave, dataset],
      [AUTOMATION_CHANNELS.evaluationDatasetDelete, "dataset-1"],
      [AUTOMATION_CHANNELS.evaluationEvaluatorList],
      [AUTOMATION_CHANNELS.evaluationEvaluatorSave, evaluator],
      [AUTOMATION_CHANNELS.evaluationEvaluatorDelete, "evaluator-1"],
      [AUTOMATION_CHANNELS.evaluationExperimentList],
      [AUTOMATION_CHANNELS.evaluationExperimentSave, experiment],
      [AUTOMATION_CHANNELS.evaluationExperimentDelete, "experiment-1"],
      [AUTOMATION_CHANNELS.evaluationRunList, { experimentId: "experiment-1", limit: 25 }],
      [AUTOMATION_CHANNELS.evaluationRunGet, "run-1"],
      [AUTOMATION_CHANNELS.evaluationRunDelete, "run-1"],
      [AUTOMATION_CHANNELS.evaluationArtifactOpen, { runId: "run-1", resultId: "result-1" }],
      [AUTOMATION_CHANNELS.evaluationExperimentRun, { experimentId: "experiment-1" }],
    ]);
  });
});
