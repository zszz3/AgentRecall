import { describe, expect, it } from "vitest";
import {
  normalizeTerminalTitle,
  withCmdTerminalTitle,
  withPosixTerminalTitle,
  withPowerShellTerminalTitle,
} from "./terminal-title";

const MAX_CODE_POINTS = 160;

describe("normalizeTerminalTitle", () => {
  it("collapses internal whitespace runs into a single space", () => {
    expect(normalizeTerminalTitle("build   the   thing")).toBe("build the thing");
  });

  it("strips carriage returns, tabs and newlines that would break the label", () => {
    expect(normalizeTerminalTitle("refactor\r\n\tsession loader")).toBe("refactor session loader");
  });

  it("removes C0/C1 control characters and unicode line separators", () => {
    expect(normalizeTerminalTitle("safe\u0000ti\u0007tle\u2028end")).toBe("safetitleend");
  });

  it("falls back to a placeholder when nothing printable survives", () => {
    expect(normalizeTerminalTitle("\r\n\t")).toBe("Untitled Session");
    expect(normalizeTerminalTitle("   ")).toBe("Untitled Session");
  });

  it("never leaves a trailing space after truncation at the code-point limit", () => {
    const title = `${"x".repeat(MAX_CODE_POINTS - 1)} tail`;
    const result = normalizeTerminalTitle(title);
    expect(Array.from(result).length).toBeLessThanOrEqual(MAX_CODE_POINTS);
    expect(result.endsWith(" ")).toBe(false);
    expect(result).toBe("x".repeat(MAX_CODE_POINTS - 1));
  });

  it("counts by code point so multi-byte glyphs are never split", () => {
    const emoji = "🚀".repeat(MAX_CODE_POINTS + 20);
    expect(Array.from(normalizeTerminalTitle(emoji)).length).toBe(MAX_CODE_POINTS);
  });
});

describe("terminal title command wrappers", () => {
  it("single-quotes posix titles and preserves the trailing command", () => {
    expect(withPosixTerminalTitle("ls -la", "my session")).toBe(
      "printf '\\033]0;%s\\007' 'my session' && ls -la",
    );
  });

  it("escapes embedded single quotes for posix shells", () => {
    expect(withPosixTerminalTitle("run", "it's fine")).toContain("'it'\\''s fine'");
  });

  it("doubles single quotes for powershell", () => {
    expect(withPowerShellTerminalTitle("run", "it's fine")).toContain("'it''s fine'");
  });

  it("drops cmd metacharacters that the title builtin cannot handle", () => {
    expect(withCmdTerminalTitle("dir", "a & b | c > d")).toBe("title a b c d & dir");
  });
});
