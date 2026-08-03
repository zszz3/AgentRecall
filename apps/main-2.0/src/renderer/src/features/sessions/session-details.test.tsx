// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionFamily } from "../../../../core/session-family";
import type { SessionSearchResult } from "../../../../core/types";
import { SessionDetails } from "./session-details";

const session: SessionSearchResult = {
  sessionKey: "codex:parent",
  rawId: "parent",
  source: "codex-cli",
  projectPath: "/work/agent-recall",
  filePath: "/fixtures/parent.jsonl",
  originalTitle: "Parent task",
  firstQuestion: "Coordinate the work",
  timestamp: 1_000,
  fileMtimeMs: 1_000,
  fileSize: 100,
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
  displayTitle: "Parent task",
  favorited: false,
  hidden: false,
  tags: [],
  matchSnippet: null,
  lastOpenedAt: null,
  lastResumedAt: null,
  lastActivityAt: 1_000,
  messageCount: 2,
  aiSummary: null,
  aiSummaryStale: false,
};

const family: SessionFamily = {
  parent: null,
  children: [{
    sessionKey: "codex:child",
    rawId: "child",
    title: "Child task",
    source: "codex-cli",
    environmentId: "local",
    environmentLabel: "Local",
    messageCount: 1,
    lastActivityAt: 2_000,
    aiSummary: null,
    children: [],
  }],
  truncated: false,
};

describe("SessionDetails family navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let getSessionFamily: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    getSessionFamily = vi.fn().mockResolvedValue(family);
    Reflect.set(window, "sessionSearch", {
      getSessionFamily,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "sessionSearch");
  });

  function createActions(openFamilySession = vi.fn().mockResolvedValue("opened")) {
    return {
      loadTurn: async () => null,
      closeLocal: vi.fn(),
      closeRemote: vi.fn(),
      rename: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      toggleFavorite: vi.fn(),
      summarize: vi.fn(),
      resume: vi.fn(),
      resumeInIterm: vi.fn(),
      migrate: vi.fn(),
      uploadRemote: vi.fn(),
      copyResume: vi.fn(),
      copyMarkdown: vi.fn(),
      exportMarkdown: vi.fn(),
      exportJson: vi.fn(),
      copyPlain: vi.fn(),
      deleteSession: vi.fn(),
      reveal: vi.fn(),
      openFamilySession,
    };
  }

  async function renderDetails({
    actions = createActions(),
    familyRefreshVersion = 0,
  } = {}): Promise<void> {
    await act(async () => {
      root.render(createElement(SessionDetails, {
        detail: session,
        remoteDetail: null,
        turns: [],
        turnsLoading: false,
        matchedTurnId: null,
        actionStatus: null,
        query: "",
        liveState: "closed",
        language: "zh",
        revealLabel: "访达",
        showItermAction: false,
        summarizing: false,
        familyRefreshVersion,
        actions,
      }));
      await Promise.resolve();
    });
  }

  function childButton(title = "Child task"): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes(title));
    expect(button).toBeDefined();
    return button!;
  }

  it("shows indexed subagent sessions and opens the selected session", async () => {
    const openFamilySession = vi.fn().mockResolvedValue("opened");
    await renderDetails({ actions: createActions(openFamilySession) });

    expect(container.textContent).toContain("子 Agent 会话");
    await act(async () => childButton().click());
    expect(openFamilySession).toHaveBeenCalledWith("codex:child");
  });

  it("reloads the family when the session index refreshes", async () => {
    const refreshedFamily: SessionFamily = {
      ...family,
      children: [{
        ...family.children[0]!,
        sessionKey: "codex:new-child",
        rawId: "new-child",
        title: "New child task",
      }],
    };
    getSessionFamily
      .mockResolvedValueOnce(family)
      .mockResolvedValueOnce(refreshedFamily);

    await renderDetails({ familyRefreshVersion: 0 });
    expect(container.textContent).toContain("Child task");

    await renderDetails({ familyRefreshVersion: 1 });
    expect(container.textContent).toContain("New child task");
    expect(getSessionFamily).toHaveBeenCalledTimes(2);
  });

  it("shows a retry action when subagent loading fails", async () => {
    getSessionFamily
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(family);

    await renderDetails();
    expect(container.textContent).toContain("Subagent 加载失败");
    const retryButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("重试"));
    expect(retryButton).toBeDefined();

    await act(async () => {
      retryButton!.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Child task");
    expect(getSessionFamily).toHaveBeenCalledTimes(2);
  });

  it("refreshes the family after selecting a missing related session", async () => {
    const openFamilySession = vi.fn().mockResolvedValue("missing");
    await renderDetails({ actions: createActions(openFamilySession) });

    await act(async () => {
      childButton().click();
      await Promise.resolve();
    });

    expect(openFamilySession).toHaveBeenCalledWith("codex:child");
    expect(getSessionFamily).toHaveBeenCalledTimes(2);
  });
});
