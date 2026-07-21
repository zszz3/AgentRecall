import type {
  BuildWorkflowV2GraphRevisionRequest,
  BuildWorkflowV2GraphRevisionResult,
  BuildWorkflowV2PlanRequest,
  BuildWorkflowV2PlanResult,
} from "../../../shared/workflow/commands";
import { validateWorkflowV2Definition } from "../../../shared/workflow-v2/validation";
import { normalizeWorkflowV2TerminalNode } from "../../../shared/workflow-v2/topology";
import {
  buildWorkflowV2GraphRevision,
  buildWorkflowV2Plan,
  WorkflowV2PlanBuildError,
} from "../../workflows/v2/workflow-v2-planner";

export class WorkflowPlanningService {
  async buildPlan(input: BuildWorkflowV2PlanRequest): Promise<BuildWorkflowV2PlanResult> {
    let validation: ReturnType<typeof validateWorkflowV2Definition> | undefined;
    try {
      const definition = normalizeWorkflowV2TerminalNode(input.definition).definition;
      validation = validateWorkflowV2Definition(definition);
      if (!validation.valid) return { ok: false, error: validation.errors.join(" "), validation };
      const approvedBy = typeof input.approvedBy === "string" ? input.approvedBy.trim() : "";
      if (!approvedBy) return { ok: false, error: "Workflow V2 plan requires approvedBy.", validation };
      const plan = await buildWorkflowV2Plan({
        definition,
        approvedBy,
        ...(input.objective?.trim() ? { objective: input.objective.trim() } : {}),
        ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
        ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
        ...(input.costBudget ? { costBudget: input.costBudget } : {}),
        ...(input.roleModelProfiles ? { roleModelProfiles: input.roleModelProfiles } : {}),
      });
      return { ok: true, plan, validation };
    } catch (error) {
      return {
        ok: false,
        error: planningErrorMessage(error, "Workflow V2 plan build failed unexpectedly."),
        ...(validation ? { validation } : {}),
      };
    }
  }

  async buildGraphRevision(input: BuildWorkflowV2GraphRevisionRequest): Promise<BuildWorkflowV2GraphRevisionResult> {
    try {
      return { ok: true, revision: buildWorkflowV2GraphRevision(input) };
    } catch (error) {
      return { ok: false, error: planningErrorMessage(error, "Workflow V2 graph revision build failed unexpectedly.") };
    }
  }
}

function planningErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof WorkflowV2PlanBuildError) return [error.message, ...(error.details?.errors ?? [])].join(" ");
  return error instanceof Error ? error.message : fallback;
}
