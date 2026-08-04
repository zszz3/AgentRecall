import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SkillService } from "./skill-service";

// Focused tests for the phase-four skill regression suite methods
// (getSkillEvalSuites / createSkillEvalSuite / runSkillEvalSuite). The heavy
// service-level harness was pruned upstream; these tests cover the new gating and
// skill-hash binding behavior directly.

const NOW = 1_700_000_000_000;

function makeEvaluationServiceMock(overrides: Record<string, unknown> = {}) {
  return {
    listExperiments: vi.fn(async () => []),
    listDatasets: vi.fn(async () => []),
    listRuns: vi.fn(async () => ({ items: [], total: 0, offset: 0, limit: 1 })),
    saveDataset: vi.fn(async (value: unknown) => value),
    saveExperiment: vi.fn(async (value: unknown) => value),
    startExperiment: vi.fn(async () => "run-1"),
    getRun: vi.fn(async () => null),
    cancelRun: vi.fn(),
    ensureBuiltinJudge: vi.fn(async (agentId: string) => ({ id: `builtin-judge-${agentId}` })),
    ...overrides,
  };
}

function makeService(evalEnabled: boolean, evaluationService: unknown) {
  return new SkillService({
    getStore: vi.fn() as never,
    getSettings: () => ({ evalEnabled }) as never,
    getHookSetup: vi.fn() as never,
    getEvaluationService: () => evaluationService as never,
    copyText: vi.fn(),
    revealPath: vi.fn(async () => undefined),
    now: () => NOW,
    logError: vi.fn(),
  });
}

// Creates an installed skill whose SKILL.md content yields a known hash.
function installSkillFixture(skillName: string, content: string): string {
  const root = path.join(tmpdir(), `skill-eval-suite-test-${Date.now()}-${Math.random()}`);
  const skillDir = path.join(root, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), content);
  return root;
}

