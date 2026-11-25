import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isCodexSqliteSession } from "../session-environment";
import { resolveCodexSqliteRolloutPath } from "../session-loaders/codex-sqlite-history";
import { sessionSourceDescriptor } from "../session-sources";
import { type TerminalChoice, normalizeTerminal } from "../terminal-options";
import {
  windowsTerminalTitleArgs,
  withCmdTerminalTitle,
  withPowerShellTerminalTitle,
} from "../terminal-title";
import type { MigrationTarget, SessionSearchResult, SessionSource } from "../types";
import { defaultSettings, type AppSettings } from "./app-settings";
import {
  migrationBinary,
  migrationResumeArgs,
  zcodeMigrationResumeHint,
} from "./migration-cli-probe";
import {
  buildShellCommand,
  existingDirectory,
  formatPowershellSshDisplay,
  formatPowershellWslDisplay,
  formatSshDisplayCommand,
  formatWslDisplayCommand,
  powershellQuote,
  remoteInteractiveCommand,
  shellTokenQuote,
  withWslShellProfile,
  type ShellCommands,
  type ShellKind,
} from "./shell-quoting";

export interface ResumeProcessSpec {
  command: string;
  args: string[];
  cwd?: string;
  displayCommand: string;
}

export interface ResumeOptions {
  withCwd?: boolean;
  skipPermissions?: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
  sshTarget?: string;
  sshArgs?: string[];
  wslDistribution?: string;
}

export type ResumeOpenOptions = Pick<ResumeOptions, "skipPermissions" | "platform" | "homeDir" | "sshTarget" | "sshArgs" | "wslDistribution">;

export interface WindowsLaunch {
  file: string;
  args: string[];
  cwd?: string;
}

function sourceDisplayName(source: SessionSource): string {
  return sessionSourceDescriptor(source).label;
}

function migrationTargetForResumeSource(source: SessionSource): MigrationTarget | null {
  return sessionSourceDescriptor(source).resumeTarget;
}

