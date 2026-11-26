// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSearch } from "../../../../core/store/saved-searches";
import { customDateRangeFromInputs, naturalDateRange } from "./date-presets";
import { SessionsPage, type SessionsPageActions, type SessionsPageModel } from "./sessions-page";

describe("SessionsPage search tools", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value) });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: { platform: "darwin" } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes the complete long branch label without changing the row structure", async () => {
    const model = createModel();
    const tag = "refactor/" + "frontend-storage-foundation".repeat(12);
    model.sessions[0]!.tags = ["branch:" + tag];
    await act(async () => root.render(<SessionsPage model={model} actions={createActions()} />));
    const label = container.querySelector(".row-tags .branch-tag");
    expect(label?.getAttribute("title")).toBe(tag);
    expect(label?.textContent).toBe(tag);
  });

  it("shows high-frequency filter chips by default, puts secondary filters under More, and surfaces active filters", async () => {
    const actions = createActions();
    const model = createModel();
    const project = { path: "/repo/app", label: "app", labelKind: "path" as const, labelSuffix: null, sessionCount: 2,
      environmentId: "local", environmentLabel: "Local", createdAt: 1, lastActivityAt: 1, tags: [] };
    model.sidebarTree = [{ environment: null, projects: [project] }];
    await act(async () => root.render(<SessionsPage model={model} actions={actions} />));

    expect(container.querySelector('[role="separator"]')).toBeNull();
    expect(chips(container).map((chip) => chip.textContent)).toEqual(["Project", "Agent", "Date", "More"]);
    expect(chips(container).some((chip) => chip.classList.contains("is-set"))).toBe(false);
    expect(container.querySelector(".session-filter-clear")).toBeNull();

    await act(async () => chip(container, "Project").click());
    expect(menuLabels("Project")).toEqual(["All projects", "app"]);
    await act(async () => menuItem("Project", "app").click());
    expect(actions.selectProject).toHaveBeenCalledWith(project);
    await act(async () => chip(container, "Agent").click());
    await act(async () => menuItem("Agent", "Codex").click());
    expect(actions.setSource).toHaveBeenCalledWith("codex");

    // Secondary filters live inside the More popover until active
    await act(async () => chip(container, "More").click());
    const moreDialog = container.querySelector(".session-more-menu")!;
    expect(moreDialog).toBeTruthy();
    const favoritesBtn = [...moreDialog.querySelectorAll<HTMLButtonElement>("button")].find((btn) => btn.textContent === "Favorites")!;
    await act(async () => favoritesBtn.click());
    expect(actions.setVisibility).toHaveBeenCalledWith("favorites");

    await act(async () => root.render(<SessionsPage model={{ ...model, source: "codex", visibility: "favorites", projectPath: "/repo/app", projectEnvironmentId: "local" }} actions={actions} />));
    expect(chip(container, "app").classList.contains("is-set")).toBe(true);
    expect(chip(container, "Codex").classList.contains("is-set")).toBe(true);
    expect(chip(container, "Favorites").classList.contains("is-set")).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>(".session-filter-clear")!.click());
    expect(actions.selectAllSessions).toHaveBeenCalledTimes(1);
    expect(actions.setSource).toHaveBeenLastCalledWith("all");
    expect(actions.setLiveStatus).toHaveBeenCalledWith("all");
    expect(actions.setVisibility).toHaveBeenCalledWith("default");
    expect(actions.setOrigin).toHaveBeenCalledWith("ordinary");
    expect(actions.setDateRange).toHaveBeenCalledWith("all");
  });

  it("lists AgentRecall call types under the Type filter with localized counts", async () => {
    const actions = createActions();
    const model = { ...createModel(), language: "zh" as const, origin: "agentrecall" as const };
    await act(async () => root.render(<SessionsPage model={model} actions={actions} />));

    const type = chip(container, "AgentRecall 调用");
    expect(type.classList.contains("is-set")).toBe(true);
    await act(async () => type.click());
    expect(menuLabels("类型")).toEqual([
      "普通会话 (3)", "AgentRecall 调用 (2)", "workflow (1)", "eval (0)", "chat (1)", "agent (0)", "skill (0)", "system (0)", "全部 (5)",
    ]);
    expect(document.querySelector('[role="menu"][aria-label="类型"] .ui-menu-section')?.textContent).toBe("AgentRecall 调用类型");
    await act(async () => menuItem("类型", "eval (0)").click());
    expect(actions.setInvocationSurface).toHaveBeenCalledWith("evaluation");
    expect(actions.setOrigin).toHaveBeenCalledWith("agentrecall");
  });

  it("groups Sessions by date until another grouping or order is picked from the sort menu", async () => {
    const actions = createActions();
    await act(async () => root.render(<SessionsPage model={createModel()} actions={actions} />));
    expect(container.querySelectorAll(".result-group-head")).toHaveLength(1);

    const sort = container.querySelector<HTMLButtonElement>(".session-sort")!;
    expect(sort.textContent).toBe("Smart");
    await act(async () => sort.click());
    expect(menuLabels("Sort and group")).toEqual([
      "Smart: relevance + recency", "Most recent first", "Oldest first", "By date", "By project", "By agent", "No groups",
    ]);
    expect(menuItem("Sort and group", "By date").getAttribute("aria-checked")).toBe("true");
    await act(async () => menuItem("Sort and group", "Most recent first").click());
    expect(actions.setSortBy).toHaveBeenCalledWith("activity");
    await act(async () => sort.click());
    await act(async () => menuItem("Sort and group", "No groups").click());
    expect(container.querySelector(".result-group-head")).toBeNull();
  });

  it("applies the advanced search and a saved search to the page filters", async () => {
    const savedSearch: SavedSearch = {
      id: 7,
      name: "Codex favorites",
      options: {
        query: "migration",
        source: "codex",
        origin: "agentrecall",
        tag: "important",
        visibility: "favorites",
        dateFrom: Date.parse("2026-07-01T00:00:00.000Z"),
        dateTo: Date.parse("2026-07-31T23:59:59.999Z"),
      },
      createdAt: Date.now(),
      lastUsedAt: null,
      useCount: 0,
    };
    const listSavedSearches = vi.fn(async () => [savedSearch]);
    const createSavedSearch = vi.fn(async () => savedSearch);
    const touchSavedSearch = vi.fn(async () => undefined);
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: {
        platform: "win32",
        listSavedSearches,
        createSavedSearch,
        deleteSavedSearch: vi.fn(async () => true),
        touchSavedSearch,
      },
    });

    const actions = createActions();
    const model = { ...createModel(), origin: "all" as const };
    await act(async () => root.render(<SessionsPage model={model} actions={actions} />));
    expect(container.querySelector(".toolbar-primary .searchbox")).not.toBeNull();

    const advancedButton = buttonByLabel(container, "Advanced search");
    await act(async () => advancedButton.click());
    expect(container.querySelector(".query-builder")).not.toBeNull();
    expect(container.querySelectorAll<HTMLSelectElement>(".query-builder select")[1]?.textContent)
      .toContain("important");

    const sourceSelect = container.querySelector<HTMLSelectElement>(".query-builder select");
    expect(sourceSelect).not.toBeNull();
    await act(async () => {
      if (!sourceSelect) return;
      sourceSelect.value = "codex";
      sourceSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => root.render(
      <SessionsPage model={{ ...model, sessionTotalCount: 1 }} actions={actions} />,
    ));
    expect(container.querySelector<HTMLSelectElement>(".query-builder select")?.value).toBe("codex");
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>(".query-builder-actions button")]
      .find((button) => button.textContent?.trim() === "Save");
    await act(async () => saveButton?.click());
    const saveName = container.querySelector<HTMLInputElement>('.query-builder-save input');
    if (!saveName) throw new Error("Expected saved-search name input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(saveName, "Runtime calls");
    await act(async () => saveName.dispatchEvent(new Event("input", { bubbles: true })));
    const saveSearchButton = [...container.querySelectorAll<HTMLButtonElement>(".query-builder-save button")]
      .find((button) => button.textContent?.includes("Save search"));
    await act(async () => saveSearchButton?.click());
    expect(createSavedSearch).toHaveBeenCalledWith("Runtime calls", expect.objectContaining({
      origin: "all",
      source: "codex",
    }));
    const applyButton = [...container.querySelectorAll<HTMLButtonElement>(".query-builder button")]
      .find((button) => button.textContent?.includes("Apply"));
    await act(async () => applyButton?.click());
    expect(actions.setSource).toHaveBeenCalledWith("codex");

    await act(async () => buttonByLabel(container, "Saved searches").click());
    await vi.waitFor(() => expect(listSavedSearches).toHaveBeenCalledTimes(2));
    const savedSearchButton = container.querySelector<HTMLButtonElement>(".saved-search-apply");
    expect(savedSearchButton?.textContent).toContain("Codex favorites");
    await act(async () => savedSearchButton?.click());
    expect(actions.search).toHaveBeenCalledWith("migration");
    expect(actions.setSource).toHaveBeenCalledWith("codex");
    expect(actions.setTag).toHaveBeenCalledWith("important");
    expect(actions.setVisibility).toHaveBeenCalledWith("favorites");
    expect(actions.setCustomDateRange).toHaveBeenCalledWith({
      dayStart: Date.parse("2026-07-01T00:00:00.000Z"),
      dayEndExclusive: Date.parse("2026-08-01T00:00:00.000Z"),
    });
    expect(touchSavedSearch).toHaveBeenCalledWith(7);
  });

  it("keeps the count and page actions in the header and the cleanup tools in the More menu", async () => {
    const actions = createActions();
    const model = { ...createModel(), sessionTotalCount: 134 };
    await act(async () => root.render(<SessionsPage model={model} actions={actions} />));
    const head = container.querySelector(".sessions-page-head")!;
    expect(head.textContent).toContain("134 sessions");
    expect(head.querySelector("p")).toBeNull();
    const headButton = (label: string) => head.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    await act(async () => headButton("AI session finder")?.click());
    await act(async () => headButton("Remote sessions")?.click());
    expect(actions.openAiAssistant).toHaveBeenCalledTimes(1);
    expect(actions.openRemoteSessions).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".result-count")).toBeNull();

    const more = container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!;
    const menu = () => document.querySelector('[role="menu"][aria-label="More actions"]');
    expect(menu()).toBeNull();
    await act(async () => more.click());
    const items = [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Clean up by date", "Leftover Subagent Chats"]);
    await act(async () => items[0]!.click());
    expect(actions.openDateCleanup).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    await act(async () => more.click());
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(menu()).toBeNull();
  });

  it("applies natural date presets from the date menu", async () => {
    const now = new Date(2026, 9, 13, 15, 30, 12).getTime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const actions = createActions();
    await act(async () => root.render(<SessionsPage model={createModel()} actions={actions} />));
    const trigger = buttonByLabel(container, "Session time range");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());
    const menu = container.querySelector('[role="menu"][aria-label="Session time range"]');
    if (!menu) throw new Error("Expected the date menu");
    expect([...menu.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "All time", "Last 7 days", "Last 30 days", "Last 3 months", "Today", "Yesterday", "This week", "This month", "Last month",
    ]);
    await act(async () => [...menu.querySelectorAll("button")].find((button) => button.textContent === "Today")!.click());
    expect(actions.setCustomDateRange).toHaveBeenCalledExactlyOnceWith(naturalDateRange("today", now));
    expect(actions.setDateRange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="menu"][aria-label="Session time range"]')).toBeNull();
    nowSpy.mockRestore();
  });

  it("applies explicit start and end dates from the date menu", async () => {
    const actions = createActions();
    await act(async () => root.render(<SessionsPage model={createModel()} actions={actions} />));
    await act(async () => buttonByLabel(container, "Session time range").click());
    const [startInput, endInput] = [...container.querySelectorAll<HTMLInputElement>(".session-date-custom input[type=date]")];
    if (!startInput || !endInput) throw new Error("Expected start and end date inputs");
    // Assign through the prototype setter so React's value tracker still sees a change.
    const setDateValue = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    await act(async () => setDateValue(startInput, "2026-09-30"));
    await act(async () => setDateValue(endInput, "2026-10-02"));
    await act(async () => buttonByLabel(container, "Apply date range").click());
    expect(actions.setCustomDateRange).toHaveBeenCalledExactlyOnceWith(
      customDateRangeFromInputs("2026-09-30", "2026-10-02"),
    );
    expect(container.querySelector('[role="menu"][aria-label="Session time range"]')).toBeNull();
  });

  it("clears the active custom range when a rolling range is chosen", async () => {
    const actions = createActions();
    const model = createModel();
    model.customDateRange = { dayStart: 1, dayEndExclusive: 2 };
    await act(async () => root.render(<SessionsPage model={model} actions={actions} />));
    await act(async () => buttonByLabel(container, "Session time range").click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".session-date-menu button")]
      .find((button) => button.textContent === "Last 7 days")!.click());
    expect(actions.setDateRange).toHaveBeenCalledWith("7d");
    expect(actions.clearCustomDateRange).toHaveBeenCalledExactlyOnceWith();
  });
});

