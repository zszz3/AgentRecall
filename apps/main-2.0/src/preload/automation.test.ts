import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_CHANNELS } from "../shared/ipc/automation";
import { createAutomationApi } from "./automation";

describe("createAutomationApi", () => {
  it("maps Runtime, MCP, and Evaluation calls to prefixed channels", async () => {
    const ipc = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const api = createAutomationApi(ipc as never);

    await api.saveModelChannels([]);
    await api.listMcpServers();
    await api.runEvaluationExperiment("experiment-1");

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, AUTOMATION_CHANNELS.runtimeSaveChannels, []);
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, AUTOMATION_CHANNELS.mcpList);
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, AUTOMATION_CHANNELS.evaluationExperimentRun, { experimentId: "experiment-1" });
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

  it("unsubscribes snapshot listeners with the same callback", () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);
    const unsubscribe = api.onSnapshot(() => undefined);
    const listener = ipc.on.mock.calls[0]?.[1];

    unsubscribe();

    expect(ipc.removeListener).toHaveBeenCalledWith(AUTOMATION_CHANNELS.snapshotChanged, listener);
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
