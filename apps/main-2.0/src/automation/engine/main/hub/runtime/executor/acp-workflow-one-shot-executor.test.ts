import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../../../shared/types";
import { openCodeRuntimeStateCodec } from "../../../agents/opencode/opencode-runtime-state-codec";
import { AcpWorkflowOneShotExecutor } from "./acp-workflow-one-shot-executor";
import type { AgentExecutionContext } from "./agent-executor-types";

describe("AcpWorkflowOneShotExecutor", () => {
  it("publishes the native session returned by ACP attach", async () => {
    const events: AgentEvent[] = [];
    const exits: Array<number | null | undefined> = [];
    const client = {
      attach: vi.fn(async () => "session-acp"),
      prompt: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
    };
    const context: AgentExecutionContext = {
      runId: "task-1",
      runKind: "task",
      configuredAgentId: "configured-opencode",
      runtimeId: "opencode",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "model-1" },
      invocation: { surface: "workflow", role: "node", ownerReference: { workflowId: "workflow-1" } },
      runtime: { id: "opencode", label: "OpenCode", version: "1", available: true, command: "opencode" },
      channelId: "opencode-default",
      prompt: "Review",
      workDir: "/repo",
      developerInstructions: "Follow the workflow contract.",
      emit: (event) => events.push(event),
      onExit: (code) => exits.push(code),
    };

    await new AcpWorkflowOneShotExecutor(context, {
      executable: "opencode",
      args: ["acp"],
      mcpServers: [],
      modelId: "model-1",
      runtimeStateCodec: openCodeRuntimeStateCodec,
      createClient: () => client,
    }).start();

    expect(events).toEqual([{
      type: "runtime_conversation",
      runtimeConversation: {
        runtimeId: "opencode",
        codecVersion: "v1",
        payload: {
          native: { sessionId: "session-acp" },
          appContext: { cwd: "/repo", modelId: "model-1", transport: "acp" },
        },
      },
    }]);
    expect(client.prompt).toHaveBeenCalledWith("Follow the workflow contract.\n\nUser request:\nReview");
    expect(client.detach).toHaveBeenCalledOnce();
    expect(exits).toEqual([0]);
  });
});
