// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillEvalDetail, SkillEvalOverview, SkillEvalOverviewItem } from "../../../../main/services/skill-service";
import { EvalPage } from "./eval-page";

const harness = vi.hoisted(() => ({
  refreshSkillUsage: vi.fn(),
  getSkillEvalOverview: vi.fn(),
  getSkillEvalDetail: vi.fn(),
  listSkillTriggers: vi.fn(),
  getSkillEvalFindings: vi.fn(),
  listSkillEvalSuites: vi.fn(),
  listDatasets: vi.fn(),
  listExperiments: vi.fn(),
}));

function skill(name: string): SkillEvalOverviewItem {
  return {
    skill: name,
    agent: "claude",
    installed: true,
    totalTriggers: 2,
    triggers7d: 1,
    triggers30d: 2,
    lastTriggeredAt: null,
    linkedTriggers: 2,
    observation: "exercised",
  };
}

function detail(name: string): SkillEvalDetail {
  return {
    skill: name,
    signals: {
      sampleSize: 0,
      medianTotalTokens: null,
      medianDurationMs: null,
      errorTurnRatio: null,
      baselineTurnCount: 0,
      baselineMedianTotalTokens: null,
      baselineMedianDurationMs: null,
      baselineErrorTurnRatio: null,
    },
    versions: [],
    currentHash: null,
    remoteVersion: null,
  };
}

const overview: SkillEvalOverview = {
  hookInstalled: true,
  claudeHookObservable: true,
  skills: [skill("alpha"), skill("Beta")],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  harness.refreshSkillUsage.mockReset().mockResolvedValue(undefined);
  harness.getSkillEvalOverview.mockReset().mockResolvedValue(overview);
  harness.getSkillEvalDetail.mockReset().mockImplementation(async (name: string) => detail(name));
  harness.listSkillTriggers.mockReset().mockResolvedValue([]);
  harness.getSkillEvalFindings.mockReset().mockResolvedValue([]);
  harness.listSkillEvalSuites.mockReset().mockResolvedValue([]);
  harness.listDatasets.mockReset().mockResolvedValue([]);
  harness.listExperiments.mockReset().mockResolvedValue([]);
  Object.assign(window, {
    sessionSearch: {
      refreshSkillUsage: harness.refreshSkillUsage,
      getSkillEvalOverview: harness.getSkillEvalOverview,
      getSkillEvalDetail: harness.getSkillEvalDetail,
      listSkillTriggers: harness.listSkillTriggers,
      getSkillEvalFindings: harness.getSkillEvalFindings,
      listSkillEvalSuites: harness.listSkillEvalSuites,
      automation: {
        listEvaluationDatasets: harness.listDatasets,
        listEvaluationExperiments: harness.listExperiments,
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

async function render(props: { enabled: boolean; preselectedSkill?: string; onPreselectedConsumed?: () => void }): Promise<void> {
  await act(async () => {
    root.render(createElement(EvalPage, {
      language: "zh",
      onOpenSettings: vi.fn(),
      onOpenSession: vi.fn(),
      ...props,
    }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function selectedSkillTitle(): string | null | undefined {
  return container.querySelector(".eval-trigger-panel h3")?.textContent;
}

describe("EvalPage", () => {
  it("opens the preselected skill and keeps a later choice across tab switches without rescanning usage", async () => {
    const onPreselectedConsumed = vi.fn();
    await render({ enabled: true, preselectedSkill: "beta", onPreselectedConsumed });

    expect(selectedSkillTitle()).toBe("Beta");
    expect(onPreselectedConsumed).toHaveBeenCalledTimes(1);
    expect(harness.getSkillEvalDetail).toHaveBeenLastCalledWith("Beta");

    await act(async () => {
      button("alpha").click();
    });
    expect(selectedSkillTitle()).toBe("alpha");

    await act(async () => {
      button("数据集").click();
    });
    expect(selectedSkillTitle()).toBeUndefined();
    await act(async () => {
      button("Skill 表现").click();
    });

    expect(selectedSkillTitle()).toBe("alpha");
    expect(harness.refreshSkillUsage).toHaveBeenCalledTimes(1);
  });

  it("shows the off state without scanning skill usage while Eval is disabled", async () => {
    await render({ enabled: false });

    expect(container.textContent).toContain("Eval 默认关闭");
    expect(harness.refreshSkillUsage).not.toHaveBeenCalled();
  });
});
