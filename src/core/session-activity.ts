import { execFile } from "node:child_process";
import type { LiveSession, LiveSessionFamily, LiveSessionSnapshot } from "./types";

type ProcessListRunner = (command: string, args: string[]) => Promise<string>;

interface ProcessEntry {
  pid: number;
  command: string;
}

export interface LoadLiveSessionOptions {
  platform?: NodeJS.Platform;
  runner?: ProcessListRunner;
  now?: Date;
}

export function detectLiveSessionsFromProcessLines(lines: string[]): LiveSession[] {
  const sessions: LiveSession[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const entry = parseProcessLine(line);
    if (!entry) continue;

    const tokens = splitCommandLine(entry.command);
    const command = detectResumeCommand(tokens);
    if (!command) continue;

    const key = `${command.family}:${command.rawId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push({ ...command, pid: entry.pid });
  }

  return sessions;
}

export async function loadLiveSessionSnapshot(options: LoadLiveSessionOptions = {}): Promise<LiveSessionSnapshot> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? execText;

  try {
    const output =
      platform === "win32"
        ? await runner("powershell.exe", [
            "-NoProfile",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { "{0} {1}" -f $_.ProcessId, $_.CommandLine } }',
          ])
        : await runner("/bin/ps", ["-axo", "pid=,command="]);

    return {
      generatedAt,
      sessions: detectLiveSessionsFromProcessLines(output.split(/\r?\n/)),
    };
  } catch (error) {
    return {
      generatedAt,
      sessions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseProcessLine(line: string): ProcessEntry | null {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return null;

  const pid = Number(match[1]);
  const command = match[2]?.trim();
  if (!Number.isFinite(pid) || !command) return null;

  return { pid, command };
}

function detectResumeCommand(tokens: string[]): { family: LiveSessionFamily; rawId: string } | null {
  const commandStartIndexes = isNodeExecutable(tokens[0]) ? [1] : [0];

  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (!family) continue;

    const args = tokens.slice(index + 1);
    const rawId = family === "codex" ? codexResumeId(args) : flagResumeId(args);
    if (rawId) return { family, rawId };
  }

  return null;
}

function codexResumeId(args: string[]): string | null {
  const resumeIndex = args.findIndex((arg) => arg === "resume");
  if (resumeIndex < 0) return null;
  const rawId = args[resumeIndex + 1]?.trim();
  return rawId && !rawId.startsWith("-") ? rawId : null;
}

function flagResumeId(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--resume" || arg === "-r") {
      const rawId = args[index + 1]?.trim();
      if (rawId && !rawId.startsWith("-")) return rawId;
    }
    if (arg.startsWith("--resume=")) {
      const rawId = arg.slice("--resume=".length).trim();
      if (rawId) return rawId;
    }
  }

  return null;
}

function executableFamily(token: string | undefined): LiveSessionFamily | null {
  if (!token) return null;
  const normalized = normalizedExecutableName(token);
  if (normalized === "codex") return "codex";
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "codebuddy" || normalized === "cbc") return "codebuddy";

  const lower = token.toLowerCase();
  if (lower.includes("@openai/codex")) return "codex";
  if (lower.includes("@anthropic-ai/claude") || lower.includes("claude-code")) return "claude";
  if (lower.includes("@tencent-ai/codebuddy-code") || lower.includes("codebuddy")) return "codebuddy";
  return null;
}

function isNodeExecutable(token: string | undefined): boolean {
  const normalized = normalizedExecutableName(token);
  return normalized === "node" || normalized === "nodejs";
}

function normalizedExecutableName(token: string | undefined): string {
  if (!token) return "";
  const name = token.replace(/^['"]|['"]$/g, "").split(/[\\/]/).pop()?.toLowerCase() || "";
  return name.replace(/\.(?:js|cjs|mjs|cmd|exe)$/i, "");
}

function splitCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }

    token += char;
  }

  if (token) tokens.push(token);
  return tokens;
}

function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}
