import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SessionTurnDetail, SessionTurnSummary } from "../../../../core/types";

const detailStyles = readFileSync(new URL("../../styles/session-detail.css", import.meta.url), "utf8");

async function loadTurnAccordion(): Promise<Record<string, any> | null> {
  try {
    return await import("./turn-accordion");
  } catch {
    return null;
  }
}

const summary: SessionTurnSummary = {
  id: "turn-1",
  turnIndex: 0,
  sourceMessageIndex: 0,
  synthetic: false,
  status: "completed",
  startedAt: "2026-07-24T08:00:00.000Z",
  endedAt: "2026-07-24T08:00:03.000Z",
  userPreview: "Inspect the failing test",
  assistantPreview: "I found the cause.",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 40,
  reasoningOutputTokens: 5,
  totalTokens: 165,
  errorCount: 0,
  toolNames: ["Read"],
  messageCount: 2,
  spanCount: 1,
};

const detail: SessionTurnDetail = {
  ...summary,
  messages: [
    {
      messageIndex: 0,
      sourceMessageIndex: 0,
      role: "user",
      content: "Inspect the failing test",
      timestamp: "2026-07-24T08:00:00.000Z",
    },
    {
      messageIndex: 1,
      sourceMessageIndex: 1,
      role: "assistant",
      content: "I found the cause.",
      timestamp: "2026-07-24T08:00:03.000Z",
    },
  ],
  spans: [
    {
      id: "span-1",
      parentSpanId: null,
      spanIndex: 0,
      kind: "tool",
      name: "Read",
      status: "completed",
      startedAt: "2026-07-24T08:00:01.000Z",
      endedAt: "2026-07-24T08:00:02.000Z",
      callId: "call-1",
      input: { path: "src/app.ts" },
      output: { text: "file contents" },
      error: null,
      attributes: {},
    },
  ],
};

describe("TurnAccordion", () => {
  it("keeps multiple Turn cards expanded until each is explicitly closed", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    let state = feature.createTurnAccordionState("session-a");
    state = feature.turnAccordionReducer(state, { type: "toggle", turnId: "turn-1" });
    state = feature.turnAccordionReducer(state, { type: "toggle", turnId: "turn-2" });
    expect([...state.expandedTurnIds]).toEqual(["turn-1", "turn-2"]);

    state = feature.turnAccordionReducer(state, { type: "toggle", turnId: "turn-1" });
    expect([...state.expandedTurnIds]).toEqual(["turn-2"]);
  });

  it("caches loaded detail and clears expansion state for another Session", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    let state = feature.createTurnAccordionState("session-a");
    state = feature.turnAccordionReducer(state, { type: "open", turnId: "turn-1" });
    state = feature.turnAccordionReducer(state, { type: "load-started", turnId: "turn-1" });
    state = feature.turnAccordionReducer(state, { type: "load-succeeded", turnId: "turn-1", detail });
    expect(state.detailsById["turn-1"]).toEqual(detail);
    expect(state.loadingTurnIds.has("turn-1")).toBe(false);

    state = feature.turnAccordionReducer(state, { type: "reset", sessionKey: "session-b" });
    expect(state.sessionKey).toBe("session-b");
    expect([...state.expandedTurnIds]).toEqual([]);
    expect(state.detailsById).toEqual({});
  });

  it("interleaves Turn messages and spans by observed time", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    expect(feature.buildTurnTimeline(detail).map((item: { key: string }) => item.key)).toEqual([
      "message:0",
      "span:span-1",
      "message:1",
    ]);
  });

  it("renders every Turn collapsed by default", async () => {
    const feature = await loadTurnAccordion();
    expect(feature).not.toBeNull();
    if (!feature) return;

    const html = renderToStaticMarkup(createElement(feature.TurnAccordion, {
      sessionKey: "session-a",
      turns: [summary],
      loading: false,
      matchedTurnId: null,
      query: "",
      language: "zh",
      onLoadTurn: async () => detail,
    }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Inspect the failing test");
    expect(html).not.toContain("file contents");
  });

  it("defines compact Turn, timeline, and nested payload styles", () => {
    for (const selector of [
      ".turn-conversation",
      ".turn-count",
      ".turn-card",
      ".turn-card-summary",
      ".turn-card-detail",
      ".turn-timeline",
      ".turn-message",
      ".turn-span",
      ".turn-span-payload",
    ]) {
      expect(detailStyles).toContain(selector);
    }
  });
});
