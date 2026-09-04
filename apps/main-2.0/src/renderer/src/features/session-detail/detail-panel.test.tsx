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
    const sourceButton = actionButtons.at(-1);
    expect(sourceButton?.textContent).toContain("Back to source");
    await act(async () => sourceButton?.click());
    expect(onOpenInvocationOwner).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "invocation-1",
      ownerReference: { workflowId: "workflow-1", runId: "run-1" },
    }));

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
  });
});
