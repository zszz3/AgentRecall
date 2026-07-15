import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  defaultApiConfig,
  defaultClaudeApiConfig,
  normalizeApiConfig,
  normalizeClaudeApiConfig,
  type ApiConfig,
  type ClaudeApiConfig,
} from "./api-config";
import { DEFAULT_GLOBAL_SHORTCUT, normalizeGlobalShortcut, type GlobalShortcut } from "./shortcuts";
import {
  type TerminalChoice,
  defaultTerminalFor,
  normalizeTerminal,
  terminalOptionsFor,
} from "./terminal-options";
import type { MigrationTarget, SessionSearchResult, SessionSource } from "./types";

export { type TerminalChoice, defaultTerminalFor, normalizeTerminal, terminalOptionsFor } from "./terminal-options";
export {
  defaultApiConfig,
  defaultClaudeApiConfig,
  normalizeApiConfig,
  normalizeClaudeApiConfig,
  type ApiConfig,
  type ApiFormat,
  type ApiProviderChoice,
  type ClaudeApiConfig,
  type ClaudeApiFormat,
} from "./api-config";

type ProcessRunner = (command: string, args: string[]) => Promise<void>;

export interface ResumeProcessSpec {
  command: string;
  args: string[];
  cwd?: string;
  // Child-process environment overrides only. Execution boundaries must merge
  // this map over process.env rather than treating it as a complete env.
  env?: Record<string, string>;
  displayCommand: string;
}

interface ResumeOptions {
  withCwd?: boolean;
  skipPermissions?: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
  sshTarget?: string;
  sshArgs?: string[];
}

type ResumeOpenOptions = Pick<ResumeOptions, "skipPermissions" | "platform" | "homeDir" | "sshTarget" | "sshArgs">;

export interface AppSettings {
  defaultTerminal: TerminalChoice;
  globalShortcut: GlobalShortcut;
  claudeBinary: string;
  codexBinary: string;
  codeBuddyBinary: string;
  codeWizBinary: string;
  cursorBinary: string;
  tclaudeBinary: string;
  tcodexBinary: string;
  claudeInternalBinary: string;
  includeClaudeInternal: boolean;
  includeCodexInternal: boolean;
  includeTclaude: boolean;
  includeTcodex: boolean;
  includeCodeBuddyCli: boolean;
  includeCodeWizCli: boolean;
  includeOpenClaw: boolean;
  includeHermes: boolean;
  includeOpenCode: boolean;
  includeCursorAgent: boolean;
  includeTrae: boolean;
  hideCodexQuota: boolean;
  hideClaudeQuota: boolean;
  hideSubagentSessions: boolean;
  autoCheckUpdates: boolean;
  summaryAutoBackfill: boolean;
  summaryMaxAgeDays: number;
  compressionConcurrency: number;
  summarySource: "codex" | "claude" | "custom";
  sessionSearchMcpEnabled: boolean;
  skillSyncEnabled: boolean;
  skillSyncSupabaseUrl: string;
  skillSyncSupabaseAnonKey: string;
  remoteSyncEnabled: boolean;
  remoteSyncSupabaseUrl: string;
  remoteSyncSupabaseAnonKey: string;
  apiConfig: ApiConfig;
  claudeApiConfig: ClaudeApiConfig;
  summaryApiConfig: ApiConfig;
}

export type AppSettingsUpdate = Partial<Omit<AppSettings, "apiConfig" | "claudeApiConfig" | "summaryApiConfig">> & {
  apiConfig?: Partial<ApiConfig>;
  claudeApiConfig?: Partial<ClaudeApiConfig>;
  summaryApiConfig?: Partial<ApiConfig>;
};

export const defaultSettings: AppSettings = {
  defaultTerminal: defaultTerminalFor(),
  globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
  claudeBinary: "claude",
  codexBinary: "codex",
  codeBuddyBinary: "codebuddy",
  codeWizBinary: "codewiz",
  cursorBinary: "cursor-agent",
  tclaudeBinary: "tclaude",
  tcodexBinary: "tcodex",
  claudeInternalBinary: "claude-internal",
  includeClaudeInternal: false,
  includeCodexInternal: false,
  includeTclaude: false,
  includeTcodex: false,
  includeCodeBuddyCli: false,
  includeCodeWizCli: false,
  includeOpenClaw: false,
  includeHermes: false,
  includeOpenCode: false,
  includeCursorAgent: false,
  includeTrae: false,
  hideCodexQuota: false,
  hideClaudeQuota: false,
  hideSubagentSessions: true,
  autoCheckUpdates: true,
  summaryAutoBackfill: false,
  summaryMaxAgeDays: 30,
  compressionConcurrency: 8,
  summarySource: "codex",
  sessionSearchMcpEnabled: true,
  skillSyncEnabled: false,
  skillSyncSupabaseUrl: "",
  skillSyncSupabaseAnonKey: "",
  remoteSyncEnabled: false,
  remoteSyncSupabaseUrl: "",
  remoteSyncSupabaseAnonKey: "",
  apiConfig: defaultApiConfig,
  claudeApiConfig: defaultClaudeApiConfig,
  summaryApiConfig: defaultApiConfig,
};

