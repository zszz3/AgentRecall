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

function fixture(options: {
  dataset?: EvaluationDataset;
  agents?: ConfiguredAgent[];
  executeAgent?: ReturnType<typeof vi.fn>;
} = {}) {
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
    saveEvaluator: vi.fn(async (value: EvaluationEvaluator) => value),
    deleteEvaluator: vi.fn(),
    listExperiments: vi.fn(async () => [experiment]),
    saveExperiment: vi.fn(),
    deleteExperiment: vi.fn(),
    listRuns: vi.fn(async () => []),
    saveRun,
    getRun: vi.fn(async (id: string) => {
      const saved = saveRun.mock.calls.map((call) => call[0]).filter((run) => run.id === id);
      return saved[saved.length - 1];
    }),
    deleteRun: vi.fn(),
    close: vi.fn(),
  } as unknown as EvaluationStore;
  const agents = options.agents ?? [
    agent(),
    agent({ id: "judge-agent", name: "Judge", channelId: "judge-channel", currentRevisionId: undefined }),
  ];
  const executeAgent = options.executeAgent ?? vi.fn(async (agentId: string) => ({
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
  it("reports experiments that reference an Agent", async () => {
    const { service } = fixture();

    await expect(service.configuredAgentReferences(new Set(["target-agent"]))).resolves.toEqual([
      { agentId: "target-agent", location: "Evaluation experiment Regression" },
    ]);
  });

  it("runs a saved experiment with its target Agent and Runtime Judge", async () => {
    const { service, executeAgent, saveRun } = fixture();

    const run = await service.runExperiment("experiment-1");

    expect(executeAgent).toHaveBeenNthCalledWith(1, "target-agent", "Explain the result", undefined);
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

  describe("ensureBuiltinJudge", () => {
    it("provisions an llm_judge bound to the execution agent's channel", async () => {
      const { service, store } = fixture();

      const judge = await service.ensureBuiltinJudge("target-agent");

      expect(judge.id).toBe("builtin-judge-codex-main");
      expect(judge).toMatchObject({
        kind: "llm_judge",
        runtimeId: "codex-main",
        enabled: true,
      });
      expect(judge.prompt).toContain("{{input}}");
      expect(judge.prompt).toContain("{{output}}");
      expect(store.saveEvaluator).toHaveBeenCalledWith(expect.objectContaining({ id: "builtin-judge-codex-main" }));
    });

    it("reuses an existing built-in judge instead of saving a duplicate", async () => {
      const { service, store } = fixture();
      const existing: EvaluationEvaluator = {
        id: "builtin-judge-codex-main",
        name: "Built-in Judge (codex-main)",
        kind: "llm_judge",
        runtimeId: "codex-main",
        threshold: 0.6,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      };
      (store.listEvaluators as ReturnType<typeof vi.fn>).mockResolvedValue([existing]);

      const judge = await service.ensureBuiltinJudge("target-agent");

      expect(judge).toBe(existing);
      expect(store.saveEvaluator).not.toHaveBeenCalled();
    });

    it("rejects an unknown execution agent", async () => {
      const { service } = fixture();
      await expect(service.ensureBuiltinJudge("missing-agent")).rejects.toThrow(/Evaluation Agent not found/);
    });
  });

  describe("run lifecycle", () => {
    it("startExperiment persists a running row immediately and completes in the background", async () => {
      const { service, store } = fixture();

      const runId = await service.startExperiment("experiment-1");

      expect(runId).toMatch(/^eval-run-/);
      const savedRuns = (store.saveRun as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
      expect(savedRuns[0]).toMatchObject({ id: runId, status: "running", results: [] });
      await vi.waitFor(() => {
        const calls = (store.saveRun as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
        expect(calls.some((run) => run.id === runId && run.status === "completed")).toBe(true);
      });
      const final = await service.getRun(runId);
      expect(final?.status).toBe("completed");
      expect(final?.results).toHaveLength(1);
    });

    it("cancelRun aborts the active run, which finalizes as cancelled", async () => {
      const { service, store } = fixture({
        executeAgent: vi.fn(async (agentId: string, _prompt: string, signal?: AbortSignal) => {
          if (agentId !== "target-agent") {
            return { output: '{"score":0.9,"reason":"clear"}', durationMs: 1 };
          }
          // Block until the abort signal fires, like a real agent conversation.
          return new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("Run cancelled")));
          });
        }),
      });

      const runId = await service.startExperiment("experiment-1");
      service.cancelRun(runId);

      await vi.waitFor(() => {
        const calls = (store.saveRun as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
        expect(calls.some((run) => run.id === runId && run.status === "cancelled")).toBe(true);
      });
    });

    it("startExperiment validates the experiment before persisting anything", async () => {
      const { service, store } = fixture();
      await expect(service.startExperiment("missing")).rejects.toThrow(/experiment not found/i);
      expect(store.saveRun).not.toHaveBeenCalled();
    });
  });
});
