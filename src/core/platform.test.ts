import { describe, expect, it } from "vitest";
import { getResumeCommand, resolveMacApplicationName } from "./platform";
import type { SessionSearchResult } from "./types";

describe("platform application resolution", () => {
  it("returns the first macOS application name that resolves", async () => {
    const calls: string[][] = [];
    const runner = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1].includes('"iTerm"')) throw new Error("not found");
    };

    await expect(resolveMacApplicationName(["iTerm", "iTerm2"], runner)).resolves.toBe("iTerm2");
    expect(calls).toHaveLength(2);
  });

  it("returns null when none of the macOS application names resolve", async () => {
    const runner = async () => {
      throw new Error("not found");
    };

    await expect(resolveMacApplicationName(["iTerm", "iTerm2"], runner)).resolves.toBeNull();
  });
});

describe("resume commands", () => {
  it("uses CodeBuddy CLI resume syntax for CodeBuddy sessions", () => {
    const session = {
      source: "codebuddy-cli",
      rawId: "codebuddy-1",
      projectPath: "/repo",
    } as SessionSearchResult;

    expect(getResumeCommand(session)).toBe("cd /repo && codebuddy --resume codebuddy-1");
  });
});
