import { describe, expect, test } from "vitest";
import type { AgentExecutionContext, AgentExecutor } from "./agent-executor";
import type { AgentRuntime } from "../../../../shared/types";
import type { RuntimeCapabilities } from "../../../agents/runtime/runtime-capabilities";
import type {
  InteractiveSessionContext,
  RuntimeOneShotRequest,
} from "../../../agents/runtime/runtime-driver";
import { RuntimeDriverRegistry } from "../../../agents/runtime/runtime-driver";
import { RuntimeRouter } from "../../../agents/runtime/runtime-router";
import { NOOP_RUNTIME_INVOCATION_RECORDER } from "../../../agents/runtime/runtime-invocation-recorder";
import { support } from "./agent-executor-capabilities";
import { createOneShotRuntimeDriver } from "./agent-executor-driver-factories";

function oneshotCapabilities(runtimeId: AgentRuntime["id"]): RuntimeCapabilities {
  return {
    runtimeId,
    chatStyle: "oneshot",
    oneShotStyle: "oneshot",
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

function buildRunContext(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    runId: "run-1",
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
    invocation: overrides.invocation ?? { surface: "agent", role: "chat" },
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
    invocation: overrides.invocation ?? { surface: "agent", role: "chat" },
  };
}

function buildOneShotRequest(
  overrides: Partial<RuntimeOneShotRequest> = {},
): RuntimeOneShotRequest {
  return {
    requestId: "request-1",
    prompt: "Plan it",
    runtimeId: "api",
    executionMode: "oneshot",
    continuationPolicy: "fresh",
    runtimeConfig: { model: "default" },
    runtime: buildRuntime(),
    channelId: "api-default",
    workDir: "C:/repo",
    ...overrides,
    invocation: overrides.invocation ?? { surface: "agent", role: "oneshot" },
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
      support("oneshot", ["oneshot"], ["fresh"]),
    ] as const;
    const driver = createOneShotRuntimeDriver({
      runtimeId: "api",
      surfaceSupport: [...declaredSupport],
      getCapabilities: () => oneshotCapabilities("api"),
      createOneShotExecutor: () => executor,
      askOneShot: async () => ({ content: "one-shot ok" }),
      testChannel: undefined,
      deleteSessionArtifacts: undefined,
    });
    const registry = new RuntimeDriverRegistry([driver]);
    const router = new RuntimeRouter(registry, NOOP_RUNTIME_INVOCATION_RECORDER);
    const runtimeConversation = {
      runtimeId: "api",
      codecVersion: "v1",
      payload: { requestId: "api-request-1" },
    } as const;

    expect(registry.driverFor("api").surfaceSupport).toEqual(declaredSupport);
    expect(router.createOneShotExecutor(buildRunContext())).toEqual({
      start: expect.any(Function),
      stop: expect.any(Function),
    });
    await expect(router.askOneShot(buildOneShotRequest())).resolves.toEqual({ content: "one-shot ok" });

    expect(() =>
      router.createInteractiveSession(buildInteractiveContext({
        runtimeConversation,
      })),
    ).toThrow(/api does not support chat interactive with continuation policy fresh/i);
    expect(() =>
      router.createOneShotExecutor(buildRunContext({
        continuationPolicy: "resume-required",
        runtimeConversation,
      })),
    ).toThrow(/api does not support chat oneshot with continuation policy resume-required/i);
    await expect(
      router.askOneShot(buildOneShotRequest({
        continuationPolicy: "resume-preferred",
        runtimeConversation,
      })),
    ).rejects.toThrow(/api does not support oneshot oneshot with continuation policy resume-preferred/i);
  });
});
