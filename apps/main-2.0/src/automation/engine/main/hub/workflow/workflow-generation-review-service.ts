import { randomUUID } from "node:crypto";
import type { WorkflowAgentEvent, WorkflowAgentResponse, WorkflowDraftState } from "../../../shared/types";
import type { WorkflowV2GenerationReviewState } from "../../../shared/workflow-v2/generation-review";
import type { WorkflowV2GenerationReviewResult } from "../../../shared/workflow-v2/generation-review";
import type { WorkflowV2ReviewTraceEntry } from "../../../shared/workflow-v2/review";
import { parseWorkflowV2GenerationReview, workflowV2GenerationReviewPrompt } from "../../workflows/v2/workflow-v2-generation-review";

export async function executeWorkflowGenerationReview(input: {
  workflow: WorkflowDraftState;
  askReviewer: (prompt: string, onEvent?: (event: WorkflowAgentEvent) => void) => Promise<WorkflowAgentResponse>;
  onTrace?: (trace: WorkflowV2ReviewTraceEntry[]) => void;
  takeSubmittedResult?: () => WorkflowV2GenerationReviewResult | undefined;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<WorkflowV2GenerationReviewState> {
  const now = input.now ?? Date.now;
  const prompt = workflowV2GenerationReviewPrompt({ definition: input.workflow.definition, revision: input.workflow.revision, conversation: input.workflow.messages });
  const trace: WorkflowV2ReviewTraceEntry[] = [{ id: randomUUID(), kind: "request", at: now(), content: prompt }];
  input.onTrace?.(structuredClone(trace));
  try {
    let response: WorkflowAgentResponse;
    try {
      response = await input.askReviewer(prompt, (event) => {
        const entry = workflowAgentEventTraceEntry(event, now);
        if (!entry) return;
        trace.push(entry);
        input.onTrace?.(structuredClone(trace));
      });
    } catch (error) {
      const submittedResult = input.takeSubmittedResult?.();
      if (submittedResult) {
        return { status: submittedResult.verdict === "approve" ? "approved" : "changes_requested", reviewerConfiguredAgentId: input.workflow.reviewerConfiguredAgentId, reviewerModelId: input.workflow.reviewerModelId, reviewedRevision: input.workflow.revision, result: submittedResult, trace, updatedAt: now() };
      }
      throw error;
    }
    trace.push({
      id: randomUUID(),
      kind: "response",
      at: now(),
      content: response.content,
      ...(response.executionReference ? { metadata: { ...structuredClone(response.executionReference) } } : {}),
    });
    input.onTrace?.(structuredClone(trace));
    const result = input.takeSubmittedResult?.()
      ?? parseWorkflowV2GenerationReview({ definition: input.workflow.definition, revision: input.workflow.revision, content: response.content });
    return { status: result.verdict === "approve" ? "approved" : "changes_requested", reviewerConfiguredAgentId: input.workflow.reviewerConfiguredAgentId, reviewerModelId: input.workflow.reviewerModelId, reviewedRevision: input.workflow.revision, result, trace, updatedAt: now() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!trace.some((entry) => entry.kind === "error" && entry.content === message)) {
      trace.push({ id: randomUUID(), kind: "error", at: now(), content: message });
      input.onTrace?.(structuredClone(trace));
    }
    if (input.signal?.aborted) return { status: "not_reviewed", reviewerConfiguredAgentId: input.workflow.reviewerConfiguredAgentId, reviewerModelId: input.workflow.reviewerModelId, reviewedRevision: input.workflow.revision, trace, updatedAt: now() };
    return { status: "failed", reviewerConfiguredAgentId: input.workflow.reviewerConfiguredAgentId, reviewerModelId: input.workflow.reviewerModelId, reviewedRevision: input.workflow.revision, error: message, trace, updatedAt: now() };
  }
}

function workflowAgentEventTraceEntry(event: WorkflowAgentEvent, now: () => number): WorkflowV2ReviewTraceEntry | undefined {
  if (event.type === "delta" || event.type === "completed") return undefined;
  if (event.type === "error") return { id: randomUUID(), kind: "error", at: now(), content: event.error };
  const metadata: Record<string, unknown> = {
    ...(event.metadata ?? {}),
    requestId: event.requestId,
    ...(event.type === "approval_request" || event.type === "approval_response" ? { approvalRequestId: event.approvalRequestId } : {}),
    ...(event.type === "approval_response" ? { decision: event.decision } : {}),
  };
  return {
    id: randomUUID(),
    kind: event.type,
    at: now(),
    content: event.content ?? event.type.replaceAll("_", " "),
    ...(event.type === "tool_call" || event.type === "tool_result" ? event.name ? { name: event.name } : {} : {}),
    metadata,
  };
}

export async function runWorkflowGenerationReviewLifecycle(input: {
  workflow: WorkflowDraftState;
  askReviewer: (prompt: string, onEvent?: (event: WorkflowAgentEvent) => void) => Promise<WorkflowAgentResponse>;
  publish: (workflow: WorkflowDraftState) => void;
  current: () => WorkflowDraftState | undefined;
  flush: () => Promise<void>;
  clone: (workflow: WorkflowDraftState) => WorkflowDraftState;
  takeSubmittedResult?: () => WorkflowV2GenerationReviewResult | undefined;
  signal?: AbortSignal;
}): Promise<void> {
  const { workflow } = input;
  input.publish(input.clone({ ...workflow, generationReview: { status: "reviewing", reviewerConfiguredAgentId: workflow.reviewerConfiguredAgentId, reviewerModelId: workflow.reviewerModelId, reviewedRevision: workflow.revision, updatedAt: Date.now() }, updatedAt: Date.now() }));
  await input.flush();
  const review = await executeWorkflowGenerationReview({
    workflow,
    askReviewer: input.askReviewer,
    onTrace: (trace) => {
      const current = input.current();
      if (!current || current.revision !== workflow.revision || current.reviewerConfiguredAgentId !== workflow.reviewerConfiguredAgentId || current.reviewerModelId !== workflow.reviewerModelId) return;
      input.publish(input.clone({
        ...current,
        generationReview: { ...current.generationReview!, trace, updatedAt: Date.now() },
        updatedAt: Date.now(),
      }));
    },
    ...(input.takeSubmittedResult ? { takeSubmittedResult: input.takeSubmittedResult } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (input.signal?.aborted) return;
  const current = input.current();
  if (!current || current.revision !== workflow.revision || current.reviewerConfiguredAgentId !== workflow.reviewerConfiguredAgentId || current.reviewerModelId !== workflow.reviewerModelId) return;
  input.publish(input.clone({ ...current, generationReview: review, updatedAt: Date.now() }));
  await input.flush();
}

export function interruptWorkflowGenerationReviewState(workflow: WorkflowDraftState, now = Date.now()): WorkflowDraftState | undefined {
  if (workflow.generationReview?.status !== "reviewing") return undefined;
  return { ...workflow, generationReview: { status: "not_reviewed", reviewerConfiguredAgentId: workflow.reviewerConfiguredAgentId, reviewerModelId: workflow.reviewerModelId, reviewedRevision: workflow.revision, ...(workflow.generationReview.trace ? { trace: structuredClone(workflow.generationReview.trace) } : {}), updatedAt: now }, updatedAt: now };
}

export class WorkflowGenerationReviewCoordinator {
  private readonly controllers = new Map<string, AbortController>();

  async run(input: Omit<Parameters<typeof runWorkflowGenerationReviewLifecycle>[0], "signal" | "askReviewer"> & { askReviewer: (prompt: string, onEvent: ((event: WorkflowAgentEvent) => void) | undefined, signal: AbortSignal) => Promise<WorkflowAgentResponse> }): Promise<void> {
    this.controllers.get(input.workflow.workflowId)?.abort();
    const controller = new AbortController();
    this.controllers.set(input.workflow.workflowId, controller);
    try { await runWorkflowGenerationReviewLifecycle({ ...input, askReviewer: (prompt, onEvent) => input.askReviewer(prompt, onEvent, controller.signal), signal: controller.signal }); }
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
