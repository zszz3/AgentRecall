import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type {
  LiveSessionSnapshot,
  SessionEnvironment,
  SessionTraceEvent,
} from "../core/types";
import { CORE_IPC } from "../shared/ipc/core";
import {
  registerCoreIpc,
  type CoreIpcDependencies,
} from "./ipc/core";
import type { IpcMainRegistrar } from "./ipc/register-ipc-handler";

type RegisteredHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

function createMainRegistrar() {
  const handlers = new Map<string, RegisteredHandler>();
  const ipc = {
    handle(channel: string, listener: RegisteredHandler) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  } as unknown as IpcMainRegistrar;
  return { ipc, handlers };
}

function auxiliaryCoreServices() {
  return {
    nativeUpdateService: {
      getState: vi.fn(),
      check: vi.fn(),
      download: vi.fn(),
      install: vi.fn(),
      retry: vi.fn(),
      copyDiagnostics: vi.fn(),
      openHelp: vi.fn(),
      openReleases: vi.fn(),
    },
    privacyService: {
      diagnostics: vi.fn(),
      inspectLegacy: vi.fn(),
      previewLegacyCleanup: vi.fn(),
      applyLegacyCleanup: vi.fn(),
    },
  };
}

describe("Core IPC", () => {
  it("returns only Claude and Codex live sessions", async () => {
    const { ipc, handlers } = createMainRegistrar();
    const snapshot: LiveSessionSnapshot = {
      generatedAt: "2026-07-25T00:00:00.000Z",
      sessions: [
        { family: "claude", rawId: "claude-1", pid: 1 },
        { family: "codex", rawId: "codex-1", pid: 2 },
        { family: "tclaude", rawId: "tclaude-1", pid: 3 },
        { family: "tcodex", rawId: "tcodex-1", pid: 4 },
        { family: "codebuddy", rawId: "codebuddy-1", pid: 5 },
        { family: "trae", rawId: "trae-1", pid: 6 },
      ],
    };
    const dependencies = {
      getLiveSessions: vi.fn(async () => snapshot),
      ...auxiliaryCoreServices(),
    } as unknown as CoreIpcDependencies;
    registerCoreIpc(ipc, dependencies);

    const result = await handlers
      .get(CORE_IPC.getLiveSessions.channel)
      ?.({} as IpcMainInvokeEvent);

    expect(result).toEqual({
      ...snapshot,
      sessions: snapshot.sessions.slice(0, 2),
    });
  });

  it("returns only the real local environment", async () => {
    const { ipc, handlers } = createMainRegistrar();
    const environment = (
      id: string,
      kind: SessionEnvironment["kind"],
    ): SessionEnvironment => ({
      id,
      kind,
      label: id,
      hostAlias: null,
      host: null,
      user: null,
      port: null,
      authMode: "none",
      identityFile: null,
      enabled: true,
      syncState: "idle",
      lastSyncedAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const local = environment("local", "local");
    const store = {
      listEnvironments: vi.fn(() => [
        local,
        environment("local", "ssh"),
        environment("remote", "ssh"),
      ]),
    };
    const dependencies = {
      getStore: () => store,
      ...auxiliaryCoreServices(),
    } as unknown as CoreIpcDependencies;
    registerCoreIpc(ipc, dependencies);

    const result = await handlers
      .get(CORE_IPC.listEnvironments.channel)
      ?.({} as IpcMainInvokeEvent);

    expect(result).toEqual([local]);
  });

  it("filters legacy trace formats out of Core results", async () => {
    const { ipc, handlers } = createMainRegistrar();
    const trace = (source: SessionTraceEvent["source"]): SessionTraceEvent => ({
      index: 0,
      kind: "event",
      source,
      title: source,
      detail: "",
      timestamp: "2026-07-25T00:00:00.000Z",
    });
    const store = {
      getSession: vi.fn(() => ({
        sessionKey: "claude-cli:local:session",
        source: "claude-cli",
        environmentId: "local",
        environmentKind: "local",
      })),
      getTraceEvents: vi.fn(() => [
        trace("claude"),
        trace("trae"),
        trace("codex"),
        trace("codebuddy"),
      ]),
    };
    const dependencies = {
      getStore: () => store,
      ...auxiliaryCoreServices(),
    } as unknown as CoreIpcDependencies;
    registerCoreIpc(ipc, dependencies);

    const result = await handlers
      .get(CORE_IPC.getTraceEvents.channel)
      ?.({} as IpcMainInvokeEvent, "claude-cli:local:session", undefined);

    expect(result).toEqual([trace("claude"), trace("codex")]);
  });
});
