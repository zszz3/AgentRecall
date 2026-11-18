// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultAgentModelConfig } from "../../../../core/agent-model-config";
import type { AppSettings } from "../../../../core/platform";
import type { MemoryCard } from "../../../../shared/ipc/experience-cards";
import { MemoryPage } from "./memory-page";

const card: MemoryCard = {
  id: "card-1",
  projectPath: "/repo/app",
  kind: "experience",
  problem: "PGlite 参数类型推断失败",
  solution: "显式写 $2::integer",
  previousSolution: null,
  failedAttempts: ["改用字符串"],
  keywords: ["pglite"],
  status: "active",
  supersededBy: null,
  model: "m",
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
  sources: [{ sessionKey: "codex:abc", firstTurnIndex: 2, lastTurnIndex: 4, lastTurnAt: "2026-11-15T08:00:00.000Z" }],
};

const status = {
  activeCards: 1,
  supersededCards: 0,
  processedSessions: 3,
  processedToday: 1,
  inputTokens: null,
  outputTokens: null,
  failures: [{ sessionKey: "claude:x", title: "失败的会话", attempts: 5, nextRetryAt: null, lastError: "bad json" }],
  running: false,
  lastRunError: null,
};

const deepseek = { ...defaultAgentModelConfig, provider: "deepseek", model: "deepseek-v4-pro" };

describe("MemoryPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function install(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
    const api = {
      getExperienceCardStatus: vi.fn(async () => status),
      listExperienceCards: vi.fn(async () => [card]),
      editExperienceCard: vi.fn(async (_id: string, edit: Partial<MemoryCard>) => ({ ...card, ...edit })),
      deleteExperienceCard: vi.fn(async () => undefined),
      retryExperienceExtraction: vi.fn(async () => undefined),
      ...overrides,
    };
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: api });
    return api as Record<string, ReturnType<typeof vi.fn>>;
  }

  async function render(settings: Partial<AppSettings>, extra: Record<string, unknown> = {}): Promise<void> {
    await act(async () => root.render(createElement(MemoryPage, {
      language: "zh",
      settings: { experienceCardsEnabled: false, agentModel: defaultAgentModelConfig, experienceCardsEnabledAt: "", ...settings } as AppSettings,
      onSettingsChange: vi.fn(async () => undefined),
      onOpenAgentModel: vi.fn(),
      onViewSource: vi.fn(),
      ...extra,
    })));
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label);
  }

  it("refuses to turn extraction on until the AgentRecall model is set up and links to its setup", async () => {
    install();
    const onSettingsChange = vi.fn(async () => undefined);
    const onOpenAgentModel = vi.fn();
    await render({}, { onSettingsChange, onOpenAgentModel });

    const toggle = container.querySelector<HTMLInputElement>("input[role=switch]");
    await act(async () => toggle?.click());

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("请先设置 AgentRecall 模型");
    expect(container.textContent).toContain("尚未设置");
    await act(async () => button("去设置")?.click());
    expect(onOpenAgentModel).toHaveBeenCalledOnce();
  });

  it("names the model in use and shows unknown tokens", async () => {
    install();
    const onSettingsChange = vi.fn(async () => undefined);
    await render({ agentModel: deepseek }, { onSettingsChange });

    expect(container.textContent).toContain("deepseek · deepseek-v4-pro");
    expect(container.textContent).toContain("未知 / 未知");
    expect(container.textContent).toContain("多次失败后已停止");
    await act(async () => container.querySelector<HTMLInputElement>("input[role=switch]")?.click());
    expect(onSettingsChange).toHaveBeenCalledWith({ experienceCardsEnabled: true });
  });

  it("groups cards by project, opens the dated source Turn and retries a failed Session", async () => {
    const api = install();
    const onViewSource = vi.fn();
    await render({ agentModel: deepseek }, { onViewSource });

    expect(container.querySelector("section[aria-label='/repo/app']")?.textContent).toContain("PGlite 参数类型推断失败");
    expect(button("来源")?.textContent).toBe(`来源 · 第 3–5 轮 · ${new Date("2026-11-15T08:00:00.000Z").toLocaleDateString()}`);
    await act(async () => button("来源")?.click());
    expect(onViewSource).toHaveBeenCalledWith("codex:abc", 2);

    const retry = [...container.querySelectorAll<HTMLButtonElement>(".memory-failures li button")][0];
    await act(async () => retry?.click());
    expect(api.retryExperienceExtraction).toHaveBeenCalledWith("claude:x");
  });

  it("includes superseded cards only when asked", async () => {
    const api = install();
    await render({});
    expect(api.listExperienceCards).toHaveBeenLastCalledWith({ query: "", includeSuperseded: false });

    const checkbox = [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
      .find((input) => input.parentElement?.textContent?.includes("已被取代"));
    await act(async () => checkbox?.click());
    expect(api.listExperienceCards).toHaveBeenLastCalledWith({ query: "", includeSuperseded: true });
  });

  it("keeps only the latest list response", async () => {
    const resolvers: Array<(cards: MemoryCard[]) => void> = [];
    install({ listExperienceCards: vi.fn(() => new Promise((resolve) => { resolvers.push(resolve); })) });
    await render({});
    const checkbox = [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
      .find((input) => input.parentElement?.textContent?.includes("已被取代"));
    await act(async () => checkbox?.click());

    await act(async () => resolvers[1]?.([]));
    await act(async () => resolvers[0]?.([card]));

    expect(container.textContent).not.toContain("PGlite 参数类型推断失败");
  });

  it("edits a card and deletes only after confirmation", async () => {
    const api = install();
    await render({});

    await act(async () => button("编辑卡片")?.click());
    const solution = [...container.querySelectorAll("label")].find((label) => label.textContent?.startsWith("做法"))?.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(solution, "新做法");
      solution?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("保存")?.click());
    expect(api.editExperienceCard).toHaveBeenCalledWith("card-1", expect.objectContaining({ solution: "新做法", keywords: ["pglite"] }));
    expect(container.textContent).toContain("新做法");

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    await act(async () => button("删除卡片")?.click());
    expect(api.deleteExperienceCard).not.toHaveBeenCalled();
    await act(async () => button("删除卡片")?.click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(api.deleteExperienceCard).toHaveBeenCalledWith("card-1");
    expect(container.textContent).not.toContain("PGlite 参数类型推断失败");
  });
});
