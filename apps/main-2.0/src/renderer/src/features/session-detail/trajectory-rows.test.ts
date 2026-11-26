import { describe, expect, it } from "vitest";

import type { SessionTraceSpan, SessionTurnDetail, SessionTurnMessage } from "../../../../core/types";
import { trajectoryRows, type TrajectoryOptions, type TrajectoryRow } from "./trajectory-rows";

const all: TrajectoryOptions = { turns: true, calls: true, subcalls: true, query: "" };

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
    startedAt: null,
    endedAt: null,
    callId: id,
    input: null,
    output: null,
    error: null,
    attributes: { traceKind: "tool_call" },
    ...overrides,
  };
}

function turn(id: string, turnIndex: number, startedAt: string, endedAt: string, messages: SessionTurnMessage[], spans: SessionTraceSpan[] = []): SessionTurnDetail {
  return {
    id,
    turnIndex,
    sourceMessageIndex: 0,
    synthetic: false,
    status: "completed",
    startedAt,
    endedAt,
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

const session = [
  turn("t1", 0, "2026-01-01T00:00:00Z", "2026-01-01T00:00:10Z", [
    message(0, "user", "List the\nfiles", "2026-01-01T00:00:00Z"),
    message(1, "assistant", "", "2026-01-01T00:00:02Z"),
    message(2, "assistant", "Two files.", "2026-01-01T00:00:10Z"),
  ], [
    call("ls", 0, {
      startedAt: "2026-01-01T00:00:04Z",
      endedAt: "2026-01-01T00:00:06Z",
      input: { text: "ls -la" },
      output: { text: "a.md\nb.md" },
    }),
    call("parsed", 1, {
      parentSpanId: "ls",
      startedAt: "2026-01-01T00:00:05Z",
      input: { text: "cat a.md" },
      attributes: { traceKind: "tool_call", tool: { executionEvidence: "static-only" } },
    }),
  ]),
  turn("t2", 1, "2026-01-01T01:00:00Z", "2026-01-01T01:00:01Z", [
    message(0, "user", "Thanks", "2026-01-01T01:00:00Z"),
  ]),
];

function summary(rows: TrajectoryRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "turn") return `turn ${row.turn.turnIndex}`;
    if (row.kind === "message") return `${row.message.role} ${row.text}`;
    if (row.kind === "step") return `step ${row.text}`;
    return `${"  ".repeat(row.depth)}${row.span.name} ${row.input} → ${row.output}${row.foldedSubcalls ? ` +${row.foldedSubcalls}` : ""}`;
  });
}

function modelStep(id: string, spanIndex: number, startedAt: string, endedAt: string, reasoning: string): SessionTraceSpan {
  return call(id, spanIndex, {
    kind: "event",
    name: "Model step",
    callId: null,
    startedAt,
    endedAt,
    output: reasoning ? { text: reasoning } : null,
    attributes: { traceKind: "event", eventType: "deepseek.step" },
  });
}

describe("trajectoryRows", () => {
  it("lists each Turn's messages and calls in time order on one line each, skipping empty answers", () => {
    expect(summary(trajectoryRows(session, all))).toEqual([
      "turn 0",
      "user List the files",
      "bash ls -la → a.md b.md",
      "  bash cat a.md → ",
      "assistant Two files.",
      "turn 1",
      "user Thanks",
    ]);
  });

  it("folds subcalls into their call, hides calls and Turn headers independently", () => {
    expect(summary(trajectoryRows(session, { ...all, subcalls: false }))).toContain("bash ls -la → a.md b.md +1");
    expect(summary(trajectoryRows(session, { ...all, calls: false }))).toEqual([
      "turn 0",
      "user List the files",
      "assistant Two files.",
      "turn 1",
      "user Thanks",
    ]);
    expect(summary(trajectoryRows(session, { ...all, turns: false }))[0]).toBe("user List the files");
  });

  it("searches folded subcalls too and keeps only the Turns with a match", () => {
    expect(summary(trajectoryRows(session, { ...all, subcalls: false, query: "CAT A" }))).toEqual([
      "turn 0",
      "bash ls -la → a.md b.md",
      "  bash cat a.md → ",
    ]);
  });

  it("shows the model step before each call as an assistant line, folded together with the calls", () => {
    const stepped = [turn("t1", 0, "2026-01-01T00:00:00Z", "2026-01-01T00:00:09Z", [
      message(0, "user", "List the files", "2026-01-01T00:00:00Z"),
      message(1, "assistant", "One file.", "2026-01-01T00:00:09Z"),
    ], [
      modelStep("s1", 0, "2026-01-01T00:00:01Z", "2026-01-01T00:00:03Z", "Look at\nthe folder first"),
      call("ls", 1, { startedAt: "2026-01-01T00:00:03Z", endedAt: "2026-01-01T00:00:04Z", input: { text: "ls" } }),
      modelStep("s2", 2, "2026-01-01T00:00:05Z", "2026-01-01T00:00:06Z", ""),
      call("cat", 3, { startedAt: "2026-01-01T00:00:06Z", endedAt: "2026-01-01T00:00:07Z", input: { text: "cat a.md" } }),
    ])];

    const rows = trajectoryRows(stepped, all);
    expect(rows.map((row) => row.kind === "step" ? `step:${row.text}` : row.kind === "span" ? `call:${row.input}` : row.kind === "message" ? `${row.message.role}:${row.text}` : "turn"))
      .toEqual(["turn", "user:List the files", "step:Look at the folder first", "call:ls", "step:", "call:cat a.md", "assistant:One file."]);
    expect(trajectoryRows(stepped, { ...all, calls: false }).map((row) => row.kind)).toEqual(["turn", "message", "message"]);
    expect(trajectoryRows(stepped, { ...all, query: "folder" }).map((row) => row.key)).toEqual(["turn:t1", "span:s1"]);
  });
});
