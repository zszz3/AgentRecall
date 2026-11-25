import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { MigrationTarget } from "../types";
import { zcodeDatabasePathFromHome } from "../zcode-session-writer";
import type { AppSettings } from "./app-settings";
import {
  buildShellCommand,
  mergeProcessEnvOverrides,
  remoteUserShellCommand,
} from "./shell-quoting";

interface MigrationCliVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

interface VersionRule {
  label: string;
  pattern: RegExp;
  minimum: MigrationCliVersion;
}

export type CliVersionRunner = (command: string, args: string[], env?: Record<string, string>) => Promise<string>;

function version(major: number, minor: number, patch: number): MigrationCliVersion {
  return { major, minor, patch, text: `${major}.${minor}.${patch}` };
}

const MIGRATION_CLI_VERSION_RULES: Record<MigrationTarget, VersionRule[]> = {
  claude: [{ label: "Claude Code", pattern: /^\s*v?(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/im, minimum: version(2, 1, 186) }],
  codex: [{ label: "codex", pattern: /^\s*(?:codex(?:-cli)?|Codex(?: CLI)?)\s*:?[ \t]*v?(\d+\.\d+\.\d+)[ \t]*$/im, minimum: version(0, 141, 0) }],
  codebuddy: [{ label: "CodeBuddy", pattern: /^\s*v?(\d+\.\d+\.\d+)\s*$/im, minimum: version(2, 109, 1) }],
  codewiz: [{ label: "CodeWiz", pattern: /^\s*v?(\d+\.\d+\.\d+)\s*$/im, minimum: version(0, 1, 0) }],
  cursor: [{ label: "cursor-agent", pattern: /(\d+\.\d+\.\d+[-\w]*|\d{4}\.\d+\.\d+)/i, minimum: version(0, 0, 0) }],
  tclaude: [
    { label: "@tencent/tclaude", pattern: /^\s*@tencent\/tclaude\s*:?[ \t]*v?(\d+\.\d+\.\d+)[ \t]*$/im, minimum: version(0, 0, 9) },
    { label: "@anthropic-ai/claude-code", pattern: /^\s*@anthropic-ai\/claude-code\s*:?[ \t]*v?(\d+\.\d+\.\d+)[ \t]*$/im, minimum: version(2, 1, 154) },
  ],
  tcodex: [
    { label: "@tencent/tcodex", pattern: /^\s*@tencent\/tcodex\s*:?[ \t]*v?(\d+\.\d+\.\d+)[ \t]*$/im, minimum: version(0, 0, 13) },
    { label: "@openai/codex", pattern: /^\s*@openai\/codex\s*:?[ \t]*v?(\d+\.\d+\.\d+)[ \t]*$/im, minimum: version(0, 142, 4) },
  ],
  deepseek: [{ label: "dsh", pattern: /^\s*v?(\d+\.\d+\.\d+)(?:-[\w.-]+)?\s*$/im, minimum: version(0, 0, 0) }],
  // ZCode migrations write into the local ZCode database directly, so no CLI
  // version gate applies; inspectMigrationCli checks the database instead.
  zcode: [],
};

// Login and interactive startup files are where users put the PATH entries their
// terminal relies on, but reading them means running arbitrary startup code.
const SHELL_CLI_LOOKUP_TIMEOUT_MS = 5_000;

export function migrationBinary(target: MigrationTarget, settings: AppSettings): string {
  if (target === "claude") return settings.claudeBinary;
  if (target === "tclaude") return settings.tclaudeBinary;
  if (target === "tcodex") return settings.tcodexBinary;
  if (target === "codebuddy") return settings.codeBuddyBinary;
  if (target === "codewiz") return settings.codeWizBinary;
  if (target === "cursor") return settings.cursorBinary;
  if (target === "deepseek") return settings.deepseekBinary;
  if (target === "zcode") return "zcode";
  return settings.codexBinary;
}

/** Normalize local CLI settings before inspecting a remote POSIX environment. */
export function remoteMigrationSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    claudeBinary: "claude",
    codexBinary: "codex",
    codeBuddyBinary: "codebuddy",
    codeWizBinary: "codewiz",
    cursorBinary: "cursor-agent",
    tclaudeBinary: "tclaude",
    tcodexBinary: "tcodex",
    deepseekBinary: "dsh",
  };
}

