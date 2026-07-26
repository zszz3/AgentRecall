import { execFile, type ExecFileOptions } from "node:child_process";
import { runRemoteCommand } from "./remote-process";
import { buildRemoteSyncSshArgs, formatRemoteSyncProcessError } from "./remote-sync";
import type { SessionEnvironment, SessionSearchResult, SessionSource } from "./types";
import { sessionSourceDescriptor } from "./session-sources";

export type RemoteHealthStatus = "ok" | "warning" | "error";

export interface RemoteHealthCheck {
  id: string;
  label: string;
  status: RemoteHealthStatus;
  message: string;
  detail?: string;
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
    const checks: RemoteHealthCheck[] = [
      { id: "connectivity", label: "SSH connection", status: "ok", message: `Connected as ${payload.user || "remote user"}.` },
      cliCheck("codex-cli", "Codex CLI", payload.codexCli),
      cliCheck("claude-cli", "Claude CLI", payload.claudeCli),
      directoryCheck("codex-sessions", "Codex sessions", payload.codexSessionsExists, payload.codexSessionsReadable),
      directoryCheck("claude-projects", "Claude projects", payload.claudeProjectsExists, payload.claudeProjectsReadable),
      cliCheck("tclaude-cli", "TClaude CLI", payload.tclaudeCli),
      cliCheck("tcodex-cli", "TCodex CLI", payload.tcodexCli),
      cliCheck("codebuddy-cli", "CodeBuddy CLI", payload.codebuddyCli),
      directoryCheck("tclaude-projects", "TClaude projects", payload.tclaudeProjectsExists, payload.tclaudeProjectsReadable),
      directoryCheck("tcodex-sessions", "TCodex sessions", payload.tcodexSessionsExists, payload.tcodexSessionsReadable),
      directoryCheck("codebuddy-projects", "CodeBuddy projects", payload.codebuddyProjectsExists, payload.codebuddyProjectsReadable),
    ];
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
    return buildReport([
      { id: "connectivity", label: "WSL connection", status: "ok", message: `Connected as ${payload.user || "remote user"}.` },
      cliCheck("codex-cli", "Codex CLI", payload.codexCli),
      cliCheck("claude-cli", "Claude CLI", payload.claudeCli),
      directoryCheck("codex-sessions", "Codex sessions", payload.codexSessionsExists, payload.codexSessionsReadable),
      directoryCheck("claude-projects", "Claude projects", payload.claudeProjectsExists, payload.claudeProjectsReadable),
    ]);
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

function cliCheck(id: string, label: string, path: unknown): RemoteHealthCheck {
  if (typeof path === "string" && path) {
    return { id, label, status: "ok", message: `${label} found.`, detail: path };
  }
  return { id, label, status: "warning", message: `${label} was not found on PATH.` };
}

function directoryCheck(id: string, label: string, exists: unknown, readable: unknown): RemoteHealthCheck {
  if (exists && readable) return { id, label, status: "ok", message: `${label} directory is readable.` };
  if (exists) return { id, label, status: "error", message: `${label} directory exists but is not readable.` };
  return { id, label, status: "warning", message: `${label} directory was not found.` };
}

function sessionFileCheck(exists: unknown, readable: unknown): RemoteHealthCheck {
  if (exists && readable) return { id: "session-file", label: "Session file", status: "ok", message: "Remote session file is readable." };
  if (exists) return { id: "session-file", label: "Session file", status: "error", message: "Remote session file exists but is not readable." };
  return { id: "session-file", label: "Session file", status: "error", message: "Remote session file was not found." };
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

codex_sessions = home / ".codex" / "sessions"
claude_projects = home / ".claude" / "projects"
tclaude_projects = home / ".tclaude" / "projects"
tcodex_sessions = home / ".tcodex" / "sessions"
codebuddy_projects = home / ".codebuddy" / "projects"
print(json.dumps({
  "ok": True,
  "home": str(home),
  "user": os.environ.get("USER") or os.environ.get("USERNAME") or "",
  "codexCli": shutil.which("codex"),
  "claudeCli": shutil.which("claude"),
  "tclaudeCli": shutil.which("tclaude"),
  "tcodexCli": shutil.which("tcodex"),
  "codebuddyCli": shutil.which("codebuddy"),
  "codexSessionsExists": codex_sessions.exists(),
  "codexSessionsReadable": readable(codex_sessions),
  "claudeProjectsExists": claude_projects.exists(),
  "claudeProjectsReadable": readable(claude_projects),
  "tclaudeProjectsExists": tclaude_projects.exists(),
  "tclaudeProjectsReadable": readable(tclaude_projects),
  "tcodexSessionsExists": tcodex_sessions.exists(),
  "tcodexSessionsReadable": readable(tcodex_sessions),
  "codebuddyProjectsExists": codebuddy_projects.exists(),
  "codebuddyProjectsReadable": readable(codebuddy_projects),
}, ensure_ascii=False))`;
  return buildPythonBase64Command(script);
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

function buildPythonBase64Command(script: string): string {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const compressed = zlib.deflateRawSync(Buffer.from(script, "utf-8"));
  const encoded = compressed.toString("base64");
  const pythonCommand = `python3 -c 'import base64,zlib; exec(zlib.decompress(base64.b64decode("${encoded}"), -15).decode("utf-8"))'`;
  return `bash -lc ${posixShellQuote(pythonCommand)}`;
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
