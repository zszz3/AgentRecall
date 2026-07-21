import { describe, expect, test } from "vitest";
import { createCodexStreamState, normalizeCodexNotification } from "./codex-events";

describe("normalizeCodexNotification", () => {
  test("streams item agent message deltas", () => {
    const state = createCodexStreamState();

    expect(normalizeCodexNotification("item/agentMessage/delta", { itemId: "a", delta: "Hel" }, state)).toEqual([
      { type: "delta", content: "Hel" },
    ]);
    expect(normalizeCodexNotification("item/agentMessage/delta", { itemId: "a", delta: "lo" }, state)).toEqual([
      { type: "delta", content: "lo" },
    ]);
    expect(state.lastText).toBe("Hello");
  });

  test("uses completed raw response text when no deltas were emitted", () => {
    const state = createCodexStreamState();
    const events = normalizeCodexNotification(
      "rawResponseItem/completed",
      { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
      state,
    );

    expect(events).toEqual([{ type: "delta", content: "Done" }]);
    expect(state.lastText).toBe("Done");
  });

  test("ignores raw developer and user context items", () => {
    const state = createCodexStreamState();

    expect(
      normalizeCodexNotification(
        "rawResponseItem/completed",
        { item: { type: "message", role: "developer", content: [{ type: "input_text", text: "hidden system text" }] } },
        state,
      ),
    ).toEqual([]);
    expect(
      normalizeCodexNotification(
        "rawResponseItem/completed",
        { item: { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] } },
        state,
      ),
    ).toEqual([]);
    expect(state.lastText).toBe("");
  });

  test("emits structured tool events for tool calls and results", () => {
    const state = createCodexStreamState();

    expect(
      normalizeCodexNotification(
        "rawResponseItem/completed",
        { item: { type: "function_call", call_id: "call-1", name: "shell_command", arguments: "{\"command\":\"ls src\"}" } },
        state,
      ),
    ).toEqual([{ type: "tool_call", name: "shell_command", content: "ls src" }]);
    expect(
      normalizeCodexNotification(
        "rawResponseItem/completed",
        { item: { type: "function_call_output", call_id: "call-1", output: "Exit code: 0\nOutput:\nApp.tsx" } },
        state,
      ),
    ).toEqual([{ type: "tool_result", name: "shell_command", content: "Exit code: 0\nOutput:\nApp.tsx" }]);
  });

  test("maps turn completion to completed event", () => {
    const state = createCodexStreamState();

    expect(normalizeCodexNotification("turn/completed", { turn: { status: "completed" } }, state)).toEqual([
      { type: "completed" },
    ]);
  });

  test("does not duplicate final snapshots after streaming deltas", () => {
    const state = createCodexStreamState();

    expect(normalizeCodexNotification("item/agentMessage/delta", { itemId: "a", delta: "Hello" }, state)).toEqual([
      { type: "delta", content: "Hello" },
    ]);
    expect(
      normalizeCodexNotification(
        "rawResponseItem/completed",
        { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } },
        state,
      ),
    ).toEqual([]);
    expect(normalizeCodexNotification("turn/completed", { turn: { status: "completed" } }, state)).toEqual([
      { type: "completed" },
    ]);
  });
});
