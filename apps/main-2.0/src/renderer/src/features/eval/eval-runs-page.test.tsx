// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EvaluationExperiment,
  EvaluationRun,
  EvaluationRunSummary,
} from "../../../../automation/contracts";
import { EvalRunsPage } from "./eval-runs-page";

const harness = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  deleteRun: vi.fn(),
  listExperiments: vi.fn(),
  listEvaluators: vi.fn(),
  confirm: vi.fn(),
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
          {
            nodeId: "agent",
            nodeType: "run_agent",
            nodeVersion: 1,
            role: "prepare",
            status: "pass",
            durationMs: 10,
          },
          {
            nodeId: "judge-broken",
            nodeType: "llm_judge",
            nodeVersion: 1,
            role: "judge",
            status: "excused",
            attribution: { type: "infra_failure", reason: "judge_runtime_not_configured" },
          },
          {
            nodeId: "skill-use",
            nodeType: "skill_use_observe",
            nodeVersion: 1,
            role: "prepare",
            status: "pass",
            facts: { injected: true, skillName: "review", skillHash: "h1", observable: false, used: null },
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
  harness.listRuns.mockReset();
  harness.getRun.mockReset();
  harness.listExperiments.mockReset();
  harness.listExperiments.mockResolvedValue([experiment()]);
  harness.listEvaluators.mockReset().mockResolvedValue([]);
  harness.deleteRun.mockReset().mockResolvedValue(true);
  harness.confirm.mockReset().mockReturnValue(true);
  Object.assign(window, {
    confirm: harness.confirm,
    sessionSearch: {
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

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(EvalRunsPage, { language: "zh", onOpenSession: () => undefined }));
  });
}

