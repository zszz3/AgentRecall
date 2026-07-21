import { describe, expect, test } from "vitest";
import type { AgentExecutionContext, AgentExecutor } from "./agent-executor";
import type { AgentRuntime } from "../../../../shared/types";
import type { RuntimeCapabilities } from "../../../agents/runtime/runtime-capabilities";
import type {
  InteractiveSessionContext,
  RuntimeWorkflowRequestContext,
} from "../../../agents/runtime/runtime-driver";
import { RuntimeDriverRegistry } from "../../../agents/runtime/runtime-driver";
import { RuntimeRouter } from "../../../agents/runtime/runtime-router";
import { support } from "./agent-executor-capabilities";
import { createOneShotRuntimeDriver } from "./agent-executor-driver-factories";

function oneshotCapabilities(runtimeId: AgentRuntime["id"]): RuntimeCapabilities {
  return {
    runtimeId,
    chatStyle: "oneshot",
    taskStyle: "oneshot",
    workflowStyle: "oneshot",
    testStyle: "oneshot",
    supportsInterrupt: false,
    supportsContinue: false,
    supportsApprovalRequests: false,
    supportsUserInputRequests: false,
    resume: {
      supportsInProcessConversationResume: false,
      supportsResumeAfterDetach: false,
      supportsResumeAfterAppRestart: false,
      supportsTurnResume: false,
    },
  };
}

function buildRuntime(): AgentRuntime {
  return {
    id: "api",
    label: "Future One-Shot Runtime",
    version: "test",
    available: true,
    command: "future-runtime",
  };
}

function buildTaskContext(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    runId: "task-1",
    runKind: "task",
    prompt: "Inspect the repo",
    runtimeId: "api",
    executionMode: "oneshot",
    continuationPolicy: "fresh",
    runtimeConfig: { model: "default" },
    runtime: buildRuntime(),
    channelId: "api-default",
    workDir: "C:/repo",
    developerInstructions: "",
    emit: () => undefined,
    onExit: () => undefined,
    ...overrides,
  };
}

function buildInteractiveContext(
  overrides: Partial<InteractiveSessionContext> = {},
): InteractiveSessionContext {
  return {
    chatId: "chat-1",
    configuredAgentId: "agent-1",
    runtimeId: "api",
    executionMode: "interactive",
    continuationPolicy: "fresh",
    runtimeConfig: { model: "default" },
    runtime: buildRuntime(),
    channelId: "api-default",
    workDir: "C:/repo",
    developerInstructions: "",
    emit: () => undefined,
    ...overrides,
  };
}

function buildWorkflowContext(
  overrides: Partial<RuntimeWorkflowRequestContext> = {},
): RuntimeWorkflowRequestContext {
  return {
    requestId: "wf-1",
    prompt: "Plan it",
    runtimeId: "api",
    executionMode: "oneshot",
    continuationPolicy: "fresh",
    runtimeConfig: { model: "default" },
    runtime: buildRuntime(),
    channelId: "api-default",
    workDir: "C:/repo",
    ...overrides,
  };
}

describe("runtime onboarding contract", () => {
  test("stateless one-shot runtimes onboard through declared support instead of inferred resume behavior", async () => {
    const executor = {
      start: async () => undefined,
      stop: async () => undefined,
    } satisfies AgentExecutor;
    const declaredSupport = [
      support("chat", ["oneshot"], ["fresh"]),
      support("task", ["oneshot"], ["fresh"]),
      support("workflow", ["oneshot"], ["fresh"]),
    ] as const;
    const driver = createOneShotRuntimeDriver({
      runtimeId: "api",
      surfaceSupport: [...declaredSupport],
      getCapabilities: () => oneshotCapabilities("api"),
      createOneShotExecutor: () => executor,
      askWorkflow: async () => ({ content: "workflow ok" }),
      testChannel: undefined,
      deleteSessionArtifacts: undefined,
    });
    const registry = new RuntimeDriverRegistry([driver]);
    const router = new RuntimeRouter(registry);
    const runtimeConversation = {
      runtimeId: "api",
      codecVersion: "v1",
      payload: { requestId: "api-request-1" },
    } as const;

    expect(registry.driverFor("api").surfaceSupport).toEqual(declaredSupport);
    expect(router.createOneShotExecutor(buildTaskContext())).toBe(executor);
    await expect(router.askWorkflow(buildWorkflowContext())).resolves.toEqual({ content: "workflow ok" });

    expect(() =>
      router.createInteractiveSession(buildInteractiveContext({
        runtimeConversation,
      })),
    ).toThrow(/api does not support chat interactive with continuation policy fresh/i);
    expect(() =>
      router.createOneShotExecutor(buildTaskContext({
        continuationPolicy: "resume-required",
        runtimeConversation,
      })),
    ).toThrow(/api does not support task oneshot with continuation policy resume-required/i);
    await expect(
      router.askWorkflow(buildWorkflowContext({
        continuationPolicy: "resume-preferred",
        runtimeConversation,
      })),
    ).rejects.toThrow(/api does not support workflow oneshot with continuation policy resume-preferred/i);
  });
});