export function mergeAppSettings(previous: AppSettings, updates: AppSettingsUpdate): AppSettings {
  const merged = { ...previous, ...updates };
  return {
    ...merged,
    defaultTerminal: normalizeTerminal(merged.defaultTerminal),
    globalShortcut: normalizeGlobalShortcut(merged.globalShortcut),
    summaryMaxAgeDays: normalizeSummaryMaxAgeDays(merged.summaryMaxAgeDays),
    compressionConcurrency: normalizeCompressionConcurrency(merged.compressionConcurrency),
    autoCheckUpdates: Boolean(merged.autoCheckUpdates),
    summarySource: merged.summarySource === "claude" || merged.summarySource === "custom" ? merged.summarySource : "codex",
    skillSyncEnabled: Boolean(merged.skillSyncEnabled),
    skillSyncSupabaseUrl: normalizeSupabaseSettingUrl(merged.skillSyncSupabaseUrl),
    skillSyncSupabaseAnonKey: String(merged.skillSyncSupabaseAnonKey ?? "").trim(),
    remoteSyncEnabled: Boolean(merged.remoteSyncEnabled),
    remoteSyncSupabaseUrl: normalizeSupabaseSettingUrl(merged.remoteSyncSupabaseUrl),
    remoteSyncSupabaseAnonKey: String(merged.remoteSyncSupabaseAnonKey ?? "").trim(),
    apiConfig: normalizeApiConfig({ ...previous.apiConfig, ...(updates.apiConfig ?? {}) }),
    claudeApiConfig: normalizeClaudeApiConfig({ ...previous.claudeApiConfig, ...(updates.claudeApiConfig ?? {}) }),
    summaryApiConfig: normalizeApiConfig({ ...previous.summaryApiConfig, ...(updates.summaryApiConfig ?? {}) }),
  };
}

function normalizeSupabaseSettingUrl(value: string | undefined): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function normalizeSummaryMaxAgeDays(value: number): number {
  if (!Number.isFinite(value) || value < 1) return defaultSettings.summaryMaxAgeDays;
  return Math.min(3650, Math.round(value));
}

function normalizeCompressionConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1) return defaultSettings.compressionConcurrency;
  return Math.min(32, Math.round(value));
}

const ITERM_APPLICATION_NAMES = ["iTerm", "iTerm2"];

type SourceFamily = "claude" | "codex" | "tclaude" | "tcodex" | "codebuddy" | "codewiz" | "openclaw" | "hermes" | "opencode" | "cursor" | "trae";

function sourceDisplayName(source: SessionSource): string {
  if (source === "opencode-cli") return "OpenCode";
  if (source === "cursor-agent") return "Cursor Agent";
  if (source === "openclaw") return "OpenClaw";
  if (source === "hermes") return "Hermes";
  if (source === "trae") return "Trae";
  if (source === "tclaude-cli") return "TClaude";
  if (source === "tcodex-cli") return "TCodex";
  if (source === "codebuddy-cli") return "CodeBuddy";
  if (source === "codewiz-cli") return "CodeWiz";
  if (source.startsWith("claude")) return "Claude";
  return "Codex";
}

export function sourceFamily(source: SessionSource): SourceFamily {
  if (source === "tclaude-cli") return "tclaude";
  if (source === "tcodex-cli") return "tcodex";
  if (source === "codebuddy-cli") return "codebuddy";
  if (source === "codewiz-cli") return "codewiz";
  if (source === "openclaw") return "openclaw";
  if (source === "hermes") return "hermes";
  if (source === "opencode-cli") return "opencode";
  if (source === "cursor-agent") return "cursor";
  if (source === "trae") return "trae";
  return source === "claude-cli" || source === "claude-app" || source === "claude-internal" ? "claude" : "codex";
}

export function migrationBinary(target: MigrationTarget, settings: AppSettings): string {
  if (target === "claude") return settings.claudeBinary;
  if (target === "tclaude") return settings.tclaudeBinary;
  if (target === "tcodex") return settings.tcodexBinary;
  if (target === "claude-internal") return settings.claudeInternalBinary;
  if (target === "codebuddy") return settings.codeBuddyBinary;
  if (target === "codewiz") return settings.codeWizBinary;
  if (target === "cursor") return settings.cursorBinary;
  return settings.codexBinary;
}

function migrationTargetDisplayName(target: MigrationTarget): string {
  if (target === "claude") return "Claude";
  if (target === "tclaude") return "TClaude";
  if (target === "tcodex") return "TCodex";
  if (target === "claude-internal") return "Claude Internal";
  if (target === "codex-internal") return "Codex Internal";
  if (target === "codebuddy") return "CodeBuddy";
  if (target === "codewiz") return "CodeWiz";
  if (target === "cursor") return "Cursor";
  return "Codex";
}

function migrationResumeArgs(target: MigrationTarget, sessionId: string): string[] {
  return target === "codex" || target === "tcodex" || target === "codex-internal"
    ? ["resume", sessionId]
    : target === "codewiz"
      ? ["--session", sessionId]
    : ["--resume", sessionId];
}

interface ShellCommands {
  posix: string;
  cmd: string;
  powershell: string;
}

interface CommandBuildOptions {
  shell: ShellKind;
  withCwd: boolean;
}

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
  "claude-internal": [
    { label: "claude-internal", pattern: /^\s*claude-internal\s*:?[ \t]*v?(\d+\.\d+\.\d+)[ \t]*$/im, minimum: version(1, 1, 9) },
    { label: "claude", pattern: /^\s*claude\s*:?[ \t]*v?(\d+\.\d+\.\d+)[ \t]*$/im, minimum: version(2, 1, 154) },
  ],
  "codex-internal": [{ label: "codex", pattern: /^\s*(?:codex(?:-cli)?|Codex(?: CLI)?)\s*:?[ \t]*v?(\d+\.\d+\.\d+)[ \t]*$/im, minimum: version(0, 141, 0) }],
};

