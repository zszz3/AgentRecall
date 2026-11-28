// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSearchResult, SessionTurnSummary } from "../../../../core/types";
import { DetailPanel } from "./detail-panel";

const session: SessionSearchResult = {
  sessionKey: "pi:test-session",
  rawId: "test-session",
  source: "pi-cli",
  projectPath: "",
  filePath: "C:\\fixtures\\test-session.jsonl",
  originalTitle: "Test session",
  firstQuestion: "first question",
  timestamp: Date.parse("2026-08-10T10:00:00.000Z"),
  fileMtimeMs: Date.parse("2026-08-10T10:00:01.000Z"),
  fileSize: 1_024,
  prUrl: null,
  prNumber: null,
  environmentId: "local",
  environmentKind: "local",
  environmentLabel: "Local",
  tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
  customTitle: null,
  displayTitle: "Test session",
  favorited: false,
  hidden: false,
  tags: [],
  matchSnippet: null,
  lastOpenedAt: null,
  lastResumedAt: null,
  lastActivityAt: Date.parse("2026-08-10T10:00:01.000Z"),
  messageCount: 2,
  aiSummary: null,
  aiSummaryStale: false,
};

const turn: SessionTurnSummary = {
  id: "turn-1",
  turnIndex: 0,
  sourceMessageIndex: 0,
  sourceTurnId: "turn-1",
  synthetic: false,
  status: "completed",
  startedAt: "2026-08-10T10:00:00.000Z",
  endedAt: "2026-08-10T10:00:01.000Z",
  userPreview: "user question",
  assistantPreview: "assistant answer",
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  errorCount: 0,
  toolNames: [],
  messageCount: 2,
  spanCount: 0,
};