function createModel(): SessionsPageModel {
  return {
    language: "en",
    indexStatus: null,
    sessionTotalCount: 0,
    origin: "ordinary",
    originCounts: { ordinary: 3, agentRecall: 2, all: 5 },
    invocationSurface: "all",
    invocationSurfaceCounts: {
      workflow: 1,
      evaluation: 0,
      team_chat: 1,
      agent: 0,
      skill: 0,
      system: 0,
      all: 2,
    },
    environmentId: "all",
    tags: ["important"],
    sidebarTree: [],
    source: "all",
    sourceFilters: [
      { label: "All", value: "all" },
      { label: "Codex", value: "codex" },
    ],
    visibility: "default",
    searchRef: createRef<HTMLInputElement>(),
    searchPlaceholder: "Search sessions",
    query: "",
    liveStatus: "all",
    customDateRange: null,
    dateRange: "all",
    sortBy: "smart",
    aiAssistantOpen: false,
    remoteSessionsOpen: false,
    selected: null,
    sessions: [session("ordinary", false), session("agentrecall", true)],
    currentPage: 1,
    totalPages: 1,
    liveSessionKeys: new Set(),
    liveDetectionFailed: false,
    bulkSelectionActive: false,
    bulkSelectedKeys: new Set(),
  };
}

