import { execFile } from "node:child_process";
import type { SessionSource } from "./types";

export interface FrontmostApp {
  name: string;
  bundleId: string | null;
}

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export interface AppFocusOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
}

export interface DesktopAppProfile {
  displayName: string;
  /** Lowercased name/bundle substrings matched against the frontmost process. */
  matchTokens: readonly string[];
  /** macOS application names tried in order when activating the desktop window. */
  macAppNames: readonly string[];
  /** Windows process names tried when activating the desktop window. */
  winProcessNames: readonly string[];
}

const DESKTOP_APP_PROFILES: Partial<Record<SessionSource, DesktopAppProfile>> = {
  "deepseek-cli": {
    displayName: "DeepSeek Harness",
    matchTokens: ["deepseek", "dsh", "deep seek"],
    macAppNames: ["DeepSeek Harness", "DSH", "DeepSeek", "DSH Desktop"],
    winProcessNames: ["DeepSeek Harness", "DSH", "DeepSeek"],
  },
  "claude-app": {
    displayName: "Claude",
    matchTokens: ["claude"],
    macAppNames: ["Claude"],
    winProcessNames: ["Claude"],
  },
  "claude-cli": {
    displayName: "Claude",
    matchTokens: ["claude"],
    macAppNames: ["Claude"],
    winProcessNames: ["Claude"],
  },
  "codex-app": {
    displayName: "Codex",
    matchTokens: ["codex", "chatgpt"],
    macAppNames: ["Codex", "ChatGPT"],
    winProcessNames: ["Codex", "ChatGPT"],
  },
  "codex-cli": {
    displayName: "Codex",
    matchTokens: ["codex", "chatgpt"],
    macAppNames: ["Codex", "ChatGPT"],
    winProcessNames: ["Codex", "ChatGPT"],
  },
  "cursor-agent": {
    displayName: "Cursor",
    matchTokens: ["cursor"],
    macAppNames: ["Cursor"],
    winProcessNames: ["Cursor"],
  },
  "zcode-cli": {
    displayName: "ZCode",
    matchTokens: ["zcode"],
    macAppNames: ["ZCode"],
    winProcessNames: ["ZCode"],
  },
  "workbuddy-cli": {
    displayName: "WorkBuddy",
    matchTokens: ["workbuddy"],
    macAppNames: ["WorkBuddy", "WorkBuddy AI"],
    winProcessNames: ["WorkBuddy"],
  },
  "codebuddy-cli": {
    displayName: "CodeBuddy",
    matchTokens: ["codebuddy"],
    macAppNames: ["CodeBuddy"],
    winProcessNames: ["CodeBuddy"],
  },
  trae: {
    displayName: "Trae",
    matchTokens: ["trae"],
    macAppNames: ["Trae"],
    winProcessNames: ["Trae"],
  },
  qoder: {
    displayName: "Qoder",
    matchTokens: ["qoder"],
    macAppNames: ["Qoder"],
    winProcessNames: ["Qoder"],
  },
  "qoder-ide": {
    displayName: "Qoder",
    matchTokens: ["qoder"],
    macAppNames: ["Qoder"],
    winProcessNames: ["Qoder"],
  },
  antigravity: {
    displayName: "Antigravity",
    matchTokens: ["antigravity"],
    macAppNames: ["Antigravity"],
    winProcessNames: ["Antigravity"],
  },
  "antigravity-cli": {
    displayName: "Antigravity",
    matchTokens: ["antigravity"],
    macAppNames: ["Antigravity"],
    winProcessNames: ["Antigravity"],
  },
};

const MAC_SOUND_PATHS: Record<"completed" | "waiting_input" | "error", string> = {
  completed: "/System/Library/Sounds/Glass.aiff",
  waiting_input: "/System/Library/Sounds/Tink.aiff",
  error: "/System/Library/Sounds/Basso.aiff",
};

