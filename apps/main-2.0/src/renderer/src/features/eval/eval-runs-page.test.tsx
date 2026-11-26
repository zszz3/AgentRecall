// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationExperiment, EvaluationRun, EvaluationRunSummary } from "../../../../automation/contracts";
import { EvalRunsPage } from "./eval-runs-page";

const harness = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  deleteRun: vi.fn(),
  listExperiments: vi.fn(),
  listEvaluators: vi.fn(),
  confirm: vi.fn(),
  resolveSession: vi.fn(),
}));

function summary(overrides: Partial<EvaluationRunSummary> = {}): EvaluationRunSummary {
  return {
    id: "run-1",
    experimentId: "experiment-1",
    status: "completed",
    startedAt: 1,
    engine: "graph",
    resultCount: 1,
    failedResultCount: 0,
    ...overrides,
  };
}

function experiment(overrides: Partial<EvaluationExperiment> = {}): EvaluationExperiment {
  return {
    id: "experiment-1",
    name: "Login regression",
    datasetId: "dataset-1",
    agentId: "agent-1",
    evaluatorIds: [],
    repetitions: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function graphRun(): EvaluationRun {
  return {
    id: "run-1",
    experimentId: "experiment-1",
    status: "completed",
    engine: "graph",
    startedAt: 1,
    finishedAt: 2,
    passRate: 0,
    scoredCaseCount: 0,
    unscoredCaseCount: 1,
    results: [
      {
        id: "run-1:item-1:1",
        runId: "run-1",
        datasetItemId: "item-1",
        repetition: 1,
        input: "explain the failure",
        output: "",
        durationMs: 12,
        gatePassed: true,
        unscoredReason: "judge_runtime_not_configured",
        scores: [],
        nodes: [
          { nodeId: "agent", nodeType: "run_agent", nodeVersion: 1, role: "prepare", status: "pass", durationMs: 10 },
          {
            nodeId: "judge-broken",
            nodeType: "llm_judge",
            nodeVersion: 1,
            role: "judge",
            status: "excused",
            attribution: { type: "infra_failure", reason: "judge_runtime_not_configured" },
            facts: { evaluatorId: "judge-1" },
          },
        ],
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  harness.listRuns.mockReset().mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
  harness.getRun.mockReset().mockResolvedValue(graphRun());
  harness.listExperiments.mockReset().mockResolvedValue([experiment()]);
  harness.listEvaluators.mockReset().mockResolvedValue([]);
  harness.deleteRun.mockReset().mockResolvedValue(true);
  harness.confirm.mockReset().mockReturnValue(true);
  harness.resolveSession.mockReset().mockResolvedValue({ status: "not_recorded" });
  Object.assign(window, {
    confirm: harness.confirm,
    sessionSearch: {
      resolveRuntimeInvocationSession: harness.resolveSession,
      automation: {
        listEvaluationRuns: harness.listRuns,
        getEvaluationRun: harness.getRun,
        deleteEvaluationRun: harness.deleteRun,
        listEvaluationExperiments: harness.listExperiments,
        listEvaluationEvaluators: harness.listEvaluators,
      },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(props: Partial<Parameters<typeof EvalRunsPage>[0]> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(EvalRunsPage, { language: "zh", onOpenSession: () => undefined, ...props }));
  });
}

describe("EvalRunsPage", () => {
  it("opens an explicitly requested older run and links subject and judge invocations", async () => {
    const onInitialRunConsumed = vi.fn();
    const onOpenSession = vi.fn();
    harness.getRun.mockImplementation(async (runId: string) => {
      const base = graphRun();
      return { ...base, id: runId, results: base.results.map((item) => ({ ...item, runId })) };
    });
    harness.resolveSession.mockResolvedValue({ status: "found", session: { sessionKey: "codex:linked" } });

    await render({
      onOpenSession,
      initialRunId: "run-older",
      initialCaseId: "run-1:item-1:1",
      initialEvaluatorId: "judge-1",
      onInitialRunConsumed,
    });

    await vi.waitFor(() => expect(harness.getRun).toHaveBeenCalledWith("run-older"));
    expect(onInitialRunConsumed).toHaveBeenCalledOnce();
    await act(async () => { await Promise.resolve(); });

    const subject = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("被测会话"))!;
    const judge = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("评分会话"))!;
    await act(async () => { subject.click(); await Promise.resolve(); });
    await act(async () => { judge.click(); await Promise.resolve(); });

    expect(harness.resolveSession).toHaveBeenCalledWith({
      surface: "evaluation",
      role: "subject",
      ownerReference: { runId: expect.any(String), caseId: "run-1:item-1:1" },
    });
    expect(harness.resolveSession).toHaveBeenLastCalledWith({
      surface: "evaluation",
      role: "judge",
      ownerReference: { runId: expect.any(String), caseId: "run-1:item-1:1", evaluatorId: "judge-1" },
    });
    expect(onOpenSession).toHaveBeenCalledTimes(2);
  });

  it("shows dimension breakdown diagnostics and respects weighted case pass verdicts", async () => {
    harness.listEvaluators.mockResolvedValue([
      { id: "brief", name: "简洁检查", kind: "llm_judge", threshold: 0.75, enabled: true, dimension: "简洁性", createdAt: 1, updatedAt: 1 },
    ]);
    harness.getRun.mockResolvedValue({
      ...graphRun(),
      coverage: 0.75,
      dimensions: [{ dimension: "简洁性", score: 0.4, weight: 1, scoredCaseCount: 1 }],
      results: [{
        ...graphRun().results[0]!,
        unscoredReason: undefined,
        score: 0.8,
        passed: true,
        dimensions: [{ dimension: "简洁性", score: 0.4, weight: 1, decided: 1, undecided: 0, met: 0, unmet: 1 }],
        scores: [
          { evaluatorId: "correct", score: 1, passed: true, durationMs: 1 },
          { evaluatorId: "brief", dimension: "简洁性", score: 0.4, passed: false, reason: "重复解释了同一段背景", durationMs: 1 },
        ],
      }],
    } satisfies EvaluationRun);

    await render();
    expect(container.querySelector(".eval-graph-case header .eval-badge")?.textContent).toBe("通过");

    const conciseCard = [...container.querySelectorAll<HTMLButtonElement>("button.eval-dimension-card")]
      .find((item) => item.textContent?.includes("简洁性"))!;
    await act(async () => { conciseCard.click(); });
    expect(container.querySelector(".eval-dimension-diagnostics")?.textContent).toContain("重复解释了同一段背景");
  });

  it("requires confirmation to delete a run, clears selection after deletion, and reports errors", async () => {
    const deleteBtn = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.getAttribute("aria-label") === "删除运行")!;

    harness.confirm.mockReturnValueOnce(false).mockReturnValue(true);
    await render();
    await act(async () => { deleteBtn().click(); });
    expect(harness.deleteRun).not.toHaveBeenCalled();

    harness.deleteRun.mockRejectedValueOnce(new Error("run is still being written"));
    await act(async () => { deleteBtn().click(); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("run is still being written");

    harness.listRuns.mockResolvedValueOnce({ items: [], total: 0, offset: 0, limit: 50 });
    const fetchCountBefore = harness.getRun.mock.calls.length;
    await act(async () => { deleteBtn().click(); });
    expect(harness.deleteRun).toHaveBeenCalledWith("run-1");
    expect(harness.getRun.mock.calls.length).toBe(fetchCountBefore);
  });
});