function migrationCodexHome(homeDir: string, platform: NodeJS.Platform): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(homeDir, ".codex-internal");
}

function migrationTargetForResumeSource(source: SessionSource): MigrationTarget | null {
  if (source === "claude-cli" || source === "claude-app") return "claude";
  if (source === "claude-internal") return "claude-internal";
  if (source === "codex-cli" || source === "codex-app") return "codex";
  if (source === "codex-internal") return "codex-internal";
  if (source === "tclaude-cli") return "tclaude";
  if (source === "tcodex-cli") return "tcodex";
  if (source === "codebuddy-cli") return "codebuddy";
  if (source === "codewiz-cli") return "codewiz";
  if (source === "cursor-agent") return "cursor";
  return null;
}

function buildResumeRuntimeProcessSpec(
  session: SessionSearchResult,
  settings: AppSettings,
  skipPermissions: boolean,
  platform: NodeJS.Platform,
  homeDir: string,
): Omit<ResumeProcessSpec, "displayCommand"> {
  const target = migrationTargetForResumeSource(session.source);
  if (!target) {
    throw new Error(`Resume is not supported for ${sourceDisplayName(session.source)} sessions yet.`);
  }

  const args = migrationResumeArgs(target, session.rawId);
  if (skipPermissions) {
    if (target === "claude" || target === "tclaude" || target === "claude-internal") {
      args.push("--dangerously-skip-permissions");
    } else if (target === "codex" || target === "tcodex" || target === "codex-internal") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
  }

  return {
    command: migrationBinary(target, settings),
    args,
    cwd: session.projectPath || undefined,
    env: target === "codex-internal" ? { CODEX_HOME: migrationCodexHome(homeDir, platform) } : undefined,
  };
}

// Which shell the displayed/copied command is meant to be pasted into. The
// remote (ssh) command body always runs on a POSIX login shell; the local
// terminal can be cmd.exe or PowerShell on Windows.
type ShellKind = "posix" | "cmd" | "powershell";

function localShellKind(platform: NodeJS.Platform, settings: AppSettings): ShellKind {
  if (platform !== "win32") return "posix";
  return normalizeTerminal(settings.defaultTerminal, "win32") === "PowerShell" ? "powershell" : "cmd";
}

function shellTokenQuote(s: string, shell: ShellKind): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  if (shell === "cmd") return winQuote(s);
  if (shell === "powershell") return powershellQuote(s);
  return shellQuote(s);
}

function buildCdPrefix(projectPath: string, shell: ShellKind): string {
  // PowerShell has no `cd /d` and chains statements with `;`; cmd uses `&&`.
  if (shell === "cmd") return `cd /d ${winQuote(projectPath)} && `;
  if (shell === "powershell") return `cd ${powershellQuote(projectPath)}; `;
  return `cd ${shellQuote(projectPath)} && `;
}

function buildShellCommand(
  command: string,
  args: string[],
  projectPath: string | null | undefined,
  opts: CommandBuildOptions,
): string {
  const quotedCommand = shellTokenQuote(command, opts.shell);
  // PowerShell treats a quoted leading token as a string literal, so the call
  // operator `&` is required to actually run a quoted executable path.
  const invocation = opts.shell === "powershell" && quotedCommand !== command ? `& ${quotedCommand}` : quotedCommand;
  let cmd = [invocation, ...args.map((token) => shellTokenQuote(token, opts.shell))].join(" ");
  if (opts.withCwd && projectPath) {
    cmd = `${buildCdPrefix(projectPath, opts.shell)}${cmd}`;
  }
  return cmd;
}

function buildResumeShellCommand(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: Required<Pick<ResumeOptions, "withCwd" | "skipPermissions" | "platform">> & { shell: ShellKind; homeDir?: string },
): string {
  const spec = buildResumeRuntimeProcessSpec(session, settings, opts.skipPermissions, opts.platform, opts.homeDir ?? homedir());
  return buildMigrationResumeShellCommand(spec, session.projectPath ?? "", opts.shell, opts.withCwd);
}

function buildMigrationResumeShellCommand(
  spec: Omit<ResumeProcessSpec, "displayCommand">,
  projectPath: string,
  shell: ShellKind,
  withCwd = true,
): string {
  const codexHome = spec.env?.CODEX_HOME;
  if (shell === "cmd" && requiresEncodedCmdCommand(spec, projectPath, withCwd)) {
    return buildEncodedCmdCommand(spec, projectPath, withCwd);
  }

  const invocation = buildShellCommand(spec.command, spec.args, projectPath, {
    shell,
    withCwd: withCwd && !spec.env?.CODEX_HOME,
  });
  if (!codexHome) return invocation;

  if (shell === "posix") {
    const scopedInvocation = `CODEX_HOME=${shellTokenQuote(codexHome, shell)} ${buildShellCommand(spec.command, spec.args, projectPath, { shell, withCwd: false })}`;
    return withCwd && projectPath ? `${buildCdPrefix(projectPath, shell)}${scopedInvocation}` : scopedInvocation;
  }
  if (shell === "powershell") {
    const command = buildShellCommand(spec.command, spec.args, projectPath, { shell, withCwd });
    return `$__assHadCodexHome = Test-Path Env:CODEX_HOME; $__assCodexHome = $env:CODEX_HOME; try { $env:CODEX_HOME = ${powershellQuote(codexHome)}; ${command} } finally { if ($__assHadCodexHome) { $env:CODEX_HOME = $__assCodexHome } else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } }`;
  }

  const command = buildShellCommand(spec.command, spec.args, projectPath, { shell, withCwd });
  return `setlocal & set "CODEX_HOME=${codexHome.replace(/"/g, '""')}" & ${command} & endlocal`;
}

