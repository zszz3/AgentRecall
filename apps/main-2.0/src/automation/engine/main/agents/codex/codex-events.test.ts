import { describe, expect, it } from "vitest";
import { createCodexStreamState, normalizeCodexNotification } from "./codex-events";

describe("normalizeCodexNotification", () => {
  it("keeps a Codex turn alive while the app-server is reconnecting", () => {
    const state = createCodexStreamState();

    expect(normalizeCodexNotification("error", {
      error: { message: "Reconnecting... 2/5" },
      willRetry: true,
      threadId: "thread-1",
      turnId: "turn-1",
    }, state)).toEqual([{
      type: "system",
      content: "Reconnecting... 2/5",
      metadata: { willRetry: true },
    }]);
    expect(normalizeCodexNotification("turn/completed", {
      turn: { status: "completed" },
    }, state)).toEqual([{ type: "completed" }]);
    expect(state.lastError).toBe("");
  });

  it("still reports a non-retryable Codex error", () => {
    const state = createCodexStreamState();

    expect(normalizeCodexNotification("error", {
      error: { message: "Connection failed" },
      willRetry: false,
      threadId: "thread-1",
      turnId: "turn-1",
    }, state)).toEqual([{ type: "error", error: "Connection failed" }]);
    expect(state.lastError).toBe("Connection failed");
  });
});
