import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SkillService } from "./skill-service";

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
    deleteRun: vi.fn(async () => true),
    deleteExperiment: vi.fn(async () => true),
    deleteDataset: vi.fn(async () => true),
    ensureBuiltinJudge: vi.fn(async (agentId: string, skillName?: string) => ({
      id: skillName === "rewrite-technical-tutorial"
        ? `builtin-judge-${agentId}-rewrite-technical-tutorial`
        : `builtin-judge-${agentId}`,
    })),
    ...overrides,
  };
}

function makeService(evalEnabled: boolean, evaluationService?: unknown) {
  return new SkillService({
    getStore: vi.fn() as never,
    getSettings: () => ({ evalEnabled }) as never,
    getHookSetup: vi.fn() as never,
    ...(evaluationService !== undefined ? { getEvaluationService: () => evaluationService as never } : {}),
    copyText: vi.fn(),
    revealPath: vi.fn(async () => undefined),
    now: () => NOW,
    logError: vi.fn(),
  });
}

function installSkillFixture(skillName: string, content: string): { root: string; filePath: string; hash: string } {
  const root = path.join(tmpdir(), `skill-eval-suite-test-${Date.now()}-${Math.random()}`);
  const filePath = path.join(root, skillName, "SKILL.md");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return { root, filePath, hash: createHash("sha256").update(content).digest("hex") };
}