function defaultRunner(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2500, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function desktopAppProfileForSource(source: SessionSource): DesktopAppProfile | null {
  return DESKTOP_APP_PROFILES[source] ?? null;
}

export async function getFrontmostApplication(options: AppFocusOptions = {}): Promise<FrontmostApp | null> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;
  if (platform === "darwin") {
    try {
      const output = await runner("/usr/bin/osascript", [
        "-e",
        'tell application "System Events" to tell first application process whose frontmost is true to return (name & "\t" & (bundle identifier as text))',
      ]);
      const line = output.trim();
      if (!line) return null;
      const [rawName = "", rawBundle = ""] = line.split("\t");
      const name = rawName.trim();
      if (!name) return null;
      const bundleId = rawBundle.trim();
      return { name, bundleId: bundleId && bundleId !== "missing value" ? bundleId : null };
    } catch {
      // Accessibility or System Events can be restricted on macOS; fall back silently to non-suppressed alerts.
      return null;
    }
  }
  if (platform === "win32") {
    try {
      const script = [
        "Add-Type 'using System; using System.Runtime.InteropServices; public class W { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }'",
        "$h = [W]::GetForegroundWindow()",
        "$p = 0",
        "[void][W]::GetWindowThreadProcessId($h, [ref]$p)",
        "if ($p -gt 0) { (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName }",
      ].join("; ");
      const output = await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      const name = output.trim();
      return name ? { name, bundleId: null } : null;
    } catch {
      // Best-effort foreground check on Windows; failure should never block Dynamic Island alerts.
      return null;
    }
  }
  return null;
}

export function isSourceFrontmost(source: SessionSource, frontmost: FrontmostApp | null): boolean {
  if (!frontmost) return false;
  const profile = desktopAppProfileForSource(source);
  if (!profile) return false;
  const haystack = `${frontmost.name} ${frontmost.bundleId ?? ""}`.toLowerCase();
  // Never confuse AgentRecall itself with the external agent app.
  if (haystack.includes("agentrecall") || haystack.includes("agent-recall")) return false;
  return profile.matchTokens.some((token) => haystack.includes(token));
}

export async function activateDesktopAppForSource(
  source: SessionSource,
  options: AppFocusOptions = {},
): Promise<{ activated: boolean; targetLabel?: string }> {
  const profile = desktopAppProfileForSource(source);
  if (!profile) return { activated: false };
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;

  if (platform === "darwin") {
    // First look for a running GUI process matching any token (handles localized/custom bundle names like DSH Desktop).
    const tokenChecks = profile.matchTokens
      .map((token) => `procName contains "${escapeAppleScript(token)}" or procBundle contains "${escapeAppleScript(token)}"`)
      .join(" or ");
    const findAndActivate = [
      'tell application "System Events"',
      "  repeat with p in (every application process whose background only is false)",
      '    set procName to do shell script "printf %s " & quoted form of (name of p as text) & " | tr \'[:upper:]\' \'[:lower:]\'"',
      '    set procBundle to ""',
      "    try",
      '      set procBundle to do shell script "printf %s " & quoted form of (bundle identifier of p as text) & " | tr \'[:upper:]\' \'[:lower:]\'"',
      "    end try",
      '    if (procName does not contain "agentrecall") and (procName does not contain "agent-recall") and (' + tokenChecks + ") then",
      "      set frontmost of p to true",
      "      return name of p as text",
      "    end if",
      "  end repeat",
      "end tell",
      'return ""',
    ].join("\n");
    try {
      const activatedName = (await runner("/usr/bin/osascript", ["-e", findAndActivate])).trim();
      if (activatedName) return { activated: true, targetLabel: activatedName };
    } catch {
      // Fall through to explicit app name activation when System Events is restricted.
    }

    for (const appName of profile.macAppNames) {
      try {
        await runner("/usr/bin/open", ["-a", appName]);
        return { activated: true, targetLabel: appName };
      } catch {
        // Try next known macOS bundle name for this agent.
      }
    }
    return { activated: false };
  }

  if (platform === "win32") {
    for (const procName of profile.winProcessNames) {
      const safe = procName.replace(/'/g, "''");
      const script = [
        `$proc = Get-Process -Name '${safe}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1`,
        "if (-not $proc) { exit 1 }",
        "Add-Type 'using System; using System.Runtime.InteropServices; public class WinFocus { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int c); }'",
        "[void][WinFocus]::ShowWindowAsync($proc.MainWindowHandle, 9)",
        "[void][WinFocus]::SetForegroundWindow($proc.MainWindowHandle)",
        "Write-Output $proc.ProcessName",
      ].join("; ");
      try {
        const activatedName = (await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])).trim();
        if (activatedName) return { activated: true, targetLabel: activatedName };
      } catch {
        // Try next process name candidate.
      }
    }
  }

  return { activated: false };
}

export async function playIslandNotificationSound(
  kind: "completed" | "waiting_input" | "error",
  options: AppFocusOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;
  if (platform === "darwin") {
    try {
      await runner("/usr/bin/afplay", ["-v", "0.45", MAC_SOUND_PATHS[kind]]);
    } catch {
      // Sound playback is optional feedback; ignore missing audio device or sound file errors.
    }
    return;
  }
  if (platform === "win32") {
    try {
      await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[System.Media.SystemSounds]::Asterisk.Play()"]);
    } catch {
      // Optional audio feedback on Windows.
    }
  }
}
