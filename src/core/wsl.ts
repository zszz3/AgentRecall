import { execFile, type ExecFileOptions } from "node:child_process";

export interface WslProcessSpec {
  command: string;
  args: string[];
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
  const distributions: string[] = [];
  const seen = new Set<string>();
  for (const line of decodeWslOutput(output).split(/\r?\n/)) {
    const distribution = line.replace(/\0/g, "").replace(/^\uFEFF/, "").trim();
    if (distribution && !seen.has(distribution)) {
      seen.add(distribution);
      distributions.push(distribution);
    }
  }
  return distributions;
}

export function buildWslProcessSpec(distribution: string, remoteCommand: string): WslProcessSpec {
  const normalized = distribution.trim();
  if (!normalized) throw new Error("WSL distribution is required.");
  return {
    command: "wsl.exe",
    args: ["--distribution", normalized, "--exec", "bash", "-lc", remoteCommand],
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
