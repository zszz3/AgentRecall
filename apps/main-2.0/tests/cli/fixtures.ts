import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { WorkspaceService } from "@agentrecall/workspace-core";

export const execute = promisify(execFile);

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliSourceEntry = path.join(appRoot, "src", "cli", "index.ts");
const cliTsconfigPath = path.join(appRoot, "tests", "cli", "tsconfig.json");
const launcherEntry = path.join(appRoot, "bin", "agent-recall.cjs");

export async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const service = new WorkspaceService(home);
  return { root, home, service };
}

export async function repository(directory: string, url?: string) {
  await fs.mkdir(directory, { recursive: true });
  await execute("git", ["init", "-q", directory]);
  await execute("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  if (url) await execute("git", ["-C", directory, "remote", "add", "origin", url]);
  return directory;
}

export interface CliResult {
  code: number | string | null;
  stdout: string;
  stderr: string;
  result: { ok: boolean; data?: unknown; error?: { code: string; message: string } };
}

export async function cli(home: string, directory: string, args: string[]): Promise<CliResult> {
  try {
    const result = await execute(process.execPath, ["--import", "tsx", cliSourceEntry, ...args, "--cwd", directory, "--json"], {
      cwd: appRoot,
      env: { ...process.env, AGENTRECALL_HOME: home, TSX_TSCONFIG_PATH: cliTsconfigPath },
      timeout: 15_000,
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      result: JSON.parse(result.stdout) as CliResult["result"],
    };
  } catch (error) {
    if (!(error instanceof Error) || !("stdout" in error) || typeof error.stdout !== "string"
      || !("stderr" in error) || typeof error.stderr !== "string" || !("code" in error)) throw error;
    return {
      code: error.code as number | string | null,
      stdout: error.stdout,
      stderr: error.stderr,
      result: JSON.parse(error.stdout) as CliResult["result"],
    };
  }
}

export async function launcherCli(
  home: string,
  directory: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | string | null; stdout: string; stderr: string }> {
  try {
    const result = await execute(process.execPath, [launcherEntry, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        AGENTRECALL_HOME: home,
        AGENT_RECALL_NO_UPDATE_CHECK: "1",
        ...extraEnv,
      },
      timeout: 15_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (!(error instanceof Error) || !("stdout" in error) || typeof error.stdout !== "string"
      || !("stderr" in error) || typeof error.stderr !== "string" || !("code" in error)) throw error;
    return {
      code: error.code as number | string | null,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}
