import { execFile, type ExecFileOptions } from "node:child_process";
import { runRemoteCommand } from "./remote-process";
import { buildRemoteSyncSshArgs, formatRemoteSyncProcessError } from "./remote-sync";
import type { SessionEnvironment, SessionSearchResult, SessionSource } from "./types";
import { sessionSourceDescriptor } from "./session-sources";

export type RemoteHealthStatus = "ok" | "warning" | "error";
export type RemoteHealthCategory = "connection" | "runtime" | "cli" | "directory" | "permission" | "session";

export interface RemoteHealthCheck {
  id: string;
  label: string;
  status: RemoteHealthStatus;
  message: string;
  detail?: string;
  category?: RemoteHealthCategory;
  /** A safe, user-facing next step. It is deliberately not an auto-fix. */
  suggestion?: string;
  /** Only populated when the remote package manager was detected safely. */
  repairCommand?: string;
}

export interface RemoteHealthReport {
  ok: boolean;
  summary: string;
  checkedAt: number;
  checks: RemoteHealthCheck[];
}

export interface RemoteHealthOptions {
  runSsh?: (environment: SessionEnvironment, remoteCommand: string) => Promise<string>;
}

const REMOTE_HEALTH_EXEC_OPTIONS = {
  maxBuffer: 512 * 1024,
  timeout: 20_000,
} satisfies ExecFileOptions;

export async function diagnoseRemoteEnvironment(
  environment: SessionEnvironment,
  options: RemoteHealthOptions = {},
): Promise<RemoteHealthReport> {
  if (environment.kind === "wsl") return diagnoseWslEnvironment(environment, options);
  const runSsh = options.runSsh ?? runHealthSsh;
  try {
    const output = await runSsh(environment, buildRemoteHealthCommand());
    const payload = parseHealthPayload(output);
    const checks = buildHealthChecks(payload, "SSH");
    return buildReport(checks);
  } catch (error) {
    return buildReport([
      {
        id: "connectivity",
        label: "SSH connection",
        status: "error",
        message: errorMessage(error),
      },
    ]);
  }
}

async function diagnoseWslEnvironment(
  environment: SessionEnvironment,
  options: RemoteHealthOptions,
): Promise<RemoteHealthReport> {
  const runWsl = options.runSsh ?? runHealthRemote;
  try {
    const output = await runWsl(environment, buildRemoteHealthCommand());
    const payload = parseHealthPayload(output);
    return buildReport(buildHealthChecks(payload, "WSL"));
  } catch (error) {
    return buildReport([{
      id: "connectivity",
      label: "WSL connection",
      status: "error",
      message: errorMessage(error),
    }]);
  }
}

export async function preflightRemoteSessionResume(
  environment: SessionEnvironment,
  session: SessionSearchResult,
  options: RemoteHealthOptions = {},
): Promise<RemoteHealthReport> {
  const runSsh = options.runSsh ?? (environment.kind === "wsl" ? runHealthRemote : runHealthSsh);
  try {
    const output = await runSsh(environment, buildRemoteResumePreflightCommand(session));
    const payload = parseResumePreflightPayload(output);
    const cli = resumeCliForSource(session.source);
    const checks: RemoteHealthCheck[] = [
      sessionFileCheck(payload.fileExists, payload.fileReadable),
      {
        id: "project-path",
        label: "Project path",
        status: payload.projectExists ? "ok" : "warning",
        message: payload.projectExists ? "Remote project path exists." : "Remote project path was not found; resume will start without a verified project directory.",
      },
      cliCheck("resume-cli", `${cli} CLI`, payload.cliPath),
    ];
    return buildReport(checks);
  } catch (error) {
    return buildReport([
      {
        id: "connectivity",
        label: environment.kind === "wsl" ? "WSL connection" : "SSH connection",
        status: "error",
        message: errorMessage(error),
      },
    ]);
  }
}

