import { describe, expect, it } from "vitest";
import {
  normalizeTerminalTitle,
  windowsTerminalTitleArgs,
  withCmdTerminalTitle,
  withPosixTerminalTitle,
  withPowerShellTerminalTitle,
} from "./terminal-title";

describe("terminal titles", () => {
  it("normalizes control characters while preserving Unicode", () => {
    expect(normalizeTerminalTitle("  修复登录\n流程\t\u001b[31m  ")).toBe("修复登录 流程 [31m");
    expect(normalizeTerminalTitle("alpha\u0085beta\u2028gamma\u2029delta")).toBe("alphabetagammadelta");
  });

  it("caps by Unicode code points", () => {
    expect(Array.from(normalizeTerminalTitle("会".repeat(200)))).toHaveLength(160);
  });

  it("quotes POSIX and PowerShell titles without altering the command", () => {
    expect(withPosixTerminalTitle("codex resume abc", "Bob's fix")).toBe(
      "printf '\\033]0;%s\\007' 'Bob'\\''s fix' && codex resume abc",
    );
    expect(withPowerShellTerminalTitle("codex resume abc", "Bob's fix")).toBe(
      "$Host.UI.RawUI.WindowTitle = 'Bob''s fix'; codex resume abc",
    );
  });

  it("removes cmd metacharacters from the display-only title", () => {
    const command = withCmdTerminalTitle("codex resume abc", "Fix & launch %PATH%!");
    expect(command).toBe("title Fix launch PATH & codex resume abc");
  });

  it("builds argv-safe Windows Terminal title options", () => {
    expect(windowsTerminalTitleArgs("修复登录")).toEqual([
      "--title",
      "修复登录",
      "--suppressApplicationTitle",
    ]);
  });
});