describe("SkillService skill regression suites (phase four)", () => {
  // ── Gate ─────────────────────────────────────────────────────────────

  it("rejects all suite methods when Eval is disabled", async () => {
    const service = makeService(false, makeEvaluationServiceMock());
    await expect(service.getSkillEvalSuites("review")).rejects.toThrow("Eval is disabled");
    await expect(
      service.createSkillEvalSuite({
        skill: "review",
        name: "suite",
        agentId: "agent-1",
        evaluatorIds: [],
        useBuiltinJudge: false,
        repetitions: 1,
        cases: [{ input: "hello" }],
      }),
    ).rejects.toThrow("Eval is disabled");
    await expect(service.runSkillEvalSuite("experiment-1")).rejects.toThrow("Eval is disabled");
  });

  it("throws when the runtime/evaluation service is not available", async () => {
    const service = new SkillService({
      getStore: vi.fn() as never,
      getSettings: () => ({ evalEnabled: true }) as never,
      getHookSetup: vi.fn() as never,
      copyText: vi.fn(),
      revealPath: vi.fn(async () => undefined),
      now: () => NOW,
      logError: vi.fn(),
    });
    await expect(service.getSkillEvalSuites("review")).rejects.toThrow("Runtime is not ready");
  });

  // ── createSkillEvalSuite ────────────────────────────────────────────

  it("creates a dataset plus an experiment bound to the skill and its current hash", async () => {
    const root = installSkillFixture("review", "# review skill v1");
    try {
      const evaluations = makeEvaluationServiceMock();
      const service = makeService(true, evaluations);
      vi.spyOn(service, "listSkills").mockResolvedValue({
        skills: [{ name: "review", path: path.join(root, "review", "SKILL.md") }],
      } as never);

      const suite = await service.createSkillEvalSuite({
        skill: "review",
        name: "basic regression",
        agentId: "agent-1",
        evaluatorIds: ["eval-1", "eval-2"],
        useBuiltinJudge: false,
        repetitions: 3,
        cases: [
          { input: "case one" },
          { input: "case two", expectedOutput: "expected two" },
        ],
      });

      expect(evaluations.saveDataset).toHaveBeenCalledTimes(1);
      const datasetArg = (evaluations.saveDataset as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(datasetArg.items).toHaveLength(2);
      // expectedOutput stays optional: only case two carries it.
      expect(datasetArg.items[0].expectedOutput).toBeUndefined();
      expect(datasetArg.items[1].expectedOutput).toBe("expected two");

      expect(evaluations.saveExperiment).toHaveBeenCalledTimes(1);
      const experimentArg = (evaluations.saveExperiment as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(experimentArg.skillName).toBe("review");
      expect(experimentArg.skillHash).toMatch(/^[0-9a-f]{64}$/);
      expect(experimentArg.agentId).toBe("agent-1");
      expect(experimentArg.evaluatorIds).toEqual(["eval-1", "eval-2"]);
      expect(experimentArg.repetitions).toBe(3);

      expect(suite.skill).toBe("review");
      expect(suite.drifted).toBe(false);
      expect(suite.skillHash).toBe(experimentArg.skillHash);
      expect(suite.caseCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clamps repetitions into the 1..5 range and validates required fields", async () => {
    const evaluations = makeEvaluationServiceMock();
    const service = makeService(true, evaluations);
    vi.spyOn(service, "listSkills").mockResolvedValue({ skills: [] } as never);

    await expect(
      service.createSkillEvalSuite({
        skill: "review",
        name: "suite",
        agentId: "agent-1",
        evaluatorIds: [],
        useBuiltinJudge: true,
        repetitions: 1,
        cases: [],
      }),
    ).rejects.toThrow("At least one case is required.");

    await expect(
      service.createSkillEvalSuite({
        skill: "review",
        name: " ",
        agentId: "agent-1",
        evaluatorIds: [],
        useBuiltinJudge: true,
        repetitions: 1,
        cases: [{ input: "hello" }],
      }),
    ).rejects.toThrow("A suite name is required.");

    await expect(
      service.createSkillEvalSuite({
        skill: "review",
        name: "suite",
        agentId: "agent-1",
        evaluatorIds: [],
        useBuiltinJudge: false,
        repetitions: 1,
        cases: [{ input: "hello" }],
      }),
    ).rejects.toThrow("At least one evaluator is required.");

    const root = installSkillFixture("review", "x");
    try {
      vi.spyOn(service, "listSkills").mockResolvedValue({
        skills: [{ name: "review", path: path.join(root, "review", "SKILL.md") }],
      } as never);
      const suite = await service.createSkillEvalSuite({
        skill: "review",
        name: "suite",
        agentId: "agent-1",
        evaluatorIds: [],
        useBuiltinJudge: true,
        repetitions: 99,
        cases: [{ input: "hello" }],
      });
      expect(suite.repetitions).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores a null hash when the skill is no longer readable", async () => {
    const evaluations = makeEvaluationServiceMock();
    const service = makeService(true, evaluations);
    vi.spyOn(service, "listSkills").mockResolvedValue({ skills: [] } as never);

    const suite = await service.createSkillEvalSuite({
      skill: "missing-skill",
      name: "suite",
      agentId: "agent-1",
      evaluatorIds: [],
      useBuiltinJudge: true,
      repetitions: 1,
      cases: [{ input: "hello" }],
    });
    expect(suite.skillHash).toBeNull();
    expect(suite.currentHash).toBeNull();
    expect(suite.drifted).toBe(false);
  });

  it("provisions the built-in judge on the execution agent's channel when requested", async () => {
    const evaluations = makeEvaluationServiceMock();
    const service = makeService(true, evaluations);
    vi.spyOn(service, "listSkills").mockResolvedValue({ skills: [] } as never);

    const suite = await service.createSkillEvalSuite({
      skill: "review",
      name: "suite",
      agentId: "agent-1",
      evaluatorIds: ["eval-custom"],
      useBuiltinJudge: true,
      repetitions: 1,
      cases: [{ input: "hello" }],
    });

    expect(evaluations.ensureBuiltinJudge).toHaveBeenCalledWith("agent-1");
    const experimentArg = (evaluations.saveExperiment as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Built-in judge leads so it reads as the primary scoring signal.
    expect(experimentArg.evaluatorIds).toEqual(["builtin-judge-agent-1", "eval-custom"]);
    expect(suite.evaluatorIds).toContain("builtin-judge-agent-1");
  });

  // ── runSkillEvalSuite ──────────────────────────────────────────────

  it("refreshes the stored skill hash to the current version before running", async () => {
    const root = installSkillFixture("review", "# review skill v2");
    try {
      const evaluations = makeEvaluationServiceMock({
        listExperiments: vi.fn(async () => [
          {
            id: "experiment-1",
            name: "suite",
            datasetId: "dataset-1",
            agentId: "agent-1",
            evaluatorIds: [],
            repetitions: 1,
            skillName: "review",
            skillHash: "stale-hash",
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
      });
      const service = makeService(true, evaluations);
      vi.spyOn(service, "listSkills").mockResolvedValue({
        skills: [{ name: "review", path: path.join(root, "review", "SKILL.md") }],
      } as never);

      await service.runSkillEvalSuite("experiment-1");

      expect(evaluations.saveExperiment).toHaveBeenCalledTimes(1);
      const refreshed = (evaluations.saveExperiment as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(refreshed.skillHash).not.toBe("stale-hash");
      expect(refreshed.skillHash).toMatch(/^[0-9a-f]{64}$/);
      expect(evaluations.startExperiment).toHaveBeenCalledWith("experiment-1", {
        skillHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips the hash refresh when the stored hash already matches the current version", async () => {
    const root = installSkillFixture("review", "# review skill v3");
    try {
      const { createHash } = await import("node:crypto");
      const fs = await import("node:fs");
      const currentHash = createHash("sha256")
        .update(fs.readFileSync(path.join(root, "review", "SKILL.md")))
        .digest("hex");
      const evaluations = makeEvaluationServiceMock({
        listExperiments: vi.fn(async () => [
          {
            id: "experiment-1",
            name: "suite",
            datasetId: "dataset-1",
            agentId: "agent-1",
            evaluatorIds: [],
            repetitions: 1,
            skillName: "review",
            skillHash: currentHash,
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
      });
      const service = makeService(true, evaluations);
      vi.spyOn(service, "listSkills").mockResolvedValue({
        skills: [{ name: "review", path: path.join(root, "review", "SKILL.md") }],
      } as never);

      const started = await service.runSkillEvalSuite("experiment-1");

      expect(evaluations.saveExperiment).not.toHaveBeenCalled();
      expect(evaluations.startExperiment).toHaveBeenCalledWith("experiment-1", {
        skillHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      // The run executes in the background; callers get the id immediately.
      expect(started).toEqual({ runId: "run-1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes run polling and cancellation behind the Eval gate", async () => {
    const evaluations = makeEvaluationServiceMock({
      getRun: vi.fn(async (id: string) => id === "run-1"
        ? { id: "run-1", status: "running", results: [] }
        : null),
    });
    const gated = makeService(false, evaluations);
    await expect(gated.getSkillEvalRun("run-1")).rejects.toThrow("Eval is disabled");
    expect(() => gated.cancelSkillEvalRun("run-1")).toThrow("Eval is disabled");

    const service = makeService(true, evaluations);
    await expect(service.getSkillEvalRun("run-1")).resolves.toMatchObject({ id: "run-1" });
    await expect(service.getSkillEvalRun("missing")).resolves.toBeNull();
    service.cancelSkillEvalRun("run-1");
    expect(evaluations.cancelRun).toHaveBeenCalledWith("run-1");
  });

  it("lists a suite's runs newest-first and rejects suites not bound to a skill", async () => {
    const fixture = suiteFixtureMocks();
    fixture.evaluations.listRuns = vi.fn(async () => ({
      items: [{ id: "run-2" }, { id: "run-1" }],
      total: 2,
      offset: 0,
      limit: 10,
    })) as never;
    const service = makeService(true, fixture.evaluations);

    await expect(service.getSkillEvalSuiteRuns("missing")).rejects.toThrow("Evaluation suite not found");
    await expect(service.getSkillEvalSuiteRuns("experiment-1")).resolves.toEqual([
      { id: "run-2" },
      { id: "run-1" },
    ]);
    expect(fixture.evaluations.listRuns).toHaveBeenCalledWith({ experimentId: "experiment-1", limit: 10 });

    fixture.listExperiments.mockResolvedValueOnce([
      { ...fixture.experiment, id: "generic-1", skillName: "" },
    ]);
    await expect(service.getSkillEvalSuiteRuns("generic-1")).rejects.toThrow("not bound to a skill");
  });

  it("rejects when the experiment is missing or not skill-bound", async () => {
    const evaluations = makeEvaluationServiceMock({
      listExperiments: vi.fn(async () => [
        {
          id: "generic-1",
          name: "suite",
          datasetId: "dataset-1",
          agentId: "agent-1",
          evaluatorIds: [],
          repetitions: 1,
          skillName: null,
          skillHash: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    });
    const service = makeService(true, evaluations);
    await expect(service.runSkillEvalSuite("missing")).rejects.toThrow("Evaluation suite not found");
    await expect(service.runSkillEvalSuite("generic-1")).rejects.toThrow("not bound to a skill");
  });

  // ── getSkillEvalSuites ──────────────────────────────────────────────

  it("marks suites drifted when the stored hash differs from the current one", async () => {
    const root = installSkillFixture("review", "# review skill v4");
    try {
      const { createHash } = await import("node:crypto");
      const fs = await import("node:fs");
      const currentHash = createHash("sha256")
        .update(fs.readFileSync(path.join(root, "review", "SKILL.md")))
        .digest("hex");
      const evaluations = makeEvaluationServiceMock({
        listExperiments: vi.fn(async () => [
          {
            id: "experiment-drifted",
            name: "old suite",
            datasetId: "dataset-1",
            agentId: "agent-1",
            evaluatorIds: [],
            repetitions: 1,
            skillName: "review",
            skillHash: "old-hash",
            createdAt: 1,
            updatedAt: 2,
          },
          {
            id: "experiment-current",
            name: "new suite",
            datasetId: "dataset-2",
            agentId: "agent-1",
            evaluatorIds: [],
            repetitions: 1,
            skillName: "review",
            skillHash: currentHash,
            createdAt: 1,
            updatedAt: 3,
          },
        ]),
        listDatasets: vi.fn(async () => [
          { id: "dataset-1", name: "d1", description: "", items: [1, 2, 3], createdAt: 1, updatedAt: 1 },
          { id: "dataset-2", name: "d2", description: "", items: [1], createdAt: 1, updatedAt: 1 },
        ]),
        listRuns: vi.fn(async () => ({
          items: [{ id: "run-1", experimentId: "experiment-current", status: "completed", startedAt: 5, passRate: 0.5, averageScore: 0.7 }],
          total: 1,
          offset: 0,
          limit: 1,
        })),
      });
      const service = makeService(true, evaluations);
      vi.spyOn(service, "listSkills").mockResolvedValue({
        skills: [{ name: "review", path: path.join(root, "review", "SKILL.md") }],
      } as never);

      const suites = await service.getSkillEvalSuites("review");
      expect(suites).toHaveLength(2);
      // Sorted by updatedAt desc: experiment-current (3) first.
      expect(suites[0].id).toBe("experiment-current");
      expect(suites[0].caseCount).toBe(1);
      expect(suites[0].lastRun?.passRate).toBe(0.5);
      // Its stored hash equals the current SKILL.md hash, so it is not drifted.
      expect(suites[0].skillHash).toBe(currentHash);
      expect(suites[0].drifted).toBe(false);
      expect(suites[1].id).toBe("experiment-drifted");
      expect(suites[1].drifted).toBe(true);
      expect(suites[1].caseCount).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a skill with no bound suites", async () => {
    const evaluations = makeEvaluationServiceMock();
    const service = makeService(true, evaluations);
    vi.spyOn(service, "listSkills").mockResolvedValue({ skills: [] } as never);
    await expect(service.getSkillEvalSuites("nothing")).resolves.toEqual([]);
  });

  // ── Suite lifecycle: cases, update, delete ─────────────────────────

  function suiteFixtureMocks() {
    const experiment = {
      id: "experiment-1",
      name: "suite",
      datasetId: "dataset-1",
      agentId: "agent-1",
      evaluatorIds: ["builtin-judge-old-channel", "eval-x"],
      repetitions: 2,
      skillName: "review",
      skillHash: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const dataset = {
      id: "dataset-1",
      name: "suite",
      description: "review",
      items: [
        { id: "case-a", input: "first", expectedOutput: "want first", metadata: {}, sequence: 0 },
        { id: "case-b", input: "second", metadata: {}, sequence: 1 },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    const listExperiments = vi.fn(async () => [experiment]);
    const listDatasets = vi.fn(async () => [dataset]);
    const deleteRun = vi.fn(async () => true);
    const deleteExperiment = vi.fn(async () => true);
    const deleteDataset = vi.fn(async () => true);
    return {
      experiment,
      dataset,
      listExperiments,
      deleteRun,
      deleteExperiment,
      deleteDataset,
      evaluations: makeEvaluationServiceMock({
        listExperiments,
        listDatasets,
        deleteRun,
        deleteExperiment,
        deleteDataset,
      }),
    };
  }

  it("returns a suite's cases, keeping expectedOutput optional", async () => {
    const fixture = suiteFixtureMocks();
    const service = makeService(true, fixture.evaluations);
    await expect(service.getSkillEvalSuiteCases("experiment-1")).resolves.toEqual([
      { input: "first", expectedOutput: "want first" },
      { input: "second" },
    ]);
  });

  it("updates a suite in place: preserved case ids, appended ids, and a re-bound built-in judge", async () => {
    const fixture = suiteFixtureMocks();
    const service = makeService(true, fixture.evaluations);
    vi.spyOn(service, "listSkills").mockResolvedValue({ skills: [] } as never);

    await service.updateSkillEvalSuite({
      id: "experiment-1",
      name: "renamed suite",
      agentId: "agent-1",
      evaluatorIds: ["eval-x"],
      useBuiltinJudge: true,
      repetitions: 9,
      cases: [
        { input: "first edited" },
        { input: "second" },
        { input: "third added", expectedOutput: "want third" },
      ],
    });

    // Stale built-in id from the old channel is replaced by the one bound to
    // the current execution agent; custom evaluators pass through.
    expect(fixture.evaluations.ensureBuiltinJudge).toHaveBeenCalledWith("agent-1");
    const datasetArg = (fixture.evaluations.saveDataset as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(datasetArg.id).toBe("dataset-1");
    // Existing ids survive positionally; only the appended case gets a fresh id.
    expect(datasetArg.items[0].id).toBe("case-a");
    expect(datasetArg.items[0].input).toBe("first edited");
    expect(datasetArg.items[0].expectedOutput).toBeUndefined();
    expect(datasetArg.items[1].id).toBe("case-b");
    expect(datasetArg.items[2].id).toMatch(/^case-/);
    expect(datasetArg.items[2].expectedOutput).toBe("want third");

    const experimentArg = (fixture.evaluations.saveExperiment as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(experimentArg.id).toBe("experiment-1");
    expect(experimentArg.name).toBe("renamed suite");
    expect(experimentArg.evaluatorIds).toEqual(["builtin-judge-agent-1", "eval-x"]);
    expect(experimentArg.repetitions).toBe(5);
  });

  it("rejects updates for unknown suites", async () => {
    const fixture = suiteFixtureMocks();
    const service = makeService(true, fixture.evaluations);
    await expect(service.updateSkillEvalSuite({
      id: "missing",
      name: "suite",
      agentId: "agent-1",
      evaluatorIds: [],
      useBuiltinJudge: true,
      repetitions: 1,
      cases: [{ input: "hello" }],
    })).rejects.toThrow("Evaluation suite not found");
  });

  it("deletes a suite with its runs and orphaned dataset", async () => {
    const fixture = suiteFixtureMocks();
    fixture.evaluations.listRuns = vi.fn(async () => ({
      items: [{ id: "run-1" }, { id: "run-2" }],
      total: 2,
      offset: 0,
      limit: 100,
    })) as never;
    // Mirror the real store: after deleteExperiment the listing no longer
    // contains it, so the dataset is seen as orphaned.
    fixture.listExperiments
      .mockResolvedValueOnce([fixture.experiment])
      .mockResolvedValueOnce([]);
    const service = makeService(true, fixture.evaluations);

    await service.deleteSkillEvalSuite("experiment-1");

    expect(fixture.deleteRun).toHaveBeenCalledTimes(2);
    expect(fixture.deleteExperiment).toHaveBeenCalledWith("experiment-1");
    expect(fixture.deleteDataset).toHaveBeenCalledWith("dataset-1");
  });

  it("keeps a dataset shared with another experiment when deleting a suite", async () => {
    const fixture = suiteFixtureMocks();
    fixture.listExperiments
      .mockResolvedValueOnce([fixture.experiment])
      .mockResolvedValueOnce([
        { ...fixture.experiment, id: "experiment-2", datasetId: "dataset-1" },
      ]);
    const service = makeService(true, fixture.evaluations);

    await service.deleteSkillEvalSuite("experiment-1");

    expect(fixture.deleteExperiment).toHaveBeenCalledWith("experiment-1");
    expect(fixture.deleteDataset).not.toHaveBeenCalled();
  });
});