function legacyMigratedCodexProvider(session: SessionSearchResult, target: MigrationTarget): string | null {
  if (target !== "codex" && target !== "tcodex") return null;
  let descriptor: number | null = null;
  try {
    const sourcePath = isCodexSqliteSession(session)
      ? resolveCodexSqliteRolloutPath(session.filePath, session.rawId) : session.filePath;
    if (!sourcePath) return null;
    descriptor = openSync(sourcePath, "r");
    const prefix = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = readSync(descriptor, prefix, 0, prefix.length, 0);
    const firstLine = prefix.toString("utf8", 0, bytesRead).split(/\r?\n/, 1)[0];
    const row = JSON.parse(firstLine) as {
      type?: unknown;
      payload?: { originator?: unknown; cli_version?: unknown; model_provider?: unknown };
    };
    if (
      row.type !== "session_meta"
      || row.payload?.originator !== "agent-session-search"
      || row.payload?.cli_version !== "migration"
      || (typeof row.payload?.model_provider === "string" && row.payload.model_provider.trim())
    ) {
      return null;
    }
    if (target === "tcodex") return "tencent";
    return "openai";
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function buildResumeRuntimeProcessSpec(
  session: SessionSearchResult,
  settings: AppSettings,
  skipPermissions: boolean,
  useRemoteBinary = false,
): Omit<ResumeProcessSpec, "displayCommand"> {
  if (session.source === "antigravity-cli") {
    const args = ["--resume", session.rawId];
    if (skipPermissions) args.push("--dangerously-skip-permissions");
    return {
      command: useRemoteBinary
        ? "agy"
        : settings.antigravityCliBinary?.trim() || defaultSettings.antigravityCliBinary,
      args,
      cwd: session.projectPath || undefined,
    };
  }

  const target = migrationTargetForResumeSource(session.source);
  if (!target) {
    throw new Error(`Resume is not supported for ${sourceDisplayName(session.source)} sessions yet.`);
  }

  const stepcodeAgent = session.source === "stepcode-codex"
    ? "codex"
    : session.source === "stepcode-claude"
      ? "claude"
      : null;
  const args = stepcodeAgent
    ? [stepcodeAgent, ...migrationResumeArgs(target, session.rawId)]
    : migrationResumeArgs(target, session.rawId);
  const legacyProvider = legacyMigratedCodexProvider(session, target);
  if (legacyProvider) args.splice(1, 0, "-c", `model_provider=${JSON.stringify(legacyProvider)}`);
  if (skipPermissions) {
    if (target === "claude" || target === "tclaude") {
      args.push("--dangerously-skip-permissions");
    } else if (target === "codex" || target === "tcodex") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
  }

  // Local absolute CLI settings do not describe the SSH host. Interactive SSH
  // resolves these stable command names through the remote user's own shell.
  return {
    command: useRemoteBinary && !stepcodeAgent && ["claude", "codex", "tclaude", "tcodex", "codebuddy"].includes(target)
      ? target
      : stepcodeAgent
        ? settings.stepcodeBinary
        : migrationBinary(target, settings),
    args,
    cwd: session.projectPath || undefined,
  };
}

export function localShellKind(platform: NodeJS.Platform, settings: AppSettings): ShellKind {
  if (platform !== "win32") return "posix";
  return normalizeTerminal(settings.defaultTerminal, "win32") === "PowerShell" ? "powershell" : "cmd";
}

export function resolveSshArgs(opts: Pick<ResumeOptions, "sshTarget" | "sshArgs">): string[] | undefined {
  if (opts.sshArgs) return opts.sshArgs;
  if (opts.sshTarget) return ["--", opts.sshTarget];
  return undefined;
}

export function resolveWslDistribution(opts: Pick<ResumeOptions, "wslDistribution">): string | undefined {
  const value = opts.wslDistribution?.trim();
  return value || undefined;
}

function requiresEncodedCmdCommand(
  spec: Omit<ResumeProcessSpec, "displayCommand">,
  projectPath: string,
  withCwd: boolean,
): boolean {
  const values = [spec.command, ...spec.args, withCwd ? projectPath : undefined];
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
  if (withCwd && projectPath) {
    statements.push(`Set-Location -LiteralPath ${powershellQuote(projectPath)}`);
  }
  statements.push(`& ${[spec.command, ...spec.args].map((token) => shellTokenQuote(token, "powershell")).join(" ")}`);
  const script = statements.join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `setlocal DisableDelayedExpansion & powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded} & endlocal`;
}

function buildMigrationResumeShellCommand(
  spec: Omit<ResumeProcessSpec, "displayCommand">,
  projectPath: string,
  shell: ShellKind,
  withCwd = true,
): string {
  if (shell === "cmd" && requiresEncodedCmdCommand(spec, projectPath, withCwd)) {
    return buildEncodedCmdCommand(spec, projectPath, withCwd);
  }
  return buildShellCommand(spec.command, spec.args, projectPath, { shell, withCwd });
}

function buildResumeShellCommand(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: Required<Pick<ResumeOptions, "withCwd" | "skipPermissions" | "platform">> & {
    shell: ShellKind;
    homeDir?: string;
    useRemoteBinary?: boolean;
  },
): string {
  const spec = buildResumeRuntimeProcessSpec(session, settings, opts.skipPermissions, opts.useRemoteBinary);
  return buildMigrationResumeShellCommand(spec, session.projectPath ?? "", opts.shell, opts.withCwd);
}

export function buildMigrationResumeCommands(
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
  const { withCwd = true, skipPermissions = false, platform = process.platform } = opts;
  const sshArgs = resolveSshArgs(opts);
  const wslDistribution = resolveWslDistribution(opts);
  const shell = localShellKind(platform, settings);
  if (wslDistribution) {
    const spec = buildResumeRuntimeProcessSpec(session, settings, skipPermissions, true);
    const innerCommand = withWslShellProfile(buildMigrationResumeShellCommand(spec, session.projectPath ?? "", "posix", withCwd));
    return shell === "powershell"
      ? formatPowershellWslDisplay(wslDistribution, innerCommand)
      : formatWslDisplayCommand(wslDistribution, innerCommand, platform);
  }
  const spec = buildResumeRuntimeProcessSpec(session, settings, skipPermissions, Boolean(sshArgs));
  if (sshArgs) {
    // The remote command body always targets a POSIX shell; only the outer ssh
    // invocation is quoted for the local terminal (cmd carets vs PowerShell).
    const innerCommand = buildMigrationResumeShellCommand(spec, session.projectPath ?? "", "posix", withCwd);
    const remoteCommand = remoteInteractiveCommand(sshArgs, innerCommand);
    if (shell === "powershell") return formatPowershellSshDisplay(sshArgs, remoteCommand);
    return formatSshDisplayCommand(sshArgs, remoteCommand, platform);
  }
  return buildMigrationResumeShellCommand(spec, session.projectPath ?? "", shell, withCwd);
}

// Ordered candidate launches. The caller tries each until one spawns (ENOENT -> next).
export function buildWindowsLaunchPlan(
  terminal: TerminalChoice,
  cmdCommand: string,
  cwd: string,
  powershellCommand?: string,
  title?: string,
): WindowsLaunch[] {
  const titleArgs = title ? windowsTerminalTitleArgs(title) : [];
  const titledCmdCommand = title ? withCmdTerminalTitle(cmdCommand, title) : cmdCommand;
  const basePowerShellCommand = powershellCommand ?? cmdCommand;
  const titledPowerShellCommand = title
    ? withPowerShellTerminalTitle(basePowerShellCommand, title)
    : basePowerShellCommand;
  const wt = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", titledCmdCommand];
    return { file: "wt.exe", args: cwd ? ["-d", cwd, ...titleArgs, ...inner] : [...titleArgs, ...inner] };
  };
  const pwsh = (): WindowsLaunch => ({
    file: "pwsh.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", titledPowerShellCommand],
    cwd: cwd || undefined,
  });
  const powershell = (): WindowsLaunch => ({
    file: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", titledPowerShellCommand],
    cwd: cwd || undefined,
  });
  const cmd = (): WindowsLaunch => ({ file: "cmd.exe", args: ["/d", "/k", titledCmdCommand], cwd: cwd || undefined });
  const wezterm = (): WindowsLaunch => {
    const inner = ["cmd.exe", "/d", "/k", titledCmdCommand];
    return { file: "wezterm.exe", args: cwd ? ["start", "--cwd", cwd, "--", ...inner] : ["start", "--", ...inner] };
  };

  if (terminal === "Cmd") return [cmd()];
  if (terminal === "PowerShell") return [pwsh(), powershell(), cmd()];
  if (terminal === "WezTerm") return [wezterm(), wt(), pwsh(), powershell(), cmd()];
  // WindowsTerminal (default): wt first, then fall back through shells.
  return [wt(), pwsh(), powershell(), cmd()];
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
    useRemoteBinary: true,
  });
  return formatPowershellSshDisplay(opts.sshArgs, remoteInteractiveCommand(opts.sshArgs, innerCommand));
}

