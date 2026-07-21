import { describe, expect, test, vi } from "vitest";
import type { AgentEvent, ChatRuntimeSessionState } from "../../../../../shared/types";
import type { InteractiveSessionContext } from "../../../../agents/runtime/runtime-driver";
import { hermesRuntimeStateCodec } from "../../../../agents/hermes/hermes-runtime-state-codec";
import { HermesInteractiveSession } from "./hermes-session";

const capabilities: ChatRuntimeSessionState["capabilities"] = {
  supportsInProcessConversationResume: true,
  supportsResumeAfterDetach: true,
  supportsResumeAfterAppRestart: true,
  supportsTurnResume: false,
  supportsInterrupt: true,
  supportsContinue: true,
  supportsApprovalRequests: true,
  supportsUserInputRequests: false,
};

function context(overrides: Partial<InteractiveSessionContext> = {}): InteractiveSessionContext {
  return {
    chatId: "chat-1",
    configuredAgentId: "hermes-agent",
    runtimeId: "hermes",
    executionMode: "interactive",
    continuationPolicy: "resume-preferred",
    runtimeConfig: { model: "default" },
    runtime: { id: "hermes", label: "Hermes", command: "hermes", version: "test", available: true },
    channelId: "hermes-default",
    workDir: "/repo",
    developerInstructions: "Follow desktop host instructions.",
    emit: vi.fn(),
    syncState: vi.fn(),
    ...overrides,
  };
}

function createFakeClient(onEvent: (event: AgentEvent) => void) {
  let attached = false;
  return {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(async (resumeSessionId?: string) => {
      attached = true;
      return resumeSessionId ?? "hermes-session-new";
    }),
    prompt: vi.fn(async (_prompt: string) => {
      onEvent({ type: "delta", content: "answer" });
      onEvent({ type: "completed" });
    }),
    interrupt: vi.fn(async () => undefined),
    detach: vi.fn(async () => {
      attached = false;
    }),
  };
}

describe("HermesInteractiveSession", () => {
  test("creates an ACP conversation and injects developer instructions on the first turn", async () => {
    const runtimeContext = context();
    let fakeClient: ReturnType<typeof createFakeClient> | undefined;
    const session = new HermesInteractiveSession(runtimeContext, {
      capabilities,
      createClient: ({ onEvent }) => {
        fakeClient = createFakeClient(onEvent);
        return fakeClient;
      },
    });

    await session.ensureAttached();
    await session.sendPrompt("Inspect the repo");

    expect(fakeClient?.attach).toHaveBeenCalledWith(undefined);
    expect(fakeClient?.prompt).toHaveBeenCalledWith(
      "Follow desktop host instructions.\n\nUser request:\nInspect the repo",
    );
    expect(session.snapshot().runtimeState.attachmentState).toBe("idle");
    expect(hermesRuntimeStateCodec.decodeConversation(session.snapshot().runtimeConversation)).toEqual({
      native: { sessionId: "hermes-session-new" },
      appContext: { cwd: "/repo", modelId: "default", transport: "acp" },
    });
    expect(runtimeContext.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "runtime_conversation" }));
  });

  test("resumes an ACP conversation, supports interrupt, and detaches cleanly", async () => {
    const runtimeConversation = hermesRuntimeStateCodec.encodeConversation({
      native: { sessionId: "hermes-session-existing" },
      appContext: { cwd: "/repo", modelId: "default", transport: "acp" },
    });
    const runtimeContext = context({ runtimeConversation });
    let fakeClient: ReturnType<typeof createFakeClient> | undefined;
    const session = new HermesInteractiveSession(runtimeContext, {
      capabilities,
      createClient: ({ onEvent }) => {
        fakeClient = createFakeClient(onEvent);
        return fakeClient;
      },
    });

    await session.ensureAttached();
    await session.sendPrompt("Continue");
    await session.interrupt();
    await session.detach("app_shutdown");

    expect(fakeClient?.attach).toHaveBeenCalledWith("hermes-session-existing");
    expect(fakeClient?.prompt).toHaveBeenCalledWith("Continue");
    expect(fakeClient?.interrupt).toHaveBeenCalledOnce();
    expect(fakeClient?.detach).toHaveBeenCalledOnce();
    expect(session.snapshot().runtimeState.attachmentState).toBe("detached");
  });
});
