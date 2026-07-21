import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RuntimeSessionCleanupContext } from "../../../../agents/runtime/runtime-driver";
import { codexHome } from "../../../../channels/model-config";
import { execCli } from "../../../../platform/cli-launcher";
import { codexThreadIdFromConversation } from "../agent-executor-conversation";

export async function deleteCodexSessionFiles(home: string, sessionId: string): Promise<number> {
  const root = path.join(home, "sessions");
  let deleted = 0;
  const visit = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
          return;
        }
        if (!entry.isFile() || !entry.name.includes(sessionId)) return;
        await rm(entryPath, { force: true });
        deleted += 1;
      }),
    );
  };
  await visit(root);
  return deleted;
}

export async function deleteCodexSessionArtifacts(
  executable: string,
  input: RuntimeSessionCleanupContext,
): Promise<void> {
  const sessionId = codexThreadIdFromConversation(input.runtimeConversation);
  if (!sessionId) return;
  try {
    await execCli({
      executable,
      args: ["archive", sessionId],
      cwd: process.cwd(),
      env: process.env,
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 1024 * 64,
    });
  } catch (error) {
    console.warn(`Failed to archive Codex session ${sessionId}:`, error);
  }
  try {
    await deleteCodexSessionFiles(codexHome(), sessionId);
  } catch (error) {
    console.warn(`Failed to delete local Codex session ${sessionId}:`, error);
  }
}