function requiresEncodedCmdCommand(
  spec: Omit<ResumeProcessSpec, "displayCommand">,
  projectPath: string,
  withCwd: boolean,
): boolean {
  const values = [spec.command, ...spec.args, spec.env?.CODEX_HOME, withCwd ? projectPath : undefined];
  // `%NAME%` is expanded by cmd.exe even inside quotes, while `!NAME!` is
  // expanded when delayed expansion is enabled by the parent shell. Embedded
  // quotes/newlines can also escape the token boundary. Avoid cmd's parser for
  // these values instead of relying on batch-only percent escaping.
  return values.some((value) => value !== undefined && /[%!"\r\n]/.test(value));
}

function buildEncodedCmdCommand(
  spec: Omit<ResumeProcessSpec, "displayCommand">,
  projectPath: string,
  withCwd: boolean,
): string {
  const statements = ["$ErrorActionPreference = 'Stop'"];
  if (spec.env?.CODEX_HOME) {
    statements.push(`$env:CODEX_HOME = ${powershellQuote(spec.env.CODEX_HOME)}`);
  }
  if (withCwd && projectPath) {
    statements.push(`Set-Location -LiteralPath ${powershellQuote(projectPath)}`);
  }
  statements.push(`& ${[spec.command, ...spec.args].map((token) => shellTokenQuote(token, "powershell")).join(" ")}`);
  const script = statements.join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `setlocal DisableDelayedExpansion & powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded} & endlocal`;
}

function buildMigrationResumeCommands(
  spec: Omit<ResumeProcessSpec, "displayCommand">,
  projectPath: string,
  withCwd = true,
): ShellCommands {
  return {
    posix: buildMigrationResumeShellCommand(spec, projectPath, "posix", withCwd),
    cmd: buildMigrationResumeShellCommand(spec, projectPath, "cmd", withCwd),
    powershell: buildMigrationResumeShellCommand(spec, projectPath, "powershell", withCwd),
  };
}

export function getResumeCommand(
  session: SessionSearchResult,
  settings: AppSettings = defaultSettings,
  opts: ResumeOptions = {},
): string {
  const { withCwd = true, skipPermissions = false, platform = process.platform, homeDir = homedir() } = opts;
  const sshArgs = resolveSshArgs(opts);
  const shell = localShellKind(platform, settings);
  const runtimePlatform = sshArgs ? "linux" : platform;
  const spec = buildResumeRuntimeProcessSpec(session, settings, skipPermissions, runtimePlatform, homeDir);
  if (sshArgs) {
    // The remote command body always targets a POSIX shell; only the outer ssh
    // invocation is quoted for the local terminal (cmd carets vs PowerShell).
    const innerCommand = buildMigrationResumeShellCommand(spec, session.projectPath ?? "", "posix", withCwd);
    if (shell === "powershell") return formatPowershellSshDisplay(sshArgs, innerCommand);
    return formatSshDisplayCommand(sshArgs, innerCommand, platform);
  }
  return buildMigrationResumeShellCommand(spec, session.projectPath ?? "", shell, withCwd);
}

function formatPowershellSshDisplay(sshArgs: string[], innerCommand: string): string {
  return ["ssh", ...sshArgs.map(powershellSshArgQuote), powershellQuote(innerCommand)].join(" ");
}

export interface WindowsLaunch {
  file: string;
  args: string[];
  cwd?: string;
}

// Ordered candidate launches. The caller tries each until one spawns (ENOENT -> next).
export function buildWindowsLaunchPlan(
  terminal: TerminalChoice,
  cmdCommand: string,
  cwd: string,
  powershellCommand?: string,
): WindowsLaunch[] {
  const wt = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", cmdCommand];
    return { file: "wt.exe", args: cwd ? ["-d", cwd, ...inner] : inner };
  };
  const pwsh = (): WindowsLaunch => ({
    file: "pwsh.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", powershellCommand ?? cmdCommand],
    cwd: cwd || undefined,
  });
  const powershell = (): WindowsLaunch => ({
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", powershellCommand ?? cmdCommand],
    cwd: cwd || undefined,
  });
  const cmd = (): WindowsLaunch => ({ file: "cmd.exe", args: ["/d", "/k", cmdCommand], cwd: cwd || undefined });
  const wezterm = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", cmdCommand];
    return { file: "wezterm.exe", args: cwd ? ["start", "--cwd", cwd, "--", ...inner] : ["start", "--", ...inner] };
  };

  if (terminal === "Cmd") return [cmd()];
  if (terminal === "PowerShell") return [pwsh(), powershell(), cmd()];
  if (terminal === "WezTerm") return [wezterm(), wt(), pwsh(), powershell(), cmd()];
  // WindowsTerminal (default): wt first, then fall back through shells.
  return [wt(), pwsh(), powershell(), cmd()];
}

