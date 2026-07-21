import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AgentEvent, AgentRuntime, ChatRuntimeSessionState } from "../../../shared/types";
import { CodexRpcClient } from "./codex-rpc";
import { CodexInteractiveSession } from "./codex-interactive-session";

function codexRuntime(command: string): AgentRuntime {
  return {
    id: "codex",
    label: "Codex",
    command,
    version: "test",
    available: true,
  };
}

function runtimeSessionCapabilities(): ChatRuntimeSessionState["capabilities"] {
  return {
    supportsInProcessConversationResume: true,
    supportsResumeAfterDetach: true,
    supportsResumeAfterAppRestart: true,
    supportsTurnResume: false,
    supportsInterrupt: true,
    supportsContinue: true,
    supportsApprovalRequests: true,
    supportsUserInputRequests: true,
  };
}

function baseCodexContextWithResume(workDir: string) {
  return {
    chatId: "chat-1",
    configuredAgentId: "codex-agent",
    runtimeId: "codex" as const,
    executionMode: "interactive" as const,
    continuationPolicy: "resume-preferred" as const,
    runtime: codexRuntime("codex"),
    channelId: "codex-openai",
    workDir,
    runtimeConfig: { model: "gpt-5.5" },
    developerInstructions: "test",
    runtimeConversation: {
      runtimeId: "codex" as const,
      codecVersion: "v1",
      payload: { native: { threadId: "thread-1" } },
    },
    emit: () => undefined,
    syncState: () => undefined,
  };
}

function codexSessionOptions(
  clientOverrides: Partial<{
    start: () => Promise<void>;
    request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    shutdown: () => Promise<void>;
    interruptTurn: (threadId: string, turnId: string | undefined) => Promise<void>;
  }> = {},
) {
  return {
    capabilities: runtimeSessionCapabilities(),
    now: () => 1000,
    createCodexClient: () =>
      ({
        start: async () => undefined,
        request: async (method: string) =>
          method === "thread/resume"
            ? { thread: { id: "thread-1" } }
            : method === "turn/start"
              ? { turn: { id: "turn-1" } }
              : {},
        interruptTurn: async () => undefined,
        shutdown: async () => undefined,
        ...clientOverrides,
      }) as any,
  };
}

