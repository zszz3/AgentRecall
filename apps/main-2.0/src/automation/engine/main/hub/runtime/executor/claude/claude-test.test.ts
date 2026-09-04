import { describe, expect, it, vi } from "vitest";
import type { ClaudeAgentSdkAdapter } from "../../../../agents/claude/claude-agent-sdk";
import { runClaudeChannelTest } from "./claude-test";

describe("runClaudeChannelTest", () => {
  it("reports the native Session before returning the test result", async () => {
    const reportExecutionReference = vi.fn();
    const emit = vi.fn();
    const adapter = {
      runOneShot: vi.fn(async (input: Parameters<ClaudeAgentSdkAdapter["runOneShot"]>[0]) => {
        input.onEvent({
          type: "runtime_conversation",
          runtimeConversation: {
            runtimeId: "claude",
            codecVersion: "v1",
            payload: { native: { sessionId: "session-claude-test" } },
          },
        });
        input.onEvent({ type: "completed", content: "OK" });
      }),
    };

    await expect(runClaudeChannelTest({
      runtime: { id: "claude", label: "Claude", command: "claude", version: "test", available: true },
      channelId: "claude-default",
      modelId: "default",
      workDir: "/workspace",
      reportExecutionReference,
      emit,
    }, {
      executables: {} as never,
      channelById: () => ({
        id: "claude-default",
        label: "Claude",
        agentId: "claude",
        models: [],
      }),
    }, adapter)).resolves.toBe("OK");

    expect(reportExecutionReference).toHaveBeenCalledWith({ sessionId: "session-claude-test" });
  });
});
