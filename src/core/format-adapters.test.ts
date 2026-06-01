import { describe, expect, it } from "vitest";
import { claudeAdapter, codexAdapter, cleanTitle, isMeaningfulUserMessage } from "./format-adapters";

describe("format adapters", () => {
  it("extracts visible Claude text and skips tool blocks", () => {
    const parsed = claudeAdapter.parseLine({
      type: "assistant",
      timestamp: "2026-06-01T10:00:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading files" },
          { type: "tool_use", name: "Read", input: {} },
          { type: "text", text: "Done" },
        ],
      },
    });

    expect(parsed).toEqual({
      role: "assistant",
      content: "Reading files\nDone",
      timestamp: "2026-06-01T10:00:00Z",
    });
  });

  it("extracts visible Codex user and assistant messages", () => {
    expect(
      codexAdapter.parseLine({
        type: "response_item",
        timestamp: "2026-06-01T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "帮我读一下代码库" }],
        },
      }),
    ).toMatchObject({ role: "user", content: "帮我读一下代码库" });

    expect(
      codexAdapter.parseLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<permissions instructions>" }],
        },
      }),
    ).toBeNull();
  });

  it("filters injected user-role noise while keeping short real replies", () => {
    expect(isMeaningfulUserMessage("<environment_context>cwd=/tmp</environment_context>")).toBe(false);
    expect(isMeaningfulUserMessage("# AGENTS.md instructions")).toBe(false);
    expect(isMeaningfulUserMessage("[Request interrupted by user]")).toBe(false);
    expect(isMeaningfulUserMessage("ok")).toBe(true);
    expect(isMeaningfulUserMessage("要")).toBe(true);
  });

  it("cleans titles to the first useful line", () => {
    expect(cleanTitle("\n  Fix login flow\nsecond line")).toBe("Fix login flow");
    expect(cleanTitle("x".repeat(200))).toHaveLength(120);
  });
});
