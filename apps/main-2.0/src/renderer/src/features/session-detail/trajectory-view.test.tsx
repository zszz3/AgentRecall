// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionContextSample, SessionTraceSpan, SessionTurnDetail, SessionTurnMessage } from "../../../../core/types";
import { TrajectoryView } from "./trajectory-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  // happy-dom lays nothing out; give the virtualized ledger a viewport to fill.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function message(messageIndex: number, role: SessionTurnMessage["role"], content: string, timestamp: string): SessionTurnMessage {
  return { messageIndex, sourceMessageIndex: messageIndex, role, content, timestamp };
}

function call(id: string, spanIndex: number, overrides: Partial<SessionTraceSpan> = {}): SessionTraceSpan {
  return {
    id,
    parentSpanId: null,
    spanIndex,
    kind: "tool",
    name: "bash",
    status: "completed",
    startedAt: "2026-01-01T00:00:04Z",
    endedAt: "2026-01-01T00:00:06Z",
    callId: id,
    input: null,
    output: null,
    error: null,
    attributes: { traceKind: "tool_call" },
    ...overrides,
  };
}

function turn(id: string, turnIndex: number, messages: SessionTurnMessage[], spans: SessionTraceSpan[]): SessionTurnDetail {
  return {
    id,
    turnIndex,
    sourceMessageIndex: 0,
    synthetic: false,
    status: spans.some((span) => span.status === "failed") ? "failed" : "completed",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:10Z",
    userPreview: "",
    assistantPreview: "",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 12_000,
    errorCount: 0,
    toolNames: [],
    messageCount: messages.length,
    spanCount: spans.length,
    messages,
    spans,
  };
}

const preview = [
  turn("t1", 0, [
    message(0, "user", "List the files", "2026-01-01T00:00:00Z"),
    message(1, "assistant", "Two files.", "2026-01-01T00:00:10Z"),
  ], [
    call("ls", 0, { input: { text: "ls -la" }, output: { text: "a.md b.md…" } }),
    call("cat", 1, {
      parentSpanId: "ls",
      input: { text: "cat a.md" },
      attributes: { traceKind: "tool_call", tool: { executionEvidence: "static-only" } },
    }),
  ]),
  turn("t2", 1, [message(0, "user", "Run the tests", "2026-01-01T00:00:00Z")], [
    call("step", 0, {
      kind: "event",
      name: "Model step",
      callId: null,
      startedAt: "2026-01-01T00:00:01Z",
      endedAt: "2026-01-01T00:00:03Z",
      attributes: { traceKind: "event", eventType: "deepseek.step" },
    }),
    call("test", 1, { status: "failed", input: { text: "npm test" }, error: "1 failed" }),
  ]),
];

const fullFirstTurn: SessionTurnDetail = {
  ...preview[0],
  spans: [
    { ...preview[0].spans[0], output: { text: "a.md\nb.md\nthe full listing" } },
    preview[0].spans[1],
  ],
};

async function render(options: {
  loadTrajectory?: (sessionKey: string) => Promise<SessionTurnDetail[]>;
  onLoadTurn?: (turnId: string) => Promise<SessionTurnDetail | null>;
  loadContext?: (sessionKey: string) => Promise<SessionContextSample[]>;
} = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const loadTrajectory = options.loadTrajectory ?? vi.fn(async () => preview);
  const onLoadTurn = options.onLoadTurn ?? vi.fn(async () => fullFirstTurn);
  const loadContext = options.loadContext ?? vi.fn(async () => []);
  await act(async () => {
    root!.render(
      <TrajectoryView
        sessionKey="deepseek:s1"
        version="1"
        language="en"
        matchedTurnId={null}
        findRequest={0}
        loadTrajectory={loadTrajectory}
        loadContext={loadContext}
        onLoadTurn={onLoadTurn}
      />,
    );
  });
  return { host, loadTrajectory, onLoadTurn, loadContext };
}

function rowTexts(element: HTMLElement): string[] {
  return [...element.querySelectorAll<HTMLElement>(".trajectory-ledger [data-row-kind]")].map((row) =>
    [...row.children].map((part) => part.textContent!.replace(/\s+/g, " ").trim()).join(" "));
}

