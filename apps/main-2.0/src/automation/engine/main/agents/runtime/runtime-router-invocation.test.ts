import { describe, expect, test, vi } from "vitest";

import type { AgentRuntime, RuntimeConversation } from "../../../shared/types";
import { codexRuntimeStateCodec } from "../codex/codex-runtime-state-codec";
import { RuntimeDriverRegistry, type RuntimeDriver } from "./runtime-driver";
import type {
  RuntimeInvocationRecorder,
  RuntimeInvocationStart,
  RuntimeInvocationStatus,
  RuntimeSessionBinding,
} from "./runtime-invocation-recorder";
import { RuntimeRouter } from "./runtime-router";

const runtime: AgentRuntime = {
  id: "codex",
  label: "Codex",
  command: "codex",
  version: "test",
  available: true,
};

function conversation(sessionId: string): RuntimeConversation {
  return codexRuntimeStateCodec.encodeConversation({ native: { threadId: sessionId } });
}

function request(runtimeConversation?: RuntimeConversation) {
  return {
    requestId: "request-1",
    prompt: "Run it",
    configuredAgentId: "agent-1",
    runtimeId: "codex" as const,
    executionMode: "oneshot" as const,
    continuationPolicy: runtimeConversation ? "resume-required" as const : "fresh" as const,
    runtimeConfig: { model: "default" },
    ...(runtimeConversation ? { runtimeConversation } : {}),
    invocation: {
      surface: "workflow" as const,
      role: "node",
      ownerReference: { workflowId: "workflow-1", runId: "run-1" },
    },
    runtime,
    channelId: "codex-default",
    workDir: "/workspace",
  };
}

function recorder(events: string[]): RuntimeInvocationRecorder {
  return {
    begin: vi.fn(async (input: RuntimeInvocationStart) => {
      events.push(`begin:${input.invocation.surface}`);
    }),
    bind: vi.fn(async (_invocationId: string, binding: RuntimeSessionBinding) => {
      events.push(`bind:${binding.sessionId}:${binding.relation}`);
    }),
    finish: vi.fn(async (
      _invocationId: string,
      status: Exclude<RuntimeInvocationStatus, "pending">,
    ) => {
      events.push(`finish:${status}`);
    }),
  };
}

function driver(askWorkflow: NonNullable<RuntimeDriver["askWorkflow"]>): RuntimeDriver {
  return {
    runtimeId: "codex",
    surfaceSupport: [{
      surface: "workflow",
      executionModes: ["oneshot"],
      continuationPolicies: ["fresh", "resume-required"],
    }],
    runtimeStateCodec: codexRuntimeStateCodec,
    getCapabilities: () => ({
      runtimeId: "codex",
      chatStyle: "oneshot",
      taskStyle: "oneshot",
      workflowStyle: "oneshot",
      testStyle: "oneshot",
      supportsInterrupt: true,
      supportsContinue: true,
      supportsApprovalRequests: true,
      supportsUserInputRequests: true,
      resume: {
        supportsInProcessConversationResume: true,
        supportsResumeAfterDetach: true,
        supportsResumeAfterAppRestart: true,
        supportsTurnResume: true,
      },
    }),
    askWorkflow,
  };
}

describe("RuntimeRouter invocation lifecycle", () => {
  test("persists pending before dispatch and binds a created Session even when Runtime fails", async () => {
    const events: string[] = [];
    const runtimeDriver = driver(async (input) => {
      events.push("driver");
      input.reportExecutionReference?.({ sessionId: "thread-created", turnId: "turn-1" });
      throw new Error("runtime failed");
    });
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      recorder(events),
      () => 1_000,
      () => "invocation-1",
    );

    await expect(router.askWorkflow(request())).rejects.toThrow("runtime failed");
    expect(events).toEqual([
      "begin:workflow",
      "driver",
      "bind:thread-created:created",
      "finish:failed",
    ]);
  });

  test("records another invocation as continued when it resumes the same Session", async () => {
    const events: string[] = [];
    const runtimeDriver = driver(async (input) => {
      input.reportExecutionReference?.({ sessionId: "thread-existing", turnId: "turn-2" });
      return {
        content: "done",
        runtimeConversation: conversation("thread-existing"),
        executionReference: { sessionId: "thread-existing", turnId: "turn-2" },
      };
    });
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      recorder(events),
      () => 2_000,
      () => "invocation-2",
    );

    await expect(router.askWorkflow(request(conversation("thread-existing"))))
      .resolves.toMatchObject({ content: "done" });
    expect(events[0]).toBe("begin:workflow");
    expect(events.filter((event) => event === "bind:thread-existing:continued").length).toBeGreaterThan(0);
    expect(events.at(-1)).toBe("finish:completed");
  });
});
