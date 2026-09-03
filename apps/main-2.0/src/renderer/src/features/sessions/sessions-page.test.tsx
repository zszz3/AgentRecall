// @vitest-environment happy-dom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedSearch } from "../../../../core/store/saved-searches";
import { SessionsPage, type SessionsPageActions, type SessionsPageModel } from "./sessions-page";

describe("SessionsPage search tools", () => {
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

  it("wires advanced, saved, grouped, and sorted search controls", async () => {
    const savedSearch: SavedSearch = {
      id: 7,
      name: "Codex favorites",
      options: {
        query: "migration",
        source: "codex",
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
      value: {
        platform: "win32",
        listSavedSearches,
        createSavedSearch: vi.fn(async () => savedSearch),
        deleteSavedSearch: vi.fn(async () => true),
        touchSavedSearch,
      },
    });

    const actions = createActions();
    const model = createModel();
    await act(async () => root.render(<SessionsPage model={model} actions={actions} />));
    expect(container.querySelector(".toolbar-primary .searchbox")).not.toBeNull();
    expect(container.querySelector(".toolbar-secondary .toolbar-filters")).not.toBeNull();
    const invocationGroup = [...container.querySelectorAll<HTMLButtonElement>(".session-origin-filter button")]
      .find((button) => button.textContent?.includes("AgentRecall calls"));
    expect(invocationGroup?.textContent).toContain("(2)");
    expect(invocationGroup?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => invocationGroup?.click());
    expect(actions.setOrigin).toHaveBeenCalledWith("agentrecall");

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
    const applyButton = [...container.querySelectorAll<HTMLButtonElement>(".query-builder button")]
      .find((button) => button.textContent?.includes("Apply"));
    await act(async () => applyButton?.click());
    expect(actions.setSource).toHaveBeenCalledWith("codex");

    const groupButton = buttonByLabel(container, "Group results");
    await act(async () => groupButton.click());
    expect(groupButton.classList.contains("active")).toBe(true);

    const recentButton = [...container.querySelectorAll<HTMLButtonElement>(".sort-filter button")]
      .find((button) => button.textContent === "Recent");
    await act(async () => recentButton?.click());
    expect(actions.setSortBy).toHaveBeenCalledWith("activity");

    await act(async () => buttonByLabel(container, "Saved searches").click());
    await vi.waitFor(() => expect(listSavedSearches).toHaveBeenCalledOnce());
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
});

function createModel(): SessionsPageModel {
  return {
    language: "en",
    indexStatus: null,
    sessionTotalCount: 0,
    origin: "ordinary",
    originCounts: { ordinary: 3, agentRecall: 2, all: 5 },
    sidebarSections: { environments: false, remaining: false, sources: false, views: false },
    environmentId: "all",
    tags: ["important"],
    sidebarTree: [],
    collapsedProjectGroups: new Set(),
    expandedTreeProjects: new Set(),
    source: "all",
    sourceFilters: [
      { label: "All", value: "all" },
      { label: "Codex", value: "codex" },
    ],
    visibility: "default",
    searchRef: createRef<HTMLInputElement>(),
    searchPlaceholder: "Search sessions",
    query: "",
    activeScopeFilters: [],
    liveStatus: "all",
    customDateRange: null,
    dateRange: "all",
    sortBy: "smart",
    aiAssistantOpen: false,
    remoteSessionsOpen: false,
    selected: null,
    sessions: [],
    currentPage: 1,
    totalPages: 1,
    liveSessionKeys: new Set(),
    liveDetectionFailed: false,
    bulkSelectionActive: false,
    bulkSelectedKeys: new Set(),
  };
}

function createActions(): SessionsPageActions {
  return {
    refresh: vi.fn(),
    toggleSidebarSection: vi.fn(),
    selectAllSessions: vi.fn(),
    toggleEnvironment: vi.fn(),
    selectEnvironment: vi.fn(),
    toggleProject: vi.fn(),
    selectProject: vi.fn(),
    toggleProjectTag: vi.fn(),
    deleteTag: vi.fn(),
    setSource: vi.fn(),
    setOrigin: vi.fn(),
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
