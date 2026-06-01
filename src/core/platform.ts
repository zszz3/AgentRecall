import { execFile } from "node:child_process";
import type { SessionSearchResult, SessionSource } from "./types";

export interface AppSettings {
  defaultTerminal: "Terminal" | "iTerm" | "Ghostty" | "WezTerm" | "Warp";
  claudeBinary: string;
  codexBinary: string;
}

export const defaultSettings: AppSettings = {
  defaultTerminal: "Terminal",
  claudeBinary: "claude",
  codexBinary: "codex",
};

export function sourceFamily(source: SessionSource): "claude" | "codex" {
  return source === "claude-cli" || source === "claude-app" ? "claude" : "codex";
}

export function getResumeCommand(
  session: SessionSearchResult,
  settings: AppSettings = defaultSettings,
  opts: { withCwd?: boolean; skipPermissions?: boolean } = {},
): string {
  const { withCwd = true, skipPermissions = false } = opts;
  let cmd: string;
  if (sourceFamily(session.source) === "claude") {
    cmd = `${settings.claudeBinary} --resume ${session.rawId}`;
    if (skipPermissions) cmd += " --dangerously-skip-permissions";
  } else {
    cmd = `${settings.codexBinary} resume ${session.rawId}`;
    if (skipPermissions) cmd += " --dangerously-bypass-approvals-and-sandbox";
  }
  if (withCwd && session.projectPath) cmd = `cd ${shellQuote(session.projectPath)} && ${cmd}`;
  return cmd;
}

export async function openResumeInTerminal(session: SessionSearchResult, settings: AppSettings): Promise<void> {
  const command = getResumeCommand(session, settings, { withCwd: true });
  if (process.platform !== "darwin") {
    await runProcess(settings.defaultTerminal === "WezTerm" ? "wezterm" : "sh", ["-lc", command]);
    return;
  }

  if (settings.defaultTerminal === "iTerm") {
    await runAppleScript(`tell application "iTerm"
  activate
  if (count of windows) = 0 then create window with default profile
  tell current session of current window
    write text "${escapeAppleScript(command)}"
  end tell
end tell`);
    return;
  }

  if (settings.defaultTerminal === "Ghostty") {
    await runProcess("/usr/bin/open", ["-na", "Ghostty.app", "--args", `--initial-command=${command}`]);
    return;
  }

  if (settings.defaultTerminal === "WezTerm") {
    const args = ["-na", "WezTerm.app", "--args", "start"];
    if (session.projectPath) args.push("--cwd", session.projectPath);
    args.push("--", process.env.SHELL || "/bin/zsh", "-ic", getResumeCommand(session, settings, { withCwd: false }));
    await runProcess("/usr/bin/open", args);
    return;
  }

  if (settings.defaultTerminal === "Warp") {
    await runProcess("/usr/bin/open", session.projectPath ? ["-a", "Warp", session.projectPath] : ["-a", "Warp"]);
    return;
  }

  await runAppleScript(`tell application "Terminal"
  activate
  do script "${escapeAppleScript(command)}"
end tell`);
}

export async function openNativeApp(source: SessionSource): Promise<void> {
  const appName = sourceFamily(source) === "claude" ? "Claude" : "Codex";
  if (process.platform === "darwin") {
    await runProcess("/usr/bin/open", ["-a", appName]);
  }
}

export async function revealInFileManager(targetPath: string): Promise<void> {
  if (!targetPath) return;
  if (process.platform === "darwin") await runProcess("/usr/bin/open", ["-R", targetPath]);
  else if (process.platform === "win32") await runProcess("explorer.exe", [targetPath]);
  else await runProcess("xdg-open", [targetPath]);
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(script: string): Promise<void> {
  return runProcess("/usr/bin/osascript", ["-e", script]);
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (!error) return resolve();
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}
