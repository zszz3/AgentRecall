import { describe, expect, it } from "vitest";
import type { SessionMessage, SessionTraceEvent } from "../../../../core/types";
import { conversationTimeline, filterConversationTimeline, timelineFindMatchKeys } from "./conversation-timeline";

function message(index: number, role: SessionMessage["role"], timestamp: string, content = `message ${index}`): SessionMessage {
  return { index, role, timestamp, content };
}

function trace(index: number, timestamp: string, overrides: Partial<SessionTraceEvent> = {}): SessionTraceEvent {
  return { index, kind: "tool_call", source: "codex", title: `tool ${index}`, detail: "", timestamp, ...overrides };
}

describe("conversation timeline", () => {
  it("interleaves by time, keeps traces inside the loaded window, and sorts unknown times last", () => {
    const items = conversationTimeline(
      [
        message(0, "user", "2026-01-01T00:00:10Z"),
        message(1, "assistant", "2026-01-01T00:00:30Z"),
        message(2, "assistant", ""),
      ],
      [
        trace(0, "2026-01-01T00:00:20Z"),
        trace(1, "2026-01-01T00:00:01Z"),
        trace(2, "2026-01-01T00:00:01Z", { sourceTurnId: "turn-1" }),
        trace(3, "2026-01-01T00:00:40Z"),
        trace(4, "2026-01-01T00:00:15Z", { kind: "event", eventType: "task_started" }),
        trace(5, "2026-01-01T00:00:10Z", { kind: "event", eventType: "codex.plan" }),
        trace(6, ""),
      ],
    );

    expect(items.map((item) => item.key)).toEqual([
      "trace:2",
      "message:0",
      "trace:5",
      "trace:0",
      "message:1",
      "message:2",
      "trace:6",
    ]);
  });

  it("filters by role and tool visibility, then finds matches in messages and trace fields", () => {
    const items = conversationTimeline(
      [message(0, "user", "", "Deploy the API"), message(1, "assistant", "", "Done")],
      [
        trace(0, "", { title: "Run deploy", eventType: "exec_command" }),
        trace(1, "", { kind: "event", title: "Plan", detail: "Deploy first", eventType: "codex.plan" }),
      ],
    );

    const userWithoutTools = filterConversationTimeline(items, "user", false);
    expect(userWithoutTools.map((item) => item.key)).toEqual(["message:0", "trace:1"]);
    expect(filterConversationTimeline(items, "all", true)).toHaveLength(4);

    expect(timelineFindMatchKeys(filterConversationTimeline(items, "all", true), ["deploy"])).toEqual([
      "message:0",
      "trace:0",
      "trace:1",
    ]);
    expect(timelineFindMatchKeys(userWithoutTools, ["exec_command"])).toEqual([]);
    expect(timelineFindMatchKeys(items, [])).toEqual([]);
  });
});
