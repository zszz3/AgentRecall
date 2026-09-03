import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../../../../../shared/types";
import type {
  AgentExecutionContext,
  RuntimeAgentExecutorFactoryOptions,
} from "../agent-executor-types";

const runnerMock = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../../../../agents/dsh/dsh-runner", () => ({
  DshRunner: class {
    constructor(private readonly options: Record<string, unknown>) {
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

import { DshAgentExecutor } from "./dsh-executor";

function executionContext(
  overrides: Partial<AgentExecutionContext> = {},
): { context: AgentExecutionContext; events: AgentEvent[]; exits: Array<number | null | undefined> } {
  const events: AgentEvent[] = [];
  const exits: Array<number | null | undefined> = [];
  return {
    context: {
      runId: "task-1",
      runKind: "task",
      configuredAgentId: "configured-dsh",
      runtimeId: "dsh",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "default" },
      runtime: {
        id: "dsh",
        label: "DeepSeek Harness",
        version: "0.1.0",
        available: true,
        command: "",
      },
      channelId: "dsh-default",
      prompt: "Review the result.",
      workDir: "C:\\repo",
      developerInstructions: "Follow the repository instructions.",
      emit: (event) => events.push(event),
      onExit: (code) => exits.push(code),
      ...overrides,
      invocation: overrides.invocation ?? { surface: "agent", role: "task" },
    },
    events,
    exits,
  };
}

function executorOptions(): RuntimeAgentExecutorFactoryOptions {
  return {
    executables: { dsh: "configured-dsh-binary" } as RuntimeAgentExecutorFactoryOptions["executables"],
    channelById: () => ({
      id: "dsh-default",
      agentId: "dsh",
      label: "DSH",
      models: [{ id: "default", label: "Default" }],
      environment: {
        DSH_CHANNEL_ONLY: "channel-value",
        DSH_OVERRIDE_TEST: "channel-wins",
      },
    }),
  };
}

describe("DshAgentExecutor", () => {
  beforeEach(() => {
    runnerMock.options.length = 0;
    runnerMock.start.mockReset().mockResolvedValue(undefined);
    runnerMock.stop.mockReset().mockResolvedValue(undefined);
    process.env.DSH_PARENT_ONLY = "parent-value";
    process.env.DSH_OVERRIDE_TEST = "parent-value";
  });

  afterEach(() => {
    delete process.env.DSH_PARENT_ONLY;
    delete process.env.DSH_OVERRIDE_TEST;
  });

  test("combines developer instructions and merges channel environment over process.env", async () => {
    const { context } = executionContext();
    await new DshAgentExecutor(context, executorOptions()).start();

    expect(runnerMock.options).toHaveLength(1);
    expect(runnerMock.options[0]).toMatchObject({
      executable: "configured-dsh-binary",
      cwd: "C:\\repo",
      prompt: "Follow the repository instructions.\n\nUser request:\nReview the result.",
    });
    expect(runnerMock.options[0]?.env).toEqual({
      ...process.env,
      DSH_CHANNEL_ONLY: "channel-value",
      DSH_OVERRIDE_TEST: "channel-wins",
    });
  });

  test("rejects non-default models before starting DSH", async () => {
    const { context, events, exits } = executionContext({
      runtimeConfig: { model: "deepseek-v3" },
    });
    await new DshAgentExecutor(context, executorOptions()).start();

    expect(runnerMock.options).toEqual([]);
    expect(runnerMock.start).not.toHaveBeenCalled();
    expect(events).toEqual([{
      type: "error",
      error: expect.stringContaining("configure the model in DSH settings"),
    }]);
    expect(exits).toEqual([1]);
  });
});
