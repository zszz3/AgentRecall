import { describe, expect, it, vi } from "vitest";
import { createInMemoryStore, type SessionStore } from "./session-store";
import { RemoteEnvironmentLifecycle, type RemoteEnvironmentWatchManager } from "./remote-environment-lifecycle";
import type { SessionEnvironment, SessionMessage } from "./types";

const messages: SessionMessage[] = [
  { role: "user", content: "remote session", timestamp: "2026-06-05T10:00:00Z", index: 0 },
];

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

function upsertRemoteSession(store: SessionStore, environment: SessionEnvironment): void {
  const host = environment.hostAlias ?? environment.host ?? "unknown";
  store.upsertIndexedSession(
    {
      sessionKey: `ssh:${environment.id}:codex:${host}`,
      rawId: host,
      source: "codex-cli",
      environmentId: environment.id,
      projectPath: `/work/${host}`,
      filePath: `/remote/${host}.jsonl`,
      originalTitle: host,
      firstQuestion: host,
      timestamp: 1,
      fileMtimeMs: 1,
      fileSize: 1,
      prUrl: null,
      prNumber: null,
    },
    messages,
  );
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("RemoteEnvironmentLifecycle", () => {
  it("runs credential hooks when an environment is saved and deleted", () => {
    const store = createInMemoryStore();
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

    const environment = lifecycle.saveEnvironment(input);
    lifecycle.deleteEnvironment(environment.id);

    expect(onEnvironmentSaved).toHaveBeenCalledWith(environment, input);
    expect(onEnvironmentDeleted).toHaveBeenCalledWith(environment.id);
  });

  it("rolls back a new environment when its credential cannot be saved", () => {
    const store = createInMemoryStore();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager: createWatchManager(),
      syncEnvironment: async () => undefined,
      onEnvironmentSaved: () => {
        throw new Error("Secure storage failed");
      },
    });

    expect(() =>
      lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", enabled: false }),
    ).toThrow("Secure storage failed");
    expect(store.getEnvironment("ssh-devbox")).toBeNull();
  });

  it("stops an existing watcher before syncing an updated ssh environment", async () => {
    const store = createInMemoryStore();
    const watchManager = createWatchManager();
    const syncEnvironment = vi.fn(async (_environment: SessionEnvironment) => undefined);
    const lifecycle = new RemoteEnvironmentLifecycle({ store, syncEnvironment, watchManager });

    lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "old", enabled: true });
    await lifecycle.waitForIdle("ssh-devbox");
    lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "new", enabled: true });
    await lifecycle.waitForIdle("ssh-devbox");

    expect(watchManager.stop).toHaveBeenCalledWith("ssh-devbox");
    expect(syncEnvironment.mock.calls.map(([environment]) => environment.hostAlias)).toEqual(["old", "new"]);
    expect(watchManager.start.mock.calls.map(([environment]) => environment.hostAlias)).toEqual(["old", "new"]);
  });

  it("removes rows written by an in-flight sync after the environment is deleted", async () => {
    const store = createInMemoryStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async (environment) => {
        await syncGate.promise;
        upsertRemoteSession(store, environment);
      },
    });

    lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "old", enabled: true });
    await flushPromises();
    lifecycle.deleteEnvironment("ssh-devbox");
    syncGate.resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect(store.getEnvironment("ssh-devbox")).toBeNull();
    expect(store.searchSessions({ environmentId: "ssh-devbox" })).toEqual([]);
    expect(store.searchSessions({ query: "old", environmentId: "all" })).toEqual([]);
  });

  it("schedules a latest-config follow-up when an environment is updated during an active sync", async () => {
    const store = createInMemoryStore();
    const watchManager = createWatchManager();
    const gates = [createDeferred(), createDeferred()];
    const syncEnvironment = vi.fn(async (environment: SessionEnvironment) => {
      const gate = gates[syncEnvironment.mock.calls.length - 1];
      await gate.promise;
      upsertRemoteSession(store, environment);
    });
    const lifecycle = new RemoteEnvironmentLifecycle({ store, syncEnvironment, watchManager });

    lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "old", enabled: true });
    await flushPromises();
    lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "new", enabled: true });
    await flushPromises();

    expect(syncEnvironment.mock.calls.map(([environment]) => environment.hostAlias)).toEqual(["old"]);

    gates[0].resolve();
    await flushPromises();

    expect(syncEnvironment.mock.calls.map(([environment]) => environment.hostAlias)).toEqual(["old", "new"]);

    gates[1].resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect(store.searchSessions({ environmentId: "ssh-devbox" }).map((session) => session.rawId)).toEqual(["new"]);
    expect(watchManager.start.mock.calls.at(-1)?.[0].hostAlias).toBe("new");
  });

  it("records current sync failures without starting a watcher", async () => {
    const store = createInMemoryStore();
    const watchManager = createWatchManager();
    const syncError = new Error("Permission denied");
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async () => {
        throw syncError;
      },
    });

    lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "bad-host", enabled: true });
    await lifecycle.waitForIdle("ssh-devbox");

    expect(watchManager.start).not.toHaveBeenCalled();
    expect(store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: "Permission denied",
    });
  });

  it("drops queued same-config syncs after the active sync fails", async () => {
    const store = createInMemoryStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const syncError = new Error("Permission denied");
    const syncEnvironment = vi.fn(async () => {
      await syncGate.promise;
    });
    const lifecycle = new RemoteEnvironmentLifecycle({ store, syncEnvironment, watchManager });

    const environment = lifecycle.saveEnvironment({
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
    expect(store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: "Permission denied",
    });
  });

  it("rejects manual refresh when it waits on an already-running failed sync", async () => {
    const store = createInMemoryStore();
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

    lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "bad-host", enabled: true });
    await flushPromises();
    const refresh = lifecycle.refreshEnvironment("ssh-devbox");
    await flushPromises();

    syncGate.reject(syncError);

    await expect(refresh).rejects.toThrow("Permission denied");
    expect(store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: "Permission denied",
    });
  });

  it("handles falsy sync rejection reasons as failures", async () => {
    const store = createInMemoryStore();
    const watchManager = createWatchManager();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async () => {
        throw 0;
      },
    });

    lifecycle.saveEnvironment({ id: "ssh-devbox", kind: "ssh", label: "devbox", hostAlias: "bad-host", enabled: true });
    await lifecycle.waitForIdle("ssh-devbox");

    expect(watchManager.start).not.toHaveBeenCalled();
    expect(store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: "0",
    });
    await expect(lifecycle.refreshEnvironment("ssh-devbox")).rejects.toBe(0);
  });

  it("preserves indexed sessions when an environment is disabled during an active sync", async () => {
    const store = createInMemoryStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async () => {
        await syncGate.promise;
      },
    });

    const environment = lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      enabled: true,
    });
    upsertRemoteSession(store, environment);
    await flushPromises();

    lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      enabled: false,
    });
    syncGate.resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect(store.searchSessions({ environmentId: "ssh-devbox" }).map((session) => session.rawId)).toEqual(["devbox"]);
    expect(watchManager.stop).toHaveBeenCalledWith("ssh-devbox");
    expect(watchManager.start).not.toHaveBeenCalled();
  });

  it("sets disabled environments to idle when an active sync completes", async () => {
    const store = createInMemoryStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const lifecycle = new RemoteEnvironmentLifecycle({
      store,
      watchManager,
      syncEnvironment: async (environment) => {
        store.updateEnvironmentSyncState(environment.id, "syncing", { lastError: null });
        await syncGate.promise;
        store.updateEnvironmentSyncState(environment.id, "watching", { lastError: null });
      },
    });

    const environment = lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      enabled: true,
    });
    upsertRemoteSession(store, environment);
    await flushPromises();

    lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "devbox",
      hostAlias: "devbox",
      enabled: false,
    });
    syncGate.resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect(store.searchSessions({ environmentId: "ssh-devbox" }).map((session) => session.rawId)).toEqual(["devbox"]);
    expect(store.getEnvironment("ssh-devbox")).toMatchObject({ enabled: false, syncState: "idle" });
    expect(watchManager.start).not.toHaveBeenCalled();
  });

  it("preserves sessions and starts the watcher with current metadata after a label-only update during active sync", async () => {
    const store = createInMemoryStore();
    const watchManager = createWatchManager();
    const syncGate = createDeferred();
    const syncEnvironment = vi.fn(async () => {
      await syncGate.promise;
    });
    const lifecycle = new RemoteEnvironmentLifecycle({ store, syncEnvironment, watchManager });

    const environment = lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "Old label",
      hostAlias: "devbox",
      enabled: true,
    });
    upsertRemoteSession(store, environment);
    await flushPromises();

    lifecycle.saveEnvironment({
      id: "ssh-devbox",
      kind: "ssh",
      label: "New label",
      hostAlias: "devbox",
      enabled: true,
    });
    syncGate.resolve();
    await lifecycle.waitForIdle("ssh-devbox");

    expect(syncEnvironment).toHaveBeenCalledTimes(1);
    expect(store.searchSessions({ environmentId: "ssh-devbox" }).map((session) => session.rawId)).toEqual(["devbox"]);
    expect(watchManager.start.mock.calls.at(-1)?.[0]).toMatchObject({ id: "ssh-devbox", label: "New label" });
  });
});
