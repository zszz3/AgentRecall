import { expect, it } from "vitest";
import { defaultSettings, getResumeProcessSpec, buildWindowsResumeLaunchPlan } from "./platform";
import type { SessionSearchResult } from "./types";

it.each([
  ["claude-cli", "claudeBinary", "claude"],
  ["codex-cli", "codexBinary", "codex"],
  ["tclaude-cli", "tclaudeBinary", "tclaude"],
  ["tcodex-cli", "tcodexBinary", "tcodex"],
  ["codebuddy-cli", "codeBuddyBinary", "codebuddy"],
])("resolves WSL %s independently of the local CLI setting", (source, setting, binary) => {
  const session = { source, rawId: "fixture", projectPath: "/tmp/fixture" } as SessionSearchResult;
  const settings = { ...defaultSettings, [setting]: "C:\\WindowsOnly\\agent.exe" };
  const spec = getResumeProcessSpec(session, settings, { platform: "win32", wslDistribution: "Ubuntu" });
  expect(spec.args.at(-1)).not.toContain("WindowsOnly");
  expect(spec.args.at(-1)).toContain(binary + (binary.endsWith("codex") ? " resume fixture" : " --resume fixture"));
  const local = getResumeProcessSpec(session, settings, { platform: "linux" });
  expect(local.command).toBe(settings[setting as keyof typeof settings]);
});

it("resolves the SSH CLI remotely for both Windows PowerShell launchers", () => {
  const session = { source: "claude-cli", rawId: "fixture", projectPath: "/tmp/fixture" } as SessionSearchResult;
  const plan = buildWindowsResumeLaunchPlan(session, { ...defaultSettings, claudeBinary: "C:\\WindowsOnly\\claude.exe", defaultTerminal: "PowerShell" }, { platform: "win32", terminal: "PowerShell", sshArgs: ["--", "example.invalid"] });
  expect(plan.length).toBeGreaterThan(0);
  expect(JSON.stringify(plan)).not.toContain("WindowsOnly");
  expect(JSON.stringify(plan)).toContain("claude --resume fixture");
});
