import { describe, expect, it, vi } from "vitest";
import {
  activateDesktopAppForSource,
  getFrontmostApplication,
  isSourceFrontmost,
  playIslandNotificationSound,
} from "./app-focus";

describe("app-focus", () => {
  it("matches DeepSeek Harness Desktop and ignores AgentRecall itself", () => {
    expect(isSourceFrontmost("deepseek-cli", { name: "DeepSeek Harness", bundleId: "com.deepseek.harness" })).toBe(true);
    expect(isSourceFrontmost("deepseek-cli", { name: "DSH", bundleId: null })).toBe(true);
    expect(isSourceFrontmost("deepseek-cli", { name: "Google Chrome", bundleId: "com.google.Chrome" })).toBe(false);
    expect(isSourceFrontmost("deepseek-cli", { name: "AgentRecall", bundleId: "com.agentrecall.v2" })).toBe(false);
  });

  it("reads the macOS frontmost application name and bundle id", async () => {
    const runner = vi.fn(async () => "DeepSeek Harness\tcom.deepseek.harness\n");
    await expect(getFrontmostApplication({ platform: "darwin", runner })).resolves.toEqual({
      name: "DeepSeek Harness",
      bundleId: "com.deepseek.harness",
    });
  });

  it("activates a running macOS desktop app via System Events first and falls back to open -a", async () => {
    const firstRunner = vi.fn(async () => "DeepSeek Harness\n");
    await expect(activateDesktopAppForSource("deepseek-cli", { platform: "darwin", runner: firstRunner })).resolves.toEqual({
      activated: true,
      targetLabel: "DeepSeek Harness",
    });

    const fallbackRunner = vi.fn(async (command: string, args: string[]) => {
      if (command === "/usr/bin/osascript") return "";
      if (command === "/usr/bin/open" && args[1] === "DSH") return "";
      throw new Error("not installed");
    });
    await expect(activateDesktopAppForSource("deepseek-cli", { platform: "darwin", runner: fallbackRunner })).resolves.toEqual({
      activated: true,
      targetLabel: "DSH",
    });
  });

  it("plays distinct macOS sounds for completed, waiting and error alerts", async () => {
    const runner = vi.fn(async () => "");
    await playIslandNotificationSound("completed", { platform: "darwin", runner });
    expect(runner).toHaveBeenCalledWith("/usr/bin/afplay", ["-v", "0.45", "/System/Library/Sounds/Glass.aiff"]);
  });
});
