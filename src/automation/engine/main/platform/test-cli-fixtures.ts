import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeNodeCliLauncher(dir: string, baseName: string, script: string): Promise<string> {
  const entryPath = path.join(dir, `${baseName}.cjs`);
  const normalizedScript = script.replace(/^#![^\r\n]*\r?\n/, "");
  await writeFile(entryPath, `#!/usr/bin/env node\n${normalizedScript}`, "utf8");

  if (process.platform === "win32") {
    const launcherPath = path.join(dir, `${baseName}.cmd`);
    await writeFile(launcherPath, `@echo off\r\n"${process.execPath}" "${entryPath}" %*\r\n`, "utf8");
    return launcherPath;
  }

  await chmod(entryPath, 0o755);
  return entryPath;
}
