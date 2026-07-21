import { randomUUID } from "node:crypto";
import type {
  AgentTeamMember,
  AgentWorkflowTarget,
  CreateAgentTeamRequest,
  TeamRunStep,
} from "../../../shared/types";
import { asNumber } from "../persisted/agent-hub-persistence";
import { isAgentTeamMode, isAgentWorkflowTarget } from "../persisted/agent-hub-persistence";
import { AgentTeamState } from "../state/agent-hub-state";

export function normalizeWorkflowTarget(target: AgentWorkflowTarget | undefined): AgentWorkflowTarget | undefined {
  if (!isAgentWorkflowTarget(target)) return undefined;
  const label = target.label.trim();
  const value = target.value.trim();
  if (!label && !value) return undefined;
  return {
    kind: target.kind,
    label: label || target.kind,
    value,
  };
}

export function normalizeCanvasPosition(position: AgentTeamMember["canvasPosition"]): AgentTeamMember["canvasPosition"] {
  if (!position || typeof position !== "object") return undefined;
  const x = Math.max(0, Math.round(asNumber(position.x, Number.NaN)));
  const y = Math.max(0, Math.round(asNumber(position.y, Number.NaN)));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

export function normalizeTeamMembers(
  members: Array<Partial<Omit<AgentTeamMember, "id">> & { id?: string }>,
  resolveConfiguredAgentId: (configuredAgentId: string | undefined) => string,
): AgentTeamMember[] {
  return members.map((member, index) => {
    const canvasPosition = normalizeCanvasPosition(member.canvasPosition);
    return {
      id: member.id || randomUUID(),
      roleName: member.roleName?.trim() || `Agent ${index + 1}`,
      prompt: member.prompt?.trim() ?? "",
      configuredAgentId: resolveConfiguredAgentId(member.configuredAgentId),
      ...(canvasPosition ? { canvasPosition } : {}),
    };
  });
}

export function teamMembersFromRunSteps(
  steps: TeamRunStep[],
  normalizeMembers: (members: Array<Partial<Omit<AgentTeamMember, "id">> & { id?: string }>) => AgentTeamMember[],
): AgentTeamMember[] {
  return normalizeMembers(
    steps
      .filter((step) => !step.teamMemberId.endsWith(":synthesis"))
      .map((step) => ({
        id: step.teamMemberId,
        roleName: step.roleName,
        prompt: step.prompt,
        configuredAgentId: step.configuredAgentId,
      })),
  );
}

export function createTeamState(
  input: CreateAgentTeamRequest,
  normalizeMembers: (members: Array<Partial<Omit<AgentTeamMember, "id">> & { id?: string }>) => AgentTeamMember[],
): AgentTeamState {
  const name = input.name.trim() || "New Agent Team";
  const mode = isAgentTeamMode(input.mode) ? input.mode : "pipeline";
  return new AgentTeamState(name, mode, input.sharedContext ?? "", normalizeMembers(input.members ?? []));
}
