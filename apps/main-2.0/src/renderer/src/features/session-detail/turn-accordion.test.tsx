// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTraceSpan, SessionTurnDetail, SessionTurnSummary } from "../../../../core/types";
import { TurnAccordion } from "./turn-accordion";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function createTurn(
  id: string,
  turnIndex: number,
  overrides: Partial<SessionTurnSummary> = {},
): SessionTurnSummary {
  return {
    id,
    turnIndex,
    sourceMessageIndex: turnIndex * 10,
    sourceTurnId: id,
    synthetic: false,
    status: "completed",
    startedAt: `2026-08-10T10:00:0${turnIndex % 10}.000Z`,
    endedAt: `2026-08-10T10:00:0${(turnIndex + 1) % 10}.000Z`,
    userPreview: `user ${id}`,
    assistantPreview: `assistant ${id}`,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    errorCount: 0,
    toolNames: [],
    messageCount: 2,
    spanCount: 0,
    ...overrides,
  };
}

function createTurnDetail(
  turn: SessionTurnSummary,
  userContent = turn.userPreview,
  assistantContent = turn.assistantPreview,
  spans: SessionTraceSpan[] = [],
): SessionTurnDetail {
  const sourceMessageIndex = turn.sourceMessageIndex ?? 0;
  return {
    ...turn,
    spanCount: spans.length,
    messages: [
      { messageIndex: 0, sourceMessageIndex, role: "user", content: userContent, timestamp: turn.startedAt ?? "" },
      { messageIndex: 1, sourceMessageIndex: sourceMessageIndex + 1, role: "assistant", content: assistantContent, timestamp: turn.endedAt ?? "" },
    ],
    spans,
  };
}

