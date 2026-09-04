import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AgentRuntime,
  AgentTestEvent,
  WorkflowAgentEvent,
} from "../../../../../shared/types";
import type {
  RuntimeChannelTestContext,
  RuntimeWorkflowRequestContext,
} from "../../../../agents/runtime/runtime-driver";
import type { RuntimeWorkflowExecutionOptions } from "../workflow/agent-executor-workflow-shared";
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
import { runDshChannelTest, runDshWorkflow } from "./dsh-workflow";

const runtime: AgentRuntime = {
  id: "dsh",
  label: "DeepSeek Harness",
  command: "",
  version: "0.1.0",
  available: true,
};

function workflowInput(
  overrides: Partial<RuntimeWorkflowRequestContext> = {},
): { input: RuntimeWorkflowRequestContext; events: WorkflowAgentEvent[] } {
  const events: WorkflowAgentEvent[] = [];
  return {
    input: {
      requestId: "workflow-request-1",
      prompt: "Summarize the repository.",
      runtimeId: "dsh",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "default" },
      runtime,
      channelId: "dsh-default",
      workDir: "/work/repository",
      developerInstructions: "Use terse output.",
      instructionScope: "agent",
      onEvent: (event) => events.push(event),
      ...overrides,
      invocation: overrides.invocation ?? { surface: "workflow" },
    },
    events,
  };
}

function workflowOptions(): RuntimeWorkflowExecutionOptions {
  return {
    executables: { dsh: "/configured/bin/dsh" } as RuntimeWorkflowExecutionOptions["executables"],
    channelById: () => ({
      id: "dsh-default",
      agentId: "dsh",
      label: "DSH",
      models: [{ id: "default", label: "Default" }],
      environment: {
        DSH_WORKFLOW_CHANNEL: "channel",
        DSH_WORKFLOW_OVERRIDE: "channel-wins",
      },
    }),
  };
}

describe("DSH workflow execution", () => {
  beforeEach(() => {
    runnerMock.options.length = 0;
    runnerMock.start.mockReset();
    runnerMock.stop.mockReset().mockResolvedValue(undefined);
    process.env.DSH_WORKFLOW_PARENT = "parent";
    process.env.DSH_WORKFLOW_OVERRIDE = "parent";
  });

  afterEach(() => {
    delete process.env.DSH_WORKFLOW_PARENT;
    delete process.env.DSH_WORKFLOW_OVERRIDE;
  });

  test("runs with developer instructions, channel environment, and completed output", async () => {
    runnerMock.start.mockImplementation(async (options: Record<string, any>) => {
      options.onEvent({
        type: "runtime_conversation",
        runtimeConversation: {
          runtimeId: "dsh",
          codecVersion: "v1",
          payload: { native: { sessionId: "session-dsh-workflow" } },
        },
      });
      options.onEvent({ type: "completed", content: "  concise answer  " });
      options.onExit(0);
    });
    const reportExecutionReference = vi.fn();
    const { input, events } = workflowInput({ reportExecutionReference });

    await expect(runDshWorkflow(input, workflowOptions())).resolves.toEqual({
      content: "concise answer",
      runtimeConversation: {
        runtimeId: "dsh",
        codecVersion: "v1",
        payload: { native: { sessionId: "session-dsh-workflow" } },
      },
      executionReference: { sessionId: "session-dsh-workflow" },
    });
    expect(reportExecutionReference).toHaveBeenCalledWith({ sessionId: "session-dsh-workflow" });

    expect(runnerMock.options).toHaveLength(1);
    expect(runnerMock.options[0]).toMatchObject({
      executable: "/configured/bin/dsh",
      cwd: "/work/repository",
      prompt: "Use terse output.\n\nUser request:\nSummarize the repository.",
    });
    expect(runnerMock.options[0]?.env).toEqual({
      ...process.env,
      DSH_WORKFLOW_CHANNEL: "channel",
      DSH_WORKFLOW_OVERRIDE: "channel-wins",
    });
    expect(events).toEqual([{
      requestId: "workflow-request-1",
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
    const abortReason = new Error("workflow cancelled by user");
    const { input } = workflowInput({ signal: controller.signal });

    const result = runDshWorkflow(input, workflowOptions());
    controller.abort(abortReason);

    await expect(result).rejects.toBe(abortReason);
    expect(runnerMock.stop).toHaveBeenCalledTimes(1);
  });

  test("reports an interruption failure instead of leaving a rejected stop promise unhandled", async () => {
    runnerMock.start.mockImplementation(() => new Promise<void>(() => undefined));
    runnerMock.stop.mockRejectedValue(new Error("process tree is still alive"));
    const controller = new AbortController();
    const { input } = workflowInput({ signal: controller.signal });

    const result = runDshWorkflow(input, workflowOptions());
    controller.abort(new Error("workflow cancelled by user"));

    await expect(result).rejects.toThrow(
      "Failed to stop DSH after workflow interruption: process tree is still alive",
    );
    expect(runnerMock.stop).toHaveBeenCalledOnce();
  });

  test("removes the abort listener after normal completion", async () => {
    runnerMock.start.mockImplementation(async (options: Record<string, any>) => {
      options.onEvent({ type: "completed", content: "done" });
      options.onExit(0);
    });
    const controller = new AbortController();
    const { input } = workflowInput({ signal: controller.signal });

    await expect(runDshWorkflow(input, workflowOptions())).resolves.toEqual({
      content: "done",
    });
    controller.abort(new Error("too late"));
    await Promise.resolve();

    expect(runnerMock.stop).not.toHaveBeenCalled();
  });

  test("does not launch when the workflow signal is already aborted", async () => {
    const controller = new AbortController();
    const abortReason = new Error("already cancelled");
    controller.abort(abortReason);
    const { input } = workflowInput({ signal: controller.signal });

    await expect(runDshWorkflow(input, workflowOptions())).rejects.toBe(abortReason);
    expect(runnerMock.options).toEqual([]);
    expect(runnerMock.start).not.toHaveBeenCalled();
  });

  test("rejects non-default models before constructing the runner", async () => {
    const { input } = workflowInput({
      runtimeConfig: { model: "deepseek-v3" },
    });

    await expect(runDshWorkflow(input, workflowOptions())).rejects.toThrow(
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

    await expect(runDshChannelTest(input, workflowOptions())).resolves.toBe("OK");

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
      const result = runDshChannelTest(input, workflowOptions());
      controller.abort(new Error("DSH channel test timed out."));

      await expect(result).rejects.toThrow("DSH channel test timed out.");
      expect(timeout).toHaveBeenCalledWith(RUNTIME_CHANNEL_TEST_TIMEOUT_MS);
      expect(runnerMock.stop).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });
});
