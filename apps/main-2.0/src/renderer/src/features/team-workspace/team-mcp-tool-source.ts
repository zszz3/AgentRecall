import type { ConfigurationChange } from "@agentrecall/workspace-core";
import type { McpServerDefinition } from "../../../../automation/engine/shared/mcp/types";

export type TeamMcpServer = Extract<ConfigurationChange, { kind: "mcp" }>["value"];
export type TeamMcpConversion = { ok: true; server: McpServerDefinition } | { ok: false; fixed: string[] };
/** `variable` is the command variable that reads the differently named local variable `reads`. */
export type ToolSourceConversion = { ok: true; value: TeamMcpServer } | { ok: false; variable: string; reads: string };

const TEAM_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");

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

/**
 * Drafts a new team server from a tool source. Tool-source env and header values already name local
 * variables, so they become `{ fromEnv }` references and no secret value can reach the team. A
 * command variable reading a differently named local variable is refused: team servers can only
 * reference the variable of the same name. The member reviews the draft in the editor before saving.
 */
export function teamMcpFromToolSource(server: McpServerDefinition): ToolSourceConversion {
  const named = slug(server.name), fallback = `mcp-${slug(server.id)}`;
  const id = TEAM_ID.test(named) ? named : TEAM_ID.test(fallback) ? fallback : "mcp-server";
  const targets: Array<"codex" | "claude"> = ["codex", "claude"];
  if (server.transport === "http") {
    return { ok: true, value: { id, name: server.name, transport: "http", url: server.url ?? "", headers: Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, name]) => [key, { fromEnv: name }])), targets } };
  }
  const renamed = Object.entries(server.env).find(([key, name]) => key !== name);
  if (renamed) return { ok: false, variable: renamed[0], reads: renamed[1] };
  return { ok: true, value: { id, name: server.name, transport: "stdio", command: server.command ?? "", args: [...server.args], env: Object.fromEntries(Object.keys(server.env).map(key => [key, { fromEnv: key }])), targets } };
}
