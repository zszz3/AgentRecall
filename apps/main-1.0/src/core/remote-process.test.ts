import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_PROCESS_EXEC_OPTIONS,
  runRemoteCommand,
  runRemoteCommandWithInput,
  spawnRemoteCommand,
} from "./remote-process";
import type { SessionEnvironment } from "./types";

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  ...childProcessMocks,
}));

const wslEnvironment: SessionEnvironment = {
  id: "wsl-ubuntu",
  kind: "wsl",
  label: "Ubuntu",
  wslDistribution: "Ubuntu",
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
};

describe("remote-process Windows console hiding", () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
    childProcessMocks.spawn.mockReset();
  });

  it("hides background wsl.exe execFile and spawn processes even with custom options", async () => {
    expect(REMOTE_PROCESS_EXEC_OPTIONS.windowsHide).toBe(true);

    const end = vi.fn();
    childProcessMocks.execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, "ok", "");
      return { stdin: { end } };
    });

    await expect(runRemoteCommand(wslEnvironment, "echo ok", { timeout: 5_000 })).resolves.toBe("ok");
    expect(childProcessMocks.execFile.mock.calls[0]?.[2]).toEqual({
      timeout: 5_000,
      windowsHide: true,
    });

    await expect(runRemoteCommandWithInput(wslEnvironment, "cat", "hello")).resolves.toBe("ok");
    expect(childProcessMocks.execFile.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ windowsHide: true }),
    );
    expect(end).toHaveBeenCalledWith("hello");

    const spawned = new EventEmitter();
    childProcessMocks.spawn.mockReturnValueOnce(spawned);
    spawnRemoteCommand(wslEnvironment, "echo ok");
    expect(childProcessMocks.spawn.mock.calls[0]?.[2]).toEqual({
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  });
});
