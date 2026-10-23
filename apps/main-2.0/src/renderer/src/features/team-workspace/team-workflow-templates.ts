import type { WorkflowTemplate, WorkflowTemplateContent } from "@agentrecall/workspace-core";
import type { ConfiguredAgent } from "../../../../automation/contracts";
import type { WorkflowDefinition, WorkflowNode } from "../../../../automation/engine/shared/workflow/model";
import { teamRoleTag } from "./team-agent-roles";

type RoleRef = { roleId: string; nodes: string[] };

/** The local Agent enabled from a team role, found through the role tag. */
const roleAgent = (agents: ConfiguredAgent[], teamId: string, roleId: string) => agents.find(agent => agent.tags.includes(teamRoleTag(teamId, roleId)));

/**
 * Turns a team template into a personal Workflow. Each role is replaced by the
 * local Agent enabled from it; when a role has not been enabled the copy is not
 * created and the missing roles are returned instead.
 */
export function workflowFromTemplate(template: WorkflowTemplate, content: WorkflowTemplateContent, agents: ConfiguredAgent[], teamId: string, repository: string, now = Date.now()): { definition: WorkflowDefinition; missing: [] } | { definition: null; missing: RoleRef[] } {
  const missing = new Map<string, string[]>();
  const nodes = content.nodes.map(node => {
    const { role, ...rest } = node;
    if (!role) return rest;
    const agent = roleAgent(agents, teamId, role);
    if (!agent) missing.set(role, [...missing.get(role) ?? [], node.title]);
    return { ...rest, agentId: agent?.id ?? "" };
  }) as unknown as WorkflowNode[];
  if (missing.size) return { definition: null, missing: [...missing].map(([roleId, titles]) => ({ roleId, nodes: titles })) };
  return { missing: [], definition: {
    id: `workflow_${now}`, name: template.name, description: template.description || template.name,
    inputs: content.inputs as unknown as WorkflowDefinition["inputs"], nodes, createdAt: now, updatedAt: now,
    origin: { kind: "team-template", teamId, repository, templateId: template.id, templateName: template.name, digest: template.digest, copiedAt: now },
  } };
}

/**
 * Turns a personal Workflow into portable template content. Agent ids only
 * exist on this machine, so each Agent must have been enabled from a team role;
 * otherwise the Agent is reported as missing and nothing is published.
 */
export function templateFromWorkflow(definition: WorkflowDefinition, agents: ConfiguredAgent[], teamId: string): { content: string; missing: [] } | { content: null; missing: Array<{ agentId: string; name: string; nodes: string[] }> } {
  const missing = new Map<string, string[]>();
  const prefix = teamRoleTag(teamId, "");
  const nodes = definition.nodes.map(node => {
    if (node.kind !== "agent" && node.kind !== "review") return node;
    const { agentId, ...rest } = node;
    const role = agents.find(agent => agent.id === agentId)?.tags.find(tag => tag.startsWith(prefix))?.slice(prefix.length);
    if (!role) missing.set(agentId, [...missing.get(agentId) ?? [], node.title]);
    return { ...rest, role: role ?? "" };
  });
  if (missing.size) return { content: null, missing: [...missing].map(([agentId, titles]) => ({ agentId, name: agents.find(agent => agent.id === agentId)?.name ?? agentId, nodes: titles })) };
  return { missing: [], content: JSON.stringify({ schemaVersion: 1, inputs: definition.inputs, nodes }, null, 2) + "\n" };
}