function buildWindowsShellSpecificLaunchPlan(
  terminal: TerminalChoice,
  cmdCommand: string,
  powershellCommand: string,
  cwd: string,
): WindowsLaunch[] {
  const wt = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", cmdCommand];
    return { file: "wt.exe", args: cwd ? ["-d", cwd, ...inner] : inner };
  };
  const pwsh = (): WindowsLaunch => ({
    file: "pwsh.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", powershellCommand],
    cwd: cwd || undefined,
  });
  const powershell = (): WindowsLaunch => ({
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", powershellCommand],
    cwd: cwd || undefined,
  });
  const cmd = (): WindowsLaunch => ({ file: "cmd.exe", args: ["/d", "/k", cmdCommand], cwd: cwd || undefined });
  const wezterm = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", cmdCommand];
    return { file: "wezterm.exe", args: cwd ? ["start", "--cwd", cwd, "--", ...inner] : ["start", "--", ...inner] };
  };

  if (terminal === "Cmd") return [cmd()];
  if (terminal === "PowerShell") return [pwsh(), powershell(), cmd()];
  if (terminal === "WezTerm") return [wezterm(), wt(), pwsh(), powershell(), cmd()];
  return [wt(), pwsh(), powershell(), cmd()];
}

export function buildWindowsResumeLaunchPlan(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions & { terminal?: TerminalChoice } = {},
): WindowsLaunch[] {
  const platform = opts.platform ?? "win32";
  const sshArgs = resolveSshArgs(opts);
  // The launch plan wraps this string in `cmd.exe /d /k`, so it must always be
  // cmd-syntax even when the user's preferred terminal is PowerShell (that
  // variant is supplied separately as `powershellCommand`).
  const cmdCommand = getResumeCommand(session, { ...settings, defaultTerminal: "Cmd" }, {
    withCwd: Boolean(sshArgs),
    skipPermissions: opts.skipPermissions,
    platform,
    homeDir: opts.homeDir,
    sshTarget: opts.sshTarget,
    sshArgs: opts.sshArgs,
  });
  const powershellCommand = sshArgs
    ? getResumePowerShellCommand(session, settings, { ...opts, sshArgs })
    : getResumeCommand(session, { ...settings, defaultTerminal: "PowerShell" }, {
        withCwd: true,
        skipPermissions: opts.skipPermissions,
        platform,
        homeDir: opts.homeDir,
      });
  const terminal = normalizeTerminal(opts.terminal ?? settings.defaultTerminal, "win32");
  const cwd = sshArgs ? "" : existingDirectory(session.projectPath);
  if (!sshArgs) return buildWindowsLaunchPlan(terminal, cmdCommand, cwd, powershellCommand);
  return buildWindowsShellSpecificLaunchPlan(terminal, cmdCommand, powershellCommand, cwd);
}

async function openResumeInWindowsTerminal(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): Promise<void> {
  const plan = buildWindowsResumeLaunchPlan(session, settings, opts);

  let lastError: Error | null = null;
  for (const launch of plan) {
    try {
      await spawnDetached(launch.file, launch.args, launch.cwd);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (code === "ENOENT") continue; // terminal not installed; try the next candidate
      throw lastError;
    }
  }
  throw new Error(`No Windows terminal could be launched. ${lastError?.message ?? ""}`.trim());
}

function existingDirectory(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return existsSync(value) ? value : "";
  } catch {
    return "";
  }
}

