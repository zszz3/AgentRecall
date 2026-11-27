import path from "node:path";

export function antigravityHandoffFilePath(sessionId: string, homeDir: string): string {
  const handoffPath = path.join(homeDir, ".gemini", "antigravity-cli", "handoffs", `${sessionId}.md`);
  if (/[^\x20-\x7e]|[$%`]/.test(handoffPath)) {
    throw new Error("Antigravity handoff requires a printable ASCII path without dollar signs, percent signs, or backticks.");
  }
  return handoffPath;
}

export function antigravityHandoffPrompt(handoffPath: string): string {
  return `Read the migrated session handoff file at ${handoffPath} and continue this conversation. Acknowledge once loaded and wait for my next instruction.`;
}
