import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentEvent, AgentRuntime, ChatRuntimeSessionState } from "../../../shared/types";
import { ClaudeInteractiveSession } from "./claude-interactive-session";

function claudeRuntime(command: string): AgentRuntime {
  return {
    id: "claude",
    label: "Claude",
    command,
    version: "test",
    available: true,
  };
}

function runtimeSessionCapabilities(): ChatRuntimeSessionState["capabilities"] {
  return {
    supportsInProcessConversationResume: true,
    supportsResumeAfterDetach: false,
    supportsResumeAfterAppRestart: false,
    supportsTurnResume: false,
    supportsInterrupt: true,
    supportsContinue: true,
    supportsApprovalRequests: true,
    supportsUserInputRequests: true,
  };
}

function claudeConversation(
  dir: string,
  sessionId: string,
  options: {
    modelId?: string;
    projectKey?: string;
    subpaths?: string[];
    claudeConfigDir?: string;
    sessionStoreRef?: string;
  } = {},
) {
  return {
    runtimeId: "claude" as const,
    codecVersion: "v1",
    payload: {
      native: {
        sessionId,
        ...(options.projectKey !== undefined ? { projectKey: options.projectKey } : {}),
        ...(options.subpaths !== undefined ? { subpaths: options.subpaths } : {}),
      },
      appContext: {
        cwd: dir,
        modelId: options.modelId ?? "claude-sonnet-4-6",
        ...(options.claudeConfigDir !== undefined ? { claudeConfigDir: options.claudeConfigDir } : {}),
        ...(options.sessionStoreRef !== undefined ? { sessionStoreRef: options.sessionStoreRef } : {}),
      },
    },
  };
}

function baseClaudeContext(dir: string, modelId = "claude-sonnet-4-6") {
  return {
    chatId: "chat-1",
    configuredAgentId: "claude-agent",
    runtimeId: "claude" as const,
    executionMode: "interactive" as const,
    continuationPolicy: "resume-preferred" as const,
    runtime: claudeRuntime("claude"),
    channelId: "claude-code",
    workDir: dir,
    runtimeConfig: { model: modelId },
    developerInstructions: "test",
    emit: () => undefined,
  };
}

function createSdkInteractiveStub(options: {
  isAttached?: () => boolean;
  attach?: (input: {
    cwd: string;
    modelId?: string;
    developerInstructions?: string;
    resumeSessionId?: string;
    mcpServers?: any;
    onEvent: (event: AgentEvent) => void;
  }) => Promise<void> | void;
  sendUserMessage?: (content: string) => Promise<void> | void;
  interrupt?: () => Promise<void> | void;
  detach?: () => Promise<void> | void;
} = {}) {
  let attached = false;

  return {
    isAttached: () => options.isAttached?.() ?? attached,
    attach: async (input: Parameters<NonNullable<typeof options.attach>>[0]) => {
      attached = true;
      await options.attach?.(input);
    },
    sendUserMessage: async (content: string) => {
      await options.sendUserMessage?.(content);
    },
    interrupt: async () => {
      await options.interrupt?.();
    },
    detach: async () => {
      attached = false;
      await options.detach?.();
    },
  };
}

