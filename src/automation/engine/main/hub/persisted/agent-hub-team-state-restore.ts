import { randomUUID } from "node:crypto";
import type {
  AgentTeamMember,
  ConfiguredAgent,
  TeamRunStep,
} from "../../../shared/types";
import { titleFromPrompt } from "../chat/agent-hub-ui";
import { AgentTeamState, TeamRunState } from "../state/agent-hub-state";
import {
  asArray,
  asNumber,
  asOptionalString,
  asRecord,
  isAgentTeamMode,
  isAgentWorkflowTarget,
  isTeamRunStatus,
  isTeamRunStepStatus,
} from "./agent-hub-persistence";

type RestorableTeamMemberInput = Partial<Omit<AgentTeamMember, "id">> & { id?: string };

export interface RestoreTeamStateDeps {
  normalizeTeamMembers: (members: RestorableTeamMemberInput[]) => AgentTeamMember[];
}

export interface RestoreTeamRunStepDeps {
  configuredAgentOrDefault: (configuredAgentId: string | undefined) => ConfiguredAgent | undefined;
}

export interface RestoreTeamRunStateDeps {
  workDir: string;
  normalizeTeamMembers: (members: RestorableTeamMemberInput[]) => AgentTeamMember[];
  teamMembersFromRunSteps: (steps: TeamRunStep[]) => AgentTeamMember[];
  restoreTeamRunStep: (raw: unknown) => TeamRunStep | null;
}

export function restoreTeamState(raw: unknown, deps: RestoreTeamStateDeps): AgentTeamState | null {
  const record = asRecord(raw);
  const name = asOptionalString(record?.name);
  if (!record || !name) return null;
  const now = Date.now();
  const team = new AgentTeamState(
    name,
    isAgentTeamMode(record.mode) ? record.mode : "pipeline",
    asOptionalString(record.sharedContext) ?? "",
    deps.normalizeTeamMembers(asArray(record.members) as RestorableTeamMemberInput[]),
  );
  team.id = asOptionalString(record.id) ?? team.id;
  team.createdAt = asNumber(record.createdAt, now);
  team.updatedAt = asNumber(record.updatedAt, team.createdAt);
  return team;
}

export function restoreTeamRunState(raw: unknown, deps: RestoreTeamRunStateDeps): TeamRunState | null {
  const record = asRecord(raw);
  const teamId = asOptionalString(record?.teamId);
  const prompt = asOptionalString(record?.prompt);
  if (!record || !teamId || !prompt) return null;

  const placeholderTeam = new AgentTeamState(
    asOptionalString(record.teamName) ?? "Agent Team",
    isAgentTeamMode(record.mode) ? record.mode : "pipeline",
    "",
    [],
  );
  placeholderTeam.id = teamId;

  const now = Date.now();
  const run = new TeamRunState(
    placeholderTeam,
    prompt,
    isAgentWorkflowTarget(record.target) ? record.target : undefined,
    asOptionalString(record.workDir) ?? deps.workDir,
  );
  run.id = asOptionalString(record.id) ?? run.id;
  run.teamName = asOptionalString(record.teamName) ?? placeholderTeam.name;
  run.title = asOptionalString(record.title) ?? titleFromPrompt(prompt);
  run.status = isTeamRunStatus(record.status) ? record.status : "failed";
  if (run.status === "running" || run.status === "queued") run.status = "failed";
  run.currentStepIndex = Math.max(0, Math.floor(asNumber(record.currentStepIndex, 0)));
  run.sharedContextSnapshot = asOptionalString(record.sharedContextSnapshot) ?? "";
  run.lastError = asOptionalString(record.lastError);
  run.createdAt = asNumber(record.createdAt, now);
  run.updatedAt = asNumber(record.updatedAt, run.createdAt);
  run.steps = asArray(record.steps).map((step) => deps.restoreTeamRunStep(step)).filter((step): step is TeamRunStep => Boolean(step));
  const restoredMembers = deps.normalizeTeamMembers(asArray(record.membersSnapshot) as RestorableTeamMemberInput[]);
  run.membersSnapshot = restoredMembers.length > 0 ? restoredMembers : deps.teamMembersFromRunSteps(run.steps);
  return run;
}

export function restoreTeamRunStep(raw: unknown, deps: RestoreTeamRunStepDeps): TeamRunStep | null {
  const record = asRecord(raw);
  if (!record) return null;
  const configuredAgent = deps.configuredAgentOrDefault(asOptionalString(record.configuredAgentId));
  if (!configuredAgent) return null;
  return {
    id: asOptionalString(record.id) ?? randomUUID(),
    teamMemberId: asOptionalString(record.teamMemberId) ?? randomUUID(),
    roleName: asOptionalString(record.roleName) ?? "Agent",
    prompt: asOptionalString(record.prompt) ?? "",
    configuredAgentId: configuredAgent.id,
    status:
      isTeamRunStepStatus(record.status) && record.status !== "running" && record.status !== "queued"
        ? record.status
        : "failed",
    taskId: asOptionalString(record.taskId),
    artifact: asOptionalString(record.artifact),
    lastError: asOptionalString(record.lastError),
    startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
    completedAt: typeof record.completedAt === "number" ? record.completedAt : undefined,
  };
}
