import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AgentRuntime,
  AgentTestEvent,
  AgentOneShotEvent,
} from "../../../../../shared/types";
import type {
  RuntimeChannelTestContext,
  RuntimeOneShotRequest,
} from "../../../../agents/runtime/runtime-driver";
import type { RuntimeOneShotExecutionOptions } from "../oneshot-shared";
import {
  RUNTIME_CHANNEL_TEST_PROMPT,
  RUNTIME_CHANNEL_TEST_TIMEOUT_MS,
} from "../runtime-test-constants";

const runnerMock = vi.hoisted(() => ({
  options: [] as Array<Record<string, any>>,
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../../../../agents/dsh/dsh-runner", () => ({
  DshRunner: class {
    constructor(private readonly options: Record<string, any>) {
      runnerMock.options.push(options);
    }

    async start(): Promise<void> {
      await runnerMock.start(this.options);
    }

    async stop(): Promise<void> {
      await runnerMock.stop(this.options);
    }
  },
}));

import { DSH_MODEL_CONFIGURATION_ERROR } from "./dsh-config";
import { runDshChannelTest, runDshOneShot } from "./dsh-oneshot";

const runtime: AgentRuntime = {
  id: "dsh",
  label: "DeepSeek Harness",
  command: "",
  version: "0.1.0",
  available: true,
};

function oneShotInput(
  overrides: Partial<RuntimeOneShotRequest> = {},
): { input: RuntimeOneShotRequest; events: AgentOneShotEvent[] } {
  const events: AgentOneShotEvent[] = [];
  return {
    input: {
      requestId: "oneshot-request-1",
      prompt: "Summarize the repository.",
      runtimeId: "dsh",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "default" },
      runtime,
      channelId: "dsh-default",
      workDir: "/work/repository",
      developerInstructions: "Use terse output.",
      onEvent: (event) => events.push(event),
      ...overrides,
      invocation: overrides.invocation ?? { surface: "agent", role: "oneshot" },
    },
    events,
  };
}

function oneShotOptions(): RuntimeOneShotExecutionOptions {
  return {
    executables: { dsh: "/configured/bin/dsh" } as RuntimeOneShotExecutionOptions["executables"],
    channelById: () => ({
      id: "dsh-default",
      agentId: "dsh",
      label: "DSH",
      models: [{ id: "default", label: "Default" }],
      dshUseStoredCredentials: true,
      environment: {
        DSH_TEST_CHANNEL: "channel",
        DSH_TEST_OVERRIDE: "channel-wins",
      },
    }),
  };
}

