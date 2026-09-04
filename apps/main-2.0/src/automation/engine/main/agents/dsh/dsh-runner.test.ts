import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../../../shared/types";

const cli = vi.hoisted(() => ({
  spawnCli: vi.fn(),
}));

vi.mock("../../platform/cli-launcher", () => ({
  spawnCli: cli.spawnCli,
}));

import { DshRunner, type DshRunOptions } from "./dsh-runner";

class FakeChildProcess extends EventEmitter {
  connected = false;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  readonly send = vi.fn((
    _message: unknown,
    callback?: (error: Error | null) => void,
  ) => {
    callback?.(null);
    return true;
  });

  constructor(readonly pid?: number, connected = false) {
    super();
    this.connected = connected;
  }
}

class FakeKillerProcess extends EventEmitter {
  readonly unref = vi.fn();
}

function createProcess(pid?: number, connected = false): FakeChildProcess {
  const proc = new FakeChildProcess(pid, connected);
  cli.spawnCli.mockReturnValue(proc as unknown as ChildProcess);
  return proc;
}

function createRunner(
  overrides: Partial<DshRunOptions> = {},
  dependencies?: ConstructorParameters<typeof DshRunner>[1],
): {
  runner: DshRunner;
  events: AgentEvent[];
  exits: Array<number | null>;
} {
  const events: AgentEvent[] = [];
  const exits: Array<number | null> = [];
  return {
    runner: new DshRunner({
      executable: "/opt/tools/dsh",
      cwd: "C:\\workspace\\project",
      env: { DSH_HOME: "C:\\dsh-home", CUSTOM_TOKEN: "secret" },
      prompt: "Review the current changes.",
      onEvent: (event) => events.push(event),
      onExit: (code) => exits.push(code),
      ...overrides,
    }, {
      platform: "linux",
      createSessionDiscovery: () => ({
        prepare: () => undefined,
        observe: () => undefined,
        finish: async () => undefined,
      }),
      ...dependencies,
    }),
    events,
    exits,
  };
}