function getResumeWslPowerShellCommand(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions & { wslDistribution: string },
): string {
  const innerCommand = withWslShellProfile(buildResumeShellCommand(session, settings, {
    withCwd: true,
    skipPermissions: opts.skipPermissions ?? false,
    shell: "posix",
    platform: "linux",
    homeDir: opts.homeDir,
    useRemoteBinary: true,
  }));
  return formatPowershellWslDisplay(opts.wslDistribution, innerCommand);
}

function buildWindowsWslResumeLaunchPlan(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions & { terminal?: TerminalChoice },
  platform: NodeJS.Platform,
  wslDistribution: string,
): WindowsLaunch[] {
  const cmdCommand = getResumeCommand(session, { ...settings, defaultTerminal: "Cmd" }, {
    withCwd: true,
    skipPermissions: opts.skipPermissions,
    platform,
    homeDir: opts.homeDir,
    wslDistribution,
  });
  const powershellCommand = getResumeWslPowerShellCommand(session, settings, { ...opts, wslDistribution });
  const terminal = normalizeTerminal(opts.terminal ?? settings.defaultTerminal, "win32");
  return buildWindowsLaunchPlan(
    terminal,
    cmdCommand,
    "",
    powershellCommand,
    session.displayTitle || undefined,
  );
}

export function buildWindowsResumeLaunchPlan(
  session: SessionSearchResult,
  settings: AppSettings,
  opts: ResumeOpenOptions & { terminal?: TerminalChoice } = {},
): WindowsLaunch[] {
  const platform = opts.platform ?? "win32";
  const wslDistribution = resolveWslDistribution(opts);
  if (wslDistribution) return buildWindowsWslResumeLaunchPlan(session, settings, opts, platform, wslDistribution);
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
  const title = session.displayTitle || undefined;
  return buildWindowsLaunchPlan(terminal, cmdCommand, cwd, powershellCommand, title);
}

