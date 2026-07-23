import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionTraceEvent, TokenUsageEvent } from "../types";
import { deriveSessionTimeline, TURN_DERIVATION_VERSION } from "./derive-turns";

const messages: SessionMessage[] = [
  {
    role: "user",
    content: "Find the failing test",
    timestamp: "2026-07-23T10:00:00.000Z",
    index: 0,
  },
  {
    role: "assistant",
    content: "I will inspect the test output.",
    timestamp: "2026-07-23T10:00:01.000Z",
    index: 1,
  },
  {
    role: "user",
    content: "Fix it",
    timestamp: "2026-07-23T10:01:00.000Z",
    index: 2,
  },
  {
    role: "assistant",
    content: "The test now passes.",
    timestamp: "2026-07-23T10:01:04.000Z",
    index: 3,
  },
];

const traceEvents: SessionTraceEvent[] = [
  {
    index: 0,
    kind: "tool_call",
    source: "codex",
    title: "shell · npm test",
    detail: "{\"command\":\"npm test\"}",
    timestamp: "2026-07-23T10:00:02.000Z",
    callId: "call-1",
    status: "unknown",
  },
  {
    index: 1,
    kind: "tool_result",
    source: "codex",
    title: "tool output",
    detail: "1 test failed",
    timestamp: "2026-07-23T10:00:05.000Z",
    callId: "call-1",
    status: "failure",
  },
  {
    index: 2,
    kind: "event",
    source: "codex",
    title: "apply_patch",
    detail: "updated the assertion",
    timestamp: "2026-07-23T10:01:02.000Z",
    eventType: "patch_apply_end",
    status: "success",
  },
];

const tokenEvents: TokenUsageEvent[] = [
  {
    timestamp: Date.parse("2026-07-23T10:00:06.000Z"),
    dedupeKey: "usage-1",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 50,
    reasoningOutputTokens: 5,
    totalTokens: 175,
  },
  {
    timestamp: Date.parse("2026-07-23T10:01:05.000Z"),
    dedupeKey: "usage-2",
    inputTokens: 80,
    outputTokens: 10,
    cachedInputTokens: 20,
    reasoningOutputTokens: 0,
    totalTokens: 110,
  },
];

describe("deriveSessionTimeline", () => {
  it("creates one searchable Turn per user request and pairs tool calls with their results", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:test",
      messages,
      traceEvents,
      tokenEvents,
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]).toMatchObject({
      turnIndex: 0,
      sourceMessageIndex: 0,
      synthetic: false,
      status: "failed",
      userText: "Find the failing test",
      assistantText: "I will inspect the test output.",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 50,
      reasoningOutputTokens: 5,
      totalTokens: 175,
      errorCount: 1,
      toolNames: ["shell"],
      derivationVersion: TURN_DERIVATION_VERSION,
    });
    expect(timeline.turns[0].searchText).toContain("1 test failed");
    expect(timeline.turns[0].messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(timeline.turns[0].spans).toHaveLength(1);
    expect(timeline.turns[0].spans[0]).toMatchObject({
      kind: "tool",
      name: "shell",
      status: "failed",
      callId: "call-1",
      input: { text: "{\"command\":\"npm test\"}" },
      output: { text: "1 test failed" },
    });

    expect(timeline.turns[1]).toMatchObject({
      turnIndex: 1,
      sourceMessageIndex: 2,
      status: "completed",
      userText: "Fix it",
      assistantText: "The test now passes.",
      totalTokens: 110,
      toolNames: ["apply_patch"],
    });
  });

  it("keeps preamble events in a synthetic Turn instead of attributing them to the first request", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:preamble",
      messages: [messages[0]],
      traceEvents: [{
        ...traceEvents[2],
        index: 0,
        timestamp: "2026-07-23T09:59:00.000Z",
      }],
    });

    expect(timeline.turns).toHaveLength(2);
    expect(timeline.turns[0]).toMatchObject({
      turnIndex: 0,
      sourceMessageIndex: null,
      synthetic: true,
      toolNames: ["apply_patch"],
    });
    expect(timeline.turns[1]).toMatchObject({
      turnIndex: 1,
      sourceMessageIndex: 0,
      synthetic: false,
      userText: "Find the failing test",
    });
  });

  it("creates a synthetic Turn when a transcript has no user message", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "claude:assistant-only",
      messages: [{
        role: "assistant",
        content: "Background task finished",
        timestamp: "",
        index: 4,
      }],
      traceEvents: [],
    });

    expect(timeline.turns).toHaveLength(1);
    expect(timeline.turns[0]).toMatchObject({
      turnIndex: 0,
      sourceMessageIndex: null,
      synthetic: true,
      assistantText: "Background task finished",
    });
  });

  it("generates stable identifiers independent of input array order", () => {
    const sameTimeTokenEvents = tokenEvents.map((event) => ({
      ...event,
      timestamp: tokenEvents[0].timestamp,
    }));
    const first = deriveSessionTimeline({
      sessionKey: "codex:stable",
      messages,
      traceEvents,
      tokenEvents: sameTimeTokenEvents,
    });
    const reordered = deriveSessionTimeline({
      sessionKey: "codex:stable",
      messages: [...messages].reverse(),
      traceEvents: [...traceEvents].reverse(),
      tokenEvents: [...sameTimeTokenEvents].reverse(),
    });

    expect(reordered).toEqual(first);
  });

  it("preserves every source item as an ordered raw event", () => {
    const timeline = deriveSessionTimeline({
      sessionKey: "codex:raw",
      messages,
      traceEvents,
      tokenEvents,
    });

    expect(timeline.rawEvents).toHaveLength(messages.length + traceEvents.length + tokenEvents.length);
    expect(timeline.rawEvents.map((event) => event.eventIndex)).toEqual(
      timeline.rawEvents.map((_, index) => index),
    );
    expect(new Set(timeline.rawEvents.map((event) => event.eventId)).size).toBe(timeline.rawEvents.length);
    expect(timeline.rawEvents.map((event) => event.kind)).toEqual([
      "message",
      "message",
      "trace",
      "trace",
      "token",
      "message",
      "trace",
      "message",
      "token",
    ]);
  });
});
