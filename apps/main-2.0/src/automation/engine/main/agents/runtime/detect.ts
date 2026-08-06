import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DEFINITIONS, runtimeDefinition } from "../../../shared/runtime-catalog";
import type { AgentId, AgentRuntime } from "../../../shared/types";
import { execCli } from "../../platform/cli-launcher";

interface RuntimeDetectionOptions {
  platform?: NodeJS.Platform;
  localAppData?: string;
  allowWindowsCodexDesktopFallback?: boolean;
  executeVersion?: (command: string) => Promise<string>;
}

export function resolveRuntimeExecutables(
  overrides: Partial<Record<AgentId, string>> = {},
  environment: Record<string, string | undefined> = process.env,
): Record<AgentId, string> {
  return Object.fromEntries(
    RUNTIME_DEFINITIONS.map((definition) => [
      definition.id,
      overrides[definition.id]
        ?? ("executableEnv" in definition ? environment[definition.executableEnv] : undefined)
        ?? definition.executable,
    ]),
  ) as Record<AgentId, string>;
}

export function parseCliVersion(raw: string): string {
  const firstLine = raw.split("\n")[0]?.trim() ?? "";
  const match = firstLine.match(/(\d+\.\d+[\w.+-]*)/);
  return match?.[1] ?? firstLine;
}

async function executeVersion(command: string): Promise<string> {
  const { stdout } = await execCli({
    executable: command,
    args: ["--version"],
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 1024 * 16,
  });
  return String(stdout).trim();
}

async function windowsCodexDesktopExecutables(localAppData: string | undefined): Promise<string[]> {
  if (!localAppData) return [];
  const binDir = path.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    const entries = await readdir(binDir, { withFileTypes: true });
    const candidates = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const executable = path.join(binDir, entry.name, "codex.exe");
        try {
          return { executable, modifiedAt: (await stat(executable)).mtimeMs };
        } catch {
          return undefined;
        }
      }));
    return candidates
      .filter((candidate): candidate is { executable: string; modifiedAt: number } => Boolean(candidate))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .map((candidate) => candidate.executable);
  } catch {
    return [];
  }
}

async function detectOne(
  id: AgentId,
  executables: Record<AgentId, string>,
  options: RuntimeDetectionOptions,
): Promise<AgentRuntime> {
  const definition = runtimeDefinition(id);
  const command = executables[id];
  if (definition.detection === "virtual") {
    return {
      id,
      label: definition.label,
      command,
      version: null,
      available: true,
    };
  }

  const runVersion = options.executeVersion ?? executeVersion;
  let error: unknown;
  const candidates = [command];
  try {
    candidates.push(...(
      id === "codex"
      && (options.platform ?? process.platform) === "win32"
      && options.allowWindowsCodexDesktopFallback !== false
        ? await windowsCodexDesktopExecutables(options.localAppData ?? process.env.LOCALAPPDATA)
        : []
    ));
  } catch {
    // The configured command remains authoritative if Desktop discovery fails.
  }

  for (const candidate of candidates) {
    try {
      const stdout = await runVersion(candidate);
      return {
        id,
        label: definition.label,
        command: candidate,
        version: parseCliVersion(stdout),
        available: true,
      };
    } catch (cause) {
      error ??= cause;
    }
  }

  return {
    id,
    label: definition.label,
    command,
    version: null,
    available: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function detectAgentRuntimes(
  executables: Record<AgentId, string> = resolveRuntimeExecutables(),
  options: RuntimeDetectionOptions = {},
): Promise<AgentRuntime[]> {
  return Promise.all(RUNTIME_DEFINITIONS.map((definition) => detectOne(definition.id, executables, options)));
}
