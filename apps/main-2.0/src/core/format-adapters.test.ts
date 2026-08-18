import { describe, expect, it } from "vitest";
import {
  codexAdapter,
  deepSeekHarnessAdapter,
  getAdapter,
  getFormatForSource,
  workbuddyAdapter,
} from "./format-adapters";

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

  it("drops Cursor's system follow-up instruction from user messages", () => {
    const followUp = "Perform any necessary follow-up actions in response to the subagent completion above. If no follow-up work is needed, no further action is required.";

    expect(
      codexAdapter.parseLine({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: followUp }],
        },
      }),
    ).toBeNull();
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

describe("DeepSeek Harness format adapter", () => {
  it("parses appended human and legacy assistant messages without exposing injected context", () => {
    expect(getFormatForSource("deepseek-harness")).toBe("dsh");
    expect(getAdapter("deepseek-harness")).toBe(deepSeekHarnessAdapter);
    expect(deepSeekHarnessAdapter.parseLine({
      type: "user/message",
      time: 1_780_000_000_000,
      surfaceOp: "append",
      data: {
        content: [{ type: "text", text: "Inspect the project" }],
        source: { kind: "user" },
      },
    })).toMatchObject({
      role: "user",
      content: "Inspect the project",
      timestamp: "2026-05-28T20:26:40.000Z",
    });
    expect(deepSeekHarnessAdapter.parseLine({
      type: "assistant/message",
      time: 1_780_000_001_000,
      surfaceOp: "append",
      data: {
        turn: 2,
        step: 1,
        content: [{ type: "text", text: "Done" }],
        provenance: { provider: "deepseek" },
      },
    })).toMatchObject({
      role: "assistant",
      content: "Done",
      sourceTurnId: "dsh:2",
    });
    expect(deepSeekHarnessAdapter.parseLine({
      type: "user/message",
      surfaceOp: "append",
      data: {
        source: { kind: "user" },
        content: [{
          type: "image",
          data: "data:image/png;base64,AA==",
          name: "pixel.png",
        }],
      },
    })).toMatchObject({
      role: "user",
      content: "[Attachment]",
      attachments: [{
        fileName: "pixel.png",
        mimeType: "image/png",
        status: "available",
        source: { kind: "inline", value: "AA==" },
      }],
    });
    expect(deepSeekHarnessAdapter.parseLine({
      type: "user/message",
      surfaceOp: "append",
      data: {
        content: [{ type: "text", text: "delegated request" }],
        source: { kind: "coordinator", form: "relay" },
      },
    })).toMatchObject({
      role: "user",
      content: "delegated request",
    });
    expect(deepSeekHarnessAdapter.parseLine({
      type: "user/message",
      surfaceOp: "append",
      data: {
        content: [{ type: "text", text: "runtime context" }],
        source: { kind: "plugin" },
      },
    })).toBeNull();
    expect(deepSeekHarnessAdapter.parseLine({
      type: "assistant/message",
      surfaceOp: { op: "replace", start: 1, end: 2 },
      data: { content: [{ type: "text", text: "compacted" }] },
    })).toBeNull();
  });
});