describe("DSH one-shot execution", () => {
  beforeEach(() => {
    runnerMock.options.length = 0;
    runnerMock.start.mockReset();
    runnerMock.stop.mockReset().mockResolvedValue(undefined);
    process.env.DSH_TEST_PARENT = "parent";
    process.env.DSH_TEST_OVERRIDE = "parent";
  });

  afterEach(() => {
    delete process.env.DSH_TEST_PARENT;
    delete process.env.DSH_TEST_OVERRIDE;
  });

  test("resumes the exact persisted session and ignores it for fresh runs", async () => {
    runnerMock.start.mockImplementation(async (options: Record<string, any>) => {
      options.onEvent({ type: "completed", content: "continued" });
      options.onExit(0);
    });
    const { input } = oneShotInput({ continuationPolicy: "resume-required", runtimeConversation: {
      runtimeId: "dsh", codecVersion: "v1", payload: { native: { sessionId: "session-prior" } },
    } });
    await runDshOneShot(input, oneShotOptions());
    expect(runnerMock.options[0]?.sessionId).toBe("session-prior");
    await runDshOneShot({ ...input, continuationPolicy: "fresh" }, oneShotOptions());
    expect(runnerMock.options[1]?.sessionId).toBeUndefined();
  });

  test("runs with developer instructions, channel environment, and completed output", async () => {
    runnerMock.start.mockImplementation(async (options: Record<string, any>) => {
      options.onEvent({
        type: "runtime_conversation",
        runtimeConversation: {
          runtimeId: "dsh",
          codecVersion: "v1",
          payload: { native: { sessionId: "session-dsh-oneshot" } },
        },
      });
      options.onEvent({ type: "delta", content: "Progress" });
      options.onEvent({ type: "meta", content: "Thinking" });
      options.onEvent({ type: "system", content: "DSH step start", metadata: { phase: "step_start" } });
      options.onEvent({ type: "tool_call", content: "fixture", name: "read", metadata: { callId: "c1" } });
      options.onEvent({ type: "tool_result", content: "done", metadata: { callId: "c1", status: "completed" } });
      options.onEvent({ type: "completed", content: "  concise answer  " });
      options.onExit(0);
    });
    const reportExecutionReference = vi.fn();
    const { input, events } = oneShotInput({ reportExecutionReference });

    await expect(runDshOneShot(input, oneShotOptions())).resolves.toEqual({
      content: "concise answer",
      runtimeConversation: {
        runtimeId: "dsh",
        codecVersion: "v1",
        payload: { native: { sessionId: "session-dsh-oneshot" } },
      },
      executionReference: { sessionId: "session-dsh-oneshot" },
    });
    expect(reportExecutionReference).toHaveBeenCalledWith({ sessionId: "session-dsh-oneshot" });

    expect(runnerMock.options).toHaveLength(1);
    expect(runnerMock.options[0]).toMatchObject({
      executable: "/configured/bin/dsh",
      useStoredCredentials: true,
      cwd: "/work/repository",
      prompt: "Use terse output.\n\nUser request:\nSummarize the repository.",
    });
    expect(runnerMock.options[0]?.env).toEqual({
      ...process.env,
      DSH_TEST_CHANNEL: "channel",
      DSH_TEST_OVERRIDE: "channel-wins",
    });
    expect(events.slice(0, 5).map((event) => event.type)).toEqual(["delta", "meta", "system", "tool_call", "tool_result"]);
    expect(events[3]).toMatchObject({ metadata: { callId: "c1" } });
    expect(events.slice(5)).toEqual([{
      requestId: "oneshot-request-1",
      type: "completed",
      content: "concise answer",
    }]);
  });

  test("interrupts an in-flight process and rejects with the AbortSignal reason", async () => {
    let release: (() => void) | undefined;
    runnerMock.start.mockImplementation((options: Record<string, any>) => (
      new Promise<void>((resolve) => {
        release = () => {
          options.onExit(null);
          resolve();
        };
      })
    ));
    runnerMock.stop.mockImplementation(async () => {
      release?.();
    });
    const controller = new AbortController();
    const abortReason = new Error("request cancelled by user");
    const { input } = oneShotInput({ signal: controller.signal });

    const result = runDshOneShot(input, oneShotOptions());
    controller.abort(abortReason);

    await expect(result).rejects.toBe(abortReason);
    expect(runnerMock.stop).toHaveBeenCalledTimes(1);
  });

  test("reports an interruption failure instead of leaving a rejected stop promise unhandled", async () => {
    runnerMock.start.mockImplementation(() => new Promise<void>(() => undefined));
    runnerMock.stop.mockRejectedValue(new Error("process tree is still alive"));
    const controller = new AbortController();
    const { input } = oneShotInput({ signal: controller.signal });

    const result = runDshOneShot(input, oneShotOptions());
    controller.abort(new Error("request cancelled by user"));

    await expect(result).rejects.toThrow(
      "Failed to stop DSH after agent interruption: process tree is still alive",
    );
    expect(runnerMock.stop).toHaveBeenCalledOnce();
  });

  test("removes the abort listener after normal completion", async () => {
    runnerMock.start.mockImplementation(async (options: Record<string, any>) => {
      options.onEvent({ type: "completed", content: "done" });
      options.onExit(0);
    });
    const controller = new AbortController();
    const { input } = oneShotInput({ signal: controller.signal });

    await expect(runDshOneShot(input, oneShotOptions())).resolves.toEqual({
      content: "done",
    });
    controller.abort(new Error("too late"));
    await Promise.resolve();

    expect(runnerMock.stop).not.toHaveBeenCalled();
  });

  test("does not launch when the request signal is already aborted", async () => {
    const controller = new AbortController();
    const abortReason = new Error("already cancelled");
    controller.abort(abortReason);
    const { input } = oneShotInput({ signal: controller.signal });

    await expect(runDshOneShot(input, oneShotOptions())).rejects.toBe(abortReason);
    expect(runnerMock.options).toEqual([]);
    expect(runnerMock.start).not.toHaveBeenCalled();
  });

  test("rejects non-default models before constructing the runner", async () => {
    const { input } = oneShotInput({
      runtimeConfig: { model: "deepseek-v3" },
    });

    await expect(runDshOneShot(input, oneShotOptions())).rejects.toThrow(
      DSH_MODEL_CONFIGURATION_ERROR,
    );
    expect(runnerMock.options).toEqual([]);
    expect(runnerMock.start).not.toHaveBeenCalled();
  });

  test("uses the standard channel-test prompt and returns the assistant response", async () => {
    runnerMock.start.mockImplementation(async (options: Record<string, any>) => {
      options.onEvent({
        type: "runtime_conversation",
        runtimeConversation: {
          runtimeId: "dsh",
          codecVersion: "v1",
          payload: { native: { sessionId: "session-dsh-test" } },
        },
      });
      options.onEvent({ type: "completed", content: "OK" });
      options.onExit(0);
    });
    const emitted: Array<Omit<AgentTestEvent, "agentId" | "timestamp">> = [];
    const reportExecutionReference = vi.fn();
    const input: RuntimeChannelTestContext = {
      runtime,
      channelId: "dsh-default",
      modelId: "default",
      workDir: "/work/repository",
      reportExecutionReference,
      emit: (event) => emitted.push(event),
    };

    await expect(runDshChannelTest(input, oneShotOptions())).resolves.toBe("OK");

    expect(runnerMock.options[0]?.prompt).toBe(RUNTIME_CHANNEL_TEST_PROMPT);
    expect(reportExecutionReference).toHaveBeenCalledWith({ sessionId: "session-dsh-test" });
    expect(emitted).toEqual([
      {
        type: "phase",
        content: "Launching DSH with the model configured in DSH settings.",
      },
      { type: "user", content: RUNTIME_CHANNEL_TEST_PROMPT },
      { type: "assistant", content: "OK" },
    ]);
  });

  test("times out a channel test and stops the DSH process", async () => {
    let release: (() => void) | undefined;
    runnerMock.start.mockImplementation((options: Record<string, any>) => (
      new Promise<void>((resolve) => {
        release = () => {
          options.onExit(null);
          resolve();
        };
      })
    ));
    runnerMock.stop.mockImplementation(async () => {
      release?.();
    });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const input: RuntimeChannelTestContext = {
      runtime,
      channelId: "dsh-default",
      modelId: "default",
      workDir: "/work/repository",
      emit: () => undefined,
    };

    try {
      const result = runDshChannelTest(input, oneShotOptions());
      controller.abort(new Error("DSH channel test timed out."));

      await expect(result).rejects.toThrow("DSH channel test timed out.");
      expect(timeout).toHaveBeenCalledWith(RUNTIME_CHANNEL_TEST_TIMEOUT_MS);
      expect(runnerMock.stop).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });
});