function buildHealthChecks(payload: Record<string, unknown>, connectionLabel: "SSH" | "WSL"): RemoteHealthCheck[] {
  if (payload.pythonUnavailable === true) {
    return [
      { id: "connectivity", label: `${connectionLabel} connection`, status: "ok", message: `Connected as ${payload.user || "remote user"}.`, category: "connection" },
      runtimePathCheck("bash", "bash", payload.bashAvailable === true ? "available" : null, true),
      runtimePathCheck("python3", "python3", null, true),
      {
        id: "dependent-checks",
        label: "Session prerequisites",
        status: "warning",
        message: "Session, CLI, and permission checks were skipped because python3 is unavailable.",
        category: "runtime",
        suggestion: "Install python3 in this environment, then run diagnosis again.",
      },
    ];
  }
  const checks: RemoteHealthCheck[] = [
    { id: "connectivity", label: `${connectionLabel} connection`, status: "ok", message: `Connected as ${payload.user || "remote user"}.`, category: "connection" },
    cliCheck("codex-cli", "Codex CLI", payload.codexCli, payload.packageManager, "codex"),
    cliCheck("claude-cli", "Claude CLI", payload.claudeCli, payload.packageManager, "claude"),
    directoryCheck("codex-sessions", "Codex sessions", payload.codexSessionsExists, payload.codexSessionsReadable, payload.codexSessionsWritable),
    directoryCheck("claude-projects", "Claude projects", payload.claudeProjectsExists, payload.claudeProjectsReadable, payload.claudeProjectsWritable),
    cliCheck("tclaude-cli", "TClaude CLI", payload.tclaudeCli, payload.packageManager, "tclaude"),
    cliCheck("tcodex-cli", "TCodex CLI", payload.tcodexCli, payload.packageManager, "tcodex"),
    cliCheck("codebuddy-cli", "CodeBuddy CLI", payload.codebuddyCli, payload.packageManager, "codebuddy"),
    directoryCheck("tclaude-projects", "TClaude projects", payload.tclaudeProjectsExists, payload.tclaudeProjectsReadable, payload.tclaudeProjectsWritable),
    directoryCheck("tcodex-sessions", "TCodex sessions", payload.tcodexSessionsExists, payload.tcodexSessionsReadable, payload.tcodexSessionsWritable),
    directoryCheck("codebuddy-projects", "CodeBuddy projects", payload.codebuddyProjectsExists, payload.codebuddyProjectsReadable, payload.codebuddyProjectsWritable),
  ];
  // Keep compatibility with old mocked health payloads while making the real
  // command report all runtime prerequisites and permissions.
  if (Object.hasOwn(payload, "bashPath")) {
    checks.splice(1, 0,
      runtimePathCheck("bash", "bash", payload.bashPath, true),
      runtimePathCheck("python3", "python3", payload.pythonPath, true),
    );
  }
  if (Object.hasOwn(payload, "inotifyPath")) {
    checks.push(runtimePathCheck("inotifywait", "inotifywait", payload.inotifyPath, false, payload.packageManager, "inotify-tools"));
    checks.push(runtimePathCheck("fswatch", "fswatch", payload.fswatchPath, false, payload.packageManager, "fswatch"));
    checks.push(permissionCheck("home", "HOME", payload.homeWritable));
    checks.push({
      id: "default-user",
      label: "Default user",
      status: typeof payload.user === "string" && payload.user ? "ok" : "warning",
      message: typeof payload.user === "string" && payload.user ? `Running as ${payload.user}.` : "The remote user could not be identified.",
      category: "runtime",
      suggestion: "Check the distribution's default user and HOME environment before resuming sessions.",
    });
  }
  if (Object.hasOwn(payload, "codewizDbExists")) {
    checks.push(cliCheck("opencode-cli", "OpenCode CLI", payload.opencodeCli, payload.packageManager, "opencode"));
    checks.push(cliCheck("qoder-cli", "Qoder CLI", payload.qoderCli, payload.packageManager, "qoder"));
    checks.push(directoryCheck("codewiz-database", "CodeWiz database", payload.codewizDbExists, payload.codewizDbReadable, payload.codewizDbWritable));
    checks.push(directoryCheck("opencode-database", "OpenCode database", payload.opencodeDbExists, payload.opencodeDbReadable, payload.opencodeDbWritable));
    checks.push(directoryCheck("qoder-projects", "Qoder projects", payload.qoderProjectsExists, payload.qoderProjectsReadable, payload.qoderProjectsWritable));
  }
  return checks;
}

