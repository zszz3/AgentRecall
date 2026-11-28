// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSearch } from "../../../../core/storage/types";
import { customDateRangeFromInputs, naturalDateRange } from "./date-presets";
import { SessionsPage, type SessionsPageActions, type SessionsPageModel } from "./sessions-page";

describe("SessionsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
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

  it("applies filter chips, secondary More filters, sort/group options, and clears all active filters", async () => {
    const actions = createActions();
    const model = createModel();
    const project = {
      path: "/repo/app", label: "app", labelKind: "path" as const, labelSuffix: null, sessionCount: 2,
      environmentId: "local", environmentLabel: "Local", createdAt: 1, lastActivityAt: 1, tags: [],
    };
    model.sidebarTree = [{ environment: null, projects: [project] }];
    await act(async () => root.render(<SessionsPage model={model} actions={actions} />));

    await act(async () => chip(container, "Project").click());
    await act(async () => menuItem("Project", "app").click());
    expect(actions.selectProject).toHaveBeenCalledWith(project);

    await act(async () => chip(container, "Agent").click());
    await act(async () => menuItem("Agent", "Codex").click());
    expect(actions.setSource).toHaveBeenCalledWith("codex");

    await act(async () => chip(container, "More").click());
    const favBtn = [...container.querySelectorAll<HTMLButtonElement>(".session-more-menu button")]
      .find((btn) => btn.textContent === "Favorites")!;
    await act(async () => favBtn.click());
    expect(actions.setVisibility).toHaveBeenCalledWith("favorites");

    await act(async () => root.render(
      <SessionsPage model={{ ...model, source: "codex", visibility: "favorites", projectPath: "/repo/app", projectEnvironmentId: "local" }} actions={actions} />,
    ));
    await act(async () => container.querySelector<HTMLButtonElement>(".session-filter-clear")!.click());
    expect(actions.selectAllSessions).toHaveBeenCalledTimes(1);
    expect(actions.setSource).toHaveBeenLastCalledWith("all");
    expect(actions.setVisibility).toHaveBeenCalledWith("default");

    const sort = container.querySelector<HTMLButtonElement>(".session-sort")!;
    await act(async () => sort.click());
    await act(async () => menuItem("Sort and group", "Most recent first").click());
    expect(actions.setSortBy).toHaveBeenCalledWith("activity");
  });

  it("applies natural, custom, and rolling date ranges and saves/applies saved searches", async () => {
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
    const touchSavedSearch = vi.fn(async () => undefined);
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { platform: "win32", listSavedSearches, createSavedSearch: vi.fn(async () => savedSearch), deleteSavedSearch: vi.fn(async () => true), touchSavedSearch },
    });

    const now = new Date(2026, 9, 13, 15, 30, 12).getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const actions = createActions();
    await act(async () => root.render(<SessionsPage model={createModel()} actions={actions} />));

    await act(async () => buttonByLabel(container, "Session time range").click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".session-date-menu button")]
      .find((b) => b.textContent === "Today")!.click());
    expect(actions.setCustomDateRange).toHaveBeenCalledWith(naturalDateRange("today", now));

    await act(async () => buttonByLabel(container, "Session time range").click());
    const [startInput, endInput] = [...container.querySelectorAll<HTMLInputElement>(".session-date-custom input[type=date]")];
    const setDate = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    await act(async () => setDate(startInput!, "2026-09-30"));
    await act(async () => setDate(endInput!, "2026-10-02"));
    await act(async () => buttonByLabel(container, "Apply date range").click());
    expect(actions.setCustomDateRange).toHaveBeenLastCalledWith(customDateRangeFromInputs("2026-09-30", "2026-10-02"));

    await act(async () => buttonByLabel(container, "Saved searches").click());
    await vi.waitFor(() => expect(listSavedSearches).toHaveBeenCalled());
    await act(async () => container.querySelector<HTMLButtonElement>(".saved-search-apply")?.click());
    expect(actions.search).toHaveBeenCalledWith("migration");
    expect(actions.setTag).toHaveBeenCalledWith("important");
    expect(touchSavedSearch).toHaveBeenCalledWith(7);
  });
});

function createModel(): SessionsPageModel {
  return {
    language: "en",
    indexStatus: null,
    sessionTotalCount: 2,
    origin: "ordinary",
    originCounts: { ordinary: 3, agentRecall: 2, all: 5 },
    invocationSurface: "all",
    invocationSurfaceCounts: { workflow: 1, evaluation: 0, team_chat: 1, agent: 0, skill: 0, system: 0, all: 2 },
    environmentId: "all",
    tags: ["important"],
    sidebarTree: [],
    source: "all",
    sourceFilters: [{ label: "All", value: "all" }, { label: "Codex", value: "codex" }],
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
    sessionKey, rawId: sessionKey, source: "codex-cli", projectPath: "/workspace",
    filePath: `/fixtures/${sessionKey}.jsonl`, originalTitle: sessionKey, firstQuestion: sessionKey,
    timestamp: 1, fileMtimeMs: 1, fileSize: 1, prUrl: null, prNumber: null,
    environmentId: "local", environmentKind: "local", environmentLabel: "Local",
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    customTitle: null, displayTitle: sessionKey, favorited: false, hidden: false, tags: [],
    matchSnippet: null, lastOpenedAt: null, lastResumedAt: null, lastActivityAt: 1,
    messageCount: 0, aiSummary: null, aiSummaryStale: false, createdByAgentRecall,
  };
}

function createActions(): SessionsPageActions {
  return {
    refresh: vi.fn(), selectAllSessions: vi.fn(), selectEnvironment: vi.fn(), selectProject: vi.fn(),
    deleteTag: vi.fn(), setSource: vi.fn(), setOrigin: vi.fn(), setInvocationSurface: vi.fn(),
    setTag: vi.fn(), setVisibility: vi.fn(), search: vi.fn(), setLiveStatus: vi.fn(),
    clearCustomDateRange: vi.fn(), setCustomDateRange: vi.fn(), setDateRange: vi.fn(), setSortBy: vi.fn(),
    openAiAssistant: vi.fn(), openRemoteSessions: vi.fn(), selectSession: vi.fn(), openSession: vi.fn(),
    openMatch: vi.fn(), renameSession: vi.fn(), toggleFavorite: vi.fn(), openContextMenu: vi.fn(),
    goToPage: vi.fn(), toggleBulkSession: vi.fn(), toggleLoadedSelection: vi.fn(), exitBulkSelection: vi.fn(),
    selectAllMatching: vi.fn(), deleteSelected: vi.fn(), openDateCleanup: vi.fn(), openOrphanCleanup: vi.fn(),
  };
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

function chip(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".session-filter-bar .session-chip")]
    .find((button) => button.textContent === text);
  if (!found) throw new Error(`Missing filter chip: ${text}`);
  return found;
}

function menuItem(menuLabel: string, label: string): HTMLButtonElement {
  const menu = document.querySelector(`[role="menu"][aria-label="${menuLabel}"]`);
  if (!menu) throw new Error(`Missing menu: ${menuLabel}`);
  const found = [...menu.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.querySelector("span")?.textContent === label);
  if (!found) throw new Error(`Missing menu item: ${label}`);
  return found;
}
