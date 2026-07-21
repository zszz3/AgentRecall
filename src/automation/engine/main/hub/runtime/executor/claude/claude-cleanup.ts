import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RuntimeSessionCleanupContext } from "../../../../agents/runtime/runtime-driver";
import { claudeSessionIdFromConversation } from "../agent-executor-conversation";

function claudeProjectStoragePath(workDir: string, sessionId: string): string {
  const slug = workDir.replace(/[:\\/]/g, "-");
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(homeDir, ".claude", "projects", slug, `${sessionId}.jsonl`);
}

export async function deleteClaudeSessionArtifacts(input: RuntimeSessionCleanupContext): Promise<void> {
  const sessionId = claudeSessionIdFromConversation(input.runtimeConversation);
  if (!sessionId) return;
  try {
    await rm(claudeProjectStoragePath(input.workDir, sessionId), { force: true });
  } catch (error) {
    console.warn(`Failed to delete Claude session ${sessionId}:`, error);
  }
}
