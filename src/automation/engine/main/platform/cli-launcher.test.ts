import { describe, expect, test } from "vitest";
import { resolveCliInvocation } from "./cli-launcher";

describe("resolveCliInvocation", () => {
  test("routes Windows cmd shims through cmd.exe", () => {
    expect(
      resolveCliInvocation(
        "C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd",
        ["exec", "--json", "hello world", 'quote"inside', "has&meta"],
        { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" },
      ),
    ).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd" "exec" "--json" "hello world" "quote""inside" "has&meta""',
      ],
      viaWindowsCmd: true,
      windowsVerbatimArguments: true,
    });
  });

  test("routes Windows bare command names through cmd.exe", () => {
    expect(resolveCliInvocation("codex", ["--version"], { platform: "win32", comspec: "cmd.exe" })).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", '""codex" "--version""'],
      viaWindowsCmd: true,
      windowsVerbatimArguments: true,
    });
  });

  test("does not shell-wrap non-cmd executables on Windows", () => {
    expect(resolveCliInvocation("C:\\tools\\codex.exe", ["app-server"], { platform: "win32" })).toEqual({
      file: "C:\\tools\\codex.exe",
      args: ["app-server"],
      viaWindowsCmd: false,
    });
  });

  test("does not shell-wrap on non-Windows platforms", () => {
    expect(resolveCliInvocation("/usr/local/bin/codex", ["--version"], { platform: "darwin" })).toEqual({
      file: "/usr/local/bin/codex",
      args: ["--version"],
      viaWindowsCmd: false,
    });
  });
});
