import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { CORE_IPC } from "../shared/ipc/core";
import {
  registerCoreIpc,
  type CoreIpcDependencies,
} from "./ipc/core";
import type { IpcMainRegistrar } from "./ipc/register-ipc-handler";

describe("Resume IPC contract", () => {
  it("returns an actionable error when a selected session disappeared", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle(channel: string, listener: (...args: unknown[]) => unknown) {
        handlers.set(channel, listener);
      },
      removeHandler(channel: string) {
        handlers.delete(channel);
      },
    } as unknown as IpcMainRegistrar;
    const dependencies = {
      getStore: () => ({
        getSession: vi.fn(() => null),
      }),
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
      resumeSession: vi.fn(),
    } as unknown as CoreIpcDependencies;

    registerCoreIpc(ipc, dependencies);

    expect(() =>
      handlers.get(CORE_IPC.resumeSession.channel)?.(
        {} as IpcMainInvokeEvent,
        "claude-cli:local:missing",
      )).toThrow(
      "This session is no longer available. Refresh the session list and try again.",
    );
    expect(dependencies.resumeSession).not.toHaveBeenCalled();
  });
});
