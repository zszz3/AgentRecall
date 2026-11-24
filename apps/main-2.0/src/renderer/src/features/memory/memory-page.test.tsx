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
    // Node 26 exposes an undefined localStorage global that shadows happy-dom's; the list pane stores its width there.
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    container.remove();
    vi.restoreAllMocks();
  });

  function install(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
    const api = {
      getExperienceCardStatus: vi.fn(async () => status),
      listExperienceCards: vi.fn(async () => [card]),
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

  function menuItem(label: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.querySelector("span")?.textContent === label);
  }

  it("refuses to turn extraction on until the AgentRecall model is set up and links to its setup", async () => {
    install();
    const onSettingsChange = vi.fn(async () => undefined);
    const onOpenAgentModel = vi.fn();
    await render({}, { onSettingsChange, onOpenAgentModel });

    const toggle = container.querySelector<HTMLButtonElement>(".catalog-head button[role=switch]");
    await act(async () => toggle?.click());

    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("请先在「网关」中设置模型服务");
    await act(async () => button("设置模型")?.click());
    expect(onOpenAgentModel).toHaveBeenCalledOnce();
  });

  it("allows turning extraction on when a Gateway model label is available", async () => {
    install();
    const onSettingsChange = vi.fn(async () => undefined);
    await render({}, { onSettingsChange, gatewayModelLabel: "DeepSeek · deepseek-chat" });

    const head = container.querySelector(".catalog-head")!;
    expect(head.textContent).toContain("DeepSeek · deepseek-chat");
    await act(async () => head.querySelector<HTMLButtonElement>("button[role=switch]")?.click());
    expect(onSettingsChange).toHaveBeenCalledWith({ experienceCardsEnabled: true });
  });

  it("keeps the extraction switch, model and progress in the header", async () => {
    install();
    const onSettingsChange = vi.fn(async () => undefined);
    await render({ agentModel: deepseek }, { onSettingsChange });

    const head = container.querySelector(".catalog-head")!;
    expect(head.textContent).toContain("deepseek · deepseek-v4-pro");
    expect(head.textContent).toContain("1 张经验卡 · 1 个项目");
    expect(container.querySelector(".memory-status")?.textContent).toContain("Token 未知 / 未知");
    expect(container.querySelector(".memory-failures summary")?.textContent).toContain("1 个会话处理失败");
    expect(container.textContent).toContain("多次失败后已停止");
    await act(async () => head.querySelector<HTMLButtonElement>("button[role=switch]")?.click());
    expect(onSettingsChange).toHaveBeenCalledWith({ experienceCardsEnabled: true });
  });

  it("lists cards by project and shows the selected card read-only with its dated source Turns", async () => {
    const api = install();
    const onViewSource = vi.fn();
    await render({ agentModel: deepseek }, { onViewSource });

    expect(container.querySelector("section[aria-label='app']")?.textContent).toContain("PGlite 参数类型推断失败");
    const detail = container.querySelector(".catalog-detail")!;
    expect(detail.textContent).toContain("显式写 $2::integer");
    expect(detail.textContent).toContain("改用字符串");
    expect(container.querySelector("textarea")).toBeNull();
    expect(button("编辑卡片")).toBeUndefined();

    const source = detail.querySelector<HTMLButtonElement>(".memory-source")!;
    expect(source.textContent).toBe(`第 3–5 轮 · ${new Date("2026-11-15T08:00:00.000Z").toLocaleDateString()}`);
    await act(async () => source.click());
    expect(onViewSource).toHaveBeenCalledWith("codex:abc", 2);

    const retry = [...container.querySelectorAll<HTMLButtonElement>(".memory-failures li button")][0];
    await act(async () => retry?.click());
    expect(api.retryExperienceExtraction).toHaveBeenCalledWith("claude:x");
  });

  it("searches cards and includes superseded cards only when asked", async () => {
    const api = install();
    await render({});
    expect(api.listExperienceCards).toHaveBeenLastCalledWith({ query: "", includeSuperseded: false });

    await act(async () => button("更多")?.click());
    await act(async () => menuItem("显示已被取代的卡片")?.click());
    expect(api.listExperienceCards).toHaveBeenLastCalledWith({ query: "", includeSuperseded: true });

    const search = container.querySelector<HTMLInputElement>(".catalog-search input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => { setter?.call(search, "pglite"); search.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(api.listExperienceCards).toHaveBeenLastCalledWith({ query: "pglite", includeSuperseded: true });
  });

  it("keeps only the latest list response", async () => {
    const resolvers: Array<(cards: MemoryCard[]) => void> = [];
    install({ listExperienceCards: vi.fn(() => new Promise((resolve) => { resolvers.push(resolve); })) });
    await render({});
    await act(async () => button("更多")?.click());
    await act(async () => menuItem("显示已被取代的卡片")?.click());

    await act(async () => resolvers[1]?.([]));
    await act(async () => resolvers[0]?.([card]));

    expect(container.textContent).not.toContain("PGlite 参数类型推断失败");
  });

  it("deletes a card only after confirmation", async () => {
    const api = install();
    await render({});

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    await act(async () => button("删除卡片")?.click());
    expect(api.deleteExperienceCard).not.toHaveBeenCalled();
    await act(async () => button("删除卡片")?.click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(api.deleteExperienceCard).toHaveBeenCalledWith("card-1");
    expect(container.textContent).not.toContain("PGlite 参数类型推断失败");
  });

  it("promotes a card into a new library Skill", async () => {
    const api = install({ createLibrarySkill: vi.fn(async (draft: { id: string }) => ({ status: draft.id === "taken" ? "conflict" : "imported", managedId: draft.id })) });
    await render({});

    await act(async () => button("提升为 Skill")?.click());
    const form = container.querySelector<HTMLFormElement>(".memory-skill-form")!;
    const id = form.querySelector<HTMLInputElement>('input[name="skill-id"]')!;
    expect(id.value).toBe("pglite");
    expect(form.querySelector<HTMLInputElement>('input[name="skill-description"]')!.value).toBe("PGlite 参数类型推断失败");
    expect(form.querySelector("textarea")!.value).toBe("# PGlite 参数类型推断失败\n\n显式写 $2::integer\n\n## 试过无效\n\n- 改用字符串");

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => { setter?.call(id, "taken"); id.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => button("加入 Skill 库")?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Skill 库里已经有另一个「taken」，请换一个标识。");
    expect(container.querySelector(".memory-skill-form")).not.toBeNull();

    await act(async () => { setter?.call(id, "pglite-casts"); id.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => button("加入 Skill 库")?.click());
    expect(api.createLibrarySkill).toHaveBeenLastCalledWith({ id: "pglite-casts", description: "PGlite 参数类型推断失败", body: expect.stringContaining("显式写 $2::integer") });
    expect(container.textContent).toContain("已把「pglite-casts」加入 Skill 库");
    expect(container.querySelector(".memory-skill-form")).toBeNull();
  });
});
