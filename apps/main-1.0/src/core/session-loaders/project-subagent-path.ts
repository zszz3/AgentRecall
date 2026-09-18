/** Claude Code and CodeBuddy keep child transcripts beneath the owning session. */
export function parseProjectSubagentPath(filePath: string): { agentId: string; parentSessionId: string } | null {
  const parts = filePath.split(/[\\/]+/);
  const file = parts.at(-1) ?? "";
  const agentId = /^agent-(.+?)\.jsonl(?:\.tmp-.+)?$/i.exec(file)?.[1];
  if (!agentId || parts.at(-2) !== "subagents" || parts.at(-5) !== "projects") return null;
  const parentSessionId = parts.at(-3);
  return parentSessionId ? { agentId, parentSessionId } : null;
}
