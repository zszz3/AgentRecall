import type { ConfigurationChange } from "@agentrecall/workspace-core";
import type { McpServerDefinition } from "../../../../automation/engine/shared/mcp/types";

export type TeamMcpServer = Extract<ConfigurationChange, { kind: "mcp" }>["value"];
export type TeamMcpConversion = { ok: true; server: McpServerDefinition } | { ok: false; fixed: string[] };

/**
 * Converts a team MCP server into an AgentRecall tool source. Tool-source env and header values
 * name host environment variables, so `{ fromEnv }` references carry over and fixed values are
 * refused by name. The copy starts disabled because it may run a command the member has not tested.
 */
export function teamMcpToolSource(value: TeamMcpServer, team: { id: string; name: string }, now: number): TeamMcpConversion {
  const fixed: string[] = [];
  const references = (entries: Record<string, string | { fromEnv: string }>) => Object.fromEntries(Object.entries(entries).flatMap(([key, entry]) => {
    if (typeof entry === "string") { fixed.push(key); return []; }
    return [[key, entry.fromEnv]];
  }));
  const transport = value.transport === "stdio"
    ? { transport: "stdio" as const, command: value.command, args: [...value.args], env: references(value.env) }
    : { transport: "http" as const, url: value.url, args: [], env: {}, headers: references(value.headers) };
  if (fixed.length) return { ok: false, fixed };
  return { ok: true, server: {
    id: `team-${team.id}-${value.id}`,
    name: value.name,
    description: `来自团队 ${team.name}`,
    ...transport,
    enabled: false,
    tools: [],
    disabledTools: [],
    status: "untested",
    createdAt: now,
    updatedAt: now,
  } };
}