function button(element: HTMLElement, label: string): HTMLButtonElement {
  const found = [...element.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

describe("TrajectoryView", () => {
  it("lists one line per message and call under each Turn, newest Turn last", async () => {
    const { host: element, loadTrajectory } = await render();

    expect(loadTrajectory).toHaveBeenCalledWith("deepseek:s1");
    expect(element.querySelector(".trajectory-count")?.textContent).toBe("2 Turns · 3 calls");
    expect(rowTexts(element)).toEqual([
      expect.stringMatching(/^Turn 1 .*10s .*12K/),
      "User List the files",
      expect.stringMatching(/^Tool bash ls -la → a\.md b\.md… 2\.0s$/),
      expect.stringMatching(/^Subcall bash cat a\.md 2\.0s$/),
      "Assistant Two files.",
      expect.stringMatching(/^Turn 2 /),
      "User Run the tests",
      "Assistant (called tools only) 2.0s",
      expect.stringMatching(/^Tool bash npm test → 1 failed Failed 2\.0s$/),
    ]);
  });

  it("folds subcalls and calls from the toolbar and searches what is folded", async () => {
    const { host: element } = await render();

    await act(async () => button(element, "Subcalls").click());
    expect(button(element, "Subcalls").getAttribute("aria-pressed")).toBe("false");
    expect(rowTexts(element)).toContainEqual(expect.stringMatching(/^Tool bash ls -la → a\.md b\.md… \+1 2\.0s$/));

    const search = element.querySelector<HTMLInputElement>(".trajectory-search input")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(search, "cat a");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rowTexts(element)).toEqual([
      expect.stringMatching(/^Turn 1 /),
      expect.stringMatching(/^Tool bash ls -la/),
      expect.stringMatching(/^Subcall bash cat a\.md/),
    ]);

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(search, "");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(element, "Calls").click());
    expect(rowTexts(element).some((text) => text.startsWith("Tool"))).toBe(false);
  });

  it("opens a call with its full input and output from the loaded Turn", async () => {
    const { host: element, onLoadTurn } = await render();

    const callRow = [...element.querySelectorAll<HTMLElement>("[data-row-kind=span]")][0];
    await act(async () => callRow.click());

    expect(onLoadTurn).toHaveBeenCalledWith("t1");
    expect(callRow.getAttribute("aria-current")).toBe("true");
    const inspector = element.querySelector<HTMLElement>(".trajectory-inspector")!;
    expect(inspector.querySelector("h3")?.textContent).toBe("bash");
    expect([...inspector.querySelectorAll("pre")].map((pre) => pre.textContent)).toEqual([
      "ls -la",
      "a.md\nb.md\nthe full listing",
    ]);

    await act(async () => button(inspector, "Close").click());
    expect(element.querySelector(".trajectory-inspector")).toBeNull();
  });

  it("says why the trajectory could not load", async () => {
    const { host: element } = await render({
      loadTrajectory: async () => {
        throw new Error("Error invoking remote method 'session:trajectory': Error: database closed");
      },
    });

    expect(element.querySelector("[role=alert]")?.textContent).toContain("database closed");
    expect(element.querySelector("[role=alert]")?.textContent).not.toContain("invoking remote method");
  });

  it("draws the context each model call sent above the ledger and names the Turn under the pointer", async () => {
    const turnIds = preview.map((turn) => turn.id);
    const call = (turnIndex: number, occurredAt: string, cached: number): SessionContextSample => ({
      turnId: turnIds[turnIndex], turnIndex, occurredAt, inputTokens: 10, cachedInputTokens: cached, cacheCreationInputTokens: 0, outputTokens: 5,
    });
    const { loadContext } = await render({
      loadContext: vi.fn(async () => [
        call(0, "2026-11-23T08:00:01.000Z", 90_000),
        call(0, "2026-11-23T08:00:03.000Z", 180_000),
        call(1, "2026-11-23T08:01:01.000Z", 40_000),
      ]),
    });

    expect(loadContext).toHaveBeenCalledWith("deepseek:s1");
    expect(host!.querySelector(".trajectory-lanes")).toBeNull();
    const chart = host!.querySelector<SVGSVGElement>(".trajectory-context svg")!;
    expect(host!.querySelector(".trajectory-context-label")?.textContent).toBe("Context180K");
    expect(host!.querySelectorAll(".trajectory-context-compaction")).toHaveLength(1);

    chart.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 80, width: 900, height: 80, x: 0, y: 0, toJSON: () => ({}) });
    act(() => {
      chart.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 890 }));
    });
    expect(host!.querySelector(".trajectory-context-tip")?.textContent).toBe("Turn 2 · context 40,010 · after a compaction");
  });

  it("leaves out the context line for a Session without usage per model call", async () => {
    await render();
    expect(host!.querySelector(".trajectory-context")).toBeNull();
    expect(host!.querySelector(".trajectory-overview")).toBeNull();
  });
});
