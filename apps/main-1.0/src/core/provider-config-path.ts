import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function resolveProviderConfigDirectory(configuredPath: string | undefined, defaultDirectoryName: string): string {
  const value = (configuredPath ?? "").trim();
  if (!value) return path.join(os.homedir(), defaultDirectoryName);
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

export async function prepareProviderConfigDirectory(
  configuredPath: string | undefined,
  defaultDirectoryName: string,
): Promise<string> {
  const directory = resolveProviderConfigDirectory(configuredPath, defaultDirectoryName);
  if (!(configuredPath ?? "").trim()) await mkdir(directory, { recursive: true });
  let details;
  try {
    details = await stat(directory);
  } catch {
    throw new Error(`Config directory does not exist: ${directory}`);
  }
  if (!details.isDirectory()) throw new Error(`Config path is not a directory: ${directory}`);
  try {
    await access(directory, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`Config directory is not readable and writable: ${directory}`);
  }
  return directory;
}
