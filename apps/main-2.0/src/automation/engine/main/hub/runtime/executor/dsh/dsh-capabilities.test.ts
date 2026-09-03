import { describe, expect, test } from "vitest";
import {
  RuntimeDriverRegistry,
  type InteractiveSessionContext,
} from "../../../../agents/runtime/runtime-driver";
import { RuntimeRouter } from "../../../../agents/runtime/runtime-router";
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
  test("declares one-shot fresh support on every implemented surface only", () => {
    expect(dshSurfaceSupport).toEqual([
      { surface: "chat", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "task", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "workflow", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "channel-test", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
    ]);
  });

  test("advertises interruptible one-shot execution without resume or continuation", () => {
    expect(getDshCapabilities(runtime)).toEqual({
      runtimeId: "dsh",
      chatStyle: "oneshot",
      taskStyle: "oneshot",
      workflowStyle: "oneshot",
      testStyle: "oneshot",
      supportsInterrupt: true,
      supportsContinue: false,
      supportsApprovalRequests: false,
      supportsUserInputRequests: false,
      resume: {
        supportsInProcessConversationResume: false,
        supportsResumeAfterDetach: false,
        supportsResumeAfterAppRestart: false,
        supportsTurnResume: false,
      },
    });
  });

  test("registers no interactive session, state codec, resume cleanup, or hidden surfaces", () => {
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
    expect(driver.runtimeStateCodec).toBeUndefined();
    expect(driver.deleteSessionArtifacts).toBeUndefined();
    expect(driver.shutdown).toBeTypeOf("function");
  });

  test("routes fresh one-shot work and rejects resume or interactive requests", () => {
    const options: RuntimeAgentExecutorFactoryOptions = {
      executables: { dsh: "dsh" } as RuntimeAgentExecutorFactoryOptions["executables"],
      channelById: () => undefined,
    };
    const router = new RuntimeRouter(new RuntimeDriverRegistry([createDshDriver(options)]));
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
    expect(() => router.createOneShotExecutor({
      ...context,
      continuationPolicy: "resume-required",
      runtimeConversation: {
        runtimeId: "dsh",
        codecVersion: "v1",
        payload: { sessionId: "unsupported" },
      },
    })).toThrow(/does not support task oneshot with continuation policy resume-required/i);
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
