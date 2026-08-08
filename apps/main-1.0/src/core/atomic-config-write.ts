import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeVerifiedConfig(options: {
  targetPath: string;
  contents: string;
  verify(): Promise<void>;
}): Promise<void> {
  const previous = await readExistingFile(options.targetPath);
  try {
    await writeAtomicFile(options.targetPath, options.contents);
    await options.verify();
  } catch (error) {
    if (previous === null) await rm(options.targetPath, { force: true });
    else await writeAtomicFile(options.targetPath, previous);
    throw new Error(`Config verification failed for ${options.targetPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeAtomicFile(targetPath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readExistingFile(filePath: string): Promise<string | null> {
  try {
    await stat(filePath);
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}
