import type { AgentRole, AgentRoleChange } from "@agentrecall/workspace-core";
import type { AgentChannel, ConfiguredAgent, AgentId } from "../../../../automation/contracts";

export const ROLE_RUNTIMES: AgentId[] = ["codex", "claude", "dsh", "api", "hermes", "opencode", "openclaw"];
export type RoleModelChoice = { channelId: string; modelId: string; reasoningEffort?: string };
export type LocalRoleState = { agent: ConfiguredAgent | null; status: "disabled" | "enabled" | "changed" };

/** The tag is the durable link between a team role and the local Agent created from it. */
export const teamRoleTag = (teamId: string, roleId: string) => `team-role:${teamId}/${roleId}`;

export function localRoleState(agents: ConfiguredAgent[], teamId: string, role: AgentRole): LocalRoleState {
  const agent = agents.find(item => item.tags.includes(teamRoleTag(teamId, role.id))) ?? null;
  if (!agent) return { agent, status: "disabled" };
  const same = agent.name === role.name && agent.description === role.description && (agent.instructions ?? "") === role.content && agent.runtimeAgentId === role.model.runtime;
  return { agent, status: same ? "enabled" : "changed" };
}

/** Suggests a local channel and model for the role's runtime, preferring models that name its family. */
export function suggestRoleModel(role: AgentRole, channels: AgentChannel[], current?: ConfiguredAgent | null): RoleModelChoice | null {
  const candidates = channels.filter(channel => channel.agentId === role.model.runtime && channel.models.length);
  if (current && candidates.some(channel => channel.id === current.channelId && channel.models.some(model => model.id === current.modelId))) return { channelId: current.channelId, modelId: current.modelId, reasoningEffort: current.reasoningEffort };
  const family = role.model.family?.toLowerCase();
  for (const channel of candidates) {
    const model = family ? channel.models.find(item => item.id.toLowerCase().includes(family) || item.label.toLowerCase().includes(family)) : undefined;
    if (model) return { channelId: channel.id, modelId: model.id, reasoningEffort: effort(role, model.reasoningEfforts) };
  }
  const channel = candidates[0];
  return channel ? { channelId: channel.id, modelId: channel.models[0]!.id, reasoningEffort: effort(role, channel.models[0]!.reasoningEfforts) } : null;
}
const effort = (role: AgentRole, supported?: string[]) => role.model.reasoningEffort && (!supported || supported.includes(role.model.reasoningEffort)) ? role.model.reasoningEffort : undefined;

/**
 * Returns the full configured-Agent list with the role enabled locally. An Agent
 * already linked to the role is replaced in place so its id, history and
 * Workflow references survive; other Agents are returned untouched.
 */
export function enableTeamRole(agents: ConfiguredAgent[], teamId: string, role: AgentRole, choice: RoleModelChoice, now: number): ConfiguredAgent[] {
  if (!ROLE_RUNTIMES.includes(role.model.runtime as AgentId)) throw new Error(`Runtime ${role.model.runtime} is not supported by this app.`);
  const tag = teamRoleTag(teamId, role.id);
  const existing = agents.find(item => item.tags.includes(tag));
  const next: ConfiguredAgent = {
    ...existing,
    id: existing?.id ?? `team-role-${teamId}-${role.id}`,
    agentType: "execution",
    name: role.name,
    description: role.description,
    instructions: role.content,
    runtimeAgentId: role.model.runtime as AgentId,
    channelId: choice.channelId,
    modelId: choice.modelId,
    ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : { reasoningEffort: undefined }),
    tags: [...new Set([...role.tags, tag])],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (!next.reasoningEffort) delete next.reasoningEffort;
  return existing ? agents.map(item => item === existing ? next : item) : [...agents, next];
}

/** Prefills a role from a local Agent. Channel and model ids stay local; only runtime and model name are shared. */
export function roleFromAgent(agent: ConfiguredAgent, existingIds: string[]): AgentRoleChange["value"] {
  const base = agent.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(?=[0-9])/, "role-").slice(0, 48) || "role";
  let id = base, index = 2;
  while (existingIds.includes(id)) id = `${base}-${index++}`;
  const tags = new Map(agent.tags.map(tag => tag.trim()).filter(tag => tag && tag.length <= 64 && !tag.startsWith("team-role:")).map(tag => [tag.toLowerCase(), tag]));
  return {
    id, name: agent.name, description: (agent.description.trim() || agent.name).slice(0, 4096), content: agent.instructions?.trim() ? agent.instructions : `# ${agent.name}\n`,
    model: { runtime: agent.runtimeAgentId, family: agent.modelId, ...(agent.reasoningEffort && /^[a-z]{1,16}$/.test(agent.reasoningEffort) ? { reasoningEffort: agent.reasoningEffort } : {}) },
    skills: [], mcpServers: [], tags: [...tags.values()].slice(0, 16),
  };
}
