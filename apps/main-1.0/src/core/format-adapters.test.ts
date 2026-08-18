import { describe, expect, it } from "vitest";
import { claudeAdapter, codebuddyAdapter, codexAdapter, cleanTitle, cursorAdapter, dshAdapter, extractCursorUserQuery, getAdapter, getFormatForSource, isMeaningfulUserMessage, workbuddyAdapter } from "./format-adapters";
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

  it("strips Codex subagent notifications from user messages", () => {
    const notification = `<subagent_notification>
{"agent_path":"/root/researcher","status":{"completed":"done"}}
</subagent_notification>`;
    const mixed = `${notification}\n重启服务后我来验证`;

    expect(
      codexAdapter.parseLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: mixed }],
        },
      }),
    ).toMatchObject({ role: "user", content: "重启服务后我来验证" });

    expect(
      codexAdapter.parseLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: notification }],
        },
      }),
    ).toBeNull();
  });

  it("extracts the real Codex user_query from a system notification wrapper", () => {
    const wrapped = (query: string) => `<timestamp>Friday</timestamp>
<system_notification><task>completed</task></system_notification>
<user_query>${query}</user_query>`;
    const row = (text: string) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });

    expect(codexAdapter.parseLine(row(wrapped("真实输入"))))
      .toMatchObject({ role: "user", content: "真实输入" });
    expect(codexAdapter.parseLine(row(wrapped(
      "Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required.",
    )))).toBeNull();
  });

  it("keeps explicit image attachments without treating tool paths as files", () => {
    const parsed = codexAdapter.parseLine({
      type: "response_item",
      timestamp: "2026-06-01T10:00:00Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "看一下这张图" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          { type: "tool_use", input: { path: "/private/secret.txt" } },
        ],
      },
    });

    expect(parsed).toMatchObject({
      content: "看一下这张图",
      attachments: [
        expect.objectContaining({
          fileName: "image.png",
          mimeType: "image/png",
          previewKind: "image",
          status: "available",
        }),
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("/private/secret.txt");
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

  it("uses an independent WorkBuddy adapter without CodeBuddy's root-message filter", () => {
    expect(getFormatForSource("workbuddy-cli")).toBe("workbuddy");
    expect(getAdapter("workbuddy-cli")).toBe(workbuddyAdapter);
    expect(workbuddyAdapter.parseLine({
      type: "message",
      role: "user",
      timestamp: 1_780_321_278_404,
      content: [
        { type: "input_text", text: "code" },
        { type: "output_text", text: "keep this too" },
      ],
    })).toEqual({
      role: "user",
      content: "code\nkeep this too",
      timestamp: new Date(1_780_321_278_404).toISOString(),
    });
  });

  it("maps DeepSeek Harness to its append-only text adapter", () => {
    expect(getFormatForSource("deepseek-harness")).toBe("dsh");
    expect(getAdapter("deepseek-harness")).toBe(dshAdapter);
    expect(dshAdapter.parseLine({
      type: "user/message",
      time: 1_786_000_000_000,
      data: {
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "DSH prompt" }],
      },
      surfaceOp: "append",
    })).toMatchObject({
      role: "user",
      content: "DSH prompt",
    });
    expect(dshAdapter.parseLine({
      type: "user/message",
      data: {
        role: "user",
        source: { kind: "coordinator", form: "relay", senderSessionId: "parent" },
        content: [{ type: "text", text: "Continuable follow-up" }],
      },
      surfaceOp: "append",
    })).toMatchObject({
      role: "user",
      content: "Continuable follow-up",
    });
    expect(dshAdapter.parseLine({
      type: "user/message",
      data: {
        role: "user",
        source: { kind: "plugin" },
        content: [{ type: "text", text: "injected" }],
      },
      surfaceOp: "append",
    })).toBeNull();
    expect(dshAdapter.parseLine({
      type: "user/message",
      data: {
        role: "user",
        source: { kind: "coordinator", form: "notice" },
        content: [{ type: "text", text: "not a relay" }],
      },
      surfaceOp: "append",
    })).toBeNull();
  });

  it("resolves Qoder through its declared format instead of the Codex fallback", () => {
    expect(getFormatForSource("qoder")).toBe("qoder");
    expect(getFormatForSource("zcode-cli")).toBe("zcode");
    expect(getAdapter("qoder").parseLine({
      role: "assistant",
      message: { content: [{ type: "text", text: "Qoder reply" }] },
    })).toMatchObject({ role: "assistant", content: "Qoder reply" });
  });

  it("parses Pi text and inline image blocks without exposing tool calls", () => {
    const parsed = getAdapter("pi").parseLine({
      type: "message",
      timestamp: "2026-07-31T02:39:01.181Z",
      message: {
        role: "user",
        timestamp: Date.parse("2026-07-31T02:39:11.181Z"),
        content: [
          { type: "text", text: "Inspect this image" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/private/secret" } },
        ],
      },
    });

    expect(parsed).toMatchObject({
      role: "user",
      content: "Inspect this image",
      timestamp: "2026-07-31T02:39:11.181Z",
      attachments: [
        expect.objectContaining({
          mimeType: "image/png",
          previewKind: "image",
          source: { kind: "inline", value: "aGVsbG8=" },
        }),
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("/private/secret");
    expect(getAdapter("pi").parseLine({
      type: "message",
      timestamp: "2026-07-31T02:39:01.181Z",
      message: {
        role: "assistant",
        timestamp: "invalid",
        content: [{ type: "text", text: "Legacy fallback" }],
      },
    })).toMatchObject({ timestamp: "2026-07-31T02:39:01.181Z" });
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
    expect(isMeaningfulUserMessage(
      "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond</local-command-caveat>",
    )).toBe(false);
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

  it("strips Cursor subagent_notification noise from user_query while keeping real text", () => {
    const mixed = `<user_query>
<subagent_notification>
{"agent_path":"abc","status":{"completed":"done"}}
</subagent_notification> 我审核一下你刚刚写的，你重启一下服务
</user_query>`;
    expect(extractCursorUserQuery(mixed)).toBe("我审核一下你刚刚写的，你重启一下服务");
    expect(
      cursorAdapter.parseLine({
        role: "user",
        message: { content: [{ type: "text", text: mixed }] },
      }),
    ).toMatchObject({ role: "user", content: "我审核一下你刚刚写的，你重启一下服务" });

    const onlyNoise = `<user_query>
<subagent_notification>
{"agent_path":"abc","status":{"completed":"done"}}
</subagent_notification>
</user_query>`;
    expect(extractCursorUserQuery(onlyNoise)).toBe("");
    expect(isMeaningfulUserMessage(extractCursorUserQuery(onlyNoise))).toBe(false);
    expect(
      cursorAdapter.parseLine({
        role: "user",
        message: { content: [{ type: "text", text: onlyNoise }] },
      }),
    ).toBeNull();
  });

  it("drops Cursor's system follow-up instruction from user_query", () => {
    const followUp = "Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required. If you mention an agent or subagent in your response, link it with the `[Name](id)` Don't use generic label such as `[agent]`, `[worker]`, or `[subagent]`.";
    const raw = `<timestamp>Friday</timestamp>\n<user_query>${followUp}</user_query>`;

    expect(extractCursorUserQuery(raw)).toBe("");
    expect(isMeaningfulUserMessage(followUp)).toBe(false);
    expect(cursorAdapter.parseLine({
      role: "user",
      message: { content: [{ type: "text", text: raw }] },
    })).toBeNull();
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