describe("ClaudeInteractiveSession", () => {
  test("injects workflow MCP servers only for planning sessions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-planning-mcp-"));
    const attachments: Array<Record<string, unknown>> = [];
    const session = new ClaudeInteractiveSession(
      { ...baseClaudeContext(dir), planningWorkflowId: "wf-1" },
      {
        capabilities: runtimeSessionCapabilities(),
        resolveMcpServers: (context) => context.planningWorkflowId
          ? { multi_agent_chat: { type: "stdio", command: "node", args: ["mcp-server.js"] } }
          : undefined,
        sdkInteractive: createSdkInteractiveStub({ attach: async (input) => { attachments.push(input); } }),
      },
    );

    await session.ensureAttached();

    expect(attachments[0]?.mcpServers).toEqual({
      multi_agent_chat: { type: "stdio", command: "node", args: ["mcp-server.js"] },
    });
  });

  test("attaches the SDK interactive helper lazily on first prompt and sends the user message through it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-sdk-interactive-"));
    const attaches: Array<Record<string, unknown>> = [];
    const sent: string[] = [];

    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir),
        emit: () => undefined,
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        capabilities: runtimeSessionCapabilities(),
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            attaches.push(input);
          },
          sendUserMessage: async (content: string) => {
            sent.push(content);
          },
        }),
      },
    );

    await session.sendPrompt("hello");

    expect(attaches).toHaveLength(1);
    expect(attaches[0]).toMatchObject({
      cwd: dir,
      modelId: "claude-sonnet-4-6",
      developerInstructions: "test",
    });
    expect(sent).toEqual(["hello"]);
  });

  test("passes the persisted Claude session id into the SDK interactive helper when attaching", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-sdk-resume-"));
    const attaches: Array<Record<string, unknown>> = [];

    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir),
        runtimeConversation: claudeConversation(dir, "claude-session-1"),
        emit: () => undefined,
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        capabilities: runtimeSessionCapabilities(),
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            attaches.push(input);
          },
        }),
      },
    );

    await session.sendPrompt("resume");

    expect(attaches[0]).toMatchObject({
      resumeSessionId: "claude-session-1",
    });
  });

  test("resolves the SDK model id at attach time without overwriting the stored chat model id", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-resolved-model-"));
    const attaches: Array<Record<string, unknown>> = [];
    let forwardEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;

    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir, "default"),
        emit: () => undefined,
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        capabilities: runtimeSessionCapabilities(),
        resolveModelId: (context) => `resolved:${context.runtimeConfig.model}`,
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            attaches.push(input);
            forwardEvent = input.onEvent as (event: { type: string; [key: string]: unknown }) => void;
          },
        }),
      },
    );

    await session.sendPrompt("hello");
    forwardEvent?.({
      type: "runtime_conversation",
      runtimeConversation: claudeConversation(dir, "claude-session-1"),
    });

    expect(attaches[0]).toMatchObject({
      modelId: "resolved:default",
    });
    expect(session.snapshot().runtimeConversation).toMatchObject({
      runtimeId: "claude",
      codecVersion: "v1",
      payload: {
        native: { sessionId: "claude-session-1" },
        appContext: { modelId: "default" },
      },
    });
  });

  test("passes the persisted Claude session id and developer instructions into the SDK helper attach input", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-resume-envelope-"));
    const attaches: Array<Record<string, unknown>> = [];

    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir),
        runtimeConversation: claudeConversation(dir, "claude-session-1", {
          projectKey: "project-1",
          subpaths: ["subagent-a"],
          claudeConfigDir: "C:/claude-config",
          sessionStoreRef: "session-store-a",
        }),
        emit: () => undefined,
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        capabilities: runtimeSessionCapabilities(),
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            attaches.push(input);
          },
        }),
      },
    );

    await session.sendPrompt("hello");

    expect(attaches[0]).toMatchObject({
      cwd: dir,
      modelId: "claude-sonnet-4-6",
      developerInstructions: "test",
      resumeSessionId: "claude-session-1",
    });
  });

  test("does not attach Claude until the first prompt and reuses the same attached SDK session for follow-up prompts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-session-"));
    const attaches: Array<Record<string, unknown>> = [];
    const sent: string[] = [];
    let forwardEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir, "default"),
        emit: () => undefined,
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        capabilities: runtimeSessionCapabilities(),
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            attaches.push(input);
            forwardEvent = input.onEvent as (event: { type: string; [key: string]: unknown }) => void;
          },
          sendUserMessage: async (content: string) => {
            sent.push(content);
            forwardEvent?.({
              type: "runtime_conversation",
              runtimeConversation: claudeConversation(dir, "claude-session-1"),
            });
            forwardEvent?.({ type: "completed", content: `reply:${content}` });
          },
        }),
      },
    );

    expect(attaches).toHaveLength(0);
    await session.sendPrompt("first");
    await session.sendPrompt("second");

    expect(attaches).toHaveLength(1);
    expect(sent).toEqual(["first", "second"]);
    expect(session.snapshot().runtimeConversation).toMatchObject({
      runtimeId: "claude",
      codecVersion: "v1",
      payload: { native: { sessionId: "claude-session-1" } },
    });
  });

  test("preserves prior Claude resume metadata when a session event only refreshes the session id", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-session-refresh-"));
    let forwardEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir),
        runtimeConversation: claudeConversation(dir, "claude-session-1", {
          projectKey: "project-1",
          subpaths: ["worker-1"],
          claudeConfigDir: "C:/claude-config",
          sessionStoreRef: "session-store-a",
        }),
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        capabilities: runtimeSessionCapabilities(),
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            forwardEvent = input.onEvent as (event: { type: string; [key: string]: unknown }) => void;
          },
        }),
      },
    );

    await session.sendPrompt("first");
    forwardEvent?.({
      type: "runtime_conversation",
      runtimeConversation: claudeConversation(dir, "claude-session-2"),
    });

    expect(session.snapshot().runtimeConversation).toEqual(
      claudeConversation(dir, "claude-session-2", {
        projectKey: "project-1",
        subpaths: ["worker-1"],
        claudeConfigDir: "C:/claude-config",
        sessionStoreRef: "session-store-a",
      }),
    );
  });

  test("refreshes a native-only Claude runtime conversation without throwing and repopulates app context", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-native-only-refresh-"));
    let forwardEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir),
        runtimeConversation: {
          runtimeId: "claude",
          codecVersion: "v1",
          payload: {
            native: {
              sessionId: "claude-session-1",
            },
          },
        },
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        capabilities: runtimeSessionCapabilities(),
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            forwardEvent = input.onEvent as (event: { type: string; [key: string]: unknown }) => void;
          },
        }),
      },
    );

    await session.sendPrompt("first");

    expect(() =>
      forwardEvent?.({
        type: "runtime_conversation",
        runtimeConversation: claudeConversation(dir, "claude-session-2"),
      })
    ).not.toThrow();
    expect(session.snapshot().runtimeConversation).toEqual(claudeConversation(dir, "claude-session-2"));
  });

  test("preserves defined empty-string Claude resume metadata on session refresh", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-empty-metadata-refresh-"));
    let forwardEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir),
        runtimeConversation: claudeConversation(dir, "claude-session-1", {
          projectKey: "",
          subpaths: ["worker-1"],
          claudeConfigDir: "",
          sessionStoreRef: "",
        }),
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        capabilities: runtimeSessionCapabilities(),
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            forwardEvent = input.onEvent as (event: { type: string; [key: string]: unknown }) => void;
          },
        }),
      },
    );

    await session.sendPrompt("first");
    forwardEvent?.({
      type: "runtime_conversation",
      runtimeConversation: claudeConversation(dir, "claude-session-2"),
    });

    expect(session.snapshot().runtimeConversation).toEqual(
      claudeConversation(dir, "claude-session-2", {
        projectKey: "",
        subpaths: ["worker-1"],
        claudeConfigDir: "",
        sessionStoreRef: "",
      }),
    );
  });

  test("drops late Claude turn events after interrupt clears the active turn", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-interrupt-"));
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    let forwardEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir, "default"),
        emit: (event) => emitted.push(event as { type: string; [key: string]: unknown }),
        syncState: () => undefined,
      },
      {
        now: () => 1000,
        capabilities: runtimeSessionCapabilities(),
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            forwardEvent = input.onEvent as (event: { type: string; [key: string]: unknown }) => void;
            input.onEvent({
              type: "runtime_conversation",
              runtimeConversation: claudeConversation(dir, "claude-session-1"),
            });
          },
        }),
      },
    );

    await session.sendPrompt("first");
    expect(session.snapshot().runtimeState.activeTurnId).toBeDefined();

    await session.interrupt();
    expect(session.snapshot().runtimeState).toMatchObject({
      attachmentState: "interrupted",
    });
    expect(session.snapshot().runtimeState.activeTurnId).toBeUndefined();

    const eventCountBeforeLateOutput = emitted.length;
    forwardEvent?.({ type: "delta", content: "late" });
    forwardEvent?.({ type: "completed", content: "reply:first" });

    expect(emitted).toHaveLength(eventCountBeforeLateOutput);
    expect(session.snapshot().runtimeState).toMatchObject({
      attachmentState: "interrupted",
    });
  });

  test("stages a Claude model change until the running turn finishes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-claude-reconfigure-"));
    const startedModels: string[] = [];
    const syncStates: Array<{ runtimeState: ChatRuntimeSessionState }> = [];
    let forwardEvent: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    const session = new ClaudeInteractiveSession(
      {
        ...baseClaudeContext(dir),
        syncState: (state) => syncStates.push(state),
      },
      {
        capabilities: runtimeSessionCapabilities(),
        now: () => 1000,
        sdkInteractive: createSdkInteractiveStub({
          attach: async (input) => {
            startedModels.push((input.modelId as string | undefined) ?? "default");
            forwardEvent = input.onEvent as (event: { type: string; [key: string]: unknown }) => void;
            input.onEvent({
              type: "runtime_conversation",
              runtimeConversation: claudeConversation(dir, "claude-session-1"),
            });
          },
        }),
      },
    );

    await session.sendPrompt("first");
    const syncCountBeforeReconfigure = syncStates.length;

    session.reconfigure({
      ...baseClaudeContext(dir, "claude-opus-4-6"),
      syncState: (state) => syncStates.push(state),
    });

    expect(syncStates).toHaveLength(syncCountBeforeReconfigure + 1);
    expect(session.snapshot()).toMatchObject({
      runtimeState: {
        attachmentState: "running",
      },
      runtimeConversation: {
        runtimeId: "claude",
        codecVersion: "v1",
        payload: { native: { sessionId: "claude-session-1" } },
      },
    });

    forwardEvent?.({ type: "completed", content: "reply:first" });
    await session.sendPrompt("second");

    expect(startedModels).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
  });
});
