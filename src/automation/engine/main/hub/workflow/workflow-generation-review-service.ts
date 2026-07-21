import type { WorkflowAgentResponse, WorkflowDraftState } from "../../../shared/types";
import type { WorkflowV2GenerationReviewState } from "../../../shared/workflow-v2/generation-review";
import { parseWorkflowV2GenerationReview, workflowV2GenerationReviewPrompt } from "../../workflows/v2/workflow-v2-generation-review";

export async function executeWorkflowGenerationReview(input: {
  workflow: WorkflowDraftState;
  askReviewer: (prompt: string) => Promise<WorkflowAgentResponse>;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<WorkflowV2GenerationReviewState> {
  const now = input.now ?? Date.now;
  try {
    const response = await input.askReviewer(workflowV2GenerationReviewPrompt({ definition: input.workflow.definition, revision: input.workflow.revision }));
    const result = parseWorkflowV2GenerationReview({ definition: input.workflow.definition, revision: input.workflow.revision, content: response.content });
    return { status: result.verdict === "approve" ? "approved" : "changes_requested", reviewerConfiguredAgentId: input.workflow.reviewerConfiguredAgentId, reviewerModelId: input.workflow.reviewerModelId, reviewedRevision: input.workflow.revision, result, updatedAt: now() };
  } catch (error) {
    if (input.signal?.aborted) return { status: "not_reviewed", reviewerConfiguredAgentId: input.workflow.reviewerConfiguredAgentId, reviewerModelId: input.workflow.reviewerModelId, reviewedRevision: input.workflow.revision, updatedAt: now() };
    return { status: "failed", reviewerConfiguredAgentId: input.workflow.reviewerConfiguredAgentId, reviewerModelId: input.workflow.reviewerModelId, reviewedRevision: input.workflow.revision, error: error instanceof Error ? error.message : String(error), updatedAt: now() };
  }
}

export async function runWorkflowGenerationReviewLifecycle(input: {
  workflow: WorkflowDraftState;
  askReviewer: (prompt: string) => Promise<WorkflowAgentResponse>;
  publish: (workflow: WorkflowDraftState) => void;
  current: () => WorkflowDraftState | undefined;
  flush: () => Promise<void>;
  clone: (workflow: WorkflowDraftState) => WorkflowDraftState;
  signal?: AbortSignal;
}): Promise<void> {
  const { workflow } = input;
  input.publish(input.clone({ ...workflow, generationReview: { status: "reviewing", reviewerConfiguredAgentId: workflow.reviewerConfiguredAgentId, reviewerModelId: workflow.reviewerModelId, reviewedRevision: workflow.revision, updatedAt: Date.now() }, updatedAt: Date.now() }));
  await input.flush();
  const review = await executeWorkflowGenerationReview({ workflow, askReviewer: input.askReviewer, ...(input.signal ? { signal: input.signal } : {}) });
  if (input.signal?.aborted) return;
  const current = input.current();
  if (!current || current.revision !== workflow.revision || current.reviewerConfiguredAgentId !== workflow.reviewerConfiguredAgentId || current.reviewerModelId !== workflow.reviewerModelId) return;
  input.publish(input.clone({ ...current, generationReview: review, updatedAt: Date.now() }));
  await input.flush();
}

export function interruptWorkflowGenerationReviewState(workflow: WorkflowDraftState, now = Date.now()): WorkflowDraftState | undefined {
  if (workflow.generationReview?.status !== "reviewing") return undefined;
  return { ...workflow, generationReview: { status: "not_reviewed", reviewerConfiguredAgentId: workflow.reviewerConfiguredAgentId, reviewerModelId: workflow.reviewerModelId, reviewedRevision: workflow.revision, updatedAt: now }, updatedAt: now };
}

export class WorkflowGenerationReviewCoordinator {
  private readonly controllers = new Map<string, AbortController>();

  async run(input: Omit<Parameters<typeof runWorkflowGenerationReviewLifecycle>[0], "signal" | "askReviewer"> & { askReviewer: (prompt: string, signal: AbortSignal) => Promise<WorkflowAgentResponse> }): Promise<void> {
    this.controllers.get(input.workflow.workflowId)?.abort();
    const controller = new AbortController();
    this.controllers.set(input.workflow.workflowId, controller);
    try { await runWorkflowGenerationReviewLifecycle({ ...input, askReviewer: (prompt) => input.askReviewer(prompt, controller.signal), signal: controller.signal }); }
    finally { if (this.controllers.get(input.workflow.workflowId) === controller) this.controllers.delete(input.workflow.workflowId); }
  }

  async interrupt(input: { workflow: WorkflowDraftState; publish: (workflow: WorkflowDraftState) => void; flush: () => Promise<void>; clone: (workflow: WorkflowDraftState) => WorkflowDraftState }): Promise<void> {
    this.controllers.get(input.workflow.workflowId)?.abort();
    const interrupted = interruptWorkflowGenerationReviewState(input.workflow);
    if (!interrupted) return;
    input.publish(input.clone(interrupted));
    await input.flush();
  }
}
