import { describe, expect, it, vi } from "vitest";
import type {
  ConfiguredAgent,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
} from "../../automation/contracts";
import type { EvaluationStore } from "../../automation/engine/main/evaluation-store";
import { EvaluationService } from "./evaluation-service";

function agent(overrides: Partial<ConfiguredAgent> = {}): ConfiguredAgent {
  return {
    id: "target-agent",
    agentType: "execution",
    name: "Target",
    description: "",
    runtimeAgentId: "codex",
    channelId: "codex-main",
    modelId: "default",
    tags: [],
    currentRevisionId: "revision-2",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fixture(options: { dataset?: EvaluationDataset; agents?: ConfiguredAgent[] } = {}) {
  const experiment: EvaluationExperiment = {
    id: "experiment-1",
    name: "Regression",
    datasetId: "dataset-1",
    agentId: "target-agent",
    evaluatorIds: ["judge-1"],
    repetitions: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const dataset: EvaluationDataset = options.dataset ?? {
    id: "dataset-1",
    name: "Questions",
    description: "",
    items: [{ id: "case-1", input: "Explain the result", metadata: {}, sequence: 0 }],
    createdAt: 1,
    updatedAt: 1,
  };
  const evaluator: EvaluationEvaluator = {
    id: "judge-1",
    name: "Judge",
    kind: "llm_judge",
    runtimeId: "judge-channel",
    prompt: "<Input>{{input}}</Input><Answer>{{output}}</Answer>",
    threshold: 0.7,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const saveRun = vi.fn(async (run: EvaluationRun) => run);
  const store = {
    listDatasets: vi.fn(async () => options.dataset === undefined ? [dataset] : options.dataset ? [options.dataset] : []),
    saveDataset: vi.fn(),
    deleteDataset: vi.fn(),
    listEvaluators: vi.fn(async () => [evaluator]),
    saveEvaluator: vi.fn(),
    deleteEvaluator: vi.fn(),
    listExperiments: vi.fn(async () => [experiment]),
    saveExperiment: vi.fn(),
    deleteExperiment: vi.fn(),
    listRuns: vi.fn(async () => []),
    saveRun,
    deleteRun: vi.fn(),
    close: vi.fn(),
  } as unknown as EvaluationStore;
  const agents = options.agents ?? [
    agent(),
    agent({ id: "judge-agent", name: "Judge", channelId: "judge-channel", currentRevisionId: undefined }),
  ];
  const executeAgent = vi.fn(async (agentId: string) => ({
    output: agentId === "judge-agent" ? '{"score":0.9,"reason":"clear"}' : "subject output",
    durationMs: 5,
  }));
  return {
    service: new EvaluationService({ store, agents: () => agents, executeAgent }),
    store,
    saveRun,
    executeAgent,
  };
}

describe("EvaluationService", () => {
  it("runs a saved experiment with its target Agent and Runtime Judge", async () => {
    const { service, executeAgent, saveRun } = fixture();

    const run = await service.runExperiment("experiment-1");

    expect(executeAgent).toHaveBeenNthCalledWith(1, "target-agent", "Explain the result");
    expect(executeAgent).toHaveBeenNthCalledWith(2, "judge-agent", expect.stringContaining("subject output"));
    expect(saveRun).toHaveBeenCalledWith(expect.objectContaining({
      experimentId: "experiment-1",
      agentRevisionId: "revision-2",
    }));
    expect(run.passRate).toBe(1);
  });

  it("rejects an experiment whose dataset no longer exists", async () => {
    const { service, executeAgent } = fixture({ dataset: null as unknown as EvaluationDataset });

    await expect(service.runExperiment("experiment-1")).rejects.toThrow(/dataset.*dataset-1/i);
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("rejects an LLM Judge without an execution Agent on its Runtime channel", async () => {
    const { service, executeAgent } = fixture({ agents: [agent()] });

    await expect(service.runExperiment("experiment-1")).rejects.toThrow(/judge-channel.*execution Agent/i);
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("accepts legacy execution Agents that do not persist agentType", async () => {
    const { service, executeAgent } = fixture({
      agents: [
        agent(),
        agent({
          id: "judge-agent",
          name: "Judge",
          channelId: "judge-channel",
          agentType: undefined,
          currentRevisionId: undefined,
        }),
      ],
    });

    await expect(service.runExperiment("experiment-1")).resolves.toMatchObject({ passRate: 1 });
    expect(executeAgent).toHaveBeenCalledWith("judge-agent", expect.any(String));
  });
});
