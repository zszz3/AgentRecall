import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { WorkspaceService } from "@agentrecall/workspace-core";

export const execute = promisify(execFile);

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

export async function cli(home: string, directory: string, args: string[]) {
  const source = path.resolve("src/cli.ts");
  try {
    const result = await execute(process.execPath, ["--import", "tsx", source, ...args, "--cwd", directory, "--json"], {
      env: { ...process.env, AGENTRECALL_HOME: home }, timeout: 15_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, result: JSON.parse(result.stdout) as { ok: boolean; data?: unknown; error?: { code: string; message: string } } };
  } catch (error) {
    if (!(error instanceof Error) || !("stdout" in error) || typeof error.stdout !== "string"
      || !("stderr" in error) || typeof error.stderr !== "string" || !("code" in error)) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr, result: JSON.parse(error.stdout) as { ok: boolean; data?: unknown; error?: { code: string; message: string } } };
  }
}
