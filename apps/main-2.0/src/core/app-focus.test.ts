import { expect, it, vi } from "vitest";
import { activateDesktopAppForSource } from "./app-focus";

it("does not launch DeepSeek Harness Desktop when no running macOS window was found", async () => {
  const runner = vi.fn(async () => "");

  await expect(activateDesktopAppForSource("deepseek-cli", {
    platform: "darwin", runner, runningOnly: true,
  })).resolves.toEqual({ activated: false });
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner).toHaveBeenCalledWith("/usr/bin/osascript", expect.any(Array));
});

it("requires Windows foreground confirmation before reporting a running Desktop focused", async () => {
  const runner = vi.fn(async (_command: string, args: string[]) => {
    const script = args.at(-1) ?? "";
    // Simulate a found window for which Windows denies the foreground request.
    if (script.includes("[WinFocus]::GetForegroundWindow() -ne $handle")) throw new Error("exit 1");
    return "DeepSeek Harness";
  });

  await expect(activateDesktopAppForSource("deepseek-cli", {
    platform: "win32", runner, runningOnly: true,
  })).resolves.toEqual({ activated: false });
});