function spawnDetached(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function getResumeProcessSpec(
  session: SessionSearchResult,
  settings: AppSettings = defaultSettings,
  opts: Pick<ResumeOptions, "skipPermissions" | "platform" | "homeDir" | "sshTarget" | "sshArgs"> = {},
): ResumeProcessSpec {
  const { skipPermissions = false, platform = process.platform, homeDir = homedir() } = opts;
  const sshArgs = resolveSshArgs(opts);
  const runtimePlatform = sshArgs ? "linux" : platform;
  const spec = buildResumeRuntimeProcessSpec(session, settings, skipPermissions, runtimePlatform, homeDir);

  if (sshArgs) {
    const innerCommand = buildMigrationResumeShellCommand(spec, session.projectPath ?? "", "posix", true);
    return {
      command: "ssh",
      args: [...sshArgs, innerCommand],
      cwd: undefined,
      displayCommand: getResumeCommand(session, settings, {
        withCwd: true,
        skipPermissions,
        platform,
        sshTarget: opts.sshTarget,
        sshArgs: opts.sshArgs,
      }),
    };
  }

  return {
    ...spec,
    displayCommand: getResumeCommand(session, settings, { withCwd: true, skipPermissions, platform, homeDir }),
  };
}

export function getMigrationResumeProcessSpec(
  target: MigrationTarget,
  sessionId: string,
  projectPath: string,
  settings: AppSettings = defaultSettings,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): ResumeProcessSpec {
  const platform = options.platform ?? process.platform;
  const shell = localShellKind(platform, settings);
  const env = target === "codex-internal"
    ? { CODEX_HOME: migrationCodexHome(options.homeDir ?? homedir(), platform) }
    : undefined;
  const spec = {
    command: migrationBinary(target, settings),
    args: migrationResumeArgs(target, sessionId),
    cwd: projectPath || undefined,
    env,
  };
  const commands = buildMigrationResumeCommands(spec, projectPath, true);
  const displayCommand = shell === "powershell" ? commands.powershell : shell === "cmd" ? commands.cmd : commands.posix;

  return {
    ...spec,
    displayCommand,
  };
}

export function getSafeMigrationResumeCommand(
  target: MigrationTarget,
  sessionId: string,
  projectPath: string,
  settings: AppSettings = defaultSettings,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): string {
  const platform = options.platform ?? process.platform;
  const command = migrationBinary(target, settings);
  const args = migrationResumeArgs(target, sessionId);
  const codexHome = target === "codex-internal"
    ? migrationCodexHome(options.homeDir ?? homedir(), platform)
    : null;

  if (platform !== "win32") {
    const invocation = [safePosixMigrationToken(command), ...args.map(safePosixMigrationToken)].join(" ");
    const scoped = codexHome ? `CODEX_HOME=${safePosixMigrationToken(codexHome)} ${invocation}` : invocation;
    return projectPath ? `cd ${safePosixMigrationToken(projectPath)} && ${scoped}` : scoped;
  }

  if (settings.defaultTerminal === "PowerShell") {
    const invocation = `& ${[command, ...args].map(safePowerShellMigrationToken).join(" ")}`;
    const located = projectPath ? `Set-Location -LiteralPath ${safePowerShellMigrationToken(projectPath)}; ${invocation}` : invocation;
    if (!codexHome) return located;
    return `$__assHadCodexHome = Test-Path Env:CODEX_HOME; $__assCodexHome = $env:CODEX_HOME; try { $env:CODEX_HOME = ${safePowerShellMigrationToken(codexHome)}; ${located} } finally { if ($__assHadCodexHome) { $env:CODEX_HOME = $__assCodexHome } else { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue } }`;
  }

  if ([command, ...args, projectPath, codexHome].some((value) => value != null && /[%!"\r\n&|<>^]/.test(value))) {
    const statements = ["$ErrorActionPreference = 'Stop'"];
    if (codexHome) statements.push(`$env:CODEX_HOME = ${safePowerShellMigrationToken(codexHome)}`);
    if (projectPath) statements.push(`Set-Location -LiteralPath ${safePowerShellMigrationToken(projectPath)}`);
    statements.push(`& ${[command, ...args].map(safePowerShellMigrationToken).join(" ")}`);
    const encoded = Buffer.from(statements.join("; "), "utf16le").toString("base64");
    return `setlocal DisableDelayedExpansion & powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded} & endlocal`;
  }

  const invocation = [command, ...args].map(safeCmdMigrationToken).join(" ");
  const located = projectPath ? `cd /d ${safeCmdMigrationToken(projectPath)} && ${invocation}` : invocation;
  return codexHome
    ? `setlocal & set "CODEX_HOME=${codexHome.replace(/[%!"]/g, (value) => value === "%" ? "%%" : value === "!" ? "^!" : '""')}" & ${located} & endlocal`
    : located;
}

function safePosixMigrationToken(value: string): string {
  return /^[A-Za-z0-9_\-./]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function safePowerShellMigrationToken(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function safeCmdMigrationToken(value: string): string {
  if (/^[A-Za-z0-9_\-./:\\]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

// Ghostty has no `--initial-command` option, so the previous flag was silently
// ignored and the window opened without resuming. The documented way to run a
// command is the special `-e <command>` argument; run it through the user's
// shell so the `cd … &&` chain plus PATH/aliases resolve, mirroring WezTerm.
function buildGhosttyOpenArgsForCommand(command: string): string[] {
  const shell = process.env.SHELL || "/bin/zsh";
  return ["-na", "Ghostty.app", "--args", "-e", shell, "-ic", command];
}

function buildWezTermOpenArgsForCommand(command: string, cwd?: string): string[] {
  const args = ["-na", "WezTerm.app", "--args", "start"];
  if (cwd) args.push("--cwd", cwd);
  args.push("--", process.env.SHELL || "/bin/zsh", "-ic", command);
  return args;
}

async function runWarpCommand(command: string, runner: ProcessRunner = runProcess): Promise<void> {
  await runAppleScript(`tell application "Warp"
  activate
  delay 0.2
  tell application "System Events" to keystroke "${escapeAppleScript(command)}" & return
end tell`, runner);
}

export function buildGhosttyOpenArgs(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): string[] {
  return buildGhosttyOpenArgsForCommand(getResumeCommand(session, settings, { ...opts, withCwd: true }));
}

export async function openResumeInTerminal(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions = {},
): Promise<void> {
  const sshArgs = resolveSshArgs(opts);
  const command = getResumeCommand(session, settings, { ...opts, withCwd: true });
  if (process.platform === "win32") {
    await openResumeInWindowsTerminal(session, settings, opts);
    return;
  }
  if (process.platform !== "darwin") {
    // Linux / other: best-effort POSIX shell.
    await runProcess("sh", ["-lc", command]);
    return;
  }

  if (settings.defaultTerminal === "iTerm") {
    const appName = await resolveMacApplicationName(ITERM_APPLICATION_NAMES);
    if (!appName) {
      throw new Error("iTerm is not installed or is not registered with macOS. Install iTerm2 or use Resume in Terminal.");
    }

    await runAppleScript(`set wasRunning to application "${escapeAppleScript(appName)}" is running
tell application "${escapeAppleScript(appName)}"
  activate
  if wasRunning then
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window
        create tab with default profile
      end tell
    end if
  else
    delay 0.3
  end if
  tell current session of current window
    write text "${escapeAppleScript(command)}"
  end tell
end tell`);
    return;
  }

  if (settings.defaultTerminal === "Ghostty") {
    await runProcess("/usr/bin/open", buildGhosttyOpenArgs(session, settings, opts));
    return;
  }

  if (settings.defaultTerminal === "WezTerm") {
    const args = ["-na", "WezTerm.app", "--args", "start"];
    if (!sshArgs && session.projectPath) args.push("--cwd", session.projectPath);
    args.push(
      "--",
      process.env.SHELL || "/bin/zsh",
      "-ic",
      getResumeCommand(session, settings, { ...opts, withCwd: Boolean(sshArgs) }),
    );
    await runProcess("/usr/bin/open", args);
    return;
  }

  if (settings.defaultTerminal === "Warp") {
    if (sshArgs) {
      await runWarpCommand(command);
    } else {
      await runProcess("/usr/bin/open", session.projectPath ? ["-a", "Warp", session.projectPath] : ["-a", "Warp"]);
    }
    return;
  }

  await runAppleScript(`tell application "Terminal"
  activate
  do script "${escapeAppleScript(command)}"
end tell`);
}

export async function openResumeInSpecificTerminal(
  session: SessionSearchResult,
  settings: AppSettings,
  terminal: AppSettings["defaultTerminal"],
  opts: ResumeOpenOptions = {},
): Promise<void> {
  await openResumeInTerminal(session, { ...settings, defaultTerminal: terminal }, opts);
}

async function launchWindowsPlan(plan: WindowsLaunch[], runner: typeof spawnDetached = spawnDetached): Promise<void> {
  let lastError: Error | null = null;
  for (const launch of plan) {
    try {
      await runner(launch.file, launch.args, launch.cwd);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (code === "ENOENT") continue;
      throw lastError;
    }
  }
  throw new Error(`No Windows terminal could be launched. ${lastError?.message ?? ""}`.trim());
}

async function runAppleScript(script: string, runner: ProcessRunner = runProcess): Promise<void> {
  await runner("/usr/bin/osascript", ["-e", script]);
}

async function openCommandInTerminal(
  commands: ShellCommands,
  projectPath: string,
  settings: AppSettings,
  deps: {
    platform?: NodeJS.Platform;
    runProcess?: ProcessRunner;
    spawnDetached?: typeof spawnDetached;
    resolveMacApplicationName?: typeof resolveMacApplicationName;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const run = deps.runProcess ?? runProcess;
  const spawnRunner = deps.spawnDetached ?? spawnDetached;
  const resolveAppName = deps.resolveMacApplicationName ?? resolveMacApplicationName;

  if (platform === "win32") {
    const terminal = normalizeTerminal(settings.defaultTerminal, "win32");
    const cwd = existingDirectory(projectPath);
    await launchWindowsPlan(buildWindowsLaunchPlan(terminal, commands.cmd, cwd, commands.powershell), spawnRunner);
    return;
  }

  if (platform !== "darwin") {
    await run("sh", ["-lc", commands.posix]);
    return;
  }

  if (settings.defaultTerminal === "iTerm") {
    const appName = await resolveAppName(ITERM_APPLICATION_NAMES, run);
    if (!appName) {
      throw new Error("iTerm is not installed or is not registered with macOS. Install iTerm2 or use Resume in Terminal.");
    }

    await runAppleScript(`set wasRunning to application "${escapeAppleScript(appName)}" is running
tell application "${escapeAppleScript(appName)}"
  activate
  if wasRunning then
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window
        create tab with default profile
      end tell
    end if
  else
    delay 0.3
  end if
  tell current session of current window
    write text "${escapeAppleScript(commands.posix)}"
  end tell
end tell`, run);
    return;
  }

  if (settings.defaultTerminal === "Ghostty") {
    await run("/usr/bin/open", buildGhosttyOpenArgsForCommand(commands.posix));
    return;
  }

  if (settings.defaultTerminal === "WezTerm") {
    await run("/usr/bin/open", buildWezTermOpenArgsForCommand(commands.posix, existingDirectory(projectPath) || undefined));
    return;
  }

  if (settings.defaultTerminal === "Warp") {
    await run("/usr/bin/open", existingDirectory(projectPath) ? ["-a", "Warp", existingDirectory(projectPath)] : ["-a", "Warp"]);
    return;
  }

  await runAppleScript(`tell application "Terminal"
  activate
  do script "${escapeAppleScript(commands.posix)}"
end tell`, run);
}

export async function openMigrationResumeInTerminal(
  target: MigrationTarget,
  sessionId: string,
  projectPath: string,
  settings: AppSettings,
  deps: {
    platform?: NodeJS.Platform;
    runProcess?: ProcessRunner;
    spawnDetached?: typeof spawnDetached;
    resolveMacApplicationName?: typeof resolveMacApplicationName;
  } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const { displayCommand: _displayCommand, ...spec } = getMigrationResumeProcessSpec(
    target,
    sessionId,
    projectPath,
    settings,
    { platform },
  );
  const commands = buildMigrationResumeCommands(spec, projectPath, platform !== "win32");
  const run = deps.runProcess ?? runProcess;

  if (platform === "darwin" && settings.defaultTerminal === "Warp") {
    await runWarpCommand(commands.posix, run);
    return;
  }

  await openCommandInTerminal(commands, projectPath, settings, deps);
}

export async function resolveMacApplicationName(names: string[], runner: ProcessRunner = runProcess): Promise<string | null> {
  for (const name of names) {
    try {
      await runner("/usr/bin/osascript", ["-e", `id of application "${escapeAppleScript(name)}"`]);
      return name;
    } catch {
      // Try the next commonly registered app name.
    }
  }
  return null;
}

export async function openNativeApp(source: SessionSource): Promise<void> {
  const family = sourceFamily(source);
  if (family !== "claude" && family !== "codex" && family !== "codebuddy") {
    throw new Error(`Native app opening is not configured for ${sourceDisplayName(source)} sessions yet.`);
  }
  const appName = family === "claude" ? "Claude" : family === "codebuddy" ? "CodeBuddy CN" : "Codex";
  if (process.platform === "darwin") {
    await runProcess("/usr/bin/open", ["-a", appName]);
  }
}

export interface RevealCommand {
  file: string;
  args: string[];
  // explorer.exe returns a non-zero exit code even when it succeeds, so its
  // exit status must not be treated as a failure.
  ignoreExitCode: boolean;
}

export function buildRevealCommand(targetPath: string, platform: NodeJS.Platform = process.platform): RevealCommand {
  if (platform === "darwin") return { file: "/usr/bin/open", args: ["-R", targetPath], ignoreExitCode: false };
  if (platform === "win32") {
    // `explorer.exe <path>` opens the item; `/select,<path>` reveals it inside
    // its parent folder (matching `open -R`). Explorer needs backslashes.
    const winPath = targetPath.replace(/\//g, "\\");
    return { file: "explorer.exe", args: [`/select,${winPath}`], ignoreExitCode: true };
  }
  return { file: "xdg-open", args: [targetPath], ignoreExitCode: false };
}

export async function revealInFileManager(targetPath: string): Promise<void> {
  if (!targetPath) return;
  const { file, args, ignoreExitCode } = buildRevealCommand(targetPath);
  if (ignoreExitCode) {
    await runProcessIgnoringExit(file, args);
    return;
  }
  await runProcess(file, args);
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function resolveSshArgs(opts: Pick<ResumeOptions, "sshTarget" | "sshArgs">): string[] | undefined {
  if (opts.sshArgs) return opts.sshArgs;
  if (opts.sshTarget) return ["--", opts.sshTarget];
  return undefined;
}

function formatSshDisplayCommand(sshArgs: string[], innerCommand: string, platform: NodeJS.Platform): string {
  const quoteArg = platform === "win32" ? winSshArgQuote : shellQuote;
  return ["ssh", ...sshArgs.map(quoteArg), quoteArg(innerCommand)].join(" ");
}

function getResumePowerShellCommand(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions & { sshArgs: string[] },
): string {
  const innerCommand = buildResumeShellCommand(session, settings, {
    withCwd: true,
    skipPermissions: opts.skipPermissions ?? false,
    shell: "posix",
    platform: "linux",
    homeDir: opts.homeDir,
  });
  return formatPowershellSshDisplay(opts.sshArgs, innerCommand);
}

function powershellSshArgQuote(s: string): string {
  if (s === "--" || /^-[A-Za-z0-9-]+$/.test(s) || /^\d+$/.test(s)) return s;
  return powershellQuote(s);
}

function powershellQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function winSshArgQuote(s: string): string {
  if (s === "--" || /^-[A-Za-z0-9-]+$/.test(s)) return s;
  return winSshQuote(s);
}

function winQuote(s: string): string {
  // cmd.exe quoting: wrap in double quotes, double any embedded quotes.
  return `"${s.replace(/"/g, '""')}"`;
}

function winSshQuote(s: string): string {
  // This display command is fed to cmd.exe by WindowsTerminal/Cmd launch paths;
  // caret escaping keeps cmd from expanding local variables or treating separators as syntax.
  return `"${s.replace(/"/g, '""').replace(/[\^%&|<>]/g, (ch) => `^${ch}`)}"`;
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (!error) return resolve();
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}

// Spawns a process whose non-zero exit code is expected (e.g. explorer.exe),
// only rejecting when the binary itself cannot be launched.
function runProcessIgnoringExit(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => resolve());
  });
}

type CliVersionRunner = (command: string, args: string[], env?: Record<string, string>) => Promise<string>;

// `ResumeProcessSpec.env` and version-runner env values are override maps, not
// complete process environments. Keep the merge at the child execution edge.
export function mergeProcessEnvOverrides(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...(overrides ?? {}) };
}

function runCliVersion(command: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: mergeProcessEnvOverrides(env) }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      reject(Object.assign(failure, { stdout, stderr }));
    });
  });
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

export async function inspectMigrationCli(
  target: MigrationTarget,
  settings: AppSettings,
  runner: CliVersionRunner = runCliVersion,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const binary = migrationBinary(target, settings);
  if (target === "cursor") {
    try {
      await runner(binary, ["--version"]);
    } catch (error) {
      throw new Error(migrationCliVersionErrorMessage(target, binary, error));
    }
    return;
  }
  const platform = options.platform ?? process.platform;
  const env = target === "codex-internal"
    ? { CODEX_HOME: migrationCodexHome(options.homeDir ?? homedir(), platform) }
    : undefined;
  let versionOutput: string;
  try {
    versionOutput = await runner(binary, ["--version"], env);
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