describe("CodexInteractiveSession", () => {
  test.each([
    ["workflow planning", true, "on-request"],
    ["regular chat", false, "never"],
  ] as const)("uses the expected approval policy for %s", async (_label, workflowPlanning, expectedPolicy) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-approval-policy-"));
    const request = vi.fn(async (method: string) =>
      method === "thread/start" ? { thread: { id: "thread-1" } } : {},
    );
    const session = new CodexInteractiveSession(
      {
        chatId: "chat-1",
        configuredAgentId: "default-agent",
        runtimeId: "codex",
        executionMode: "interactive",
        continuationPolicy: "resume-preferred",
        runtime: codexRuntime("codex"),
        channelId: "codex-openai",
        workDir: dir,
        runtimeConfig: { model: "default" },
        developerInstructions: "test",
        emit: () => undefined,
        syncState: () => undefined,
        ...(workflowPlanning ? { planningWorkflowId: "wf-planning" } : {}),
      },
      codexSessionOptions({ request }),
    );

    await session.ensureAttached();

    expect(request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({ approvalPolicy: expectedPolicy }),
    );
  });

  test("shuts down the Codex client if attach fails after process start", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-attach-fail-"));
    const client = {
      start: vi.fn(async () => undefined),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") throw new Error("attach failed");
        return {};
      }),
      shutdown: vi.fn(async () => undefined),
      interruptTurn: vi.fn(async () => undefined),
    };

    const session = new CodexInteractiveSession(
      {
        chatId: "chat-1",
        configuredAgentId: "default-agent",
        runtimeId: "codex",
        executionMode: "interactive",
        continuationPolicy: "resume-preferred",
        runtime: codexRuntime("codex"),
        channelId: "codex-openai",
        workDir: dir,
        runtimeConfig: { model: "default" },
        developerInstructions: "test",
        emit: () => undefined,
        syncState: () => undefined,
      },
      {
        now: () => 500,
        createCodexClient: () => client as unknown as CodexRpcClient,
        capabilities: runtimeSessionCapabilities(),
      },
    );

    await expect(session.sendPrompt("First")).rejects.toThrow("attach failed");
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(session.snapshot().runtimeState.attachmentState).toBe("detached");
  });

  test("rejects a Codex attachment that does not return a thread id", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-missing-thread-"));
    const shutdown = vi.fn(async () => undefined);
    const session = new CodexInteractiveSession(
      {
        chatId: "chat-1",
        configuredAgentId: "default-agent",
        runtimeId: "codex",
        executionMode: "interactive",
        continuationPolicy: "resume-preferred",
        runtime: codexRuntime("codex"),
        channelId: "codex-openai",
        workDir: dir,
        runtimeConfig: { model: "default" },
        developerInstructions: "test",
        emit: () => undefined,
        syncState: () => undefined,
      },
      codexSessionOptions({ request: async () => ({}), shutdown }),
    );

    await expect(session.sendPrompt("First")).rejects.toThrow("without a thread id");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(session.snapshot().runtimeState.attachmentState).toBe("detached");
    await expect(session.interrupt()).resolves.toBeUndefined();
  });
  test("detaches an idle Codex attachment and resumes the same thread on the next prompt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-session-"));
    const seen: AgentEvent[] = [];
    let callbacks:
      | {
          onEvent: (event: AgentEvent) => void;
          onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string) => void;
        }
      | undefined;
    const client = {
      start: vi.fn(async () => undefined),
      request: vi.fn(async (method: string, params: any) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "thread/resume") return { thread: { id: params.threadId } };
        if (method === "turn/start") {
          callbacks?.onEvent({ type: "completed", content: `reply:${params.input[0].text}` });
          return { turn: { id: `turn-${params.input[0].text}` } };
        }
        return {};
      }),
      shutdown: vi.fn(async () => undefined),
      interruptTurn: vi.fn(async () => undefined),
    };

    const session = new CodexInteractiveSession(
      {
        chatId: "chat-1",
        configuredAgentId: "default-agent",
        runtimeId: "codex",
        executionMode: "interactive",
        continuationPolicy: "resume-preferred",
        runtime: codexRuntime("codex"),
        channelId: "codex-openai",
        workDir: dir,
        runtimeConfig: { model: "default" },
        developerInstructions: "test",
        emit: (event) => seen.push(event),
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        createCodexClient: (input) => {
          callbacks = input;
          return client as unknown as CodexRpcClient;
        },
        capabilities: runtimeSessionCapabilities(),
      },
    );

    await session.sendPrompt("First");
    const first = session.snapshot().runtimeConversation;
    expect(first).toMatchObject({
      runtimeId: "codex",
      codecVersion: "v1",
      payload: { native: { threadId: "thread-1" } },
    });
    expect(session.snapshot().runtimeState.attachmentState).toBe("idle");

    await session.detachIfStillExpired({
      expectedGeneration: session.snapshot().runtimeState.attachmentGeneration,
      expectedLastMeaningfulActivityAt: session.snapshot().runtimeState.lastMeaningfulActivityAt!,
      reason: "idle_timeout",
    });

    await session.sendPrompt("Second");

    expect(client.request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({ threadId: "thread-1" }));
    expect(session.snapshot().runtimeConversation).toEqual(first);
  });

  test("interrupts the active Codex turn with its scoped turn id", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-interrupt-"));
    const client = {
      start: vi.fn(async () => undefined),
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        return {};
      }),
      shutdown: vi.fn(async () => undefined),
      interruptTurn: vi.fn(async () => undefined),
    };

    const session = new CodexInteractiveSession(
      {
        chatId: "chat-1",
        configuredAgentId: "default-agent",
        runtimeId: "codex",
        executionMode: "interactive",
        continuationPolicy: "resume-preferred",
        runtime: codexRuntime("codex"),
        channelId: "codex-openai",
        workDir: dir,
        runtimeConfig: { model: "default" },
        developerInstructions: "test",
        emit: () => undefined,
        syncState: () => undefined,
      },
      {
        now: () => 2000,
        createCodexClient: () => client as unknown as CodexRpcClient,
        capabilities: runtimeSessionCapabilities(),
      },
    );

    await session.sendPrompt("First");
    expect(session.snapshot().runtimeState.attachmentState).toBe("running");

    await session.interrupt();

    expect(client.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-1");
    expect(session.snapshot().runtimeState.attachmentState).toBe("interrupted");
  });

  test("clears the Codex native resume handle when workDir changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-codex-reconfigure-"));
    const session = new CodexInteractiveSession(baseCodexContextWithResume(dir), codexSessionOptions());

    session.reconfigure({ ...baseCodexContextWithResume(dir), workDir: "C:/other-repo" });

    expect(session.snapshot().runtimeConversation).toBeUndefined();
  });
});