function cliCheck(id: string, label: string, path: unknown, packageManager?: unknown, packageName?: string): RemoteHealthCheck {
  if (typeof path === "string" && path) {
    return { id, label, status: "ok", message: `${label} found.`, detail: path, category: "cli" };
  }
  return {
    id, label, status: "warning", message: `${label} was not found on PATH.`, category: "cli",
    suggestion: `Install ${label} inside this environment, then run diagnosis again.`,
    ...(packageName ? packageRepair(packageManager, packageName) : {}),
  };
}

function directoryCheck(id: string, label: string, exists: unknown, readable: unknown, writable?: unknown): RemoteHealthCheck {
  if (exists && readable && (writable === undefined || writable)) {
    return { id, label, status: "ok", message: `${label} directory is readable${writable === undefined ? "" : " and writable"}.`, category: "directory" };
  }
  if (exists && !readable) return { id, label, status: "error", message: `${label} directory exists but is not readable.`, category: "permission", suggestion: `Check read permissions for the ${label.toLowerCase()} directory.` };
  if (exists) return { id, label, status: "error", message: `${label} directory is not writable.`, category: "permission", suggestion: `Check ownership and write permissions for the ${label.toLowerCase()} directory.` };
  return { id, label, status: "warning", message: `${label} directory was not found.`, category: "directory", suggestion: `Start the matching CLI once in this environment so its session directory is created.` };
}

function runtimePathCheck(id: string, label: string, value: unknown, required: boolean, packageManager?: unknown, packageName?: string): RemoteHealthCheck {
  if (typeof value === "string" && value) return { id, label, status: "ok", message: `${label} is available.`, detail: value, category: "runtime" };
  return {
    id, label, status: required ? "error" : "warning", message: `${label} is not available in the remote environment.`, category: "runtime",
    suggestion: required ? `Install or enable ${label} before retrying WSL session operations.` : `Install ${label} to use event-based WSL watching; polling will remain available.`,
    ...(packageName ? packageRepair(packageManager, packageName) : {}),
  };
}

function permissionCheck(id: string, label: string, writable: unknown): RemoteHealthCheck {
  if (writable === true) return { id, label, status: "ok", message: `${label} is writable.`, category: "permission" };
  return { id, label, status: "error", message: `${label} is not writable.`, category: "permission", suggestion: `Check the owner and write permissions for ${label}.` };
}

function packageRepair(packageManager: unknown, packageName: string): Pick<RemoteHealthCheck, "repairCommand"> {
  if (packageManager === "apt-get") return { repairCommand: `sudo apt-get install ${packageName}` };
  if (packageManager === "dnf") return { repairCommand: `sudo dnf install ${packageName}` };
  if (packageManager === "apk") return { repairCommand: `sudo apk add ${packageName}` };
  if (packageManager === "pacman") return { repairCommand: `sudo pacman -S ${packageName}` };
  return {};
}

function sessionFileCheck(exists: unknown, readable: unknown): RemoteHealthCheck {
  if (exists && readable) return { id: "session-file", label: "Session file", status: "ok", message: "Remote session file is readable.", category: "session" };
  if (exists) return { id: "session-file", label: "Session file", status: "error", message: "Remote session file exists but is not readable.", category: "permission", suggestion: "Check read permissions for the session file." };
  return { id: "session-file", label: "Session file", status: "error", message: "Remote session file was not found.", category: "session", suggestion: "Refresh the environment and verify that the source CLI still owns this session." };
}

