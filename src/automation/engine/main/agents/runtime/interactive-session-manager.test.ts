import { describe, expect, test, vi } from "vitest";
import { InteractiveSessionManager } from "./interactive-session-manager";
import { ProcessLease } from "../shared/process-lease";

describe("ProcessLease", () => {
  test("tracks monotonic attachment generations and mints generation-scoped turn ids", () => {
    const lease = new ProcessLease(0);

    expect(lease.matchesGeneration(0)).toBe(true);
    expect(lease.nextGeneration()).toBe(1);
    expect(lease.matchesGeneration(1)).toBe(true);
    expect(lease.nextTurnId()).toBe("turn-1-1");
    expect(lease.nextTurnId()).toBe("turn-1-2");
    expect(lease.nextGeneration()).toBe(2);
    expect(lease.matchesGeneration(1)).toBe(false);
    expect(lease.matchesGeneration(2)).toBe(true);
    expect(lease.nextTurnId()).toBe("turn-2-1");
  });
});

describe("InteractiveSessionManager", () => {
  test("serializes duplicate chat sends through one session queue", async () => {
    const started: string[] = [];
    let running = false;
    const session = {
      reconfigure: vi.fn(),
      ensureAttached: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async (prompt: string) => {
        expect(running).toBe(false);
        running = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        started.push(prompt);
        running = false;
      }),
      interrupt: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      detachIfStillExpired: vi.fn(async () => undefined),
      snapshot: () => ({
        runtimeState: {
          executionStyle: "interactive" as const,
          attachmentState: "idle" as const,
          attachmentGeneration: 1,
          capabilities: {
            supportsInProcessConversationResume: true,
            supportsResumeAfterDetach: false,
            supportsResumeAfterAppRestart: false,
            supportsTurnResume: false,
            supportsInterrupt: true,
            supportsContinue: true,
            supportsApprovalRequests: false,
            supportsUserInputRequests: false,
          },
        },
      }),
    };

    const manager = new InteractiveSessionManager({
      createSession: () => session,
      now: () => 1000,
    });

    await manager.getOrCreate("chat-1", {} as never);
    await Promise.all([
      manager.dispatch("chat-1", (interactive) => interactive.sendPrompt("first")),
      manager.dispatch("chat-1", (interactive) => interactive.sendPrompt("second")),
    ]);

    expect(started).toEqual(["first", "second"]);
    expect(session.reconfigure).toHaveBeenCalledTimes(0);
  });

  test("dispatch reconfigures the existing session inside the queue before the next send", async () => {
    const seen: string[] = [];
    const manager = new InteractiveSessionManager({
      createSession: () =>
        ({
          reconfigure: (context: { runtimeConfig: { model: string } }) => seen.push(`reconfigure:${context.runtimeConfig.model}`),
          ensureAttached: async () => undefined,
          sendPrompt: async (prompt: string) => seen.push(`prompt:${prompt}`),
          interrupt: async () => undefined,
          detach: async () => undefined,
          detachIfStillExpired: async () => undefined,
          snapshot: () => ({
            runtimeState: {
              executionStyle: "interactive" as const,
              attachmentState: "detached" as const,
              attachmentGeneration: 0,
              capabilities: {
                supportsInProcessConversationResume: true,
                supportsResumeAfterDetach: true,
                supportsResumeAfterAppRestart: true,
                supportsTurnResume: false,
                supportsInterrupt: true,
                supportsContinue: true,
                supportsApprovalRequests: true,
                supportsUserInputRequests: true,
              },
            },
          }),
        }) as any,
      now: () => 1000,
    });

    manager.getOrCreate("chat-1", { runtimeConfig: { model: "old-model" } } as any);
    await (manager as any).dispatch("chat-1", { runtimeConfig: { model: "new-model" } } as any, (session: any) => session.sendPrompt("hello"));

    expect(seen).toEqual(["reconfigure:new-model", "prompt:hello"]);
  });

  test("idle sweep only detaches when generation and activity timestamp still match", async () => {
    const detachIfStillExpired = vi.fn(async () => undefined);
    let snapshot = {
      runtimeState: {
        executionStyle: "interactive" as const,
        attachmentState: "idle" as const,
        attachmentGeneration: 4,
        lastMeaningfulActivityAt: 1,
        capabilities: {
          supportsInProcessConversationResume: true,
          supportsResumeAfterDetach: false,
          supportsResumeAfterAppRestart: false,
          supportsTurnResume: false,
          supportsInterrupt: true,
          supportsContinue: true,
          supportsApprovalRequests: false,
          supportsUserInputRequests: false,
        },
      },
    };
    const manager = new InteractiveSessionManager({
      createSession: () =>
        ({
          reconfigure: vi.fn(),
          ensureAttached: vi.fn(async () => undefined),
          sendPrompt: vi.fn(async () => undefined),
          interrupt: vi.fn(async () => undefined),
          detach: vi.fn(async () => undefined),
          detachIfStillExpired,
          snapshot: () => {
            const captured = snapshot;
            snapshot = {
              ...snapshot,
              runtimeState: {
                ...snapshot.runtimeState,
                attachmentGeneration: 5,
                lastMeaningfulActivityAt: 2,
              },
            };
            return captured;
          },
        }) as never,
      now: () => 3_700_000,
    });

    await manager.getOrCreate("chat-1", {} as never);
    snapshot = {
      ...snapshot,
      runtimeState: {
        ...snapshot.runtimeState,
        attachmentGeneration: 4,
        lastMeaningfulActivityAt: 1,
      },
    };
    await manager.sweepExpiredSessions();

    expect(detachIfStillExpired).toHaveBeenCalledWith({
      expectedGeneration: 4,
      expectedLastMeaningfulActivityAt: 1,
      reason: "idle_timeout",
    });
  });
});
