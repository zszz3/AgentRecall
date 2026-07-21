import { describe, expect, test } from "vitest";
import type { AgentRuntime } from "../../../../shared/types";
import { createRuntimeDriverRegistry } from "./agent-executor";
import { apiSurfaceSupport } from "./api/api-capabilities";
import { claudeInteractiveSessionCapabilities, claudeSurfaceSupport } from "./claude/claude-capabilities";
import { codexInteractiveSessionCapabilities, codexSurfaceSupport } from "./codex/codex-capabilities";
import { hermesSurfaceSupport } from "./hermes/hermes-capabilities";
import { openCodeInteractiveSessionCapabilities, openCodeSurfaceSupport } from "./opencode/opencode-capabilities";
import { openClawInteractiveSessionCapabilities, openClawSurfaceSupport } from "./openclaw/openclaw-capabilities";

function buildOptions() {
  return {
    executables: { codex: "codex", claude: "claude", api: "api", hermes: "hermes", opencode: "opencode", openclaw: "openclaw" },
    channelById: () => ({
      id: "test-channel",
      runtimeAgentId: "api",
      label: "Test Channel",
      providerId: "openai",
      modelId: "default",
      settings: {},
    }),
  } as any;
}

function runtime(id: AgentRuntime["id"]): AgentRuntime {
  return {
    id,
    label: id.toUpperCase(),
    command: id,
    version: "test",
    available: true,
  };
}

function interactiveSessionContext(runtimeId: AgentRuntime["id"]) {
  return {
    chatId: `${runtimeId}-chat-1`,
    configuredAgentId: `${runtimeId}-agent-1`,
    runtimeId,
    executionMode: "interactive",
    continuationPolicy: "resume-preferred",
    runtimeConfig: { model: "default" },
    runtime: runtime(runtimeId),
    channelId: "test-channel",
    workDir: "/tmp/runtime-capability-contract",
    developerInstructions: "Be helpful",
    emit: () => undefined,
  } as const;
}

function sessionCapabilityProjection(runtimeId: AgentRuntime["id"]) {
  const capabilities = createRuntimeDriverRegistry(buildOptions()).driverFor(runtimeId).getCapabilities(runtime(runtimeId));
  return {
    supportsInProcessConversationResume: capabilities.resume.supportsInProcessConversationResume,
    supportsResumeAfterDetach: capabilities.resume.supportsResumeAfterDetach,
    supportsResumeAfterAppRestart: capabilities.resume.supportsResumeAfterAppRestart,
    supportsTurnResume: capabilities.resume.supportsTurnResume,
    supportsInterrupt: capabilities.supportsInterrupt,
    supportsContinue: capabilities.supportsContinue,
    supportsApprovalRequests: capabilities.supportsApprovalRequests,
    supportsUserInputRequests: capabilities.supportsUserInputRequests,
  };
}

