import { describe, expect, it } from "vitest";
import { codexAdapter, cleanTitle, getAdapter, getFormatForSource, workbuddyAdapter } from "./format-adapters";

describe("Codex format adapter", () => {
  it("strips subagent notifications from user messages", () => {
    const notification = `<subagent_notification>
{"agent_path":"/root/researcher","status":{"completed":"done"}}
</subagent_notification>`;

    expect(
      codexAdapter.parseLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `${notification}\n重启服务后我来验证` }],
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

  it("extracts the real user_query from a system notification wrapper", () => {
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

});

describe("WorkBuddy format adapter", () => {
  it("parses WorkBuddy messages without applying CodeBuddy's launch-message filter", () => {
    expect(getFormatForSource("workbuddy-cli")).toBe("workbuddy");
    expect(getAdapter("workbuddy-cli")).toBe(workbuddyAdapter);
    expect(workbuddyAdapter.parseLine({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "code" }],
      timestamp: 1_780_000_000_000,
    })).toEqual({
      role: "user",
      content: "code",
      timestamp: "2026-05-28T20:26:40.000Z",
    });
  });
});

describe("Qwen format adapter", () => {
  it("uses display text and keeps reasoning out of visible messages", () => {
    expect(getAdapter("qwen-code").parseLine({
      type: "user",
      systemPayload: { displayText: "用户看到的问题" },
      message: { parts: [{ text: "内部提示" }] },
    })).toMatchObject({ role: "user", content: "用户看到的问题" });
    expect(getAdapter("qwen").parseLine({
      type: "assistant",
      message: { parts: [{ thought: true, text: "推理" }, { text: "回答" }] },
    })).toMatchObject({ role: "assistant", content: "回答" });
    expect(getAdapter("qwen").parseLine({ type: "assistant", message: { text: "文本回退" } })).toMatchObject({ role: "assistant", content: "文本回退" });
    expect(getAdapter("qwen").parseLine({ type: "assistant", message: { text: "不得回退的推理", parts: [{ thought: true, text: "推理" }] } })).toBeNull();
    expect(getAdapter("qwen").parseLine({ type: "tool_result", message: { text: "工具输出" } })).toBeNull();
  });
});

describe("cleanTitle", () => {
  it("keeps the first useful line and truncates by code point", () => {
    expect(cleanTitle("\n  Fix login flow\nsecond line")).toBe("Fix login flow");
    expect(cleanTitle("x".repeat(200))).toHaveLength(120);
  });

  it("decodes percent-encoded titles and drops truncated UTF-8 sequences", () => {
    expect(
      cleanTitle("https://example.com/p/1?from=search#1.2.1-%E4%BD%BF%E7%94%A8%E8%85%BE%E8%AE%AF%E4%BA"),
    ).toBe("https://example.com/p/1?from=search#1.2.1-使用腾讯");
    const heading = "使用腾讯云文档做知识库检索与写作指南".repeat(8);
    const cleaned = cleanTitle(`https://example.com/p/1#${encodeURIComponent(heading)}`);
    expect(cleaned.startsWith("https://example.com/p/1#使用腾讯")).toBe(true);
    expect(cleaned).not.toMatch(/%/);
    expect(Array.from(cleaned)).toHaveLength(120);
    expect(cleanTitle("keep 100% done")).toBe("keep 100% done");
  });
});