describe("DetailPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: vi.fn() });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function viewTab(label: string): HTMLButtonElement {
    const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Session view"] [role="tab"]')]
      .find((button) => button.textContent === label);
    if (!tab) throw new Error(`Missing view ${label}`);
    return tab;
  }

  async function renderPanel(overrides: Partial<Parameters<typeof DetailPanel>[0]> = {}) {
    await act(async () => root.render(
      <DetailPanel
        session={session} turns={null} turnsLoading={false} matchedTurnId={null}
        onLoadTurn={async () => null} onLoadTrajectory={async () => []} onLoadContext={async () => []}
        messages={[]} matchedContextMessages={[]} matchedMessageIndex={null} traceEvents={[]}
        loading={false} actionStatus={null} query="" liveState="closed" language="en"
        revealLabel="Explorer" showItermAction={false} messagePageSize={100} olderMessageCount={0}
        onClose={vi.fn()} onShowMore={vi.fn()} onRename={vi.fn()} onAddTag={vi.fn()} onRemoveTag={vi.fn()}
        onFavorite={vi.fn()} onSummarize={vi.fn()} summarizing={false} canResume={false} canMigrate={false}
        migrationTitle="" onResume={vi.fn()} onResumeIterm={vi.fn()} onMigrate={vi.fn()}
        onCopyResume={vi.fn()} onCopyMarkdown={vi.fn()} onExportMarkdown={vi.fn()} onExportJson={vi.fn()}
        onCopyPlain={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()}
        sessionFamily={{ parent: null, children: [], truncated: false }}
        {...overrides}
      />,
    ));
  }

  it("opens the fork origin separately from subagents and renders no link when it is unavailable", async () => {
    const onOpenFamilySession = vi.fn();
    const fork = { ...session, sessionKey: "codex:fork", rawId: "fork", source: "codex-cli" as const, forkedFromId: "origin" };
    const family = { parent: null, children: [], truncated: false };
    await renderPanel({
      session: fork, onOpenFamilySession,
      sessionFamily: { ...family, forkOrigin: { rawId: "origin", sessionKey: "codex:origin", title: "Origin session" } },
    });
    expect(container.textContent).toContain("Forked from");
    expect(container.textContent).not.toContain("Subagent sessions");
    const link = [...container.querySelectorAll("button")].find((button) => button.textContent === "Origin session");
    expect(link).toBeDefined();
    await act(async () => link?.click());
    expect(onOpenFamilySession).toHaveBeenCalledExactlyOnceWith("codex:origin");

    await renderPanel({
      session: fork, onOpenFamilySession,
      sessionFamily: { ...family, forkOrigin: { rawId: "origin", sessionKey: null, title: null } },
    });
    expect(container.textContent).toContain("Source session is not available");
    expect(container.querySelector(".subagent-session-card")).toBeNull();
  });

  it("renders More actions menu outside scroller, cleans up listeners on unmount, and keeps CodeWiz summary read-only", async () => {
    const onExportMarkdown = vi.fn();
    await renderPanel({
      turns: Array.from({ length: 101 }, (_, i) => ({ ...turn, id: `turn-${i}`, turnIndex: i })),
      onExportMarkdown,
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!;
    await act(async () => trigger.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="More actions"]')!;
    expect(menu.closest(".detail-body")).toBeNull();
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    await act(async () => items[4]!.click());
    expect(onExportMarkdown).toHaveBeenLastCalledWith(true);

    await renderPanel({
      session: { ...session, sessionKey: "codewiz:s1", source: "codewiz-cli", aiSummary: "Existing CodeWiz summary" },
    });
    expect(container.querySelector(".detail-summary")?.textContent).toContain("Existing CodeWiz summary");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Re-summarize"))).toBe(false);
  });

  it("routes active invocation history, switches views with Ctrl+F, and keeps virtualized turns outside chrome", async () => {
    const onOpenInvocationOwner = vi.fn();
    const loadTrajectory = vi.fn(async () => [{ ...turn, messages: [], spans: [] }]);
    const loadContext = vi.fn(async () => [{
      turnId: turn.id, turnIndex: 0, occurredAt: "2026-08-10T10:00:01.000Z",
      inputTokens: 50, cachedInputTokens: 1_000, cacheCreationInputTokens: 0, outputTokens: 10,
    }]);

    await renderPanel({
      session: {
        ...session,
        createdByAgentRecall: true,
        runtimeInvocations: [{
          invocationId: "inv-1", surface: "evaluation", role: "subject", ownerReference: { runId: "run-1" },
          runtimeId: "codex", channelId: "codex-default", environmentId: "local", status: "completed",
          startedAt: 1, finishedAt: 2, relation: "created", runtimeSessionId: "test-session", runtimeTurnId: "turn-1",
        }, {
          invocationId: "legacy-wf", surface: "workflow", role: "node", ownerReference: { workflowId: "wf-1" },
          runtimeId: "codex", channelId: "codex-default", environmentId: "local", status: "completed",
          startedAt: 1, finishedAt: 2, relation: "created", runtimeSessionId: "test-session", runtimeTurnId: null,
        }],
      },
      turns: Array.from({ length: 101 }, (_, i) => ({ ...turn, id: `turn-${i}`, turnIndex: i })),
      onLoadTrajectory: loadTrajectory,
      onLoadContext: loadContext,
      onOpenInvocationOwner,
    });

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".detail-actions > .detail-action-group > button")];
    await act(async () => buttons.find((b) => b.textContent?.includes("Back to source"))?.click());
    expect(onOpenInvocationOwner).toHaveBeenCalledWith(expect.objectContaining({ invocationId: "inv-1" }));
    expect(buttons.find((b) => b.textContent?.includes("Workflow removed"))?.disabled).toBe(true);

    expect(viewTab("Trajectory").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(container.querySelector(".trajectory-search input"));

    await act(async () => viewTab("Context").click());
    expect(loadContext).toHaveBeenCalledWith(session.sessionKey);
    expect(localStorage.getItem("agent-recall-session-detail-view")).toBe("context");

    await act(async () => viewTab("Turns").click());
    expect(localStorage.getItem("agent-recall-session-detail-view")).toBe("turns");
    const turnList = container.querySelector(".turn-list");
    expect(turnList?.getAttribute("data-virtualized")).toBe("true");
    expect(turnList?.closest(".detail-body-chrome")).toBeNull();
  });
});
