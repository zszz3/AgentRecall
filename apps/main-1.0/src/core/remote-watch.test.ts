import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as remoteWatch from "./remote-watch";
import type { SessionEnvironment } from "./types";

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  ...childProcessMocks,
}));

const { RemoteWatchManager } = remoteWatch;

const environment: SessionEnvironment = {
  id: "ssh-devbox",
  kind: "ssh",
  label: "devbox",
  hostAlias: "devbox",
  host: "devbox.example.com",
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
};

const secondEnvironment: SessionEnvironment = {
  ...environment,
  id: "ssh-staging",
  label: "staging",
  hostAlias: "staging",
  host: "staging.example.com",
};

async function withFakeTimers(run: () => Promise<void> | void): Promise<void> {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function createSpawnedChild() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stderr: EventEmitter;
    stdout: EventEmitter;
  };
  child.kill = vi.fn();
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}

describe("RemoteWatchManager", () => {
  it("builds a watcher command that filters all candidate session paths by existence", () => {
    const maybeBuild = remoteWatch["buildRemoteWatchCommand" as keyof typeof remoteWatch];
    expect(maybeBuild).toBeTypeOf("function");
    if (typeof maybeBuild !== "function") return;

    const command = (maybeBuild as () => string)();

    expect(command).toContain("$HOME/.tclaude/projects");
    expect(command).toContain("$HOME/.tcodex/sessions");
    expect(command).toContain("$HOME/.tcodex/session_index.jsonl");
    expect(command).toContain("$HOME/.codebuddy/projects");
    expect(command).toContain('[ -e "$path" ]');
    expect(command).toContain('inotifywait -m -r -e create,modify,move,delete "$@"');
    expect(command).toContain('fswatch -0 "$@"');
    expect(command).toContain("exit 86");
  });

  it("passes only existing candidate paths to inotifywait", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "remote-watch-home-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "remote-watch-bin-"));
    const argsFile = path.join(bin, "watch-args");
    try {
      fs.symlinkSync("/bin/sh", path.join(bin, "sh"));
      fs.writeFileSync(path.join(bin, "inotifywait"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$WATCH_ARGS"\n');
      fs.chmodSync(path.join(bin, "inotifywait"), 0o755);
      fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
      fs.mkdirSync(path.join(home, ".tclaude", "projects"), { recursive: true });

      const result = spawnSync("/bin/sh", ["-c", remoteWatch.buildRemoteWatchCommand()], {
        env: { HOME: home, PATH: bin, WATCH_ARGS: argsFile },
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(fs.readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
        "-m",
        "-r",
        "-e",
        "create,modify,move,delete",
        path.join(home, ".codex", "sessions"),
        path.join(home, ".tclaude", "projects"),
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("exits 86 when no watcher tool or no candidate path is available", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "remote-watch-home-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "remote-watch-bin-"));
    try {
      fs.symlinkSync("/bin/sh", path.join(bin, "sh"));
      fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
      const noTool = spawnSync("/bin/sh", ["-c", remoteWatch.buildRemoteWatchCommand()], {
        env: { HOME: home, PATH: bin },
      });
      expect(noTool.status).toBe(86);

      fs.writeFileSync(path.join(bin, "inotifywait"), "#!/bin/sh\nexit 0\n");
      fs.chmodSync(path.join(bin, "inotifywait"), 0o755);
      fs.rmSync(path.join(home, ".codex"), { recursive: true, force: true });
      const noPath = spawnSync("/bin/sh", ["-c", remoteWatch.buildRemoteWatchCommand()], {
        env: { HOME: home, PATH: bin },
      });
      expect(noPath.status).toBe(86);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("debounces watcher events into a sync call", async () => {
    await withFakeTimers(async () => {
      const sync = vi.fn(async (_environment: SessionEnvironment) => undefined);
      const manager = new RemoteWatchManager({
        startWatcher: (_env, onEvent) => {
          onEvent();
          onEvent();
          return { stop: () => undefined };
        },
        syncEnvironment: sync,
        debounceMs: 100,
      });

      manager.start(environment);
      await vi.advanceTimersByTimeAsync(100);

      expect(sync).toHaveBeenCalledTimes(1);
      manager.stopAll();
    });
  });

  it("falls back to polling when watcher setup fails", async () => {
    await withFakeTimers(async () => {
      const sync = vi.fn(async (_environment: SessionEnvironment) => undefined);
      const manager = new RemoteWatchManager({
        startWatcher: () => {
          throw new Error("watch unavailable");
        },
        syncEnvironment: sync,
        pollIntervalMs: 100,
      });

      manager.start(environment);
      await vi.advanceTimersByTimeAsync(250);

      expect(sync).toHaveBeenCalledTimes(2);
      manager.stopAll();
    });
  });

  it("retries event watching after a polling recovery window", async () => {
    await withFakeTimers(async () => {
      const sync = vi.fn(async (_environment: SessionEnvironment) => undefined);
      const modes: string[] = [];
      const startWatcher = vi
        .fn()
        .mockImplementationOnce(() => { throw new Error("watch unavailable"); })
        .mockImplementation(() => ({ stop: vi.fn() }));
      const manager = new RemoteWatchManager({
        startWatcher,
        syncEnvironment: sync,
        pollIntervalMs: 100,
        pollRecoveryMs: 250,
        onModeChange: (_environment, mode) => modes.push(mode),
      });

      manager.start(environment);
      expect(modes).toEqual(["polling"]);
      await vi.advanceTimersByTimeAsync(250);

      expect(sync).toHaveBeenCalledTimes(2);
      expect(startWatcher).toHaveBeenCalledTimes(2);
      expect(modes).toEqual(["polling", "event"]);
      manager.stopAll();
    });
  });

  it("switches to polling when watcher reports unavailable", async () => {
    await withFakeTimers(async () => {
      const sync = vi.fn(async (_environment: SessionEnvironment) => undefined);
      const watcherStop = vi.fn();
      let onEvent: (() => void) | undefined;
      let onUnavailable: (() => void) | undefined;
      const manager = new RemoteWatchManager({
        startWatcher: (_env, event, unavailable?) => {
          onEvent = event;
          onUnavailable = unavailable;
          return { stop: watcherStop };
        },
        syncEnvironment: sync,
        debounceMs: 50,
        pollIntervalMs: 100,
      });

      manager.start(environment);
      expect(onEvent).toBeTypeOf("function");
      expect(onUnavailable).toBeTypeOf("function");
      onEvent?.();
      onUnavailable?.();
      onUnavailable?.();
      await vi.advanceTimersByTimeAsync(250);

      expect(watcherStop).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledTimes(2);
      manager.stopAll();
    });
  });

  it("ignores late watcher events after switching to polling", async () => {
    await withFakeTimers(async () => {
      const sync = vi.fn(async (_environment: SessionEnvironment) => undefined);
      let onEvent: (() => void) | undefined;
      let onUnavailable: (() => void) | undefined;
      const manager = new RemoteWatchManager({
        startWatcher: (_env, event, unavailable?) => {
          onEvent = event;
          onUnavailable = unavailable;
          return { stop: () => undefined };
        },
        syncEnvironment: sync,
        debounceMs: 50,
        pollIntervalMs: 100,
      });

      manager.start(environment);
      onUnavailable?.();
      onEvent?.();
      await vi.advanceTimersByTimeAsync(250);

      expect(sync).toHaveBeenCalledTimes(2);
      manager.stopAll();
    });
  });

  it("does not create duplicate watchers for duplicate starts", () => {
    const watcherStop = vi.fn();
    const startWatcher = vi.fn(() => ({ stop: watcherStop }));
    const manager = new RemoteWatchManager({
      startWatcher,
      syncEnvironment: async () => undefined,
    });

    manager.start(environment);
    manager.start(environment);

    expect(startWatcher).toHaveBeenCalledTimes(1);
    manager.stopAll();
    expect(watcherStop).toHaveBeenCalledTimes(1);
  });

  it("does not start watchers for disabled or local environments", () => {
    const startWatcher = vi.fn(() => ({ stop: () => undefined }));
    const manager = new RemoteWatchManager({
      startWatcher,
      syncEnvironment: async () => undefined,
    });

    manager.start({ ...environment, enabled: false });
    manager.start({ ...environment, id: "local", kind: "local" });

    expect(startWatcher).not.toHaveBeenCalled();
  });

  it("clears a pending debounced sync on stop", async () => {
    await withFakeTimers(async () => {
      const sync = vi.fn(async (_environment: SessionEnvironment) => undefined);
      let onEvent: (() => void) | undefined;
      const manager = new RemoteWatchManager({
        startWatcher: (_env, event) => {
          onEvent = event;
          return { stop: () => undefined };
        },
        syncEnvironment: sync,
        debounceMs: 100,
      });

      manager.start(environment);
      onEvent?.();
      manager.stop(environment.id);
      await vi.advanceTimersByTimeAsync(100);

      expect(sync).not.toHaveBeenCalled();
    });
  });

  it("clears a polling interval on stop", async () => {
    await withFakeTimers(async () => {
      const sync = vi.fn(async (_environment: SessionEnvironment) => undefined);
      const manager = new RemoteWatchManager({
        startWatcher: () => {
          throw new Error("watch unavailable");
        },
        syncEnvironment: sync,
        pollIntervalMs: 100,
      });

      manager.start(environment);
      await vi.advanceTimersByTimeAsync(250);
      expect(sync).toHaveBeenCalledTimes(2);

      manager.stop(environment.id);
      await vi.advanceTimersByTimeAsync(300);

      expect(sync).toHaveBeenCalledTimes(2);
    });
  });

  it("stops multiple handles with stopAll", () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    const startWatcher = vi.fn((env: SessionEnvironment) => ({
      stop: env.id === environment.id ? firstStop : secondStop,
    }));
    const manager = new RemoteWatchManager({
      startWatcher,
      syncEnvironment: async () => undefined,
    });

    manager.start(environment);
    manager.start(secondEnvironment);
    manager.stopAll();

    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).toHaveBeenCalledTimes(1);
  });

  it("reports rejected debounced syncs without leaking unhandled rejections", async () => {
    await withFakeTimers(async () => {
      const syncError = new Error("sync failed");
      const onSyncError = vi.fn();
      let onEvent: (() => void) | undefined;
      const manager = new RemoteWatchManager({
        startWatcher: (_env, event) => {
          onEvent = event;
          return { stop: () => undefined };
        },
        syncEnvironment: async () => {
          throw syncError;
        },
        onSyncError,
        debounceMs: 100,
      });

      manager.start(environment);
      onEvent?.();
      await vi.advanceTimersByTimeAsync(100);

      expect(onSyncError).toHaveBeenCalledWith(environment, syncError);
      manager.stopAll();
    });
  });

  it("reports rejected polling syncs without leaking unhandled rejections", async () => {
    await withFakeTimers(async () => {
      const syncError = new Error("poll failed");
      const onSyncError = vi.fn();
      const manager = new RemoteWatchManager({
        startWatcher: () => {
          throw new Error("watch unavailable");
        },
        syncEnvironment: async () => {
          throw syncError;
        },
        onSyncError,
        pollIntervalMs: 100,
      });

      manager.start(environment);
      await vi.advanceTimersByTimeAsync(250);

      expect(onSyncError).toHaveBeenCalledTimes(2);
      expect(onSyncError).toHaveBeenCalledWith(environment, syncError);
      manager.stopAll();
    });
  });

  it("coalesces polling syncs while a previous sync is in flight", async () => {
    await withFakeTimers(async () => {
      let resolveSync: (() => void) | undefined;
      const sync = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSync = resolve;
          }),
      );
      const manager = new RemoteWatchManager({
        startWatcher: () => {
          throw new Error("watch unavailable");
        },
        syncEnvironment: sync,
        pollIntervalMs: 100,
      });

      manager.start(environment);
      await vi.advanceTimersByTimeAsync(250);

      expect(sync).toHaveBeenCalledTimes(1);
      resolveSync?.();
      await flushPromises();

      expect(sync).toHaveBeenCalledTimes(2);
      manager.stopAll();
      resolveSync?.();
    });
  });

  it("queues one follow-up sync for debounced watcher events that fire while in flight", async () => {
    await withFakeTimers(async () => {
      let onEvent: (() => void) | undefined;
      let resolveSync: (() => void) | undefined;
      const sync = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSync = resolve;
          }),
      );
      const manager = new RemoteWatchManager({
        startWatcher: (_env, event) => {
          onEvent = event;
          return { stop: () => undefined };
        },
        syncEnvironment: sync,
        debounceMs: 100,
      });

      manager.start(environment);
      onEvent?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(sync).toHaveBeenCalledTimes(1);

      onEvent?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(sync).toHaveBeenCalledTimes(1);

      resolveSync?.();
      await flushPromises();

      expect(sync).toHaveBeenCalledTimes(2);
      manager.stopAll();
      resolveSync?.();
    });
  });

  it("starts a new sync after stop and restart while an old sync is still in flight", async () => {
    await withFakeTimers(async () => {
      const events: Array<() => void> = [];
      const resolvers: Array<() => void> = [];
      const sync = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          }),
      );
      const manager = new RemoteWatchManager({
        startWatcher: (_env, event) => {
          events.push(event);
          return { stop: () => undefined };
        },
        syncEnvironment: sync,
        debounceMs: 100,
      });

      manager.start(environment);
      events[0]?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(sync).toHaveBeenCalledTimes(1);

      manager.stop(environment.id);
      manager.start(environment);
      events[1]?.();
      await vi.advanceTimersByTimeAsync(100);

      expect(sync).toHaveBeenCalledTimes(2);
      manager.stopAll();
      for (const resolve of resolvers) resolve();
      await flushPromises();
    });
  });

  it("reports synchronous sync throws without escaping timer callbacks", async () => {
    await withFakeTimers(async () => {
      const syncError = new Error("sync threw");
      const onSyncError = vi.fn();
      let onEvent: (() => void) | undefined;
      const manager = new RemoteWatchManager({
        startWatcher: (_env, event) => {
          onEvent = event;
          return { stop: () => undefined };
        },
        syncEnvironment: () => {
          throw syncError;
        },
        onSyncError,
        debounceMs: 100,
      });

      manager.start(environment);
      onEvent?.();
      await vi.advanceTimersByTimeAsync(100);

      expect(onSyncError).toHaveBeenCalledWith(environment, syncError);
      manager.stopAll();
    });
  });

  it("swallows errors thrown by the sync error reporter", async () => {
    await withFakeTimers(async () => {
      const syncError = new Error("sync failed");
      const reporterError = new Error("reporter failed");
      const onSyncError = vi.fn(() => {
        throw reporterError;
      });
      let onEvent: (() => void) | undefined;
      const manager = new RemoteWatchManager({
        startWatcher: (_env, event) => {
          onEvent = event;
          return { stop: () => undefined };
        },
        syncEnvironment: async () => {
          throw syncError;
        },
        onSyncError,
        debounceMs: 100,
      });

      manager.start(environment);
      onEvent?.();
      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      expect(onSyncError).toHaveBeenCalledWith(environment, syncError);
      manager.stopAll();
    });
  });

  it("ignores late unavailable callbacks after stop", async () => {
    await withFakeTimers(async () => {
      const sync = vi.fn(async (_environment: SessionEnvironment) => undefined);
      const watcherStop = vi.fn();
      let onUnavailable: (() => void) | undefined;
      const manager = new RemoteWatchManager({
        startWatcher: (_env, _event, unavailable?) => {
          onUnavailable = unavailable;
          return { stop: watcherStop };
        },
        syncEnvironment: sync,
        pollIntervalMs: 100,
      });

      manager.start(environment);
      manager.stop(environment.id);
      onUnavailable?.();
      await vi.advanceTimersByTimeAsync(250);

      expect(watcherStop).toHaveBeenCalledTimes(1);
      expect(sync).not.toHaveBeenCalled();
    });
  });

  it("falls back to polling when the default watcher exits with a failure", async () => {
    await withFakeTimers(async () => {
      const child = createSpawnedChild();
      childProcessMocks.spawn.mockReturnValueOnce(child);
      const sync = vi.fn(async (_environment: SessionEnvironment) => undefined);
      const manager = new RemoteWatchManager({
        syncEnvironment: sync,
        pollIntervalMs: 100,
      });

      manager.start(environment);
      child.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(250);

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledTimes(2);
      manager.stopAll();
    });
  });

  it("builds watcher ssh args with noninteractive options before the destination separator", () => {
    const maybeBuild = remoteWatch["buildRemoteWatchSshArgs" as keyof typeof remoteWatch];
    expect(maybeBuild).toBeTypeOf("function");
    if (typeof maybeBuild !== "function") return;
    const buildRemoteWatchSshArgs = maybeBuild as (env: SessionEnvironment, command: string) => string[];

    const args = buildRemoteWatchSshArgs(environment, "echo ok");

    expect(args.slice(0, 4)).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
    expect(args.indexOf("-o")).toBeLessThan(args.indexOf("--"));
    expect(args.slice(args.indexOf("--"))).toEqual(["--", "devbox", "echo ok"]);
  });
});
