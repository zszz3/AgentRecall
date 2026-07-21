import { describe, expect, test, vi } from "vitest";
import type { AgentExecutionContext, AgentExecutor } from "../../hub/runtime/executor/agent-executor";
import type { AgentRuntime } from "../../../shared/types";
import {
  RuntimeDriverRegistry,
  type InteractiveSession,
  type InteractiveSessionContext,
  type RuntimeDriver,
  type RuntimeWorkflowRequestContext,
} from "./runtime-driver";
import type { RuntimeCapabilities } from "./runtime-capabilities";
import type { RuntimeStateCodec } from "./runtime-state-codec";
import { RuntimeRouter } from "./runtime-router";

function interactiveCapabilities(runtimeId: AgentRuntime["id"]): RuntimeCapabilities {
  return {
    runtimeId,
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
  };
}

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

function createDriver(input: Partial<RuntimeDriver> & Pick<RuntimeDriver, "runtimeId">): RuntimeDriver {
  return {
    runtimeId: input.runtimeId,
    surfaceSupport: input.surfaceSupport ?? [],
    getCapabilities: input.getCapabilities ?? (() => oneshotCapabilities(input.runtimeId)),
    ...(input.createOneShotExecutor ? { createOneShotExecutor: input.createOneShotExecutor } : {}),
    ...(input.createInteractiveSession ? { createInteractiveSession: input.createInteractiveSession } : {}),
    ...(input.askWorkflow ? { askWorkflow: input.askWorkflow } : {}),
    ...(input.testChannel ? { testChannel: input.testChannel } : {}),
    ...(input.deleteSessionArtifacts ? { deleteSessionArtifacts: input.deleteSessionArtifacts } : {}),
    ...(input.runtimeStateCodec ? { runtimeStateCodec: input.runtimeStateCodec } : {}),
  };
}

function createInteractiveSessionStub(): InteractiveSession {
  const capabilities = interactiveCapabilities("codex");
  return {
    reconfigure: () => undefined,
    ensureAttached: async () => undefined,
    sendPrompt: async () => undefined,
    interrupt: async () => undefined,
    detach: async () => undefined,
    detachIfStillExpired: async () => undefined,
    snapshot: () => ({
      runtimeState: {
        executionStyle: "interactive",
        attachmentState: "idle",
        attachmentGeneration: 0,
        capabilities: {
          ...capabilities.resume,
          supportsInterrupt: capabilities.supportsInterrupt,
          supportsContinue: capabilities.supportsContinue,
          supportsApprovalRequests: capabilities.supportsApprovalRequests,
          supportsUserInputRequests: capabilities.supportsUserInputRequests,
        },
      },
    }),
  };
}