describe("SkillService skill regression suites", () => {
  it("enforces the Eval feature gate and runtime availability", async () => {
    const disabled = makeService(false, makeEvaluationServiceMock());
    await expect(disabled.getSkillEvalSuites("review")).rejects.toThrow("Eval is disabled");
    await expect(disabled.runSkillEvalSuite("exp-1")).rejects.toThrow("Eval is disabled");
    await expect(disabled.getSkillEvalRun("run-1")).rejects.toThrow("Eval is disabled");
    expect(() => disabled.cancelSkillEvalRun("run-1")).toThrow("Eval is disabled");

    const noRuntime = makeService(true);
    await expect(noRuntime.getSkillEvalSuites("review")).rejects.toThrow("Runtime is not ready");
  });

  it("validates suite creation, binds skill hash & built-in judge, and clamps repetitions", async () => {
    const fixture = installSkillFixture("review", "# review skill v1");
    try {
      const evaluations = makeEvaluationServiceMock();
      const service = makeService(true, evaluations);
      vi.spyOn(service, "listSkills").mockResolvedValue({ skills: [{ name: "review", path: fixture.filePath }] } as never);

      await expect(service.createSkillEvalSuite({
        skill: "review", name: "suite", agentId: "a1", evaluatorIds: [], useBuiltinJudge: true, repetitions: 1, cases: [],
      })).rejects.toThrow("At least one case is required.");
      await expect(service.createSkillEvalSuite({
        skill: "review", name: " ", agentId: "a1", evaluatorIds: [], useBuiltinJudge: true, repetitions: 1, cases: [{ input: "hi" }],
      })).rejects.toThrow("A suite name is required.");
      await expect(service.createSkillEvalSuite({
        skill: "review", name: "suite", agentId: "a1", evaluatorIds: [], useBuiltinJudge: false, repetitions: 1, cases: [{ input: "hi" }],
      })).rejects.toThrow("At least one evaluator is required.");

      const suite = await service.createSkillEvalSuite({
        skill: "review",
        name: "basic regression",
        agentId: "agent-1",
        evaluatorIds: ["eval-custom"],
        useBuiltinJudge: true,
        repetitions: 99,
        cases: [{ input: "one" }, { input: "two", expectedOutput: "want two" }],
      });

      expect(suite).toMatchObject({ skill: "review", skillHash: fixture.hash, drifted: false, caseCount: 2, repetitions: 5 });
      expect(evaluations.saveExperiment).toHaveBeenCalledWith(expect.objectContaining({
        skillName: "review",
        skillHash: fixture.hash,
        evaluatorIds: ["builtin-judge-agent-1", "eval-custom"],
      }));

      await service.createSkillEvalSuite({
        skill: "rewrite-technical-tutorial",
        name: "tech writing",
        agentId: "agent-1",
        evaluatorIds: [],
        useBuiltinJudge: true,
        repetitions: 1,
        cases: [{ input: "Explain", context: "Evidence" }],
      });
      expect(evaluations.saveExperiment).toHaveBeenLastCalledWith(expect.objectContaining({
        evaluatorIds: ["builtin-judge-agent-1-rewrite-technical-tutorial"],
        scoring: expect.objectContaining({ resolvedThreshold: 0.75 }),
      }));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("detects drift, refreshes stale skill hash on run, and rejects unbound experiments", async () => {
    const fixture = installSkillFixture("review", "# review skill v2");
    try {
      const staleExp = {
        id: "exp-stale", name: "old", datasetId: "d1", agentId: "a1", evaluatorIds: [], repetitions: 1,
        skillName: "review", skillHash: "stale-hash", createdAt: 1, updatedAt: 2,
      };
      const currentExp = {
        id: "exp-current", name: "new", datasetId: "d2", agentId: "a1", evaluatorIds: [], repetitions: 1,
        skillName: "review", skillHash: fixture.hash, createdAt: 1, updatedAt: 3,
      };
      const unboundExp = { ...staleExp, id: "exp-unbound", skillName: null, skillHash: null };
      const evaluations = makeEvaluationServiceMock({
        listExperiments: vi.fn(async () => [staleExp, currentExp, unboundExp]),
        listDatasets: vi.fn(async () => [
          { id: "d1", name: "d1", description: "", items: [1, 2], createdAt: 1, updatedAt: 1 },
          { id: "d2", name: "d2", description: "", items: [1], createdAt: 1, updatedAt: 1 },
        ]),
      });
      const service = makeService(true, evaluations);
      vi.spyOn(service, "listSkills").mockResolvedValue({ skills: [{ name: "review", path: fixture.filePath }] } as never);

      const suites = await service.getSkillEvalSuites("review");
      expect(suites.map((s) => [s.id, s.drifted])).toEqual([["exp-current", false], ["exp-stale", true]]);

      await service.runSkillEvalSuite("exp-stale");
      expect(evaluations.saveExperiment).toHaveBeenCalledWith(expect.objectContaining({ id: "exp-stale", skillHash: fixture.hash }));
      expect(evaluations.startExperiment).toHaveBeenCalledWith("exp-stale", { skillHash: fixture.hash });

      evaluations.saveExperiment.mockClear();
      await service.runSkillEvalSuite("exp-current");
      expect(evaluations.saveExperiment).not.toHaveBeenCalled();

      await expect(service.runSkillEvalSuite("missing")).rejects.toThrow("Evaluation suite not found");
      await expect(service.runSkillEvalSuite("exp-unbound")).rejects.toThrow("not bound to a skill");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("updates cases in place and deletes orphaned datasets without removing shared datasets", async () => {
    const exp = {
      id: "exp-1", name: "suite", datasetId: "d1", agentId: "a1",
      evaluatorIds: ["builtin-judge-old", "eval-x"], repetitions: 2,
      skillName: "review", skillHash: null, createdAt: 1, updatedAt: 1,
    };
    const dataset = {
      id: "d1", name: "suite", description: "review",
      items: [{ id: "case-a", input: "first", expectedOutput: "want", metadata: {}, sequence: 0 }],
      createdAt: 1, updatedAt: 1,
    };
    const listExperiments = vi.fn(async () => [exp]);
    const evaluations = makeEvaluationServiceMock({
      listExperiments,
      listDatasets: vi.fn(async () => [dataset]),
      listRuns: vi.fn(async () => ({ items: [{ id: "r1" }], total: 1, offset: 0, limit: 100 })),
    });
    const service = makeService(true, evaluations);
    vi.spyOn(service, "listSkills").mockResolvedValue({ skills: [] } as never);

    await service.updateSkillEvalSuite({
      id: "exp-1", name: "renamed", agentId: "a1", evaluatorIds: ["eval-x"], useBuiltinJudge: true, repetitions: 9,
      cases: [{ input: "first edited" }, { input: "second added", expectedOutput: "want2" }],
    });
    const savedDataset = (evaluations.saveDataset as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedDataset.items[0]).toMatchObject({ id: "case-a", input: "first edited" });
    expect(savedDataset.items[1].id).toMatch(/^case-/);

    listExperiments.mockResolvedValueOnce([exp]).mockResolvedValueOnce([]);
    await service.deleteSkillEvalSuite("exp-1");
    expect(evaluations.deleteRun).toHaveBeenCalledWith("r1");
    expect(evaluations.deleteDataset).toHaveBeenCalledWith("d1");

    evaluations.deleteDataset.mockClear();
    listExperiments.mockResolvedValueOnce([exp]).mockResolvedValueOnce([{ ...exp, id: "exp-2" }]);
    await service.deleteSkillEvalSuite("exp-1");
    expect(evaluations.deleteDataset).not.toHaveBeenCalled();
  });
});
