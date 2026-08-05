import { describe, expect, it } from "vitest";
import { codexAdapter } from "./format-adapters";

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
});