describe("RuntimeRouter", () => {
  const runtime: AgentRuntime = {
    id: "api",
    label: "API",
    version: "test",
    available: true,
    command: "api",
  };

  test("fails explicitly when a runtime does not support the requested chat mode and continuation policy", () => {
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "api",
          surfaceSupport: [
            {
              surface: "chat",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
          ],
          getCapabilities: () => oneshotCapabilities("api"),
          createOneShotExecutor: () =>
            ({
              start: async () => undefined,
              stop: async () => undefined,
            }) satisfies AgentExecutor,
        }),
      ]),
    );

    expect(() =>
      router.createInteractiveSession({
        chatId: "chat-1",
        configuredAgentId: "agent-1",
        runtimeId: "api",
        executionMode: "interactive",
        continuationPolicy: "resume-preferred",
        runtimeConfig: { model: "default" },
        runtime,
        channelId: "api-default",
        workDir: "C:/repo",
        developerInstructions: "",
        emit: () => undefined,
      } satisfies InteractiveSessionContext),
    ).toThrow(/api does not support chat interactive with continuation policy resume-preferred/i);
  });

  test("delegates persisted runtimeConversation restoration and cloning to the registered codec", () => {
    const raw = {
      runtimeId: "hermes",
      codecVersion: "v1",
      payload: { sessionId: "hermes-session-1" },
    } as const;
    const restorePersistedConversation = vi.fn(() => raw);
    const cloneConversation = vi.fn(() => raw);
    const codec: RuntimeStateCodec<{ sessionId: string }> = {
      runtimeId: "hermes",
      restorePersistedConversation,
      cloneConversation,
      decodeConversation: () => ({ sessionId: "hermes-session-1" }),
      encodeConversation: (payload) => ({
        runtimeId: "hermes",
        codecVersion: "v1",
        payload,
      }),
    };
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "hermes",
          surfaceSupport: [],
          runtimeStateCodec: codec,
        }),
      ]),
    );

    expect(router.restorePersistedConversation(raw)).toEqual(raw);
    expect(router.cloneConversation(raw)).toEqual(raw);
    expect(restorePersistedConversation).toHaveBeenCalledWith(raw);
    expect(cloneConversation).toHaveBeenCalledWith(raw);
  });

  test("keeps codec rejection rejected instead of cloning malformed runtimeConversation envelopes", () => {
    const raw = {
      runtimeId: "codex",
      codecVersion: "v1",
      payload: { native: {} },
    } as const;
    const restorePersistedConversation = vi.fn(() => undefined);
    const cloneConversation = vi.fn(() => undefined);
    const codec: RuntimeStateCodec<{ native: { threadId: string } }> = {
      runtimeId: "codex",
      restorePersistedConversation,
      cloneConversation,
      decodeConversation: () => undefined,
      encodeConversation: (payload) => ({
        runtimeId: "codex",
        codecVersion: "v1",
        payload,
      }),
    };
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [],
          runtimeStateCodec: codec,
        }),
      ]),
    );

    expect(router.restorePersistedConversation(raw)).toBeUndefined();
    expect(() => router.cloneConversation(raw)).toThrow(/invalid codex runtime conversation envelope/i);
    expect(restorePersistedConversation).toHaveBeenCalledWith(raw);
    expect(cloneConversation).toHaveBeenCalledWith(raw);
  });

  test("rejects drivers that omit explicit surface support instead of inferring it from hooks", () => {
    const executor = {
      start: async () => undefined,
      stop: async () => undefined,
    } satisfies AgentExecutor;
    const driverWithoutSurfaceSupport = {
      runtimeId: "codex",
      getCapabilities: () => oneshotCapabilities("codex"),
      createOneShotExecutor: () => executor,
    } as unknown as RuntimeDriver;
    expect(
      () =>
        new RuntimeRouter(
          new RuntimeDriverRegistry([
            driverWithoutSurfaceSupport,
          ]),
        ),
    ).toThrow(/surfaceSupport explicitly/i);
  });

  test("fails cleanup explicitly when the runtime is missing, unsupported, or unconfigured", async () => {
    const router = new RuntimeRouter(new RuntimeDriverRegistry([]));

    await expect(router.deleteSessionArtifacts("codex", { workDir: "C:/repo" })).rejects.toThrow(
      /No runtime driver registered for codex/i,
    );

    const unsupportedCleanupRouter = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "api",
          surfaceSupport: [
            {
              surface: "task",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
          ],
        }),
      ]),
    );

    await expect(unsupportedCleanupRouter.deleteSessionArtifacts("api", { workDir: "C:/repo" })).rejects.toThrow(
      /api runtime does not support cleanup/i,
    );

    const unconfiguredCleanupRouter = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "hermes",
          surfaceSupport: [
            {
              surface: "cleanup",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
          ],
        }),
      ]),
    );

    await expect(unconfiguredCleanupRouter.deleteSessionArtifacts("hermes", { workDir: "C:/repo" })).rejects.toThrow(
      /hermes runtime cleanup/i,
    );
  });

  test("reports optional runtime surfaces without throwing", () => {
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "api",
          surfaceSupport: [
            {
              surface: "task",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
          ],
        }),
      ]),
    );

    expect(router.supportsSurface("api", "task")).toBe(true);
    expect(router.supportsSurface("api", "cleanup")).toBe(false);
    expect(router.supportsSurface("openclaw", "cleanup")).toBe(false);
  });

  test("rejects cleanup requests that use runtimeConversation owned by another runtime", async () => {
    const deleteSessionArtifacts = vi.fn(async () => undefined);
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "cleanup",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
          ],
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation: (conversation) => conversation,
            decodeConversation: () => ({ native: { threadId: "codex-thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          deleteSessionArtifacts,
        }),
        createDriver({
          runtimeId: "claude",
          surfaceSupport: [],
          runtimeStateCodec: {
            runtimeId: "claude",
            restorePersistedConversation: () => undefined,
            cloneConversation: (conversation) => conversation,
            decodeConversation: () => ({ native: { sessionId: "claude-session-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "claude",
              codecVersion: "v1",
              payload,
            }),
          },
        }),
      ]),
    );

    await expect(
      router.deleteSessionArtifacts("codex", {
        workDir: "C:/repo",
        runtimeConversation: {
          runtimeId: "claude",
          codecVersion: "v1",
          payload: { native: { sessionId: "claude-session-1" } },
        },
      }),
    ).rejects.toThrow(/codex cannot use runtimeConversation owned by claude/i);
    expect(deleteSessionArtifacts).not.toHaveBeenCalled();
  });

  test("routes workflow requests only through drivers that declare workflow support", async () => {
    const askWorkflow = vi.fn(async (_input: RuntimeWorkflowRequestContext) => ({ content: "workflow ok" }));
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "workflow",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation: (conversation) => conversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          askWorkflow,
        }),
      ]),
    );

    await expect(
      router.askWorkflow({
        requestId: "wf-1",
        prompt: "Plan it",
        runtimeId: "codex",
        executionMode: "oneshot",
        continuationPolicy: "resume-preferred",
        runtimeConfig: { model: "gpt-5.5" },
        runtime: {
          id: "codex",
          label: "Codex",
          version: "test",
          available: true,
          command: "codex",
        },
        channelId: "codex-openai",
        workDir: "C:/repo",
      } satisfies RuntimeWorkflowRequestContext),
    ).resolves.toEqual({ content: "workflow ok" });
    expect(askWorkflow).toHaveBeenCalledTimes(1);

    const badRouter = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "api",
          surfaceSupport: [
            {
              surface: "workflow",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
          ],
          getCapabilities: () => oneshotCapabilities("api"),
        }),
      ]),
    );

    await expect(
      badRouter.askWorkflow({
        requestId: "wf-2",
        prompt: "Plan it",
        runtimeId: "api",
        executionMode: "oneshot",
        continuationPolicy: "resume-preferred",
        runtimeConfig: { model: "default" },
        runtime,
        channelId: "api-default",
        workDir: "C:/repo",
      } satisfies RuntimeWorkflowRequestContext),
    ).rejects.toThrow(/api does not support workflow oneshot with continuation policy resume-preferred/i);
  });

  test("routes one-shot execution through the declared driver for the request surface", () => {
    const executor = {
      start: async () => undefined,
      stop: async () => undefined,
    } satisfies AgentExecutor;
    const createOneShotExecutor = vi.fn((_context: AgentExecutionContext) => executor);
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "task",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          createOneShotExecutor,
        }),
      ]),
    );

    const context = {
      runId: "task-1",
      runKind: "task",
      prompt: "Inspect the repo",
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConfig: { model: "gpt-5.5" },
      runtime: {
        id: "codex",
        label: "Codex",
        version: "test",
        available: true,
        command: "codex",
      },
      channelId: "codex-openai",
      workDir: "C:/repo",
      developerInstructions: "",
      emit: () => undefined,
      onExit: () => undefined,
    } satisfies AgentExecutionContext;

    expect(router.createOneShotExecutor(context)).toBe(executor);
    expect(createOneShotExecutor).toHaveBeenCalledWith(context);
  });

  test("rejects resume-required one-shot requests when runtimeConversation is missing", () => {
    const executor = {
      start: async () => undefined,
      stop: async () => undefined,
    } satisfies AgentExecutor;
    const createOneShotExecutor = vi.fn((_context: AgentExecutionContext) => executor);
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "task",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-required"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation: (conversation) => conversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          createOneShotExecutor,
        }),
      ]),
    );

    expect(() =>
      router.createOneShotExecutor({
        runId: "task-resume-required-1",
        runKind: "task",
        prompt: "Inspect the repo",
        runtimeId: "codex",
        executionMode: "oneshot",
        continuationPolicy: "resume-required",
        runtimeConfig: { model: "gpt-5.5" },
        runtime: {
          id: "codex",
          label: "Codex",
          version: "test",
          available: true,
          command: "codex",
        },
        channelId: "codex-openai",
        workDir: "C:/repo",
        developerInstructions: "",
        emit: () => undefined,
        onExit: () => undefined,
      } satisfies AgentExecutionContext),
    ).toThrow(/codex task oneshot requires runtimeConversation for continuation policy resume-required/i);
    expect(createOneShotExecutor).not.toHaveBeenCalled();
  });

  test("rejects one-shot requests that use runtimeConversation owned by another runtime", () => {
    const executor = {
      start: async () => undefined,
      stop: async () => undefined,
    } satisfies AgentExecutor;
    const createOneShotExecutor = vi.fn((_context: AgentExecutionContext) => executor);
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "task",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation: (conversation) => conversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          createOneShotExecutor,
        }),
      ]),
    );

    expect(() =>
      router.createOneShotExecutor({
        runId: "task-cross-runtime-1",
        runKind: "task",
        prompt: "Inspect the repo",
        runtimeId: "codex",
        executionMode: "oneshot",
        continuationPolicy: "resume-preferred",
        runtimeConversation: {
          runtimeId: "claude",
          codecVersion: "v1",
          payload: { native: { sessionId: "claude-session-1" } },
        },
        runtimeConfig: { model: "gpt-5.5" },
        runtime: {
          id: "codex",
          label: "Codex",
          version: "test",
          available: true,
          command: "codex",
        },
        channelId: "codex-openai",
        workDir: "C:/repo",
        developerInstructions: "",
        emit: () => undefined,
        onExit: () => undefined,
      } satisfies AgentExecutionContext),
    ).toThrow(/codex cannot use runtimeConversation owned by claude/i);
    expect(createOneShotExecutor).not.toHaveBeenCalled();
  });

  test("rejects non-fresh one-shot requests for stateless runtimes from declared support before inferring runtime conversations", async () => {
    const executor = {
      start: async () => undefined,
      stop: async () => undefined,
    } satisfies AgentExecutor;
    const createOneShotExecutor = vi.fn((_context: AgentExecutionContext) => executor);
    const askWorkflow = vi.fn(async (_input: RuntimeWorkflowRequestContext) => ({ content: "workflow ok" }));
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "api",
          surfaceSupport: [
            {
              surface: "chat",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
            {
              surface: "task",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
            {
              surface: "workflow",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
          ],
          getCapabilities: () => oneshotCapabilities("api"),
          createOneShotExecutor,
          askWorkflow,
        }),
      ]),
    );
    const runtimeConversation = {
      runtimeId: "api",
      codecVersion: "v1",
      payload: { requestId: "api-request-1" },
    } as const;

    expect(() =>
      router.createOneShotExecutor({
        runId: "task-api-resume-required-1",
        runKind: "task",
        prompt: "Inspect the repo",
        runtimeId: "api",
        executionMode: "oneshot",
        continuationPolicy: "resume-required",
        runtimeConversation,
        runtimeConfig: { model: "default" },
        runtime,
        channelId: "api-default",
        workDir: "C:/repo",
        developerInstructions: "",
        emit: () => undefined,
        onExit: () => undefined,
      } satisfies AgentExecutionContext),
    ).toThrow(/api does not support task oneshot with continuation policy resume-required/i);
    expect(createOneShotExecutor).not.toHaveBeenCalled();

    await expect(
      router.askWorkflow({
        requestId: "wf-api-resume-preferred-1",
        prompt: "Plan it",
        runtimeId: "api",
        executionMode: "oneshot",
        continuationPolicy: "resume-preferred",
        runtimeConversation,
        runtimeConfig: { model: "default" },
        runtime,
        channelId: "api-default",
        workDir: "C:/repo",
      } satisfies RuntimeWorkflowRequestContext),
    ).rejects.toThrow(/api does not support workflow oneshot with continuation policy resume-preferred/i);
    expect(askWorkflow).not.toHaveBeenCalled();
  });

  test("rejects resume-required workflow requests when runtimeConversation is missing", async () => {
    const askWorkflow = vi.fn(async (_input: RuntimeWorkflowRequestContext) => ({ content: "workflow ok" }));
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "workflow",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-required"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation: (conversation) => conversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          askWorkflow,
        }),
      ]),
    );

    await expect(
      router.askWorkflow({
        requestId: "wf-resume-required-1",
        prompt: "Plan it",
        runtimeId: "codex",
        executionMode: "oneshot",
        continuationPolicy: "resume-required",
        runtimeConfig: { model: "gpt-5.5" },
        runtime: {
          id: "codex",
          label: "Codex",
          version: "test",
          available: true,
          command: "codex",
        },
        channelId: "codex-openai",
        workDir: "C:/repo",
      } satisfies RuntimeWorkflowRequestContext),
    ).rejects.toThrow(/codex workflow oneshot requires runtimeConversation for continuation policy resume-required/i);
    expect(askWorkflow).not.toHaveBeenCalled();
  });

  test("rejects workflow requests that use runtimeConversation owned by another runtime", async () => {
    const askWorkflow = vi.fn(async (_input: RuntimeWorkflowRequestContext) => ({ content: "workflow ok" }));
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "workflow",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation: (conversation) => conversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          askWorkflow,
        }),
      ]),
    );

    await expect(
      router.askWorkflow({
        requestId: "wf-cross-runtime-1",
        prompt: "Plan it",
        runtimeId: "codex",
        executionMode: "oneshot",
        continuationPolicy: "resume-preferred",
        runtimeConversation: {
          runtimeId: "claude",
          codecVersion: "v1",
          payload: { native: { sessionId: "claude-session-1" } },
        },
        runtimeConfig: { model: "gpt-5.5" },
        runtime: {
          id: "codex",
          label: "Codex",
          version: "test",
          available: true,
          command: "codex",
        },
        channelId: "codex-openai",
        workDir: "C:/repo",
      } satisfies RuntimeWorkflowRequestContext),
    ).rejects.toThrow(/codex cannot use runtimeConversation owned by claude/i);
    expect(askWorkflow).not.toHaveBeenCalled();
  });

  test("fresh one-shot requests still dispatch for same-runtime envelopes when the runtime has no codec", () => {
    const executor = {
      start: async () => undefined,
      stop: async () => undefined,
    } satisfies AgentExecutor;
    const createOneShotExecutor = vi.fn((_context: AgentExecutionContext) => executor);
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "api",
          surfaceSupport: [
            {
              surface: "task",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh"],
            },
          ],
          getCapabilities: () => oneshotCapabilities("api"),
          createOneShotExecutor,
        }),
      ]),
    );

    expect(
      router.createOneShotExecutor({
        runId: "task-api-fresh-1",
        runKind: "task",
        prompt: "Inspect the repo",
        runtimeId: "api",
        executionMode: "oneshot",
        continuationPolicy: "fresh",
        runtimeConversation: {
          runtimeId: "api",
          codecVersion: "v1",
          payload: { native: { requestId: "api-request-1" } },
        },
        runtimeConfig: { model: "default" },
        runtime,
        channelId: "api-default",
        workDir: "C:/repo",
        developerInstructions: "",
        emit: () => undefined,
        onExit: () => undefined,
      } satisfies AgentExecutionContext),
    ).toBe(executor);
    expect(createOneShotExecutor).toHaveBeenCalledTimes(1);
    expect(createOneShotExecutor.mock.calls[0]![0].runtimeConversation).toBeUndefined();
  });

  test("omits runtimeConversation before dispatching fresh one-shot requests to drivers", () => {
    const runtimeConversation = {
      runtimeId: "codex",
      codecVersion: "v1",
      payload: { native: { threadId: "thread-1" } },
    } as const;
    const executor = {
      start: async () => undefined,
      stop: async () => undefined,
    } satisfies AgentExecutor;
    const createOneShotExecutor = vi.fn((_context: AgentExecutionContext) => executor);
    const cloneConversation = vi.fn((conversation: typeof runtimeConversation) => ({
      runtimeId: conversation.runtimeId,
      codecVersion: conversation.codecVersion,
      payload: structuredClone(conversation.payload),
    }));
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "task",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          createOneShotExecutor,
        }),
      ]),
    );

    router.createOneShotExecutor({
      runId: "task-1",
      runKind: "task",
      prompt: "Inspect the repo",
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConversation,
      runtimeConfig: { model: "gpt-5.5" },
      runtime: {
        id: "codex",
        label: "Codex",
        version: "test",
        available: true,
        command: "codex",
      },
      channelId: "codex-openai",
      workDir: "C:/repo",
      developerInstructions: "",
      emit: () => undefined,
      onExit: () => undefined,
    } satisfies AgentExecutionContext);

    expect(createOneShotExecutor).toHaveBeenCalledTimes(1);
    expect(createOneShotExecutor.mock.calls[0]![0].runtimeConversation).toBeUndefined();
    expect(cloneConversation).not.toHaveBeenCalled();
  });

  test("omits runtimeConversation before dispatching fresh workflow requests to drivers", async () => {
    const runtimeConversation = {
      runtimeId: "codex",
      codecVersion: "v1",
      payload: { native: { threadId: "thread-1" } },
    } as const;
    const askWorkflow = vi.fn(async (_input: RuntimeWorkflowRequestContext) => ({ content: "workflow ok" }));
    const cloneConversation = vi.fn((conversation: typeof runtimeConversation) => ({
      runtimeId: conversation.runtimeId,
      codecVersion: conversation.codecVersion,
      payload: structuredClone(conversation.payload),
    }));
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "workflow",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          askWorkflow,
        }),
      ]),
    );

    await router.askWorkflow({
      requestId: "wf-fresh-1",
      prompt: "Plan it",
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "fresh",
      runtimeConversation,
      runtimeConfig: { model: "gpt-5.5" },
      runtime: {
        id: "codex",
        label: "Codex",
        version: "test",
        available: true,
        command: "codex",
      },
      channelId: "codex-openai",
      workDir: "C:/repo",
    } satisfies RuntimeWorkflowRequestContext);

    expect(askWorkflow).toHaveBeenCalledTimes(1);
    expect(askWorkflow.mock.calls[0]![0].runtimeConversation).toBeUndefined();
  });

  test("omits runtimeConversation before dispatching fresh interactive session requests to drivers", () => {
    const runtimeConversation = {
      runtimeId: "codex",
      codecVersion: "v1",
      payload: { native: { threadId: "thread-1" } },
    } as const;
    const session = createInteractiveSessionStub();
    const createInteractiveSession = vi.fn((_context: InteractiveSessionContext) => session);
    const cloneConversation = vi.fn((conversation: typeof runtimeConversation) => ({
      runtimeId: conversation.runtimeId,
      codecVersion: conversation.codecVersion,
      payload: structuredClone(conversation.payload),
    }));
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "chat",
              executionModes: ["interactive"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          createInteractiveSession,
        }),
      ]),
    );

    expect(
      router.createInteractiveSession({
        chatId: "chat-fresh-1",
        configuredAgentId: "agent-1",
        runtimeId: "codex",
        executionMode: "interactive",
        continuationPolicy: "fresh",
        runtimeConversation,
        runtimeConfig: { model: "gpt-5.5" },
        runtime: {
          id: "codex",
          label: "Codex",
          version: "test",
          available: true,
          command: "codex",
        },
        channelId: "codex-openai",
        workDir: "C:/repo",
        developerInstructions: "",
        emit: () => undefined,
      } satisfies InteractiveSessionContext),
    ).toBe(session);

    expect(createInteractiveSession).toHaveBeenCalledTimes(1);
    expect(createInteractiveSession.mock.calls[0]![0].runtimeConversation).toBeUndefined();
  });

  test("rejects resume-required interactive session requests when runtimeConversation is missing", () => {
    const session = createInteractiveSessionStub();
    const createInteractiveSession = vi.fn((_context: InteractiveSessionContext) => session);
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "chat",
              executionModes: ["interactive"],
              continuationPolicies: ["fresh", "resume-required"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation: (conversation) => conversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          createInteractiveSession,
        }),
      ]),
    );

    expect(() =>
      router.createInteractiveSession({
        chatId: "chat-resume-required-1",
        configuredAgentId: "agent-1",
        runtimeId: "codex",
        executionMode: "interactive",
        continuationPolicy: "resume-required",
        runtimeConfig: { model: "gpt-5.5" },
        runtime: {
          id: "codex",
          label: "Codex",
          version: "test",
          available: true,
          command: "codex",
        },
        channelId: "codex-openai",
        workDir: "C:/repo",
        developerInstructions: "",
        emit: () => undefined,
      } satisfies InteractiveSessionContext),
    ).toThrow(/codex chat interactive requires runtimeConversation for continuation policy resume-required/i);
    expect(createInteractiveSession).not.toHaveBeenCalled();
  });

  test("rejects interactive session requests that use runtimeConversation owned by another runtime", () => {
    const session = createInteractiveSessionStub();
    const createInteractiveSession = vi.fn((_context: InteractiveSessionContext) => session);
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "chat",
              executionModes: ["interactive"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation: (conversation) => conversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          createInteractiveSession,
        }),
      ]),
    );

    expect(() =>
      router.createInteractiveSession({
        chatId: "chat-cross-runtime-1",
        configuredAgentId: "agent-1",
        runtimeId: "codex",
        executionMode: "interactive",
        continuationPolicy: "resume-preferred",
        runtimeConversation: {
          runtimeId: "claude",
          codecVersion: "v1",
          payload: { native: { sessionId: "claude-session-1" } },
        },
        runtimeConfig: { model: "gpt-5.5" },
        runtime: {
          id: "codex",
          label: "Codex",
          version: "test",
          available: true,
          command: "codex",
        },
        channelId: "codex-openai",
        workDir: "C:/repo",
        developerInstructions: "",
        emit: () => undefined,
      } satisfies InteractiveSessionContext),
    ).toThrow(/codex cannot use runtimeConversation owned by claude/i);
    expect(createInteractiveSession).not.toHaveBeenCalled();
  });

  test("passes codec-cloned runtimeConversation through to non-fresh requests", async () => {
    const taskConversation = {
      runtimeId: "codex",
      codecVersion: "v1",
      payload: { native: { threadId: "thread-task-1" } },
    } as const;
    const workflowConversation = {
      runtimeId: "codex",
      codecVersion: "v1",
      payload: { native: { threadId: "thread-workflow-1" } },
    } as const;
    const interactiveConversation = {
      runtimeId: "codex",
      codecVersion: "v1",
      payload: { native: { threadId: "thread-chat-1" } },
    } as const;
    const executor = {
      start: async () => undefined,
      stop: async () => undefined,
    } satisfies AgentExecutor;
    const session = createInteractiveSessionStub();
    const createOneShotExecutor = vi.fn((_context: AgentExecutionContext) => executor);
    const askWorkflow = vi.fn(async (_input: RuntimeWorkflowRequestContext) => ({ content: "workflow ok" }));
    const createInteractiveSession = vi.fn((_context: InteractiveSessionContext) => session);
    const cloneConversation = vi.fn((conversation: {
      runtimeId: "codex";
      codecVersion: "v1";
      payload: { native: { threadId: string } };
    }) => ({
      runtimeId: conversation.runtimeId,
      codecVersion: conversation.codecVersion,
      payload: structuredClone(conversation.payload),
    }));
    const router = new RuntimeRouter(
      new RuntimeDriverRegistry([
        createDriver({
          runtimeId: "codex",
          surfaceSupport: [
            {
              surface: "task",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
            {
              surface: "workflow",
              executionModes: ["oneshot"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
            {
              surface: "chat",
              executionModes: ["interactive"],
              continuationPolicies: ["fresh", "resume-preferred"],
            },
          ],
          getCapabilities: () => interactiveCapabilities("codex"),
          runtimeStateCodec: {
            runtimeId: "codex",
            restorePersistedConversation: () => undefined,
            cloneConversation,
            decodeConversation: () => ({ native: { threadId: "thread-1" } }),
            encodeConversation: (payload) => ({
              runtimeId: "codex",
              codecVersion: "v1",
              payload,
            }),
          },
          createOneShotExecutor,
          askWorkflow,
          createInteractiveSession,
        }),
      ]),
    );

    router.createOneShotExecutor({
      runId: "task-resume-1",
      runKind: "task",
      prompt: "Inspect the repo",
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "resume-preferred",
      runtimeConversation: taskConversation,
      runtimeConfig: { model: "gpt-5.5" },
      runtime: {
        id: "codex",
        label: "Codex",
        version: "test",
        available: true,
        command: "codex",
      },
      channelId: "codex-openai",
      workDir: "C:/repo",
      developerInstructions: "",
      emit: () => undefined,
      onExit: () => undefined,
    } satisfies AgentExecutionContext);
    await router.askWorkflow({
      requestId: "wf-resume-1",
      prompt: "Plan it",
      runtimeId: "codex",
      executionMode: "oneshot",
      continuationPolicy: "resume-preferred",
      runtimeConversation: workflowConversation,
      runtimeConfig: { model: "gpt-5.5" },
      runtime: {
        id: "codex",
        label: "Codex",
        version: "test",
        available: true,
        command: "codex",
      },
      channelId: "codex-openai",
      workDir: "C:/repo",
    } satisfies RuntimeWorkflowRequestContext);
    router.createInteractiveSession({
      chatId: "chat-resume-1",
      configuredAgentId: "agent-1",
      runtimeId: "codex",
      executionMode: "interactive",
      continuationPolicy: "resume-preferred",
      runtimeConversation: interactiveConversation,
      runtimeConfig: { model: "gpt-5.5" },
      runtime: {
        id: "codex",
        label: "Codex",
        version: "test",
        available: true,
        command: "codex",
      },
      channelId: "codex-openai",
      workDir: "C:/repo",
      developerInstructions: "",
      emit: () => undefined,
    } satisfies InteractiveSessionContext);

    const oneShotContext = createOneShotExecutor.mock.calls[0]![0];
    const workflowContext = askWorkflow.mock.calls[0]![0];
    const interactiveContext = createInteractiveSession.mock.calls[0]![0];

    expect(oneShotContext.runtimeConversation).toEqual(taskConversation);
    expect(oneShotContext.runtimeConversation).not.toBe(taskConversation);
    expect(workflowContext.runtimeConversation).toEqual(workflowConversation);
    expect(workflowContext.runtimeConversation).not.toBe(workflowConversation);
    expect(interactiveContext.runtimeConversation).toEqual(interactiveConversation);
    expect(interactiveContext.runtimeConversation).not.toBe(interactiveConversation);
  });
});