describe("DshRunner", () => {
  beforeEach(() => {
    cli.spawnCli.mockReset();
  });

  test("spawns the strict headless command with the supplied cwd and environment", async () => {
    const proc = createProcess();
    const { runner, events, exits } = createRunner();
    const started = runner.start();

    expect(cli.spawnCli).toHaveBeenCalledWith({
      executable: "/opt/tools/dsh",
      args: ["--profile", "headless", "Review the current changes."],
      cwd: "C:\\workspace\\project",
      env: { DSH_HOME: "C:\\dsh-home", CUSTOM_TOKEN: "secret" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    });

    proc.stdout.write(Buffer.from("最终"));
    proc.stdout.write(Buffer.from("答案\n"));
    proc.emit("close", 0, null);
    await started;

    expect(events).toEqual([{ type: "completed", content: "最终答案" }]);
    expect(exits).toEqual([0]);
  });

  test("reports the Session discovered during the owned headless run", async () => {
    const proc = createProcess();
    const createSessionDiscovery = vi.fn((_sessionsRoot: string, onSessionId: (sessionId: string) => void) => ({
      prepare: () => undefined,
      observe: () => onSessionId("session-dsh-created"),
      finish: async () => undefined,
    }));
    const { runner, events } = createRunner({}, { createSessionDiscovery });
    const started = runner.start();

    proc.stdout.write("Done");
    proc.emit("close", 0, null);
    await started;

    expect(createSessionDiscovery).toHaveBeenCalledOnce();
    expect(events[0]).toMatchObject({
      type: "runtime_conversation",
      runtimeConversation: {
        runtimeId: "dsh",
        payload: { native: { sessionId: "session-dsh-created" } },
      },
    });
    expect(events[1]).toEqual({ type: "completed", content: "Done" });
  });

  test("reports a successful process that produced no assistant text", async () => {
    const proc = createProcess();
    const { runner, events, exits } = createRunner();
    const started = runner.start();

    proc.stdout.write(" \n\t");
    proc.emit("close", 0, null);
    await started;

    expect(events).toEqual([{
      type: "error",
      error: "DSH completed without assistant text.",
    }]);
    expect(exits).toEqual([0]);
  });

  test("reports a non-zero exit and retains only the bounded tail of stderr", async () => {
    const proc = createProcess();
    const onStderr = vi.fn();
    const { runner, events, exits } = createRunner({ onStderr });
    const started = runner.start();
    const stderr = `DROPPED-BEGIN:${"x".repeat(8_100)}:LATEST-DETAIL`;

    proc.stderr.write(stderr);
    proc.emit("close", 7, null);
    await started;

    expect(onStderr).toHaveBeenCalledWith(stderr);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    if (events[0]?.type !== "error") throw new Error("Expected a DSH error event.");
    expect(events[0].error).toContain("DSH exited with 7:");
    expect(events[0].error).toContain(":LATEST-DETAIL");
    expect(events[0].error).not.toContain("DROPPED-BEGIN");
    expect(events[0].error.length).toBeLessThanOrEqual(8_000 + "DSH exited with 7: ".length);
    expect(exits).toEqual([7]);
  });

  test("reports spawn/process errors and invokes onExit exactly once", async () => {
    const proc = createProcess();
    const { runner, events, exits } = createRunner();
    const started = runner.start();

    proc.emit("error", new Error("spawn ENOENT"));
    proc.emit("close", null, null);
    await expect(started).resolves.toBeUndefined();

    expect(events).toEqual([{ type: "error", error: "DSH process error: spawn ENOENT" }]);
    expect(exits).toEqual([null]);
  });

  test("interrupts with SIGINT without emitting a completion or error", async () => {
    const proc = createProcess();
    const { runner, events, exits } = createRunner();
    const started = runner.start();

    let firstSettled = false;
    const firstStop = runner.stop().finally(() => {
      firstSettled = true;
    });
    const secondStop = runner.stop();
    await Promise.resolve();

    expect(firstSettled).toBe(false);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGINT");

    proc.emit("close", null, "SIGINT");
    proc.emit("error", new Error("late process error"));
    await Promise.all([started, firstStop, secondStop]);

    expect(events).toEqual([]);
    expect(exits).toEqual([null]);
  });

  test("normalizes a synchronous spawn failure", async () => {
    cli.spawnCli.mockImplementation(() => {
      throw new Error("permission denied");
    });
    const { runner, events, exits } = createRunner();

    await expect(runner.start()).resolves.toBeUndefined();
    expect(events).toEqual([{
      type: "error",
      error: "DSH process error: permission denied",
    }]);
    expect(exits).toEqual([null]);
  });

  test("rejects a prompt that cannot fit in one POSIX argv entry", async () => {
    const { runner, events, exits } = createRunner({
      prompt: "界".repeat(50_000),
    }, {
      platform: "linux",
      spawnProcess: vi.fn() as never,
      killProcess: vi.fn() as never,
    });

    await expect(runner.start()).resolves.toBeUndefined();
    expect(cli.spawnCli).not.toHaveBeenCalled();
    expect(events).toEqual([{
      type: "error",
      error: expect.stringContaining("prompt is too large"),
    }]);
    expect(exits).toEqual([null]);
  });

  test("passes Windows prompts through stdin without changing or exposing them in argv", async () => {
    const proc = createProcess(undefined, true);
    const prompt = "Follow policy.\r\n\r\nUser request:\nshow %PATH% & \"continue\" 😀";
    const stdinChunks: Buffer[] = [];
    proc.stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk));
    const resolveWindowsInvocation = vi.fn((input: {
      args: string[];
    }) => ({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "--input-type=module",
        "--eval",
        "fixed bootstrap",
        "C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
      ],
      stdin: JSON.stringify(input.args),
      ipc: true as const,
    }));
    const { runner } = createRunner({
      prompt,
    }, {
      platform: "win32",
      spawnProcess: vi.fn() as never,
      killProcess: vi.fn() as never,
      resolveWindowsInvocation: resolveWindowsInvocation as never,
    });
    const started = runner.start();

    expect(resolveWindowsInvocation).toHaveBeenCalledWith({
      executable: "/opt/tools/dsh",
      args: ["--profile", "headless", prompt],
      environment: { DSH_HOME: "C:\\dsh-home", CUSTOM_TOKEN: "secret" },
      workingDirectory: "C:\\workspace\\project",
    });
    expect(cli.spawnCli).toHaveBeenCalledWith({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "--input-type=module",
        "--eval",
        "fixed bootstrap",
        "C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
      ],
      cwd: "C:\\workspace\\project",
      env: { DSH_HOME: "C:\\dsh-home", CUSTOM_TOKEN: "secret" },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
      detached: false,
    });
    expect(cli.spawnCli.mock.calls[0]?.[0]?.args).not.toContain(prompt);
    expect(stdinChunks.map((chunk) => chunk.toString("utf8")).join(""))
      .toBe(JSON.stringify(["--profile", "headless", prompt]));

    proc.stdout.end("done");
    proc.emit("close", 0, null);
    await started;
  });

  test("requests graceful interruption over IPC before forcing an official Windows bootstrap", async () => {
    const proc = createProcess(4141, true);
    const spawnProcess = vi.fn();
    const { runner, events, exits } = createRunner({}, {
      platform: "win32",
      spawnProcess: spawnProcess as never,
      killProcess: vi.fn() as never,
      resolveWindowsInvocation: (() => ({
        executable: "C:\\node.exe",
        args: ["--eval", "bootstrap", "C:\\dsh\\lib\\bin.js"],
        stdin: "[\"--profile\",\"headless\",\"prompt\"]",
        ipc: true as const,
      })) as never,
    });
    const started = runner.start();
    const stopping = runner.stop();
    await Promise.resolve();

    expect(proc.send).toHaveBeenCalledWith(
      { type: "interrupt" },
      expect.any(Function),
    );
    expect(spawnProcess).not.toHaveBeenCalled();

    proc.emit("close", 0, null);
    await Promise.all([started, stopping]);
    expect(events).toEqual([]);
    expect(exits).toEqual([null]);
  });

  test("reports stdin write failures once and terminates the Windows child", async () => {
    const proc = createProcess(undefined, true);
    const { runner, events, exits } = createRunner({}, {
      platform: "win32",
      spawnProcess: vi.fn() as never,
      killProcess: vi.fn() as never,
      resolveWindowsInvocation: (() => ({
        executable: "C:\\node.exe",
        args: ["--eval", "bootstrap", "C:\\dsh\\lib\\bin.js"],
        stdin: "[\"--profile\",\"headless\",\"prompt\"]",
        ipc: true as const,
      })) as never,
    });
    const started = runner.start();

    proc.stdin.emit("error", new Error("write EPIPE"));
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null, null);
    proc.emit("error", new Error("late error"));
    await started;

    expect(events).toEqual([{
      type: "error",
      error: "DSH process input error: write EPIPE",
    }]);
    expect(exits).toEqual([null]);
  });

  test("bounds a missing Windows stdin pipe even when forced termination cannot signal", async () => {
    vi.useFakeTimers();
    try {
      const proc = createProcess(undefined, true);
      Object.defineProperty(proc, "stdin", { value: null });
      proc.kill.mockReturnValue(false);
      const { runner, events, exits } = createRunner({}, {
        platform: "win32",
        spawnProcess: vi.fn() as never,
        killProcess: vi.fn() as never,
        resolveWindowsInvocation: (() => ({
          executable: "C:\\node.exe",
          args: ["--eval", "bootstrap", "C:\\dsh\\lib\\bin.js"],
          stdin: "[\"--profile\",\"headless\",\"prompt\"]",
          ipc: true as const,
        })) as never,
      });

      const started = runner.start();
      await vi.advanceTimersByTimeAsync(8_000);
      await started;

      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      expect(events).toEqual([{
        type: "error",
        error: "DSH runner failed to create stdin pipes.",
      }]);
      expect(exits).toEqual([null]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("terminates the full Windows cmd shim process tree", async () => {
    const proc = createProcess(4242);
    const killer = new FakeKillerProcess();
    const spawnProcess = vi.fn(() => killer as unknown as ChildProcess);
    const { runner, events, exits } = createRunner({}, {
      platform: "win32",
      spawnProcess: spawnProcess as never,
      killProcess: vi.fn() as never,
      resolveWindowsInvocation: ((input: { args: string[] }) => ({
        executable: "C:\\tools\\dsh.exe",
        args: input.args,
      })) as never,
    });
    const started = runner.start();

    let stopSettled = false;
    const stopping = runner.stop().finally(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    expect(spawnProcess).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "4242", "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
    expect(killer.unref).toHaveBeenCalledOnce();
    expect(proc.kill).not.toHaveBeenCalled();

    proc.emit("close", null, null);
    await Promise.all([started, stopping]);
    expect(events).toEqual([]);
    expect(exits).toEqual([null]);
  });

  test("falls back to killing the Windows wrapper when taskkill fails", async () => {
    const proc = createProcess(4343);
    const killer = new FakeKillerProcess();
    const spawnProcess = vi.fn(() => killer as unknown as ChildProcess);
    const { runner } = createRunner({}, {
      platform: "win32",
      spawnProcess: spawnProcess as never,
      killProcess: vi.fn() as never,
      resolveWindowsInvocation: ((input: { args: string[] }) => ({
        executable: "C:\\tools\\dsh.exe",
        args: input.args,
      })) as never,
    });
    const started = runner.start();

    const stopping = runner.stop();
    killer.emit("close", 1, null);

    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("close", null, null);
    await Promise.all([started, stopping]);
  });

  test("escalates an ignored POSIX interrupt to SIGKILL and clears it on exit", async () => {
    vi.useFakeTimers();
    try {
      const proc = createProcess(4444);
      const killProcess = vi.fn(() => true);
      const { runner } = createRunner({}, {
        platform: "linux",
        spawnProcess: vi.fn() as never,
        killProcess: killProcess as never,
      });
      const started = runner.start();

      const stopping = runner.stop();
      expect(killProcess).toHaveBeenCalledWith(-4444, "SIGINT");

      await vi.advanceTimersByTimeAsync(6_000);
      expect(killProcess).toHaveBeenLastCalledWith(-4444, "SIGKILL");

      proc.emit("close", null, "SIGKILL");
      await Promise.all([started, stopping]);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(killProcess).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not hide a natural exit when no interrupt signal can be sent", async () => {
    const proc = createProcess();
    proc.kill.mockReturnValue(false);
    const { runner, events, exits } = createRunner();
    const started = runner.start();

    await expect(runner.stop()).rejects.toThrow("could not be interrupted");
    proc.stdout.end("natural result");
    proc.emit("close", 0, null);
    await started;

    expect(events).toEqual([{ type: "completed", content: "natural result" }]);
    expect(exits).toEqual([0]);
  });

  test("allows a later stop retry when the first interrupt cannot be sent", async () => {
    const proc = createProcess();
    proc.kill
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const { runner, events, exits } = createRunner();
    const started = runner.start();

    await expect(runner.stop()).rejects.toThrow("could not be interrupted");
    const stopping = runner.stop();
    expect(proc.kill).toHaveBeenNthCalledWith(1, "SIGINT");
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGINT");

    proc.emit("close", null, "SIGINT");
    await Promise.all([started, stopping]);
    expect(events).toEqual([]);
    expect(exits).toEqual([null]);
  });

  test("rejects a stop that remains alive after graceful and forced termination", async () => {
    vi.useFakeTimers();
    try {
      const proc = createProcess(4555);
      const killProcess = vi.fn(() => true);
      const { runner } = createRunner({}, {
        platform: "linux",
        spawnProcess: vi.fn() as never,
        killProcess: killProcess as never,
      });
      const started = runner.start();
      const stopping = runner.stop();
      const stopExpectation = expect(stopping).rejects.toThrow(
        "did not exit within 8 seconds",
      );

      await vi.advanceTimersByTimeAsync(8_000);
      await stopExpectation;
      expect(killProcess).toHaveBeenNthCalledWith(1, -4555, "SIGINT");
      expect(killProcess).toHaveBeenNthCalledWith(2, -4555, "SIGKILL");

      proc.emit("close", null, "SIGKILL");
      await started;
    } finally {
      vi.useRealTimers();
    }
  });
});
