import { describe, expect, it } from "vitest";
import { listWslDistributionDetails, listWslDistributions, parseWslDistributionDetails, parseWslDistributionOutput } from "./wsl";

describe("WSL distribution parsing", () => {
  it("parses UTF-16 quiet output and removes only list decorations", () => {
    const output = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Ubuntu\r\n中文 distro\r\nUbuntu\r\n", "utf16le")]);
    expect(parseWslDistributionOutput(output)).toEqual(["Ubuntu", "中文 distro"]);
  });

  it("parses verbose rows, default marker, status and WSL version", () => {
    expect(parseWslDistributionDetails("  NAME\tSTATE\tVERSION\r\n* Ubuntu-22.04   Running   2\r\n  测试发行版 Stopped 1\r\n")).toEqual([
      { name: "Ubuntu-22.04", isDefault: true, state: "running", version: 2 },
      { name: "测试发行版", isDefault: false, state: "stopped", version: 1 },
    ]);
  });

  it("keeps quiet output compatible with the legacy list API", async () => {
    const runner = async (_file: string, args: readonly string[]) => ({
      stdout: Buffer.from(args.includes("--verbose") ? "* Ubuntu Running 2\n" : "Ubuntu\n"),
      stderr: Buffer.alloc(0),
    });
    await expect(listWslDistributions(runner, "win32")).resolves.toEqual(["Ubuntu"]);
    await expect(listWslDistributionDetails(runner, "win32")).resolves.toEqual([
      { name: "Ubuntu", isDefault: true, state: "running", version: 2 },
    ]);
    await expect(listWslDistributionDetails(runner, "linux")).resolves.toEqual([]);
  });
});
