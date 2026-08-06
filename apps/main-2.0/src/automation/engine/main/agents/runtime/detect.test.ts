import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { detectAgentRuntimes, resolveRuntimeExecutables } from "./detect";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function addDesktopCodex(root: string, versionDir: string): Promise<string> {
  const executable = path.join(root, "OpenAI", "Codex", "bin", versionDir, "codex.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture", "utf8");
  return executable;
}

describe("detectAgentRuntimes", () => {
  test("falls back to the newest working Codex Desktop executable on Windows", async () => {
    const localAppData = await mkdtemp(path.join(os.tmpdir(), "agent-recall-codex-desktop-"));
    temporaryDirectories.push(localAppData);
    const older = await addDesktopCodex(localAppData, "older");
    const newer = await addDesktopCodex(localAppData, "newer");
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));
    const executeVersion = vi.fn(async (command: string) => {
      if (command === "codex" || command === newer) throw new Error("not executable");
      if (command === older) return "codex-cli 0.147.0-alpha.1.2";
      throw new Error("missing");
    });

    const runtimes = await detectAgentRuntimes(resolveRuntimeExecutables({}, {}), {
      platform: "win32",
      localAppData,
      executeVersion,
    });

    const codexCommands = executeVersion.mock.calls
      .map(([command]) => command)
      .filter((command) => command === "codex" || command.endsWith("codex.exe"));
    expect(codexCommands).toEqual(["codex", newer, older]);
    expect(runtimes.find((runtime) => runtime.id === "codex")).toMatchObject({
      available: true,
      command: older,
      version: "0.147.0-alpha.1.2",
    });
  });

  test("does not replace an explicit Codex executable with the Desktop fallback", async () => {
    const localAppData = await mkdtemp(path.join(os.tmpdir(), "agent-recall-codex-explicit-"));
    temporaryDirectories.push(localAppData);
    const desktop = await addDesktopCodex(localAppData, "desktop");
    const executeVersion = vi.fn(async () => { throw new Error("configured executable failed"); });
    const executables = resolveRuntimeExecutables({ codex: "C:\\custom\\codex.cmd" }, {});

    const runtimes = await detectAgentRuntimes(executables, {
      platform: "win32",
      localAppData,
      allowWindowsCodexDesktopFallback: false,
      executeVersion,
    });

    expect(executeVersion).toHaveBeenCalledWith("C:\\custom\\codex.cmd");
    expect(executeVersion).not.toHaveBeenCalledWith(desktop);
    expect(runtimes.find((runtime) => runtime.id === "codex")).toMatchObject({
      available: false,
      command: "C:\\custom\\codex.cmd",
    });
  });
});