export function migrationTargetDisplayName(target: MigrationTarget): string {
  if (target === "claude") return "Claude";
  if (target === "tclaude") return "TClaude";
  if (target === "tcodex") return "TCodex";
  if (target === "codebuddy") return "CodeBuddy";
  if (target === "codewiz") return "CodeWiz";
  if (target === "cursor") return "Cursor";
  if (target === "deepseek") return "DeepSeek Harness";
  return "Codex";
}

export function migrationResumeArgs(target: MigrationTarget, sessionId: string): string[] {
  return target === "codex" || target === "tcodex"
    ? ["resume", sessionId]
    : target === "codewiz"
      ? ["--session", sessionId]
      : target === "deepseek"
        ? ["--profile", "tui", "--resume", sessionId]
        : ["--resume", sessionId];
}

// Migrated ZCode sessions land in the ZCode app's always-open default workspace,
// so they appear in its task list; there is no CLI resume command to offer.
export function zcodeMigrationResumeHint(sessionId: string): string {
  return `Open the ZCode app and continue session ${sessionId} from its task list.`;
}

function runCliVersionProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 0,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      reject(Object.assign(failure, { stdout, stderr }));
    });
  });
}

// Startup files often print banners around the lookup result, so accept only a
// line that names the requested binary instead of the first path that appears.
function absoluteCliFromShellOutput(output: string, command: string): string | null {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => path.isAbsolute(line) && path.basename(line) === command)
    .at(-1) ?? null;
}

function quotePowerShellCliArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveWindowsCliCommand(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (path.win32.isAbsolute(command) || /[\\/]/.test(command)) {
    if (existsSync(command)) return Promise.resolve(command);
    return Promise.reject(Object.assign(new Error(`CLI binary not found: ${command}`), { code: "ENOENT" }));
  }
  // where.exe gives a consistent missing-binary result even when cmd.exe is localized.
  return new Promise((resolve, reject) => {
    execFile("where.exe", [command], { env, windowsHide: true }, (error, stdout) => {
      if (!error) {
        const candidates = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        const resolved = candidates.find((value) => /\.cmd$/i.test(value)) ?? candidates[0];
        if (resolved) {
          resolve(resolved);
          return;
        }
        reject(Object.assign(new Error(`CLI binary not found: ${command}`), { code: "ENOENT" }));
        return;
      }
      reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "ENOENT" }));
    });
  });
}

async function runCliVersion(command: string, args: string[], env?: Record<string, string>): Promise<string> {
  if (process.platform === "win32") {
    // npm installs Windows CLI shims as .cmd files. PowerShell invokes those
    // shims, while single-quoted arguments keep paths and values literal.
    const childEnv = mergeProcessEnvOverrides(env);
    return resolveWindowsCliCommand(command, childEnv).then(
      (resolvedCommand) => new Promise((resolve, reject) => {
        const commandLine = ["&", quotePowerShellCliArg(resolvedCommand), ...args.map(quotePowerShellCliArg)].join(" ");
        const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", commandLine], {
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", (error) => {
          reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { stdout, stderr }));
        });
        child.once("close", (code) => {
          if (code === 0) {
            resolve(stdout);
            return;
          }
          const failure = new Error(`CLI exited with code ${code ?? "unknown"}`);
          reject(Object.assign(failure, { stdout, stderr }));
        });
      }),
    );
  }

  const childEnv = mergeProcessEnvOverrides(env);
  if (!path.isAbsolute(command) && !/[\\/]/.test(command)) {
    const shell = childEnv.SHELL?.trim() || "/bin/sh";
    try {
      const resolvedOutput = await runCliVersionProcess(
        shell,
        ["-lic", 'command -v -- "$0"', command],
        childEnv,
        SHELL_CLI_LOOKUP_TIMEOUT_MS,
      );
      command = absoluteCliFromShellOutput(resolvedOutput, command) ?? command;
    } catch {
      // A custom shell may not support login/interactive flags, and a slow
      // startup file can exhaust the lookup timeout. The inherited application
      // PATH is still a valid fallback for directly installed CLIs.
    }
  }
  return runCliVersionProcess(command, args, childEnv);
}

