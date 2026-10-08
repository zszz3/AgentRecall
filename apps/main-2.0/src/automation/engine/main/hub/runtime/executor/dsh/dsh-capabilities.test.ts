import { describe, expect, test } from "vitest";
import {
  RuntimeDriverRegistry,
  type InteractiveSessionContext,
} from "../../../../agents/runtime/runtime-driver";
import { RuntimeRouter } from "../../../../agents/runtime/runtime-router";
import { NOOP_RUNTIME_INVOCATION_RECORDER } from "../../../../agents/runtime/runtime-invocation-recorder";
import type { AgentExecutionContext } from "../agent-executor-types";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import { createDshDriver } from "./create-dsh-driver";
import { dshSurfaceSupport, getDshCapabilities } from "./dsh-capabilities";

const runtime = {
  id: "dsh",
  label: "DeepSeek Harness",
  command: "dsh",
  version: "0.1.0",
  available: true,
} as const;

describe("DSH runtime driver", () => {
  test("declares resumable one-shot support and fresh channel tests", () => {
    expect(dshSurfaceSupport).toEqual([
      { surface: "chat", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred", "resume-required"] },
      { surface: "task", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred", "resume-required"] },
      { surface: "workflow", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred", "resume-required"] },
      { surface: "channel-test", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
    ]);
  });

  test("advertises resumable sessions without turn-level replay", () => {
    expect(getDshCapabilities(runtime)).toEqual({
      runtimeId: "dsh",
      chatStyle: "oneshot",
      taskStyle: "oneshot",
      workflowStyle: "oneshot",
      testStyle: "oneshot",
      supportsInterrupt: true,
      supportsContinue: true,
      supportsApprovalRequests: false,
      supportsUserInputRequests: false,
      resume: {
        supportsInProcessConversationResume: true,
        supportsResumeAfterDetach: true,
        supportsResumeAfterAppRestart: true,
        supportsTurnResume: false,
      },
    });
  });

  test("registers a session codec while keeping execution one-shot", () => {
    const options: RuntimeAgentExecutorFactoryOptions = {
      executables: { dsh: "dsh" } as RuntimeAgentExecutorFactoryOptions["executables"],
      channelById: () => undefined,
    };
    const driver = createDshDriver(options);

    expect(driver.runtimeId).toBe("dsh");
    expect(driver.surfaceSupport).toEqual(dshSurfaceSupport);
    expect(driver.createOneShotExecutor).toBeTypeOf("function");
    expect(driver.askWorkflow).toBeTypeOf("function");
    expect(driver.testChannel).toBeTypeOf("function");
    expect(driver.createInteractiveSession).toBeUndefined();
    expect(driver.runtimeStateCodec?.runtimeId).toBe("dsh");
    expect(driver.deleteSessionArtifacts).toBeUndefined();
    expect(driver.shutdown).toBeTypeOf("function");
  });

  test("restores a persisted session envelope and rejects malformed or foreign state", () => {
    const driver = createDshDriver({ executables: { dsh: "dsh" } as RuntimeAgentExecutorFactoryOptions["executables"], channelById: () => undefined });
    const state = { runtimeId: "dsh", codecVersion: "v1", payload: { native: { sessionId: "session-persisted" } } };
    expect(driver.runtimeStateCodec?.restorePersistedConversation(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(driver.runtimeStateCodec?.restorePersistedConversation({ ...state, runtimeId: "codex" })).toBeUndefined();
    expect(driver.runtimeStateCodec?.restorePersistedConversation({ ...state, payload: { native: { sessionId: " " } } })).toBeUndefined();
  });

  test("routes fresh and resumed one-shot work and rejects interactive requests", () => {
    const options: RuntimeAgentExecutorFactoryOptions = {
      executables: { dsh: "dsh" } as RuntimeAgentExecutorFactoryOptions["executables"],
      channelById: () => undefined,
    };
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([createDshDriver(options)]),
      NOOP_RUNTIME_INVOCATION_RECORDER,
    );
    const context: AgentExecutionContext = {
      runId: "task-1",
      runKind: "task",
      configuredAgentId: "dsh-agent",
      runtimeId: "dsh",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "default" },
      invocation: { surface: "agent", role: "task" },
      runtime,
      channelId: "dsh-default",
      prompt: "Inspect the repository.",
      workDir: "/work/repository",
      developerInstructions: "",
      emit: () => undefined,
      onExit: () => undefined,
    };

    expect(router.createOneShotExecutor(context)).toBeDefined();
    expect(router.createOneShotExecutor({
      ...context,
      continuationPolicy: "resume-required",
      runtimeConversation: {
        runtimeId: "dsh",
        codecVersion: "v1",
        payload: { native: { sessionId: "session-existing" } },
      },
    })).toBeDefined();
    const interactiveContext: InteractiveSessionContext = {
      chatId: "chat-1",
      configuredAgentId: "dsh-agent",
      runtimeId: "dsh",
      executionMode: "interactive",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "default" },
      invocation: { surface: "agent", role: "chat" },
      runtime,
      channelId: "dsh-default",
      workDir: "/work/repository",
      developerInstructions: "",
      emit: () => undefined,
    };
    expect(() => router.createInteractiveSession(interactiveContext))
      .toThrow(/does not support chat interactive/i);
  });
});