describe("runtime capability declarations", () => {
  test("preserves the registry-facing support matrices and chat styles for each runtime", () => {
    const registry = createRuntimeDriverRegistry(buildOptions());

    expect(registry.driverFor("codex").surfaceSupport).toEqual(codexSurfaceSupport);
    expect(registry.driverFor("codex").surfaceSupport).toEqual([
      { surface: "chat", executionModes: ["interactive"], continuationPolicies: ["fresh", "resume-preferred"] },
      { surface: "task", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred"] },
      { surface: "workflow", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred"] },
      { surface: "channel-test", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "cleanup", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred"] },
    ]);
    expect(registry.driverFor("codex").getCapabilities(runtime("codex"))).toMatchObject({
      chatStyle: "interactive",
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
        supportsTurnResume: false,
      },
    });

    expect(registry.driverFor("claude").surfaceSupport).toEqual(claudeSurfaceSupport);
    expect(registry.driverFor("claude").surfaceSupport).toEqual([
      { surface: "chat", executionModes: ["interactive"], continuationPolicies: ["fresh", "resume-preferred"] },
      { surface: "task", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred"] },
      { surface: "workflow", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred"] },
      { surface: "channel-test", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "cleanup", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred"] },
    ]);
    expect(registry.driverFor("claude").getCapabilities(runtime("claude"))).toMatchObject({
      chatStyle: "interactive",
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
        supportsTurnResume: false,
      },
    });

    expect(registry.driverFor("api").surfaceSupport).toEqual(apiSurfaceSupport);
    expect(registry.driverFor("api").surfaceSupport).toEqual([
      { surface: "chat", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "task", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "workflow", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "channel-test", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
    ]);
    expect(registry.driverFor("api").getCapabilities(runtime("api"))).toMatchObject({
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
    });

    expect(registry.driverFor("hermes").surfaceSupport).toEqual(hermesSurfaceSupport);
    expect(registry.driverFor("hermes").surfaceSupport).toEqual([
      { surface: "chat", executionModes: ["interactive"], continuationPolicies: ["fresh", "resume-preferred"] },
      { surface: "task", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "workflow", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "channel-test", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "cleanup", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred"] },
    ]);
    expect(registry.driverFor("hermes").getCapabilities(runtime("hermes"))).toMatchObject({
      chatStyle: "interactive",
      taskStyle: "oneshot",
      workflowStyle: "oneshot",
      testStyle: "oneshot",
      supportsInterrupt: true,
      supportsContinue: true,
      supportsApprovalRequests: true,
      supportsUserInputRequests: false,
      resume: {
        supportsInProcessConversationResume: true,
        supportsResumeAfterDetach: true,
        supportsResumeAfterAppRestart: true,
        supportsTurnResume: false,
      },
    });

    expect(registry.driverFor("opencode").surfaceSupport).toEqual(openCodeSurfaceSupport);
    expect(registry.driverFor("opencode").surfaceSupport).toEqual([
      { surface: "chat", executionModes: ["interactive"], continuationPolicies: ["fresh", "resume-preferred"] },
      { surface: "task", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "workflow", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "channel-test", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "cleanup", executionModes: ["oneshot"], continuationPolicies: ["fresh", "resume-preferred"] },
    ]);
    expect(registry.driverFor("opencode").getCapabilities(runtime("opencode"))).toMatchObject({
      chatStyle: "interactive",
      taskStyle: "oneshot",
      workflowStyle: "oneshot",
      testStyle: "oneshot",
      supportsInterrupt: true,
      supportsContinue: true,
      supportsApprovalRequests: true,
      supportsUserInputRequests: false,
      resume: {
        supportsInProcessConversationResume: true,
        supportsResumeAfterDetach: true,
        supportsResumeAfterAppRestart: true,
        supportsTurnResume: false,
      },
    });

    expect(registry.driverFor("openclaw").surfaceSupport).toEqual(openClawSurfaceSupport);
    expect(registry.driverFor("openclaw").surfaceSupport).toEqual([
      { surface: "chat", executionModes: ["interactive"], continuationPolicies: ["fresh", "resume-preferred"] },
      { surface: "task", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "workflow", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
      { surface: "channel-test", executionModes: ["oneshot"], continuationPolicies: ["fresh"] },
    ]);
    expect(registry.driverFor("openclaw").getCapabilities(runtime("openclaw"))).toMatchObject({
      chatStyle: "interactive",
      taskStyle: "oneshot",
      workflowStyle: "oneshot",
      testStyle: "oneshot",
      supportsInterrupt: true,
      supportsContinue: true,
      supportsApprovalRequests: true,
      supportsUserInputRequests: false,
      resume: {
        supportsInProcessConversationResume: true,
        supportsResumeAfterDetach: true,
        supportsResumeAfterAppRestart: true,
        supportsTurnResume: false,
      },
    });
  });

  test("reuses runtime-local interactive session capability declarations for codex and claude snapshots", () => {
    const registry = createRuntimeDriverRegistry(buildOptions());

    const codexDriver = registry.driverFor("codex");
    const codexSession = codexDriver.createInteractiveSession?.(interactiveSessionContext("codex"));
    expect(codexSession?.snapshot().runtimeState.capabilities).toEqual(codexInteractiveSessionCapabilities);
    expect(codexSession?.snapshot().runtimeState.capabilities).toEqual(sessionCapabilityProjection("codex"));

    const claudeDriver = registry.driverFor("claude");
    const claudeSession = claudeDriver.createInteractiveSession?.(interactiveSessionContext("claude"));
    expect(claudeSession?.snapshot().runtimeState.capabilities).toEqual(claudeInteractiveSessionCapabilities);
    expect(claudeSession?.snapshot().runtimeState.capabilities).toEqual(sessionCapabilityProjection("claude"));

    const openCodeDriver = registry.driverFor("opencode");
    const openCodeSession = openCodeDriver.createInteractiveSession?.(interactiveSessionContext("opencode"));
    expect(openCodeSession?.snapshot().runtimeState.capabilities).toEqual(openCodeInteractiveSessionCapabilities);
    expect(openCodeSession?.snapshot().runtimeState.capabilities).toEqual(sessionCapabilityProjection("opencode"));

    const openClawDriver = registry.driverFor("openclaw");
    const openClawSession = openClawDriver.createInteractiveSession?.(interactiveSessionContext("openclaw"));
    expect(openClawSession?.snapshot().runtimeState.capabilities).toEqual(openClawInteractiveSessionCapabilities);
    expect(openClawSession?.snapshot().runtimeState.capabilities).toEqual(sessionCapabilityProjection("openclaw"));
  });
});
