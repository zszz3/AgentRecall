import { describe, expect, it } from "vitest";
import { claudeAdapter, codebuddyAdapter, codexAdapter, cleanTitle, cursorAdapter, extractCursorUserQuery, getAdapter, getFormatForSource, isMeaningfulUserMessage } from "./format-adapters";
import { decodeCursorWorkspaceSlug, parseCursorTranscriptPath } from "./session-loader";
import * as path from "node:path";

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

  it("extracts visible CodeBuddy CLI messages", () => {
    expect(
      codebuddyAdapter.parseLine({
        type: "message",
        role: "assistant",
        timestamp: 1_780_321_303_135,
        content: [{ type: "output_text", text: "我来处理" }],
      }),
    ).toEqual({
      role: "assistant",
      content: "我来处理",
      timestamp: new Date(1_780_321_303_135).toISOString(),
    });
  });

  it("resolves Qoder through its declared format instead of the Codex fallback", () => {
    expect(getFormatForSource("qoder")).toBe("qoder");
    expect(getFormatForSource("zcode-cli")).toBe("zcode");
    expect(getAdapter("qoder").parseLine({
      role: "assistant",
      message: { content: [{ type: "text", text: "Qoder reply" }] },
    })).toMatchObject({ role: "assistant", content: "Qoder reply" });
  });

  it("skips the CodeBuddy CLI bootstrap 'code' root message", () => {
    // The CLI injects a root user message whose text is the literal launch
    // keyword "code"; it must not become the session title.
    expect(
      codebuddyAdapter.parseLine({
        type: "message",
        role: "user",
        timestamp: 1_780_321_278_404,
        content: [{ type: "input_text", text: "code" }],
      }),
    ).toBeNull();
  });

  it("keeps a real later message that happens to say 'code'", () => {
    expect(
      codebuddyAdapter.parseLine({
        type: "message",
        role: "user",
        parentId: "root-1",
        timestamp: 1_780_321_303_135,
        content: [{ type: "input_text", text: "code" }],
      }),
    ).toEqual({
      role: "user",
      content: "code",
      timestamp: new Date(1_780_321_303_135).toISOString(),
    });
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

  it("extracts Cursor user_query and skips tool blocks", () => {
    expect(extractCursorUserQuery("<timestamp>Sunday</timestamp>\n<user_query>\nFix sidebar\n</user_query>")).toBe("Fix sidebar");

    expect(
      cursorAdapter.parseLine({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>\nFix sidebar\n</user_query>" }],
        },
      }),
    ).toMatchObject({ role: "user", content: "Fix sidebar" });

    expect(
      cursorAdapter.parseLine({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading files" },
            { type: "tool_use", name: "Read", input: { path: "src/App.tsx" } },
          ],
        },
      }),
    ).toEqual({
      role: "assistant",
      content: "Reading files",
      timestamp: "",
    });
  });

  it("decodes Cursor workspace slugs and subagent paths", () => {
    const pathMap = new Map([
      ["Users-mac-myProject-agent-recall", "/Users/mac/myProject/agent-recall"],
    ]);
    expect(decodeCursorWorkspaceSlug("Users-mac-myProject-agent-recall", pathMap)).toBe("/Users/mac/myProject/agent-recall");
    expect(decodeCursorWorkspaceSlug("empty-window")).toBe("");

    const filePath = path.join(
      "/Users/mac/.cursor/projects/Users-mac-work-app/agent-transcripts/parent-1/subagents/agent-1.jsonl",
    );
    expect(parseCursorTranscriptPath(filePath)).toEqual({
      workspaceSlug: "Users-mac-work-app",
      sessionId: "agent-1",
      isSubagent: true,
      parentSessionId: "parent-1",
    });
  });
});