function buildReport(checks: RemoteHealthCheck[]): RemoteHealthReport {
  const okCount = checks.filter((check) => check.status === "ok").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;
  const errorCount = checks.filter((check) => check.status === "error").length;
  const suffix = [
    warningCount ? `${warningCount} warning${warningCount === 1 ? "" : "s"}` : null,
    errorCount ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => Boolean(part));
  return {
    ok: errorCount === 0,
    summary: `${okCount}/${checks.length} checks passed${suffix.length ? `, ${suffix.join(", ")}` : ""}`,
    checkedAt: Date.now(),
    checks,
  };
}

export function resumeCliForSource(source: SessionSource): "codex" | "claude" | "tclaude" | "tcodex" | "codebuddy" | "codewiz" {
  const family = sessionSourceDescriptor(source).family;
  if (family === "tclaude" || family === "tcodex" || family === "codebuddy" || family === "codewiz") return family;
  if (family === "claude") return "claude";
  return "codex";
}

function buildRemoteHealthCommand(): string {
  const script = String.raw`import json, os, shutil
from pathlib import Path

home = Path.home()

def readable(path):
  try:
    return path.exists() and os.access(path, os.R_OK)
  except Exception:
    return False

def writable(path):
  try:
    return path.exists() and os.access(path, os.W_OK)
  except Exception:
    return False

def find_package_manager():
  for candidate in ("apt-get", "dnf", "apk", "pacman"):
    found = shutil.which(candidate)
    if found:
      return candidate
  return None

codex_sessions = home / ".codex" / "sessions"
claude_projects = home / ".claude" / "projects"
tclaude_projects = home / ".tclaude" / "projects"
tcodex_sessions = home / ".tcodex" / "sessions"
codebuddy_projects = home / ".codebuddy" / "projects"
codewiz_db = home / ".local" / "share" / "codewiz" / "opencode.db"
opencode_db = home / ".local" / "share" / "opencode" / "opencode.db"
qoder_projects = home / ".qoder" / "cache" / "projects"
print(json.dumps({
  "ok": True,
  "home": str(home),
  "user": os.environ.get("USER") or os.environ.get("USERNAME") or "",
  "bashPath": shutil.which("bash") or shutil.which("sh"),
  "pythonPath": shutil.which("python3") or shutil.which("python"),
  "inotifyPath": shutil.which("inotifywait"),
  "fswatchPath": shutil.which("fswatch"),
  "packageManager": find_package_manager(),
  "homeWritable": writable(home),
  "codexCli": shutil.which("codex"),
  "claudeCli": shutil.which("claude"),
  "tclaudeCli": shutil.which("tclaude"),
  "tcodexCli": shutil.which("tcodex"),
  "codebuddyCli": shutil.which("codebuddy"),
  "opencodeCli": shutil.which("opencode"),
  "qoderCli": shutil.which("qoder"),
  "codexSessionsExists": codex_sessions.exists(),
  "codexSessionsReadable": readable(codex_sessions),
  "codexSessionsWritable": writable(codex_sessions),
  "claudeProjectsExists": claude_projects.exists(),
  "claudeProjectsReadable": readable(claude_projects),
  "claudeProjectsWritable": writable(claude_projects),
  "tclaudeProjectsExists": tclaude_projects.exists(),
  "tclaudeProjectsReadable": readable(tclaude_projects),
  "tclaudeProjectsWritable": writable(tclaude_projects),
  "tcodexSessionsExists": tcodex_sessions.exists(),
  "tcodexSessionsReadable": readable(tcodex_sessions),
  "tcodexSessionsWritable": writable(tcodex_sessions),
  "codebuddyProjectsExists": codebuddy_projects.exists(),
  "codebuddyProjectsReadable": readable(codebuddy_projects),
  "codebuddyProjectsWritable": writable(codebuddy_projects),
  "codewizDbExists": codewiz_db.exists(),
  "codewizDbReadable": readable(codewiz_db),
  "codewizDbWritable": writable(codewiz_db.parent),
  "opencodeDbExists": opencode_db.exists(),
  "opencodeDbReadable": readable(opencode_db),
  "opencodeDbWritable": writable(opencode_db.parent),
  "qoderProjectsExists": qoder_projects.exists(),
  "qoderProjectsReadable": readable(qoder_projects),
  "qoderProjectsWritable": writable(qoder_projects),
}, ensure_ascii=False))`;
  return buildPythonBase64Command(script, `printf '%s\\n' '{"ok":false,"pythonUnavailable":true,"bashAvailable":true}'`);
}

