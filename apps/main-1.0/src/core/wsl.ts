import { execFile, type ExecFileOptions } from "node:child_process";

export interface WslProcessSpec {
  command: string;
  args: string[];
}

export type WslDistributionState = "running" | "stopped" | "unknown";

/** A parsed row from `wsl.exe --list --verbose` (or the quiet list). */
export interface WslDistributionInfo {
  name: string;
  isDefault: boolean;
  state: WslDistributionState;
  version: number | null;
}

export interface WslListRunner {
  (file: string, args: readonly string[], options: ExecFileOptions): Promise<{ stdout: Buffer; stderr: Buffer }>;
}

export const WSL_LIST_EXEC_OPTIONS = {
  maxBuffer: 256 * 1024,
  timeout: 20_000,
  encoding: "buffer",
} satisfies ExecFileOptions;

export function parseWslDistributionOutput(output: Buffer | string): string[] {
  return parseWslDistributionDetails(output).map((distribution) => distribution.name);
}

/**
 * Parse both the compact output (`--list --quiet`) and the table emitted by
 * `--list --verbose`. WSL has emitted UTF-16LE, UTF-8, and output with a BOM
 * across Windows versions, so decoding happens before any table parsing.
 */
export function parseWslDistributionDetails(output: Buffer | string): WslDistributionInfo[] {
  const distributions: WslDistributionInfo[] = [];
  const seen = new Set<string>();
  for (const rawLine of decodeWslOutput(output).split(/\r?\n/)) {
    const line = rawLine.replace(/\0/g, "").replace(/^\uFEFF/, "").trim();
    if (!line || /^name\s+state\s+version$/iu.test(line) || /^[-\s]+$/u.test(line) || /windows subsystem for linux|linux distribution/iu.test(line)) continue;
    const defaultMarked = line.startsWith("*");
    const withoutMarker = (defaultMarked ? line.slice(1) : line).trim();
    const verbose = withoutMarker.match(/^(.*?)\s+(Running|Stopped|Installing|Uninstalling)\s+(\d+)\s*$/iu);
    const name = (verbose?.[1] ?? withoutMarker).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const stateText = verbose?.[2]?.toLowerCase();
    distributions.push({
      name,
      isDefault: defaultMarked,
      state: stateText === "running" ? "running" : stateText ? "stopped" : "unknown",
      version: verbose?.[3] ? Number(verbose[3]) : null,
    });
  }
  return distributions;
}

export function buildWslProcessSpec(distribution: string, remoteCommand: string): WslProcessSpec {
  const normalized = distribution.trim();
  if (!normalized) throw new Error("WSL distribution is required.");
  return {
    command: "wsl.exe",
    args: [
      "--distribution",
      normalized,
      "--exec",
      "bash",
      "-lc",
      `if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; ${remoteCommand}`,
    ],
  };
}

export async function listWslDistributions(
  runner: WslListRunner = runWslList,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (platform !== "win32") return [];
  const result = await runner("wsl.exe", ["--list", "--quiet"], WSL_LIST_EXEC_OPTIONS);
  return parseWslDistributionOutput(result.stdout);
}

/** Return status/default information for the environment picker and diagnostics. */
export async function listWslDistributionDetails(
  runner: WslListRunner = runWslList,
  platform: NodeJS.Platform = process.platform,
): Promise<WslDistributionInfo[]> {
  if (platform !== "win32") return [];
  try {
    const result = await runner("wsl.exe", ["--list", "--verbose"], WSL_LIST_EXEC_OPTIONS);
    return parseWslDistributionDetails(result.stdout);
  } catch (verboseError) {
    // Older WSL builds do not understand --verbose. Preserve the picker and
    // return unknown status instead of turning a useful quiet list into an
    // unavailable-environment error.
    try {
      const result = await runner("wsl.exe", ["--list", "--quiet"], WSL_LIST_EXEC_OPTIONS);
      return parseWslDistributionDetails(result.stdout);
    } catch {
      throw verboseError;
    }
  }
}

async function runWslList(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
      const stderrBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
      if (error) {
        const detail = decodeWslOutput(stderrBuffer).trim();
        reject(new Error(detail || `Could not list WSL distributions: ${error.message}`));
        return;
      }
      resolve({ stdout: stdoutBuffer, stderr: stderrBuffer });
    });
  });
}

function decodeWslOutput(output: Buffer | string): string {
  if (typeof output === "string") return output;
  if (output.length >= 2 && output[0] === 0xff && output[1] === 0xfe) {
    return output.subarray(2).toString("utf16le");
  }
  const nulCount = output.reduce((count, byte) => count + (byte === 0 ? 1 : 0), 0);
  return nulCount > output.length / 8 ? output.toString("utf16le") : output.toString("utf8");
}