describe("EvalRunsPage", () => {
  it("opens an explicitly requested run even when it is older than the listed page", async () => {
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 51, offset: 0, limit: 50 });
    harness.getRun.mockImplementation(async (runId: string) => ({
      ...graphRun(),
      id: runId,
      startedAt: 99,
    }));
    const onInitialRunConsumed = vi.fn();

    await act(async () => {
      root.render(createElement(EvalRunsPage, {
        language: "zh",
        onOpenSession: () => undefined,
        initialRunId: "run-older",
        onInitialRunConsumed,
      }));
    });

    await vi.waitFor(() => expect(harness.getRun).toHaveBeenCalledWith("run-older"));
    expect(onInitialRunConsumed).toHaveBeenCalledOnce();
  });

  it("groups each task's runs under an independently collapsible heading", async () => {
    harness.listExperiments.mockResolvedValue([
      experiment(),
      experiment({ id: "experiment-2", name: "Writing regression" }),
      experiment({ id: "experiment-3", name: "Empty task" }),
    ]);
    harness.listRuns.mockImplementation((input: { experimentId?: string }) => {
      if (input.experimentId === "experiment-1") {
        return Promise.resolve({
          items: [
            summary({ id: "run-2", startedAt: 30 }),
            summary({ id: "run-1", startedAt: 20 }),
          ],
          total: 2,
          offset: 0,
          limit: 50,
        });
      }
      if (input.experimentId === "experiment-2") {
        return Promise.resolve({
          items: [summary({ id: "run-3", experimentId: "experiment-2", startedAt: 10 })],
          total: 1,
          offset: 0,
          limit: 50,
        });
      }
      return Promise.resolve({ items: [], total: 0, offset: 0, limit: 50 });
    });
    harness.getRun.mockResolvedValue(graphRun());

    await render();

    expect(harness.listRuns.mock.calls.map(([input]) => input.experimentId)).toEqual([
      "experiment-1",
      "experiment-2",
      "experiment-3",
    ]);
    const login = container.querySelector('[data-eval-task-id="experiment-1"]')!;
    const writing = container.querySelector('[data-eval-task-id="experiment-2"]')!;
    const empty = container.querySelector('[data-eval-task-id="experiment-3"]')!;
    expect(login.querySelector(".eval-run-task-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(writing.querySelector(".eval-run-task-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(login.textContent).toContain("2 次");
    expect(empty.textContent).toContain("0 次");
    expect(container.querySelector('[data-eval-run-id="run-2"]')).not.toBeNull();
    expect(container.querySelector('[data-eval-run-id="run-3"]')).toBeNull();

    await act(async () => {
      (writing.querySelector(".eval-run-task-toggle") as HTMLButtonElement).click();
      (empty.querySelector(".eval-run-task-toggle") as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-eval-run-id="run-3"]')).not.toBeNull();
    expect(empty.textContent).toContain("还没有运行记录");

    await act(async () => {
      (login.querySelector(".eval-run-task-toggle") as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-eval-run-id="run-2"]')).toBeNull();
    expect(writing.querySelector(".eval-run-task-toggle")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows each step of the selected run with the reason it produced nothing", async () => {
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue(graphRun());

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("Login regression");
    expect(text).toContain("跑模型");
    expect(text).toContain("模型评判");
    // The judge could not decide, and the copy must say so rather than showing a zero.
    expect(text).toContain("无法判定");
    expect(text).toContain("评判器未配置 Runtime 通道");
    expect(text).toContain("未评分");
    // Skill use is unobservable here, which must not read as "went unused".
    expect(text).toContain("无法观测是否使用");
    expect(text).not.toContain("未使用该 Skill");
  });

  it("explains that a run recorded before the graph engine has no steps", async () => {
    harness.listRuns.mockResolvedValue({
      items: [summary({ engine: undefined })],
      total: 1,
      offset: 0,
      limit: 50,
    });
    harness.getRun.mockResolvedValue({
      id: "run-1",
      experimentId: "experiment-1",
      status: "completed",
      startedAt: 1,
      passRate: 1,
      results: [],
    } satisfies EvaluationRun);

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("这次运行早于执行图");
    expect(text).toContain("旧格式");
  });

  it("reports a load failure instead of rendering an empty page", async () => {
    harness.listRuns.mockRejectedValue(new Error("database is not ready"));

    await render();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("database is not ready");
  });
  it("shows the score broken down by dimension, not one opaque number", async () => {
    harness.listEvaluators.mockResolvedValue([
      {
        id: "correct",
        name: "事实检查",
        kind: "llm_judge",
        threshold: 0.75,
        enabled: true,
        dimension: "正确性",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "brief",
        name: "简洁检查",
        kind: "llm_judge",
        threshold: 0.75,
        enabled: true,
        dimension: "简洁性",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue({
      ...graphRun(),
      coverage: 0.75,
      dimensions: [
        { dimension: "正确性", score: 0.9, weight: 4, scoredCaseCount: 2 },
        { dimension: "简洁性", score: 0.4, weight: 1, scoredCaseCount: 2 },
      ],
      results: [{
        ...graphRun().results[0]!,
        unscoredReason: undefined,
        score: 0.8,
        passed: true,
        coverage: 0.5,
        dimensions: [
          { dimension: "正确性", score: 0.9, weight: 4, decided: 1, undecided: 0, met: 1, unmet: 0 },
          { dimension: "简洁性", score: 0.4, weight: 1, decided: 1, undecided: 1, met: 0, unmet: 1 },
        ],
        scores: [
          {
            evaluatorId: "correct",
            dimension: "正确性",
            score: 0.9,
            passed: true,
            reason: "关键事实与材料一致",
            evidence: ["引用了事务提交点"],
            durationMs: 1,
          },
          {
            evaluatorId: "brief",
            dimension: "简洁性",
            score: 0.4,
            passed: false,
            reason: "重复解释了同一段背景",
            evidence: ["第二、三段含义重复"],
            failedCriteria: ["删除不影响理解的重复内容"],
            durationMs: 1,
          },
        ],
        byLabel: { dimension: { 正确性: 0.9, 简洁性: 0.4 } },
        skippedEvaluatorIds: ["tool-failures"],
      }],
    } satisfies EvaluationRun);

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("正确性");
    expect(text).toContain("简洁性");
    expect(text).toContain("覆盖率");
    expect(text).toContain("0.80");
    // A judge this source could not run has to stay visible rather than looking
    // like a check that passed.
    expect(text).toContain("不适用于该产物来源");
    expect(text).toContain("tool-failures");

    const conciseCard = [...container.querySelectorAll("button.eval-dimension-card")]
      .find((item) => item.textContent?.includes("简洁性")) as HTMLButtonElement;
    expect(conciseCard.textContent).toContain("点击查看原因");
    await act(async () => {
      conciseCard.click();
    });

    const diagnosis = container.querySelector(".eval-dimension-diagnostics")!;
    expect(conciseCard.getAttribute("aria-pressed")).toBe("true");
    expect(diagnosis.textContent).toContain("简洁检查");
    expect(diagnosis.textContent).toContain("重复解释了同一段背景");
    expect(diagnosis.textContent).toContain("删除不影响理解的重复内容");
    expect(diagnosis.textContent).toContain("第二、三段含义重复");
  });

  it("explains an undecided dimension from the stored run and node reason", async () => {
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue({
      ...graphRun(),
      dimensions: [{ dimension: "正确性", score: null, weight: 1, scoredCaseCount: 0 }],
      results: [{
        ...graphRun().results[0]!,
        dimensions: [{
          dimension: "正确性",
          score: null,
          weight: 1,
          decided: 0,
          undecided: 1,
          met: 0,
          unmet: 0,
        }],
      }],
    } satisfies EvaluationRun);

    await render();
    await act(async () => {
      (container.querySelector("button.eval-dimension-card") as HTMLButtonElement).click();
    });

    const diagnosis = container.querySelector(".eval-dimension-diagnostics")!;
    expect(diagnosis.textContent).toContain("这个维度没有得出分数");
    expect(diagnosis.textContent).toContain("评判器未配置 Runtime 通道");
  });

  it("calls a case passed on its weighted score, not on every check passing", async () => {
    // A case can clear its threshold with one check unmet; reading "all checks
    // passed" would contradict the score printed beside it.
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue({
      ...graphRun(),
      results: [{
        ...graphRun().results[0]!,
        unscoredReason: undefined,
        score: 0.8,
        passed: true,
        scores: [
          { evaluatorId: "correct", score: 1, passed: true, durationMs: 1 },
          { evaluatorId: "brief", score: 0, passed: false, durationMs: 1 },
        ],
      }],
    } satisfies EvaluationRun);

    await render();

    expect(container.querySelector(".eval-graph-case header .eval-badge")?.textContent)
      .toBe("通过");
  });
});

describe("EvalRunsPage deletion", () => {
  function deleteButton(): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")]
      .find((item) => item.getAttribute("aria-label") === "删除运行");
    if (!found) throw new Error("delete button was not rendered");
    return found as HTMLButtonElement;
  }

  it("deletes a run and says what goes with it", async () => {
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue(graphRun());
    await render();

    await act(async () => {
      deleteButton().click();
    });

    expect(harness.confirm.mock.calls[0]![0]).toContain("逐用例记录会一起删除");
    expect(harness.deleteRun).toHaveBeenCalledWith("run-1");
  });

  it("keeps the run when the confirmation is declined", async () => {
    harness.confirm.mockReturnValue(false);
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue(graphRun());
    await render();

    await act(async () => {
      deleteButton().click();
    });

    expect(harness.deleteRun).not.toHaveBeenCalled();
  });

  it("stops asking for a run it just deleted", async () => {
    harness.listRuns
      .mockResolvedValueOnce({ items: [summary()], total: 1, offset: 0, limit: 50 })
      .mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue(graphRun());
    await render();
    const before = harness.getRun.mock.calls.length;

    await act(async () => {
      deleteButton().click();
    });

    // Selection cleared, so the detail pane does not fetch a row that is gone.
    expect(harness.getRun.mock.calls.length).toBe(before);
    expect(container.textContent).toContain("选择一次运行");
  });

  it("reports a failed deletion instead of looking like it worked", async () => {
    harness.deleteRun.mockRejectedValue(new Error("run is still being written"));
    harness.listRuns.mockResolvedValue({ items: [summary()], total: 1, offset: 0, limit: 50 });
    harness.getRun.mockResolvedValue(graphRun());
    await render();

    await act(async () => {
      deleteButton().click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("run is still being written");
  });
});