function session(sessionKey: string, createdByAgentRecall: boolean): SessionsPageModel["sessions"][number] {
  return {
    sessionKey,
    rawId: sessionKey,
    source: "codex-cli",
    projectPath: "/workspace",
    filePath: `/fixtures/${sessionKey}.jsonl`,
    originalTitle: sessionKey,
    firstQuestion: sessionKey,
    timestamp: 1,
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
    environmentId: "local",
    environmentKind: "local",
    environmentLabel: "Local",
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    customTitle: null,
    displayTitle: sessionKey,
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 1,
    messageCount: 0,
    aiSummary: null,
    aiSummaryStale: false,
    createdByAgentRecall,
  };
}

function createActions(): SessionsPageActions {
  return {
    refresh: vi.fn(),
    selectAllSessions: vi.fn(),
    selectEnvironment: vi.fn(),
    selectProject: vi.fn(),
    deleteTag: vi.fn(),
    setSource: vi.fn(),
    setOrigin: vi.fn(),
    setInvocationSurface: vi.fn(),
    setTag: vi.fn(),
    setVisibility: vi.fn(),
    search: vi.fn(),
    setLiveStatus: vi.fn(),
    clearCustomDateRange: vi.fn(),
    setCustomDateRange: vi.fn(),
    setDateRange: vi.fn(),
    setSortBy: vi.fn(),
    openAiAssistant: vi.fn(),
    openRemoteSessions: vi.fn(),
    selectSession: vi.fn(),
    openSession: vi.fn(),
    openMatch: vi.fn(),
    renameSession: vi.fn(),
    toggleFavorite: vi.fn(),
    openContextMenu: vi.fn(),
    goToPage: vi.fn(),
    toggleBulkSession: vi.fn(),
    toggleLoadedSelection: vi.fn(),
    exitBulkSelection: vi.fn(),
    selectAllMatching: vi.fn(),
    deleteSelected: vi.fn(),
    openDateCleanup: vi.fn(),
    openOrphanCleanup: vi.fn(),
  };
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function chips(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".session-filter-bar .session-chip")];
}

function chip(container: HTMLElement, text: string): HTMLButtonElement {
  const found = chips(container).find((button) => button.textContent === text);
  if (!found) throw new Error(`Missing filter chip: ${text}`);
  return found;
}

function menuItems(menuLabel: string): HTMLButtonElement[] {
  const menu = document.querySelector(`[role="menu"][aria-label="${menuLabel}"]`);
  if (!menu) throw new Error(`Missing menu: ${menuLabel}`);
  return [...menu.querySelectorAll<HTMLButtonElement>("button")];
}

function menuLabels(menuLabel: string): string[] {
  return menuItems(menuLabel).map((item) => item.querySelector("span")?.textContent ?? "");
}

function menuItem(menuLabel: string, label: string): HTMLButtonElement {
  const found = menuItems(menuLabel).find((item) => item.querySelector("span")?.textContent === label);
  if (!found) throw new Error(`Missing menu item: ${label}`);
  return found;
}
