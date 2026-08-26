import { describe, expect, it, vi } from "vitest";
import {
  RemoteEnvironmentLifecycle,
  type RemoteEnvironmentStore,
  type RemoteEnvironmentWatchManager,
} from "./remote-environment-lifecycle";
import type {
  EnvironmentSyncState,
  EnvironmentUpsertInput,
  SessionEnvironment,
} from "./types";

interface LifecycleSession {
  sessionKey: string;
  rawId: string;
  environmentId: string;
}

class LifecycleTestStore implements RemoteEnvironmentStore {
  private readonly environments = new Map<string, SessionEnvironment>();
  private readonly sessions = new Map<string, LifecycleSession>();
  private timestamp = 1;

  async listEnvironments(): Promise<SessionEnvironment[]> {
    return [...this.environments.values()]
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label))
      .map((environment) => ({ ...environment }));
  }

  async getEnvironment(id: string): Promise<SessionEnvironment | null> {
    const environment = this.environments.get(id);
    return environment ? { ...environment } : null;
  }

  async upsertEnvironment(input: EnvironmentUpsertInput): Promise<SessionEnvironment> {
    const id = input.id ?? input.label.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-");
    const existing = this.environments.get(id);
    const environment: SessionEnvironment = {
      id,
      kind: input.kind,
      label: input.label,
      hostAlias: input.hostAlias ?? null,
      host: input.host ?? null,
      user: input.user ?? null,
      port: input.port ?? null,
      authMode: input.authMode ?? "none",
      identityFile: input.identityFile ?? null,
      enabled: input.enabled ?? true,
      syncState: existing?.syncState ?? "idle",
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      lastError: existing?.lastError ?? null,
      createdAt: existing?.createdAt ?? this.timestamp++,
      updatedAt: this.timestamp++,
    };
    this.environments.set(id, environment);
    return { ...environment };
  }

  async updateEnvironmentSyncState(
    id: string,
    state: EnvironmentSyncState,
    options: { lastSyncedAt?: number | null; lastError?: string | null } = {},
  ): Promise<void> {
    const environment = this.environments.get(id);
    if (!environment) return;
    this.environments.set(id, {
      ...environment,
      syncState: state,
      lastSyncedAt: Object.hasOwn(options, "lastSyncedAt")
        ? options.lastSyncedAt ?? null
        : environment.lastSyncedAt,
      lastError: Object.hasOwn(options, "lastError")
        ? options.lastError ?? null
        : environment.lastError,
      updatedAt: this.timestamp++,
    });
  }

  async deleteEnvironmentSessions(environmentId: string): Promise<void> {
    for (const [sessionKey, session] of this.sessions) {
      if (session.environmentId === environmentId) this.sessions.delete(sessionKey);
    }
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    this.environments.delete(environmentId);
    await this.deleteEnvironmentSessions(environmentId);
  }

  upsertRemoteSession(environment: SessionEnvironment): void {
    const host = environment.hostAlias ?? environment.host ?? "unknown";
    const sessionKey = `ssh:${environment.id}:codex:${host}`;
    this.sessions.set(sessionKey, {
      sessionKey,
      rawId: host,
      environmentId: environment.id,
    });
  }

  searchSessions(options: { environmentId?: string; query?: string }): LifecycleSession[] {
    const query = options.query?.toLocaleLowerCase();
    return [...this.sessions.values()].filter((session) => (
      (!options.environmentId || options.environmentId === "all" || session.environmentId === options.environmentId)
      && (!query || session.rawId.toLocaleLowerCase().includes(query))
    ));
  }
}

function createStore(): LifecycleTestStore {
  return new LifecycleTestStore();
}

function createDeferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createWatchManager(): RemoteEnvironmentWatchManager & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  stopAll: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
  };
}