export function getResumeProcessSpec(
  session: SessionSearchResult,
  settings: AppSettings = defaultSettings,
  opts: Pick<ResumeOptions, "skipPermissions" | "platform" | "homeDir" | "sshTarget" | "sshArgs" | "wslDistribution"> = {},
): ResumeProcessSpec {
  const { skipPermissions = false, platform = process.platform, homeDir = homedir() } = opts;
  const sshArgs = resolveSshArgs(opts);
  const wslDistribution = resolveWslDistribution(opts);
  if (wslDistribution) {
    const spec = buildResumeRuntimeProcessSpec(session, settings, skipPermissions, true);
    const innerCommand = withWslShellProfile(buildMigrationResumeShellCommand(spec, session.projectPath ?? "", "posix", true));
    return {
      command: "wsl.exe",
      args: ["--distribution", wslDistribution, "--exec", "bash", "-lc", innerCommand],
      cwd: undefined,
      displayCommand: getResumeCommand(session, settings, {
        withCwd: true,
        skipPermissions,
        platform,
        wslDistribution,
      }),
    };
  }
  const spec = buildResumeRuntimeProcessSpec(session, settings, skipPermissions, Boolean(sshArgs));

  if (sshArgs) {
    const innerCommand = buildMigrationResumeShellCommand(spec, session.projectPath ?? "", "posix", true);
    const remoteCommand = remoteInteractiveCommand(sshArgs, innerCommand);
    return {
      command: "ssh",
      args: [...sshArgs, remoteCommand],
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
  if (target === "zcode") {
    return {
      command: "zcode",
      args: [],
      cwd: projectPath || undefined,
      displayCommand: zcodeMigrationResumeHint(sessionId),
    };
  }
  const platform = options.platform ?? process.platform;
  const shell = localShellKind(platform, settings);
  const spec = {
    command: migrationBinary(target, settings),
    args: migrationResumeArgs(target, sessionId),
    cwd: projectPath || undefined,
  };
  const commands = buildMigrationResumeCommands(spec, projectPath, true);
  const displayCommand = shell === "powershell" ? commands.powershell : shell === "cmd" ? commands.cmd : commands.posix;

  return {
    ...spec,
    displayCommand,
  };
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

export function getSafeMigrationResumeCommand(
  target: MigrationTarget,
  sessionId: string,
  projectPath: string,
  settings: AppSettings = defaultSettings,
  options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): string {
  if (target === "zcode") return zcodeMigrationResumeHint(sessionId);
  const platform = options.platform ?? process.platform;
  const command = migrationBinary(target, settings);
  const args = migrationResumeArgs(target, sessionId);

  if (platform !== "win32") {
    const invocation = [safePosixMigrationToken(command), ...args.map(safePosixMigrationToken)].join(" ");
    return projectPath ? `cd ${safePosixMigrationToken(projectPath)} && ${invocation}` : invocation;
  }

  if (settings.defaultTerminal === "PowerShell") {
    const invocation = `& ${[command, ...args].map(safePowerShellMigrationToken).join(" ")}`;
    return projectPath ? `Set-Location -LiteralPath ${safePowerShellMigrationToken(projectPath)}; ${invocation}` : invocation;
  }

  if ([command, ...args, projectPath].some((value) => value != null && /[%!"\r\n&|<>^]/.test(value))) {
    const statements = ["$ErrorActionPreference = 'Stop'"];
    if (projectPath) statements.push(`Set-Location -LiteralPath ${safePowerShellMigrationToken(projectPath)}`);
    statements.push(`& ${[command, ...args].map(safePowerShellMigrationToken).join(" ")}`);
    const encoded = Buffer.from(statements.join("; "), "utf16le").toString("base64");
    return `setlocal DisableDelayedExpansion & powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded} & endlocal`;
  }

  const invocation = [command, ...args].map(safeCmdMigrationToken).join(" ");
  return projectPath ? `cd /d ${safeCmdMigrationToken(projectPath)} && ${invocation}` : invocation;
}
