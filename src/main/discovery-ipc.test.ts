import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { SessionFamily } from "../core/session-family";
import { createDiscoveryApi } from "../preload/discovery";
import { IpcInputError } from "../shared/ipc/contract";
import { DISCOVERY_IPC } from "../shared/ipc/discovery";
import {
  registerDiscoveryIpc,
  type DiscoveryIpcService,
} from "./ipc/discovery";
import type { IpcMainRegistrar } from "./ipc/register-ipc-handler";

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const EMPTY_FAMILY: SessionFamily = {
  parent: null,
  children: [],
  truncated: false,
};

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

function createService(): DiscoveryIpcService {
  return {
    listSavedSearches: vi.fn(() => []),
    createSavedSearch: vi.fn(() => ({} as never)),
    deleteSavedSearch: vi.fn(() => true),
    touchSavedSearch: vi.fn(),
    listRecentSearches: vi.fn(() => []),
    searchHistory: vi.fn(() => []),
    clearSearchHistory: vi.fn(),
    recordSearch: vi.fn(),
    getSessionFamily: vi.fn(() => EMPTY_FAMILY),
  };
}

describe("Discovery IPC", () => {
  it("does not expose heuristic related-session discovery", () => {
    expect("getRelatedSessions" in DISCOVERY_IPC).toBe(false);
    expect("getRelatedSessions" in createDiscoveryApi({ invoke: vi.fn() })).toBe(false);
  });

  it("delegates a parsed session family request", async () => {
    const { ipc, handlers } = createMainRegistrar();
    const service = createService();
    registerDiscoveryIpc(ipc, service);

    expect(DISCOVERY_IPC.getSessionFamily.channel).toBe("discovery:session-family");
    await handlers.get(DISCOVERY_IPC.getSessionFamily.channel)?.(
      {} as IpcMainInvokeEvent,
      " codex:root ",
    );
    expect(service.getSessionFamily).toHaveBeenCalledWith("codex:root");
  });

  it("rejects an empty session key before calling the service", () => {
    const { ipc, handlers } = createMainRegistrar();
    const service = createService();
    registerDiscoveryIpc(ipc, service);

    expect(() => handlers.get(DISCOVERY_IPC.getSessionFamily.channel)?.(
      {} as IpcMainInvokeEvent,
      "   ",
    )).toThrow(IpcInputError);
    expect(service.getSessionFamily).not.toHaveBeenCalled();
  });

  it("exposes the family request through the preload API", async () => {
    const invoke = vi.fn(async () => EMPTY_FAMILY);
    const api = createDiscoveryApi({ invoke });

    await expect(api.getSessionFamily("codex:root")).resolves.toEqual(EMPTY_FAMILY);
    expect(invoke).toHaveBeenCalledWith(
      DISCOVERY_IPC.getSessionFamily.channel,
      "codex:root",
    );
  });
});