async function upsertRemoteSession(store: LifecycleTestStore, environment: SessionEnvironment): Promise<void> {
  store.upsertRemoteSession(environment);
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("RemoteEnvironmentLifecycle", () => {
  it("skips password SSH during passive startup sync unless explicitly requested", async () => {
    const store = createStore();
    const syncEnvironment = vi.fn(async () => undefined);
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      syncEnvironment,
      watchManager: createWatchManager(),
    });
    await store.upsertEnvironment({
      id: "ssh-password",
      kind: "ssh",
      label: "password host",
      hostAlias: "password-host",
      authMode: "password",
      enabled: true,
    });

    await lifecycle.startEnabledEnvironments();
    await flushPromises();
    expect(syncEnvironment).not.toHaveBeenCalled();

    await lifecycle.startEnabledEnvironments({ includePasswordAuthenticated: true });
    await lifecycle.waitForIdle("ssh-password");
    expect(syncEnvironment).toHaveBeenCalledOnce();
  });

  it("runs credential hooks when an environment is saved and deleted", async () => {
    const store = createStore();
    const onEnvironmentSaved = vi.fn();
    const onEnvironmentDeleted = vi.fn();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager: createWatchManager(),
      syncEnvironment: async () => undefined,
      onEnvironmentSaved,
      onEnvironmentDeleted,
    });
    const input = { id: "ssh-devbox", kind: "ssh" as const, label: "devbox", enabled: false };

    const environment = await lifecycle.saveEnvironment(input);
    await lifecycle.deleteEnvironment(environment.id);

    expect(onEnvironmentSaved).toHaveBeenCalledWith(environment, input);
    expect(onEnvironmentDeleted).toHaveBeenCalledWith(environment.id);
  });

  it("rolls back a new environment when its credential cannot be saved", async () => {
    const store = createStore();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager: createWatchManager(),
      syncEnvironment: async () => undefined,
      onEnvironmentSaved: () => {
        throw new Error("Secure storage failed");
      },
    });

    await expect(
      lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", enabled: false }),
    ).rejects.toThrow("Secure storage failed");
    await expect(store.getEnvironment("ssh-devbox")).resolves.toBeNull();
  });

  it("stops an existing watcher before syncing an updated ssh environment", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const syncEnvironment = vi.fn(async (_environment: SessionEnvironment) => undefined);
    const lifecycle = new RemoteEnvironmentLifecycle({ store, syncEnvironment, watchManager });

    await lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "old", enabled: true });
    await lifecycle.waitForIdle("ssh-devbox");
    await lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "new", enabled: true });
    await lifecycle.waitForIdle("ssh-devbox");

    expect(watchManager.stop).toHaveBeenCalledWith("ssh-devbox");
    expect(syncEnvironment.mock.calls.map(([environment]) => environment.hostAlias)).toEqual(["old", "new"]);
    expect(watchManager.start.mock.calls.map(([environment]) => environment.hostAlias)).toEqual(["old", "new"]);
  });

  it("removes rows written by an in-flight sync after the environment is deleted", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async (environment) => {
        await syncGate.promise;
        await upsertRemoteSession(store, environment);
      },
    });

    await lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "old", enabled: true });
    await flushPromises();
    await lifecycle.deleteEnvironment("ssh-devbox");
    syncGate.resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect(await store.getEnvironment("ssh-devbox")).toBeNull();
    expect(await store.searchSessions({ environmentId: "ssh-devbox" })).toEqual([]);
    expect(await store.searchSessions({ query: "old", environmentId: "all" })).toEqual([]);
  });

  it("schedules a latest-config follow-up when an environment is updated during an active sync", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const gates = [createDeferred(), createDeferred()];
    const syncEnvironment = vi.fn(async (environment: SessionEnvironment) => {
      const gate = gates[syncEnvironment.mock.calls.length - 1];
      await gate.promise;
      await upsertRemoteSession(store, environment);
    });
    const lifecycle = new RemoteEnvironmentLifecycle({ store, syncEnvironment, watchManager });

    await lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "old", enabled: true });
    await flushPromises();
    await lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "new", enabled: true });
    await flushPromises();

    expect(syncEnvironment.mock.calls.map(([environment]) => environment.hostAlias)).toEqual(["old"]);

    gates[0].resolve();
    await vi.waitFor(() => {
      expect(syncEnvironment.mock.calls.map(([environment]) => environment.hostAlias)).toEqual(["old", "new"]);
    });

    gates[1].resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect((await store.searchSessions({ environmentId: "ssh-devbox" })).map((session) => session.rawId)).toEqual(["new"]);
    expect(watchManager.start.mock.calls.at(-1)?.[0].hostAlias).toBe("new");
  });

  it("records current sync failures without starting a watcher", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const syncError = new Error("Permission denied");
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async () => {
        throw syncError;
      },
    });

    await lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "bad-host", enabled: true });
    await lifecycle.waitForIdle("ssh-devbox");

    expect(watchManager.start).not.toHaveBeenCalled();
    expect(await store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: "Permission denied",
    });
  });

  it("handles a fast sync rejection while an environment snapshot is still loading", async () => {
    const store = createStore();
    await store.upsertEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "bad-host",
      enabled: true,
    });
    const originalListEnvironments = store.listEnvironments.bind(store);
    const snapshotStarted = createDeferred();
    const snapshotGate = createDeferred();
    let listCalls = 0;
    vi.spyOn(store, "listEnvironments").mockImplementation(async () => {
      listCalls += 1;
      if (listCalls === 2) {
        snapshotStarted.resolve();
        await snapshotGate.promise;
      }
      return originalListEnvironments();
    });
    const syncGate = createDeferred();
    const syncError = new Error("Network is unreachable");
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager: createWatchManager(),
      syncEnvironment: () => syncGate.promise,
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    await lifecycle.startEnabledEnvironments();
    await snapshotStarted.promise;
    syncGate.reject(syncError);

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
      snapshotGate.resolve();
      await lifecycle.waitForIdle("ssh-devbox");
      expect(await store.getEnvironment("ssh-devbox")).toMatchObject({
        syncState: "error",
        lastError: "Network is unreachable",
      });
    } finally {
      snapshotGate.resolve();
      await lifecycle.waitForIdle("ssh-devbox");
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("drops queued same-config syncs after the active sync fails", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const syncError = new Error("Permission denied");
    const syncEnvironment = vi.fn(async () => {
      await syncGate.promise;
    });
    const lifecycle = new RemoteEnvironmentLifecycle({ store, syncEnvironment, watchManager });

    const environment = await lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "bad-host",
      enabled: true,
    });
    await flushPromises();
    void lifecycle.syncFromWatcher(environment);
    await flushPromises();

    syncGate.reject(syncError);
    await lifecycle.waitForIdle("ssh-devbox");

    expect(syncEnvironment).toHaveBeenCalledTimes(1);
    expect(watchManager.start).not.toHaveBeenCalled();
    expect(await store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: "Permission denied",
    });
  });

  it("rejects manual refresh when it waits on an already-running failed sync", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const syncError = new Error("Permission denied");
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async () => {
        await syncGate.promise;
      },
    });

    await lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "bad-host", enabled: true });
    await flushPromises();
    const refresh = lifecycle.refreshEnvironment("ssh-devbox");
    await flushPromises();

    syncGate.reject(syncError);

    await expect(refresh).rejects.toThrow("Permission denied");
    expect(await store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: "Permission denied",
    });
  });

  it("handles falsy sync rejection reasons as failures", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async () => {
        throw 0;
      },
    });

    await lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "bad-host", enabled: true });
    await lifecycle.waitForIdle("ssh-devbox");

    expect(watchManager.start).not.toHaveBeenCalled();
    expect(await store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: "0",
    });
    await expect(lifecycle.refreshEnvironment("ssh-devbox")).rejects.toBe(0);
  });

  it("preserves indexed sessions when an environment is disabled during an active sync", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async () => {
        await syncGate.promise;
      },
    });

    const environment = await lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      enabled: true,
    });
    await upsertRemoteSession(store, environment);
    await flushPromises();

    await lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      enabled: false,
    });
    syncGate.resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect((await store.searchSessions({ environmentId: "ssh-devbox" })).map((session) => session.rawId)).toEqual(["devbox"]);
    expect(watchManager.stop).toHaveBeenCalledWith("ssh-devbox");
    expect(watchManager.start).not.toHaveBeenCalled();
  });

  it("sets disabled environments to idle when an active sync completes", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async (environment) => {
        await store.updateEnvironmentSyncState(environment.id, "syncing", { lastError: null });
        await syncGate.promise;
        await store.updateEnvironmentSyncState(environment.id, "watching", { lastError: null });
      },
    });

    const environment = await lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      enabled: true,
    });
    await upsertRemoteSession(store, environment);
    await flushPromises();

    await lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      enabled: false,
    });
    syncGate.resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect((await store.searchSessions({ environmentId: "ssh-devbox" })).map((session) => session.rawId)).toEqual(["devbox"]);
    expect(await store.getEnvironment("ssh-devbox")).toMatchObject({ enabled: false, syncState: "idle" });
    expect(watchManager.start).not.toHaveBeenCalled();
  });

  it("preserves sessions and starts the watcher with current metadata after a label-only update during active sync", async () => {
    const store = createStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const syncEnvironment = vi.fn(async () => {
      await syncGate.promise;
    });
    const lifecycle = new RemoteEnvironmentLifecycle({ store, syncEnvironment, watchManager });

    const environment = await lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "Old label",
      hostAlias: "devbox",
      enabled: true,
    });
    await upsertRemoteSession(store, environment);
    await flushPromises();

    await lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "New label",
      hostAlias: "devbox",
      enabled: true,
    });
    syncGate.resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect(syncEnvironment).toHaveBeenCalledTimes(1);
    expect((await store.searchSessions({ environmentId: "ssh-devbox" })).map((session) => session.rawId)).toEqual(["devbox"]);
    expect(watchManager.start.mock.calls.at(-1)?.[0]).toMatchObject({ id: "ssh-devbox", label: "New label" });
  });
});