describe("TurnAccordion", () => {
  let container: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    scrollIntoView.mockReset();
    vi.restoreAllMocks();
  });

  it("opens the matching Turn, marks only exact matched message indexes, and separates subagent forks", async () => {
    const turn = createTurn("turn-1", 0, { sourceMessageIndex: 40, userPreview: "before", assistantPreview: "matched phrase" });
    const detail: SessionTurnDetail = {
      ...turn,
      messages: [
        { messageIndex: 0, sourceMessageIndex: null, role: "user", content: "before", timestamp: turn.startedAt ?? "" },
        { messageIndex: 1, sourceMessageIndex: 42, role: "assistant", content: "matched phrase", timestamp: turn.endedAt ?? "" },
      ],
      spans: [],
    };
    const onLoadTurn = vi.fn(async () => detail);

    await act(async () => {
      root.render(<TurnAccordion sessionKey="codex:s1" turns={[turn]} loading={false} matchedTurnId="turn-1" matchedMessageIndex={42} showTools query="matched phrase" language="en" onLoadTurn={onLoadTurn} />);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(onLoadTurn).toHaveBeenCalledWith("turn-1");
    const matched = container.querySelector('[data-message-index="42"]');
    expect(matched?.classList.contains("match-target")).toBe(true);
    expect(scrollIntoView.mock.instances).toContain(matched);

    await act(async () => {
      root.render(<TurnAccordion sessionKey="codex:s2" turns={[turn]} loading={false} matchedTurnId="turn-1" matchedMessageIndex={null} showTools query="" language="en" onLoadTurn={async () => detail} />);
      await Promise.resolve();
    });
    expect(container.querySelector(".msg.match-target")).toBeNull();

    const subagentTurns = [
      createTurn("p1", 0),
      createTurn("p2", 1),
      createTurn("c1", 2, { agentTriggered: true, subagentExecutionStart: true }),
      createTurn("c2", 3),
    ];
    await act(async () => {
      root.render(<TurnAccordion sessionKey="codex:sub" turns={subagentTurns} loading={false} matchedTurnId={null} matchedMessageIndex={null} showTools query="" language="zh" isSubagent onLoadTurn={async () => null} />);
    });
    expect(container.querySelectorAll('[data-turn-origin="inherited"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-turn-origin="subagent"]')).toHaveLength(2);
  });

  it("groups Code Mode parsed child spans under exec and truncates large compaction output until expanded", async () => {
    const compactOutput = `compact-payload:\n${"readable compact output ".repeat(500)}`;
    const turn = createTurn("turn-spans", 0);
    const detail: SessionTurnDetail = {
      ...turn,
      messages: [],
      spanCount: 3,
      spans: [
        {
          id: "span-exec", parentSpanId: null, spanIndex: 0, kind: "tool", name: "exec", status: "unknown",
          startedAt: turn.startedAt, endedAt: turn.endedAt, callId: "call-cm", input: { code: "tools.exec_command()" }, output: null, error: null,
          attributes: { title: "exec · exec_command", nestedTools: ["exec_command"], tool: { canonicalName: "exec", executionEvidence: "recorded-request" } },
        },
        {
          id: "span-child", parentSpanId: "span-exec", spanIndex: 1, kind: "tool", name: "exec_command", status: "completed",
          startedAt: turn.startedAt, endedAt: turn.endedAt, callId: "rt-1", input: { cmd: "rg --files" }, output: { exitCode: 0 }, error: null,
          attributes: { title: "exec_command", tool: { canonicalName: "exec_command", executionEvidence: "runtime-confirmed", parentCallId: "call-cm", parsedFromCodeMode: true } },
        },
        {
          id: "span-compact", parentSpanId: null, spanIndex: 2, kind: "event", name: "Context compacted", status: "completed",
          startedAt: turn.endedAt, endedAt: turn.endedAt, callId: null, input: null, output: { text: compactOutput }, error: null,
          attributes: { eventType: "codex.context.compaction" },
        },
      ],
    };

    await act(async () => {
      root.render(createElement(TurnAccordion, {
        sessionKey: "codex:spans", turns: [turn], loading: false, matchedTurnId: null, matchedMessageIndex: null, showTools: true, query: "", language: "en", onLoadTurn: async () => detail,
      }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".turn-card-summary")?.click(); });
    await vi.waitFor(() => expect(container.querySelector(".msg-tool-group")).not.toBeNull());

    const group = container.querySelector<HTMLDetailsElement>(".msg-tool-group")!;
    expect(group.open).toBe(false);
    expect(group.querySelectorAll(".msg-tool-child-result")).toHaveLength(1);
    await act(async () => { group.querySelector<HTMLElement>(":scope > .msg-tool-summary")?.click(); });
    expect(group.textContent).toContain("rg --files");

    const compactPayload = [...container.querySelectorAll<HTMLElement>(".msg-tool-payload")]
      .find((el) => el.querySelector("pre")?.textContent?.startsWith("compact-payload:"))!;
    expect(compactPayload.querySelector("pre")!.textContent!).toContain("...(truncated)");
    await act(async () => { compactPayload.querySelector<HTMLButtonElement>("button")?.click(); });
    expect(compactPayload.querySelector("pre")?.textContent).toBe(compactOutput);
  });

  it("loads in-conversation find sequentially, cancels when cleared, and ignores stale responses across session switch", async () => {
    const t1 = createTurn("t1", 0);
    const t2 = createTurn("t2", 1);
    const d1 = deferred<SessionTurnDetail | null>();
    const onLoad = vi.fn(() => d1.promise);

    await act(async () => {
      root.render(<TurnAccordion sessionKey="codex:find" turns={[t1, t2]} loading={false} matchedTurnId={null} matchedMessageIndex={null} showTools query="" findQuery="needle" activeFindMatchIndex={0} language="en" onLoadTurn={onLoad} />);
    });
    await vi.waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));

    await act(async () => {
      root.render(<TurnAccordion sessionKey="codex:find" turns={[t1, t2]} loading={false} matchedTurnId={null} matchedMessageIndex={null} showTools query="" findQuery="" language="en" onLoadTurn={onLoad} />);
    });
    await act(async () => { d1.resolve(createTurnDetail(t1, "needle", "")); await d1.promise; await Promise.resolve(); });
    expect(onLoad).toHaveBeenCalledTimes(1);

    const oldReq = deferred<SessionTurnDetail | null>();
    const oldTurn = createTurn("shared", 0, { userPreview: "old" });
    const newTurn = createTurn("shared", 0, { userPreview: "new" });
    const newLoad = vi.fn(async () => createTurnDetail(newTurn, "new needle", "ok"));
    await act(async () => {
      root.render(<TurnAccordion sessionKey="codex:old" turns={[oldTurn]} loading={false} matchedTurnId={null} matchedMessageIndex={null} showTools query="" findQuery="needle" activeFindMatchIndex={0} language="en" onLoadTurn={() => oldReq.promise} />);
    });
    await act(async () => {
      root.render(<TurnAccordion sessionKey="codex:new" turns={[newTurn]} loading={false} matchedTurnId={null} matchedMessageIndex={null} showTools query="" findQuery="needle" activeFindMatchIndex={0} language="en" onLoadTurn={newLoad} />);
    });
    await vi.waitFor(() => expect(container.textContent).toContain("new needle"));
    await act(async () => { oldReq.resolve(createTurnDetail(oldTurn, "old needle", "")); await oldReq.promise; await Promise.resolve(); });
    expect(container.textContent).toContain("new needle");
    expect(container.textContent).not.toContain("old needle");
  });
});