function buildRemoteResumePreflightCommand(session: SessionSearchResult): string {
  const script = String.raw`import base64, json, os, shutil
from pathlib import Path

session_file = Path(base64.b64decode("__FILE_B64__").decode("utf-8"))
project = Path(base64.b64decode("__PROJECT_B64__").decode("utf-8")) if "__PROJECT_B64__" else None
cli = "__CLI__"

def readable(path):
  try:
    return path.exists() and os.access(path, os.R_OK)
  except Exception:
    return False

print(json.dumps({
  "ok": True,
  "fileExists": session_file.exists(),
  "fileReadable": readable(session_file),
  "projectExists": bool(project and project.exists() and project.is_dir()),
  "cliPath": shutil.which(cli),
}, ensure_ascii=False))`
    .replace("__FILE_B64__", Buffer.from(session.filePath, "utf-8").toString("base64"))
    .replaceAll("__PROJECT_B64__", session.projectPath ? Buffer.from(session.projectPath, "utf-8").toString("base64") : "")
    .replace("__CLI__", resumeCliForSource(session.source));
  return buildPythonBase64Command(script);
}

function buildPythonBase64Command(script: string, fallbackCommand?: string): string {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const compressed = zlib.deflateRawSync(Buffer.from(script, "utf-8"));
  const encoded = compressed.toString("base64");
  const pythonCommand = `python3 -c 'import base64,zlib; exec(zlib.decompress(base64.b64decode("${encoded}"), -15).decode("utf-8"))'`;
  const pythonFallback = pythonCommand.replace(/^python3\b/u, "python");
  const fallback = fallbackCommand ?? "exit 127";
  const shellCommand = `if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; if command -v python3 >/dev/null 2>&1; then ${pythonCommand}; elif command -v python >/dev/null 2>&1; then ${pythonFallback}; else ${fallback}; fi`;
  return `bash -lc ${posixShellQuote(shellCommand)}`;
}

function posixShellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseHealthPayload(output: string): Record<string, unknown> {
  return parseJsonRecord(output, "remote health check");
}

function parseResumePreflightPayload(output: string): Record<string, unknown> {
  return parseJsonRecord(output, "remote resume preflight");
}

function parseJsonRecord(output: string, label: string): Record<string, unknown> {
  const trimmed = output.trim();
  if (!trimmed) throw new Error(`${label} returned no output.`);
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(firstLine) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} returned an invalid payload.`);
  return parsed as Record<string, unknown>;
}

async function runHealthSsh(environment: SessionEnvironment, remoteCommand: string): Promise<string> {
  const args = buildRemoteSyncSshArgs(environment, remoteCommand);
  return new Promise((resolve, reject) => {
    execFile("ssh", args, REMOTE_HEALTH_EXEC_OPTIONS, (error, stdout, stderr) => {
      if (error) reject(new Error(formatRemoteSyncProcessError(error, stdout, stderr)));
      else resolve(stdout);
    });
  });
}

function runHealthRemote(environment: SessionEnvironment, remoteCommand: string): Promise<string> {
  return environment.kind === "wsl"
    ? runRemoteCommand(environment, remoteCommand, REMOTE_HEALTH_EXEC_OPTIONS)
    : runHealthSsh(environment, remoteCommand);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
