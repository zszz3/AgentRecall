import { describe, expect, it, vi } from "vitest";
import { buildWslProcessSpec, listWslDistributions, parseWslDistributionOutput } from "./wsl";

describe("WSL helpers", () => {
  it("parses UTF-8 output, removes empty lines, and de-duplicates distributions", () => {
    expect(parseWslDistributionOutput("Ubuntu\r\n\r\nDebian\nUbuntu\0\n")).toEqual(["Ubuntu", "Debian"]);
  });

  it("parses the UTF-16LE output produced by wsl.exe", () => {
    const output = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Ubuntu\r\nDebian\r\n", "utf16le")]);
    expect(parseWslDistributionOutput(output)).toEqual(["Ubuntu", "Debian"]);
  });

  it("builds an argument-array WSL command", () => {
    expect(buildWslProcessSpec(" Ubuntu ", "cd '/home/me/project' && codex resume 'abc'")).toEqual({
      command: "wsl.exe",
      args: ["--distribution", "Ubuntu", "--exec", "bash", "-lc", "cd '/home/me/project' && codex resume 'abc'"],
    });
    expect(() => buildWslProcessSpec("", "true")).toThrow("WSL distribution is required");
  });

  it("only discovers distributions on Windows and forwards runner errors", async () => {
    const runner = vi.fn(async () => ({ stdout: Buffer.from("Ubuntu\n"), stderr: Buffer.alloc(0) }));
    await expect(listWslDistributions(runner, "win32")).resolves.toEqual(["Ubuntu"]);
    expect(runner).toHaveBeenCalledWith("wsl.exe", ["--list", "--quiet"], expect.objectContaining({ encoding: "buffer" }));
    await expect(listWslDistributions(runner, "linux")).resolves.toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
    await expect(listWslDistributions(async () => { throw new Error("wsl missing"); }, "win32")).rejects.toThrow("wsl missing");
  });
});
