import type { AgentRoleChange } from "@agentrecall/workspace-core";
import type { ConfiguredAgent, AgentId } from "../../../../automation/contracts";

export const ROLE_RUNTIMES: AgentId[] = ["codex", "claude", "dsh", "api", "hermes", "opencode", "openclaw"];

/**
 * Prefills a role from a local Agent. Channel and model ids stay local; only
 * runtime and model name are shared. MCP bindings carry over only when the team
 * publishes a server with the same id; the rest are returned as `missing` so the
 * author can publish them first instead of shipping a role with a silent gap.
 */
export function roleFromAgent(agent: ConfiguredAgent, existingIds: string[], teamMcpIds: string[]): { value: AgentRoleChange["value"]; missing: string[] } {
  const base = agent.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(?=[0-9])/, "role-").slice(0, 48) || "role";
  let id = base, index = 2;
  while (existingIds.includes(id)) id = `${base}-${index++}`;
  const tags = new Map(agent.tags.map(tag => tag.trim()).filter(tag => tag && tag.length <= 64 && !tag.startsWith("team-role:")).map(tag => [tag.toLowerCase(), tag]));
  const bindings = agent.mcpBindings ?? [];
  const mcpServers = bindings.filter(item => teamMcpIds.includes(item.serverId)).map(item => item.toolAllowlist.length ? { id: item.serverId, tools: item.toolAllowlist.slice(0, 128) } : { id: item.serverId });
  return { missing: bindings.filter(item => !teamMcpIds.includes(item.serverId)).map(item => item.serverId), value: {
    id, name: agent.name, description: (agent.description.trim() || agent.name).slice(0, 4096), content: agent.instructions?.trim() ? agent.instructions : `# ${agent.name}\n`,
    model: { runtime: agent.runtimeAgentId, family: agent.modelId, ...(agent.reasoningEffort && /^[a-z]{1,16}$/.test(agent.reasoningEffort) ? { reasoningEffort: agent.reasoningEffort } : {}) },
    skills: [], mcpServers, tags: [...tags.values()].slice(0, 16),
  } };
}
