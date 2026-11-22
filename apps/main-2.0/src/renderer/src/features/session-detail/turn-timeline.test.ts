import { describe, expect, it } from "vitest";

import type { SessionTraceSpan, SessionTurnDetail, SessionTurnMessage } from "../../../../core/types";
import { buildTurnTimeline, durationLabel, turnTimelineSearchText } from "./turn-timeline";

function message(messageIndex: number, role: SessionTurnMessage["role"], timestamp: string): SessionTurnMessage {
  return { messageIndex, sourceMessageIndex: messageIndex, role, content: `${role} ${messageIndex}`, timestamp };
}

function span(id: string, spanIndex: number, overrides: Partial<SessionTraceSpan> = {}): SessionTraceSpan {
  return {
    id,
    parentSpanId: null,
    spanIndex,
    kind: "tool",
    name: id,
    status: "completed",
    startedAt: null,
    endedAt: null,
    callId: null,
    input: null,
    output: null,
    error: null,
    attributes: {},
    ...overrides,
  };
}

function detail(messages: SessionTurnMessage[], spans: SessionTraceSpan[]): SessionTurnDetail {
  return {
    id: "turn-1",
    turnIndex: 0,
    sourceMessageIndex: 0,
    synthetic: false,
    status: "completed",
    startedAt: null,
    endedAt: null,
    userPreview: "",
    assistantPreview: "",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    errorCount: 0,
    toolNames: [],
    messageCount: messages.length,
    spanCount: spans.length,
    messages,
    spans,
  };
}

describe("buildTurnTimeline", () => {
  it("orders timestamped items by time and keeps untimed items last in source order", () => {
    const timeline = buildTurnTimeline(detail(
      [message(0, "user", "2026-01-01T00:00:00Z"), message(1, "assistant", "")],
      [span("late", 0, { startedAt: "2026-01-01T00:00:05Z" }), span("untimed", 1)],
    ));

    expect(timeline.map((item) => item.key)).toEqual([
      "message:0",
      "span:late",
      "message:1",
      "span:untimed",
    ]);
  });

  it("applies the role filter and hides tool spans while keeping non-tool events", () => {
    const timeline = buildTurnTimeline(
      detail(
        [message(0, "user", ""), message(1, "assistant", "")],
        [
          span("tool", 0, { attributes: { traceKind: "tool_call" } }),
          span("reasoning", 1, { kind: "event", attributes: { eventType: "codex.reasoning_summary" } }),
        ],
      ),
      false,
      "assistant",
    );

    expect(timeline.map((item) => item.key)).toEqual(["message:1", "span:reasoning"]);
  });

  it("nests only code-mode parsed spans under their exec span and searches their payloads", () => {
    const timeline = buildTurnTimeline(detail([], [
      span("exec", 0),
      span("parsed", 1, {
        parentSpanId: "exec",
        input: { cmd: "rg needle" },
        attributes: { tool: { parsedFromCodeMode: true } },
      }),
      span("runtime-child", 2, { parentSpanId: "exec" }),
    ]));

    expect(timeline.map((item) => item.key)).toEqual(["span:exec", "span:runtime-child"]);
    const exec = timeline[0];
    expect(exec.kind === "span" ? exec.childSpans.map((child) => child.span.id) : []).toEqual(["parsed"]);
    expect(turnTimelineSearchText(exec)).toContain("rg needle");
  });
});

describe("durationLabel", () => {
  it("formats milliseconds, seconds, and minutes", () => {
    expect(durationLabel(null)).toBeNull();
    expect(durationLabel(850)).toBe("850ms");
    expect(durationLabel(2_340)).toBe("2.3s");
    expect(durationLabel(42_000)).toBe("42s");
    expect(durationLabel(120_000)).toBe("2m");
    expect(durationLabel(125_000)).toBe("2m 5s");
  });
});
