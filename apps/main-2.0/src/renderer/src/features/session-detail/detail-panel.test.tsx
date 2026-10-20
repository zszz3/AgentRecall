// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSearchResult, SessionTurnSummary } from "../../../../core/types";
import { DetailPanel } from "./detail-panel";

const session = {
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
  tokenUsage: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  },
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
} satisfies SessionSearchResult;

const turn = {
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
} satisfies SessionTurnSummary;

describe("DetailPanel Turn controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollBy", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function renderPanel(turns: SessionTurnSummary[] | null = null, onExportMarkdown = vi.fn()) {
    await act(async () => root.render(
      <DetailPanel
        session={session} turns={turns} turnsLoading={false} matchedTurnId={null}
        onLoadTurn={async () => null} messages={[]} matchedContextMessages={[]}
        matchedMessageIndex={null} traceEvents={[]} loading={false} actionStatus={null}
        query="" liveState="closed" language="en" revealLabel="Explorer" showItermAction={false}
        messagePageSize={100} olderMessageCount={0} onClose={vi.fn()} onShowMore={vi.fn()}
        onRename={vi.fn()} onAddTag={vi.fn()} onRemoveTag={vi.fn()} onFavorite={vi.fn()}
        onSummarize={vi.fn()} summarizing={false} canResume={false} canMigrate={false}
        migrationTitle="" onResume={vi.fn()} onResumeIterm={vi.fn()} onMigrate={vi.fn()}
        onCopyResume={vi.fn()} onCopyMarkdown={vi.fn()} onExportMarkdown={onExportMarkdown}
        onExportJson={vi.fn()} onCopyPlain={vi.fn()} onDelete={vi.fn()} onReveal={vi.fn()}
        sessionFamily={{ parent: null, children: [], truncated: false }}
      />,
    ));
  }

  it.each(["PageDown", "PageUp", " "])("pages through unobscured content with %j and a changing sticky header", async (key) => {
    await renderPanel();
    const body = container.querySelector<HTMLElement>(".detail-body")!;
    const header = container.querySelector<HTMLElement>(".detail-header")!;
    Object.defineProperty(body, "clientHeight", { value: 600 });
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue({ top: 10, bottom: 610 } as DOMRect);
    const headerRect = vi.spyOn(header, "getBoundingClientRect");
    for (const height of [120, 180]) {
      headerRect.mockReturnValue({ top: 10, bottom: 10 + height } as DOMRect);
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(body.scrollBy).toHaveBeenLastCalledWith({ top: (key === "PageUp" ? -1 : 1) * (600 - height) * 0.9 });
    }
  });

  it("exports both Markdown variants from a menu outside the virtualized metadata scroller", async () => {
    const onExport = vi.fn();
    await renderPanel(Array.from({ length: 101 }, (_, index) => ({ ...turn, id: `turn-${index}`, turnIndex: index })), onExport);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    for (const includeTrace of [false, true]) {
      await act(async () => trigger.click());
      const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
      expect(menu).not.toBeNull();
      expect(menu.closest(".detail-body")).toBeNull();
      const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
      expect(document.activeElement).toBe(items[0]);
      await act(async () => items[Number(includeTrace)].click());
      expect(onExport).toHaveBeenLastCalledWith(includeTrace);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("supports menu keyboard navigation, outside dismissal, and scroll/resize cleanup", async () => {
    await renderPanel();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    const open = async () => act(async () => trigger.click());
    const key = async (value: string) => act(async () => document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    ));
    await open();
    const items = container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    await key("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    await key("Home");
    expect(document.activeElement).toBe(items[0]);
    await key("End");
    expect(document.activeElement).toBe(items[1]);
    await key("Escape");
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await open();
    await key("Tab");
    expect(document.activeElement?.textContent).toContain("Export JSON");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    for (const dismiss of [
      () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
      () => container.querySelector(".detail-body-chrome")?.dispatchEvent(new Event("scroll")),
      () => window.dispatchEvent(new Event("resize")),
    ]) {
      await open();
      await act(async () => dismiss());
      expect(container.querySelector('[role="menu"]')).toBeNull();
    }
    await open();
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    await act(async () => root.render(null));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(removeWindowListener).toHaveBeenCalledWith("scroll", expect.any(Function), true);
    expect(removeWindowListener).toHaveBeenCalledWith("resize", expect.any(Function));
    for (const event of ["mousedown", "focusin", "keydown"]) {
      expect(removeDocumentListener).toHaveBeenCalledWith(event, expect.any(Function));
    }
  });

  it("opens in-conversation find with Ctrl+F and exposes role filters in Turn mode", async () => {
    const onOpenInvocationOwner = vi.fn();
    await act(async () => {
      root.render(
        <DetailPanel
          session={{
            ...session,
            createdByAgentRecall: true,
            runtimeInvocations: [{
              invocationId: "invocation-1",
              surface: "workflow",
              role: "node",
              ownerReference: { workflowId: "workflow-1", runId: "run-1" },
              runtimeId: "codex",
              channelId: "codex-default",
              environmentId: "local",
              status: "completed",
              startedAt: Date.parse("2026-08-10T10:00:00.000Z"),
              finishedAt: Date.parse("2026-08-10T10:00:01.000Z"),
              relation: "created",
              runtimeSessionId: "test-session",
              runtimeTurnId: "turn-1",
            }, {
              invocationId: "legacy-chat-invocation",
              surface: "team_chat",
              role: "member",
              ownerReference: { roomId: "legacy-room" },
              runtimeId: "codex",
              channelId: "codex-default",
              environmentId: "local",
              status: "completed",
              startedAt: 1,
              finishedAt: 2,
              relation: "created",
              runtimeSessionId: "test-session",
              runtimeTurnId: null,
            }],
          }}
          turns={[turn]}
          turnsLoading={false}
          matchedTurnId={null}
          onLoadTurn={async () => null}
          messages={[]}
          matchedContextMessages={[]}
          matchedMessageIndex={null}
          traceEvents={[]}
          loading={false}
          actionStatus={null}
          query=""
          liveState="closed"
          language="en"
          revealLabel="Explorer"
          showItermAction={false}
          messagePageSize={100}
          olderMessageCount={0}
          onClose={vi.fn()}
          onShowMore={vi.fn()}
          onRename={vi.fn()}
          onAddTag={vi.fn()}
          onRemoveTag={vi.fn()}
          onFavorite={vi.fn()}
          onSummarize={vi.fn()}
          summarizing={false}
          canResume={false}
          canMigrate={false}
          migrationTitle=""
          onResume={vi.fn()}
          onResumeIterm={vi.fn()}
          onMigrate={vi.fn()}
          onCopyResume={vi.fn()}
          onCopyMarkdown={vi.fn()}
          onExportMarkdown={vi.fn()}
          onExportJson={vi.fn()}
          onCopyPlain={vi.fn()}
          onDelete={vi.fn()}
          onReveal={vi.fn()}
          sessionFamily={{ parent: null, children: [], truncated: false }}
          onOpenInvocationOwner={onOpenInvocationOwner}
        />,
      );
    });

    expect(container.querySelector(".runtime-invocation-history")?.textContent)
      .toContain("Created by AgentRecall");
    expect(container.querySelector(".runtime-invocation-history button")).toBeNull();
    const actionButtons = [...container.querySelectorAll<HTMLButtonElement>(".detail-actions > .detail-action-group > button")];
    const sourceButton = actionButtons.find((button) => button.textContent?.includes("Back to source"));
    expect(sourceButton?.textContent).toContain("Back to source");
    await act(async () => sourceButton?.click());
    expect(onOpenInvocationOwner).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "invocation-1",
      ownerReference: { workflowId: "workflow-1", runId: "run-1" },
    }));

    const retiredChatButton = actionButtons.find((button) => button.textContent?.includes("Multi-agent Chat removed"));
    expect(retiredChatButton?.disabled).toBe(true);
    await act(async () => retiredChatButton?.click());
    expect(onOpenInvocationOwner).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".runtime-invocation-history")?.textContent).toContain("Team Chat");

    const roleGroup = container.querySelector('[role="group"][aria-label="Conversation role filter"]');
    expect(roleGroup?.querySelectorAll("button")).toHaveLength(3);
    expect(roleGroup?.textContent).toContain("All");
    expect(roleGroup?.textContent).toContain("User");
    expect(roleGroup?.textContent).toContain("Assistant");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    await vi.waitFor(() => {
      expect(container.querySelector(".panel-search-input")).not.toBeNull();
    });
    expect(document.activeElement).toBe(container.querySelector(".panel-search-input"));
    const searchBar = container.querySelector(".panel-search-bar");
    expect(searchBar?.parentElement?.classList.contains("detail-header")).toBe(true);
    expect(searchBar?.closest(".detail-body-chrome")).toBeNull();
  });

  it("keeps an existing CodeWiz summary visible without offering summary actions", async () => {
    await act(async () => {
      root.render(
        <DetailPanel
          session={{
            ...session,
            sessionKey: "codewiz:test-session",
            source: "codewiz-cli",
            aiSummary: "Existing CodeWiz summary",
          }}
          turns={null}
          turnsLoading={false}
          matchedTurnId={null}
          onLoadTurn={async () => null}
          messages={[]}
          matchedContextMessages={[]}
          matchedMessageIndex={null}
          traceEvents={[]}
          loading={false}
          actionStatus={null}
          query=""
          liveState="closed"
          language="en"
          revealLabel="Explorer"
          showItermAction={false}
          messagePageSize={100}
          olderMessageCount={0}
          onClose={vi.fn()}
          onShowMore={vi.fn()}
          onRename={vi.fn()}
          onAddTag={vi.fn()}
          onRemoveTag={vi.fn()}
          onFavorite={vi.fn()}
          onSummarize={vi.fn()}
          summarizing={false}
          canResume={false}
          canMigrate={false}
          migrationTitle=""
          onResume={vi.fn()}
          onResumeIterm={vi.fn()}
          onMigrate={vi.fn()}
          onCopyResume={vi.fn()}
          onCopyMarkdown={vi.fn()}
          onExportMarkdown={vi.fn()}
          onExportJson={vi.fn()}
          onCopyPlain={vi.fn()}
          onDelete={vi.fn()}
          onReveal={vi.fn()}
          sessionFamily={{ parent: null, children: [], truncated: false }}
        />,
      );
    });

    expect(container.querySelector(".detail-summary")?.textContent).toContain("Existing CodeWiz summary");
    const buttonLabels = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttonLabels.some((label) => label?.includes("Re-summarize"))).toBe(false);
  });

  it.each([null, "", "invalid", "0", "-1", "860"])("opens at a readable width for stored value %s and remains resizable", async (stored) => {
    if (stored === null) window.localStorage.removeItem("agentrecall.session-detail-width");
    else window.localStorage.setItem("agentrecall.session-detail-width", stored);
    await act(async () => {
      root.render(
        <DetailPanel
          session={session}
          turns={null}
          turnsLoading={false}
          matchedTurnId={null}
          onLoadTurn={async () => null}
          messages={[]}
          matchedContextMessages={[]}
          matchedMessageIndex={null}
          traceEvents={[]}
          loading={false}
          actionStatus={null}
          query=""
          liveState="closed"
          language="en"
          revealLabel="Explorer"
          showItermAction={false}
          messagePageSize={100}
          olderMessageCount={0}
          onClose={vi.fn()}
          onShowMore={vi.fn()}
          onRename={vi.fn()}
          onAddTag={vi.fn()}
          onRemoveTag={vi.fn()}
          onFavorite={vi.fn()}
          onSummarize={vi.fn()}
          summarizing={false}
          canResume={false}
          canMigrate={false}
          migrationTitle=""
          onResume={vi.fn()}
          onResumeIterm={vi.fn()}
          onMigrate={vi.fn()}
          onCopyResume={vi.fn()}
          onCopyMarkdown={vi.fn()}
          onExportMarkdown={vi.fn()}
          onExportJson={vi.fn()}
          onCopyPlain={vi.fn()}
          onDelete={vi.fn()}
          onReveal={vi.fn()}
          sessionFamily={{ parent: null, children: [], truncated: false }}
        />,
      );
    });

    const separator = container.querySelector<HTMLElement>(".detail-resize-handle");
    const initialWidth = stored === "860" ? 860 : Math.min(1040, window.innerWidth - 20);
    expect(separator?.getAttribute("aria-valuenow")).toBe(String(initialWidth));
    await act(async () => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(separator?.getAttribute("aria-valuenow")).toBe("420");
    await act(async () => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(separator?.getAttribute("aria-valuenow")).toBe("436");
  });

  it("keeps a virtualized Turn list outside the scrollable metadata block", async () => {
    const longSummary = Array.from({ length: 100 }, (_, index) => `Synthetic summary sentence ${index}.`).join(" ");
    const manyTurns = Array.from({ length: 101 }, (_, index) => ({ ...turn, id: `turn-${index}`, turnIndex: index }));
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("turn-list") ? 600 : 112;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);

    await act(async () => {
      root.render(
        <DetailPanel
          session={{ ...session, aiSummary: longSummary }}
          turns={manyTurns}
          turnsLoading={false}
          matchedTurnId={null}
          onLoadTurn={async () => null}
          messages={[]}
          matchedContextMessages={[]}
          matchedMessageIndex={null}
          traceEvents={[]}
          loading={false}
          actionStatus={null}
          query=""
          liveState="closed"
          language="en"
          revealLabel="Explorer"
          showItermAction={false}
          messagePageSize={100}
          olderMessageCount={0}
          onClose={vi.fn()}
          onShowMore={vi.fn()}
          onRename={vi.fn()}
          onAddTag={vi.fn()}
          onRemoveTag={vi.fn()}
          onFavorite={vi.fn()}
          onSummarize={vi.fn()}
          summarizing={false}
          canResume={false}
          canMigrate={false}
          migrationTitle=""
          onResume={vi.fn()}
          onResumeIterm={vi.fn()}
          onMigrate={vi.fn()}
          onCopyResume={vi.fn()}
          onCopyMarkdown={vi.fn()}
          onExportMarkdown={vi.fn()}
          onExportJson={vi.fn()}
          onCopyPlain={vi.fn()}
          onDelete={vi.fn()}
          onReveal={vi.fn()}
          sessionFamily={{ parent: null, children: [], truncated: false }}
        />,
      );
    });

    const body = container.querySelector(".detail-body");
    const summary = container.querySelector(".detail-summary");
    expect(summary?.textContent).toContain("Synthetic summary sentence 99.");
    expect(summary?.closest(".detail-body-chrome")).not.toBeNull();
    expect(container.querySelector(".detail-header")?.parentElement).toBe(body);
    const turnList = container.querySelector(".turn-list");
    expect(turnList?.getAttribute("data-virtualized")).toBe("true");
    expect(turnList?.closest(".detail-body-chrome")).toBeNull();
    expect(turnList?.closest(".turn-conversation")).not.toBeNull();
  });
});
