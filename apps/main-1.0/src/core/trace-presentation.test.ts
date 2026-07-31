import { describe, expect, it } from "vitest";
import {
  normalizeSessionTraceStatus,
  traceDetailText,
  traceDurationLabel,
  tracePresentation,
} from "./trace-presentation";

describe("normalizeSessionTraceStatus", () => {
  it("normalizes legacy status values at read boundaries", () => {
    expect(normalizeSessionTraceStatus("success")).toBe("completed");
    expect(normalizeSessionTraceStatus("failure")).toBe("failed");
    expect(normalizeSessionTraceStatus("running")).toBe("running");
    expect(normalizeSessionTraceStatus("invalid")).toBeNull();
  });
});

describe("tracePresentation", () => {
  it("classifies lifecycle visibility", () => {
    expect(tracePresentation({ kind: "event", eventType: "codex.turn.started" })).toEqual({
      category: "lifecycle",
      visibility: "hidden",
    });
    expect(tracePresentation({ kind: "event", eventType: "codex.turn.completed" })).toEqual({
      category: "lifecycle",
      visibility: "turn_summary",
    });
  });

  it("classifies annotations and collaboration separately from tools", () => {
    for (const eventType of [
      "codex.plan",
      "codex.review.entered",
      "codex.review.exited",
      "codex.goal.updated",
    ]) {
      expect(tracePresentation({ kind: "event", eventType }).category).toBe("annotation");
    }
    for (const eventType of [
      "codex.collaboration.tool",
      "codex.collaboration.activity",
      "codex.collaboration.message",
    ]) {
      expect(tracePresentation({ kind: "event", eventType }).category).toBe("collaboration");
    }
    expect(tracePresentation({ kind: "event", eventType: "codex.reasoning_summary" }).category).toBe("reasoning");
    expect(tracePresentation({ kind: "event", eventType: "codex.context.compaction" }).category).toBe("context");
    expect(tracePresentation({ kind: "event", eventType: "codex.thread.settings" }).category).toBe("context");
    expect(tracePresentation({ kind: "tool_call", eventType: "codex.custom_tool" }).category).toBe("tool");
  });
});

describe("traceDetailText", () => {
  it("restores embedded newlines in JSON string values", () => {
    const detail = JSON.stringify({ content: "#!/bin/bash\nset -e\n" }, null, 2);
    const text = traceDetailText(detail);
    expect(text).toContain("#!/bin/bash\nset -e");
    expect(text).not.toContain("\\n");
  });

  it("keeps plain text and malformed JSON unchanged", () => {
    expect(traceDetailText("Exit code: 0\nWall time: 0.1s")).toBe("Exit code: 0\nWall time: 0.1s");
    expect(traceDetailText("{not json")).toBe("{not json");
    expect(traceDetailText("")).toBe("");
  });

  it("unwraps a truncated preview envelope into readable text", () => {
    const detail = JSON.stringify({
      preview: JSON.stringify([{ type: "input_text", text: "line 1\nline 2" }]),
      truncated: true,
    }, null, 2);
    const text = traceDetailText(detail);
    expect(text).toContain("line 1\nline 2");
    expect(text).not.toContain('\\"');
  });
});

describe("traceDurationLabel", () => {
  it("formats recorded trace durations", () => {
    expect(traceDurationLabel({ durationMs: 1_200 })).toBe("1.2s");
    expect(traceDurationLabel({ durationMs: 450 })).toBe("450ms");
    expect(traceDurationLabel({ durationMs: 75_000 })).toBe("1m 15s");
  });

  it("returns null when no usable duration is recorded", () => {
    expect(traceDurationLabel(undefined)).toBeNull();
    expect(traceDurationLabel({})).toBeNull();
    expect(traceDurationLabel({ durationMs: -5 })).toBeNull();
    expect(traceDurationLabel({ durationMs: "1200" })).toBeNull();
  });
});

describe("traceDetailText truncated JSON", () => {
  it("restores newlines even when indexing truncated the JSON mid-value", () => {
    const full = JSON.stringify({ content: "#!/bin/bash\nset -e\necho ok\n" }, null, 2);
    const truncated = `${full.slice(0, 40)}\n\n[Indexed preview truncated: 12 characters omitted]`;
    const text = traceDetailText(truncated);
    expect(text).toContain("#!/bin/bash");
    expect(text).not.toContain("\\n");
    expect(text).toContain("[Indexed preview truncated");
  });
});
