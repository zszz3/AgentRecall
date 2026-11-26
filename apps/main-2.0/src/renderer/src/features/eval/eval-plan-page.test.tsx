// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationEvaluator, EvaluationExperiment } from "../../../../automation/contracts";
import { EvalPlanPage } from "./eval-plan-page";

const harness = vi.hoisted(() => ({
  listExperiments: vi.fn(),
  listDatasets: vi.fn(),
  listEvaluators: vi.fn(),
  listRuns: vi.fn(),
  getSnapshot: vi.fn(),
  listSkills: vi.fn(),
  saveExperiment: vi.fn(),
  deleteExperiment: vi.fn(),
  runExperiment: vi.fn(),
  importFolder: vi.fn(),
  saveEvaluator: vi.fn(),
  deleteEvaluator: vi.fn(),
  confirm: vi.fn(),
}));

function plan(overrides: Partial<EvaluationExperiment> = {}): EvaluationExperiment {
  return {
    id: "plan-1",
    name: "中文写作质量",
    datasetId: "dataset-1",
    agentId: "agent-1",
    evaluatorIds: ["rubric", "brief"],
    repetitions: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function check(overrides: Record<string, unknown>) {
  return {
    name: String(overrides.id),
    kind: "contains",
    threshold: 0.6,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function checks() {
  return [
    check({ id: "rubric", name: "语言自然", kind: "llm_judge", dimension: "正确性" }),
    check({ id: "conclusion", name: "必须含结论", kind: "script", scriptMode: "inline_js", script: "return 1;", dimension: "正确性" }),
    check({ id: "brief", name: "简洁", kind: "script", scriptMode: "inline_js", script: "return 1;", dimension: "简洁性" }),
    check({ id: "tools", name: "工具失败", kind: "tool_failures", dimension: "效率" }),
  ];
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  harness.listExperiments.mockReset().mockResolvedValue([plan()]);
  harness.listDatasets.mockReset().mockResolvedValue([{
    id: "dataset-1",
    name: "写作用例",
    description: "",
    items: [{ id: "case-0", input: "case 0", metadata: {}, sequence: 0 }],
    createdAt: 1,
    updatedAt: 1,
  }]);
  harness.listEvaluators.mockReset().mockResolvedValue(checks());
  harness.listRuns.mockReset().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 12 });
  harness.getSnapshot.mockReset().mockResolvedValue({
    configuredAgents: [{ id: "agent-1", name: "Claude Code" }],
    channels: [{ id: "channel-1", label: "Sonnet", agentId: "agent-1" }],
  });
  harness.listSkills.mockReset().mockResolvedValue({ skills: [{ name: "review" }] });
  harness.saveExperiment.mockReset().mockImplementation(async (value: EvaluationExperiment) => value);
  harness.deleteExperiment.mockReset().mockResolvedValue(true);
  harness.runExperiment.mockReset().mockResolvedValue({ id: "run-1" });
  harness.importFolder.mockReset();
  harness.saveEvaluator.mockReset().mockImplementation(async (value: EvaluationEvaluator) => value);
  harness.deleteEvaluator.mockReset().mockResolvedValue(true);
  harness.confirm.mockReset().mockReturnValue(true);
  Object.assign(window, {
    confirm: harness.confirm,
    sessionSearch: {
      listSkills: harness.listSkills,
      automation: {
        listEvaluationExperiments: harness.listExperiments,
        listEvaluationDatasets: harness.listDatasets,
        listEvaluationEvaluators: harness.listEvaluators,
        listEvaluationRuns: harness.listRuns,
        saveEvaluationExperiment: harness.saveExperiment,
        deleteEvaluationExperiment: harness.deleteExperiment,
        runEvaluationExperiment: harness.runExperiment,
        importEvaluationDatasetFolder: harness.importFolder,
        saveEvaluationEvaluator: harness.saveEvaluator,
        deleteEvaluationEvaluator: harness.deleteEvaluator,
        getSnapshot: harness.getSnapshot,
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

let renderSeq = 0;

async function render(onOpenRuns = vi.fn()): Promise<{ onOpenRuns: typeof onOpenRuns }> {
  renderSeq += 1;
  await act(async () => {
    root.render(createElement(EvalPlanPage, { key: renderSeq, language: "zh", onOpenRuns }));
  });
  return { onOpenRuns };
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function dimensionRow(name: string): HTMLElement {
  const found = [...container.querySelectorAll(".eval-plan-dimensions > li")]
    .find((item) => item.querySelector(".eval-plan-dimension-name")?.textContent === name);
  if (!found) throw new Error(`dimension not found: ${name}`);
  return found as HTMLElement;
}

function field(label: string): HTMLSelectElement | HTMLInputElement {
  const row = [...container.querySelectorAll(".eval-field")]
    .find((item) => item.querySelector(".eval-field-title")?.textContent?.includes(label));
  if (!row) throw new Error(`field not found: ${label}`);
  return row.querySelector("select, input") as HTMLSelectElement | HTMLInputElement;
}

async function setValue(control: Element, value: string): Promise<void> {
  const select = control instanceof window.HTMLSelectElement;
  const textarea = control instanceof window.HTMLTextAreaElement;
  await act(async () => {
    const prototype = select
      ? window.HTMLSelectElement.prototype
      : textarea
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(new window.Event(select ? "change" : "input", { bubbles: true }));
  });
}

describe("EvalPlanPage", () => {
  it("toggles dimensions, saves scoring weights/rules, and runs after saving", async () => {
    const { onOpenRuns } = await render();

    expect([...container.querySelectorAll(".eval-plan-dimension-name")].map((item) => item.textContent))
      .toEqual(["正确性", "简洁性"]);

    await act(async () => {
      (container.querySelector(".eval-plan-others-toggle") as HTMLButtonElement).click();
    });
    await act(async () => {
      (dimensionRow("效率").querySelector("input[type=checkbox]") as HTMLInputElement).click();
    });
    await setValue(dimensionRow("正确性").querySelector(".eval-plan-weight input")!, "4");
    await setValue(field("通过分数线"), "0.8");
    await setValue(field("最低覆盖率"), "0.5");
    await setValue(field("判不出来的"), "zero");

    await act(async () => {
      button("跑一次").click();
    });

    expect(harness.saveExperiment).toHaveBeenCalledTimes(1);
    expect(harness.saveExperiment.mock.calls[0]![0]).toMatchObject({
      evaluatorIds: expect.arrayContaining(["rubric", "brief", "tools"]),
      scoring: {
        weightByLabels: { dimension: { 正确性: 4 } },
        resolvedThreshold: 0.8,
        minCoverage: 0.5,
        uncertain: "zero",
      },
    });
    expect(harness.runExperiment).toHaveBeenCalledWith("plan-1");
    expect(onOpenRuns).toHaveBeenCalled();
  });

  it("edits and deletes custom checks from the plan dialog while keeping built-ins read-only", async () => {
    await render();

    await act(async () => {
      (dimensionRow("正确性").querySelector('[aria-label="查看检查"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (dimensionRow("正确性").querySelector(".eval-plan-check-row") as HTMLButtonElement).click();
    });
    const dialog = container.querySelector('[role="dialog"]')!;
    await setValue(dialog.querySelector("textarea")!, "判断语言是否自然");
    await act(async () => {
      ([...dialog.querySelectorAll("button")].find((item) => item.textContent === "保存") as HTMLButtonElement).click();
    });
    expect(harness.saveEvaluator.mock.calls[0]![0]).toMatchObject({ id: "rubric", prompt: "判断语言是否自然" });

    await act(async () => {
      (dimensionRow("简洁性").querySelector('[aria-label="查看检查"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (dimensionRow("简洁性").querySelector(".eval-plan-check-row") as HTMLButtonElement).click();
    });
    await act(async () => {
      ([...container.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent?.includes("删除")) as HTMLButtonElement).click();
    });
    expect(harness.deleteEvaluator).toHaveBeenCalledWith("brief");

    harness.listEvaluators.mockResolvedValue([
      check({ id: "builtin-judge-format", name: "格式", kind: "json_valid", dimension: "格式" }),
    ]);
    harness.listExperiments.mockResolvedValue([plan({ evaluatorIds: ["builtin-judge-format"] })]);
    await render();
    await act(async () => {
      (dimensionRow("格式").querySelector('[aria-label="查看检查"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (dimensionRow("格式").querySelector(".eval-plan-check-row") as HTMLButtonElement).click();
    });
    const builtinDialog = container.querySelector('[role="dialog"]')!;
    expect(([...builtinDialog.querySelectorAll("button")].find((item) => item.textContent === "保存") as HTMLButtonElement).disabled).toBe(true);
    expect([...builtinDialog.querySelectorAll("button")].some((item) => item.textContent?.includes("删除"))).toBe(false);
  });

  it("blocks running incomplete plans, confirms run-count deletion, and reports load errors", async () => {
    harness.listExperiments.mockResolvedValue([plan({ agentId: "", evaluatorIds: [] })]);
    await render();
    expect(button("跑一次").disabled).toBe(true);

    harness.listExperiments.mockResolvedValue([plan()]);
    harness.listRuns.mockResolvedValue({ items: [], total: 7, offset: 0, limit: 12 });
    await render();
    await act(async () => {
      (container.querySelector('[aria-label="删除方案"]') as HTMLButtonElement).click();
    });
    expect(harness.confirm.mock.calls[0]![0]).toContain("7 次运行");
    expect(harness.deleteExperiment).toHaveBeenCalledWith("plan-1");

    harness.listExperiments.mockRejectedValue(new Error("database is not ready"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("database is not ready");
  });
});