describe("large Turn list virtualization", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function(this: HTMLElement) { return this.classList.contains("turn-list") ? 600 : 112; });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function(this: HTMLElement) { return Number.parseFloat(this.querySelector<HTMLElement>(".turn-list-content")?.style.height ?? "600"); });
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function(this: HTMLElement, first: number | ScrollToOptions) {
      this.scrollTop = typeof first === "number" ? first : first.top ?? this.scrollTop;
      queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  const manyTurns = (count: number) => Array.from({ length: count }, (_, index) => createTurn(`turn-${index}`, index, { startedAt: null, endedAt: null }));
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });

  it("bounds mounted rows for 10000 Turns, jumps to far matches, and shares selections across virtual scroll", async () => {
    const turns = manyTurns(10000), onShare = vi.fn();
    const onLoadTurn = vi.fn(async (id: string) => createTurnDetail(turns[Number(id.slice(5))], "A".repeat(4000), "answer"));
    await act(async () => root.render(<TurnAccordion sessionKey="large" turns={turns} loading={false} matchedTurnId="turn-9999" matchedMessageIndex={99991} showTools query="" language="zh" onLoadTurn={onLoadTurn} onShareTurns={onShare} />));
    await settle();
    expect(container.querySelectorAll(".turn-card").length).toBeLessThan(40);
    const last = container.querySelector<HTMLElement>('[data-turn-row="turn-9999"]')!;
    expect(last.querySelector('[data-message-index="99991"]')?.classList.contains("match-target")).toBe(true);

    const scroller = container.querySelector<HTMLElement>(".turn-list")!;
    await act(async () => { scroller.scrollTop = 0; scroller.dispatchEvent(new Event("scroll")); }); await settle();
    await act(async () => container.querySelector('[data-turn-id="turn-0"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    const choose = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "多选轮次…")!;
    await act(async () => choose.click());
    await act(async () => { scroller.scrollTop = 560000; scroller.dispatchEvent(new Event("scroll")); }); await settle();
    const far = container.querySelector<HTMLInputElement>(".turn-card input")!;
    const farId = far.closest<HTMLElement>("[data-turn-id]")!.dataset.turnId!;
    await act(async () => far.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".turn-share-button")!.click());
    expect(onShare).toHaveBeenCalledExactlyOnceWith(["turn-0", farId]);

    await act(async () => root.render(<TurnAccordion sessionKey="another-session" turns={turns} loading={false} matchedTurnId={null} matchedMessageIndex={null} showTools query="" language="zh" onLoadTurn={onLoadTurn} onShareTurns={onShare} />));
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });
});
