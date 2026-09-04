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
import { runtimeInvocationErrorMessage } from "./runtime-invocation-recorder";
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
      continuationPolicies: ["fresh", "resume-preferred", "resume-required"],
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
  test("fails before Runtime dispatch when the durable recorder is missing", async () => {
    const askWorkflow = vi.fn(async () => ({ content: "must not run" }));
    const router = new RuntimeRouter(new RuntimeDriverRegistry([driver(askWorkflow)]));

    await expect(router.askWorkflow(request())).rejects.toThrow(/durable Runtime invocation recorder/i);
    expect(askWorkflow).not.toHaveBeenCalled();
  });

  test("redacts and bounds persisted Runtime errors", () => {
    const message = runtimeInvocationErrorMessage(
      `Authorization: Bearer private-token\npassword=visible\n${"x".repeat(5_000)}`,
    );

    expect(message).not.toContain("private-token");
    expect(message).not.toContain("password=visible");
    expect(message).toContain("Authorization: [REDACTED]");
    expect(message.length).toBeLessThanOrEqual(4_000);
  });

  test("rejects oversized identifiers reported by an untrusted Runtime", async () => {
    const runtimeDriver = driver(async (input) => {
      input.reportExecutionReference?.({ sessionId: "s".repeat(1_001) });
      return { content: "must not succeed" };
    });
    const events: string[] = [];
    const durableRecorder = recorder(events);
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      durableRecorder,
      () => 1_000,
      () => "invocation-oversized-reference",
    );

    await expect(router.askWorkflow(request())).rejects.toThrow(/Session identifier.*limit/i);
    expect(durableRecorder.bind).not.toHaveBeenCalled();
    expect(durableRecorder.finish).toHaveBeenCalledWith(
      "invocation-oversized-reference",
      "failed",
      1_000,
      expect.stringMatching(/Session identifier.*limit/i),
    );
  });

  test("rejects a Session envelope owned by a different Runtime", async () => {
    const runtimeDriver = driver(async () => ({
      content: "must not succeed",
      runtimeConversation: {
        runtimeId: "claude",
        codecVersion: "test",
        payload: { native: { sessionId: "claude-session" } },
      },
    }));
    const events: string[] = [];
    const durableRecorder = recorder(events);
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      durableRecorder,
      () => 1_000,
      () => "invocation-wrong-runtime",
    );

    await expect(router.askWorkflow(request())).rejects.toThrow(
      /codex Runtime reported a Session owned by claude/i,
    );
    expect(durableRecorder.bind).not.toHaveBeenCalled();
    expect(durableRecorder.finish).toHaveBeenCalledWith(
      "invocation-wrong-runtime",
      "failed",
      1_000,
      expect.stringMatching(/owned by claude/i),
    );
  });

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

  test("waits for an observed Session binding before finalizing a failed invocation", async () => {
    const binding = deferred<void>();
    const finish = vi.fn(async () => undefined);
    const durableRecorder: RuntimeInvocationRecorder = {
      begin: vi.fn(async () => undefined),
      bind: vi.fn(async () => binding.promise),
      finish,
    };
    const runtimeDriver = driver(async (input) => {
      input.reportExecutionReference?.({ sessionId: "thread-before-failure" });
      throw new Error("turn failed");
    });
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      durableRecorder,
      () => 1_500,
      () => "invocation-binding-order",
    );

    const execution = router.askWorkflow(request());
    await vi.waitFor(() => expect(durableRecorder.bind).toHaveBeenCalled());
    expect(finish).not.toHaveBeenCalled();
    binding.resolve();
    await expect(execution).rejects.toThrow("turn failed");
    expect(finish).toHaveBeenCalledWith(
      "invocation-binding-order",
      "failed",
      1_500,
      "turn failed",
    );
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

  test("does not bind the requested Session when continuation fails before Runtime reports a reference", async () => {
    const events: string[] = [];
    const runtimeDriver = driver(async () => {
      throw new Error("resume failed before attach");
    });
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      recorder(events),
      () => 2_500,
      () => "invocation-resume-before-reference",
    );

    await expect(router.askWorkflow(request(conversation("thread-requested"))))
      .rejects.toThrow("resume failed before attach");
    expect(events).toEqual([
      "begin:workflow",
      "finish:failed",
    ]);
  });

  test("propagates one invocation id through the Runtime request and emitted events", async () => {
    const events: string[] = [];
    const onEvent = vi.fn();
    const runtimeDriver = driver(async (input) => {
      expect(input.invocationId).toBe("invocation-propagated");
      expect(input.environmentId).toBe("ssh-dev");
      input.onEvent?.({ requestId: input.requestId, type: "delta", content: "working" });
      input.reportExecutionReference?.({ sessionId: "thread-propagated" });
      return { content: "done" };
    });
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      recorder(events),
      () => 3_000,
      () => "invocation-propagated",
    );

    const response = await router.askWorkflow({
      ...request(),
      invocationId: "invocation-propagated",
      environmentId: "ssh-dev",
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "delta",
      invocationId: "invocation-propagated",
    }));
    expect(response.executionReference).toEqual({ invocationId: "invocation-propagated" });
  });

  test("binds the native Session created by a channel test", async () => {
    const events: string[] = [];
    const runtimeDriver: RuntimeDriver = {
      ...driver(async () => ({ content: "unused" })),
      surfaceSupport: [{
        surface: "channel-test",
        executionModes: ["oneshot"],
        continuationPolicies: ["fresh"],
      }],
      testChannel: async (input) => {
        expect(input.invocationId).toBe("invocation-channel-test");
        input.emit({ type: "phase", content: "Runtime started" });
        input.reportExecutionReference?.({ sessionId: "thread-channel-test" });
        return "OK";
      },
    };
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      recorder(events),
      () => 3_500,
      () => "invocation-channel-test",
    );

    const emit = vi.fn();
    await expect(router.testChannel("codex", {
      runtime,
      channelId: "codex-default",
      modelId: "default",
      workDir: "/workspace",
      emit,
    })).resolves.toBe("OK");

    expect(emit).toHaveBeenCalledWith({
      type: "phase",
      content: "Runtime started",
      invocationId: "invocation-channel-test",
    });

    expect(events).toEqual([
      "begin:system",
      "bind:thread-channel-test:created",
      "finish:completed",
    ]);
  });

  test("marks a resume-preferred fallback as created when the Runtime returns a new Session", async () => {
    const events: string[] = [];
    const runtimeDriver = driver(async (input) => {
      input.reportExecutionReference?.({ sessionId: "thread-new" });
      return { content: "done", runtimeConversation: conversation("thread-new") };
    });
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      recorder(events),
      () => 4_000,
      () => "invocation-fallback",
    );

    await router.askWorkflow({
      ...request(conversation("thread-old")),
      continuationPolicy: "resume-preferred",
    });

    expect(events).toContain("bind:thread-new:created");
    expect(events).not.toContain("bind:thread-new:continued");
    expect(events).not.toContain("bind:thread-old:continued");
  });

  test("reports binding failures instead of publishing a successful Workflow result", async () => {
    const bindingError = new Error("binding failed");
    const failingRecorder: RuntimeInvocationRecorder = {
      begin: vi.fn(async () => undefined),
      bind: vi.fn(async () => { throw bindingError; }),
      finish: vi.fn(async () => undefined),
    };
    const runtimeDriver = driver(async (input) => {
      input.reportExecutionReference?.({ sessionId: "thread-unbound" });
      return { content: "done" };
    });
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      failingRecorder,
      () => 5_000,
      () => "invocation-bind-failure",
    );

    await expect(router.askWorkflow(request())).rejects.toThrow("binding failed");
  });

  test("records a null one-shot exit as cancelled", async () => {
    const events: string[] = [];
    const onExit = vi.fn();
    const runtimeDriver: RuntimeDriver = {
      ...driver(async () => ({ content: "unused" })),
      surfaceSupport: [{
        surface: "task",
        executionModes: ["oneshot"],
        continuationPolicies: ["fresh"],
      }],
      createOneShotExecutor: (input) => ({
        start: async () => { input.onExit(null); },
        stop: async () => undefined,
      }),
    };
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      recorder(events),
      () => 6_000,
      () => "invocation-cancelled",
    );
    const executor = router.createOneShotExecutor({
      runId: "task-1",
      runKind: "task",
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "default" },
      invocation: { surface: "agent", role: "task", ownerReference: { taskId: "task-1" } },
      runtime,
      channelId: "codex-default",
      prompt: "Run it",
      workDir: "/workspace",
      developerInstructions: "",
      emit: vi.fn(),
      onExit,
    });

    await executor.start();

    expect(events).toContain("finish:cancelled");
    expect(events).not.toContain("finish:completed");
    expect(onExit).toHaveBeenCalledWith(null);
  });

  test("keeps an interactive timeout status when interrupting the active prompt", async () => {
    const events: string[] = [];
    const durableRecorder = recorder(events);
    let releasePrompt!: () => void;
    const pendingPrompt = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const runtimeDriver: RuntimeDriver = {
      ...driver(async () => ({ content: "unused" })),
      surfaceSupport: [{
        surface: "chat",
        executionModes: ["interactive"],
        continuationPolicies: ["fresh"],
      }],
      createInteractiveSession: () => ({
        reconfigure: vi.fn(),
        ensureAttached: async () => undefined,
        sendPrompt: async () => pendingPrompt,
        interrupt: async () => {
          releasePrompt();
        },
        detach: async () => undefined,
        detachIfStillExpired: async () => undefined,
        snapshot: () => ({
          runtimeState: {
            executionStyle: "interactive",
            attachmentState: "running",
            attachmentGeneration: 1,
            capabilities: {
              supportsInProcessConversationResume: true,
              supportsResumeAfterDetach: true,
              supportsResumeAfterAppRestart: true,
              supportsTurnResume: true,
              supportsInterrupt: true,
              supportsContinue: true,
              supportsApprovalRequests: true,
              supportsUserInputRequests: true,
            },
          },
        }),
      }),
    };
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      durableRecorder,
      () => 6_500,
      () => "invocation-timeout",
    );
    const session = router.createInteractiveSession({
      chatId: "workflow-draft:workflow-1",
      configuredAgentId: "agent-1",
      runtimeId: "codex",
      executionMode: "interactive",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "default" },
      invocation: {
        surface: "workflow",
        role: "draft",
        ownerReference: { workflowId: "workflow-1", requestId: "request-1" },
      },
      runtime,
      channelId: "codex-default",
      workDir: "/workspace",
      developerInstructions: "",
      emit: vi.fn(),
    });
    const sending = session.sendPrompt("Plan it");
    await vi.waitFor(() => expect(durableRecorder.begin).toHaveBeenCalled());
    const timeoutError = new Error("Workflow planning agent timed out");

    await session.interrupt({ status: "timed_out", error: timeoutError });
    await expect(sending).resolves.toBeUndefined();

    expect(events.filter((event) => event.startsWith("finish:"))).toEqual(["finish:timed_out"]);
    expect(durableRecorder.finish).toHaveBeenCalledWith(
      "invocation-timeout",
      "timed_out",
      6_500,
      "Workflow planning agent timed out",
    );
  });

  test("publishes a terminal one-shot event only after the invocation is durable", async () => {
    const finishGate = deferred<void>();
    const emitted = vi.fn();
    const onExit = vi.fn();
    const durableRecorder: RuntimeInvocationRecorder = {
      begin: vi.fn(async () => undefined),
      bind: vi.fn(async () => undefined),
      finish: vi.fn(async () => finishGate.promise),
    };
    const runtimeDriver: RuntimeDriver = {
      ...driver(async () => ({ content: "unused" })),
      surfaceSupport: [{
        surface: "task",
        executionModes: ["oneshot"],
        continuationPolicies: ["fresh"],
      }],
      createOneShotExecutor: (input) => ({
        start: async () => {
          input.emit({ type: "completed" });
          input.onExit(0);
        },
        stop: async () => undefined,
      }),
    };
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([runtimeDriver]),
      durableRecorder,
      () => 7_000,
      () => "invocation-durable",
    );
    const executor = router.createOneShotExecutor({
      runId: "task-2",
      runKind: "task",
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "default" },
      invocation: { surface: "agent", role: "task", ownerReference: { taskId: "task-2" } },
      runtime,
      channelId: "codex-default",
      prompt: "Run it",
      workDir: "/workspace",
      developerInstructions: "",
      emit: emitted,
      onExit,
    });

    const start = executor.start();
    await vi.waitFor(() => expect(durableRecorder.finish).toHaveBeenCalled());
    expect(emitted).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    finishGate.resolve();
    await start;

    expect(emitted).toHaveBeenCalledWith(expect.objectContaining({
      type: "completed",
      invocationId: "invocation-durable",
    }));
    expect(onExit).toHaveBeenCalledWith(0);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