function parseMigrationCliVersion(value: string): MigrationCliVersion | null {
  const match = value.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? "0"),
    text: `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? "0")}`,
  };
}

function compareMigrationCliVersions(left: MigrationCliVersion, right: MigrationCliVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function migrationCliVersionPrefix(target: MigrationTarget): string {
  return `${migrationTargetDisplayName(target)} CLI`;
}

function migrationCliVersionErrorMessage(target: MigrationTarget, binary: string, error: unknown): string {
  const prefix = migrationCliVersionPrefix(target);
  const err = error as NodeJS.ErrnoException;
  if (err.code === "ENOENT") return `${prefix} binary not found: ${binary}`;
  return `${prefix} --version failed for ${binary}.`;
}

export function getRemoteMigrationCliVersionCommand(command: string, args: string[]): string {
  const invocation = buildShellCommand(command, args, null, { shell: "posix", withCwd: false });
  return remoteUserShellCommand(invocation);
}

export async function inspectMigrationCli(
  target: MigrationTarget,
  settings: AppSettings,
  runner: CliVersionRunner = runCliVersion,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): Promise<void> {
  if (target === "zcode") {
    const homeDir = options.homeDir || process.env.AGENT_RECALL_MIGRATION_HOME?.trim() || homedir();
    const dbPath = zcodeDatabasePathFromHome(homeDir);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(dbPath);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code === "ENOENT") {
        throw Object.assign(new Error(`ZCode database not found at ${dbPath}. Install ZCode and start one session so the database exists.`), { code: "ENOENT" });
      }
      throw error;
    }
    if (!stat.isFile()) throw new Error(`ZCode database path is not a regular file: ${dbPath}.`);
    const taskIndexPath = path.join(homeDir, ".zcode", "v2", "tasks-index.sqlite");
    try {
      stat = statSync(taskIndexPath);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code === "ENOENT") {
        throw Object.assign(new Error(`ZCode task index not found at ${taskIndexPath}. Start one ZCode session so its task list is initialized.`), { code: "ENOENT" });
      }
      throw error;
    }
    if (!stat.isFile()) throw new Error(`ZCode task index path is not a regular file: ${taskIndexPath}.`);
    return;
  }
  const binary = migrationBinary(target, settings);
  if (target === "cursor") {
    try {
      await runner(binary, ["--version"]);
    } catch (error) {
      throw new Error(migrationCliVersionErrorMessage(target, binary, error));
    }
    return;
  }
  let versionOutput: string;
  try {
    versionOutput = await runner(binary, ["--version"]);
  } catch (error) {
    throw new Error(migrationCliVersionErrorMessage(target, binary, error));
  }

  const trimmed = versionOutput.trim();
  const rules = MIGRATION_CLI_VERSION_RULES[target];
  const requiredLabels = rules.map((rule) => rule.label).join(", ");
  if (!trimmed) {
    throw new Error(
      `${migrationCliVersionPrefix(target)} returned no version information for ${requiredLabels} from ${binary} --version.`,
    );
  }

  for (const rule of rules) {
    const match = rule.pattern.exec(trimmed);
    const parsed = match ? parseMigrationCliVersion(match[1]) : null;
    if (!parsed) {
      if (rules.length === 1) {
        throw new Error(
          `${migrationCliVersionPrefix(target)} returned an unparseable version for ${rule.label} from ${binary} --version.`,
        );
      }
      throw new Error(
        `${migrationCliVersionPrefix(target)} returned no parseable ${rule.label} version from ${binary} --version.`,
      );
    }
    if (compareMigrationCliVersions(parsed, rule.minimum) < 0) {
      const label = rules.length === 1 ? "" : `${rule.label} `;
      const labelSuffix = rules.length === 1 ? ` (${rule.label})` : "";
      throw new Error(
        `${migrationCliVersionPrefix(target)} ${label}${parsed.text} is too old for ${binary}${labelSuffix}; require at least ${rule.minimum.text}.`,
      );
    }
  }
}
