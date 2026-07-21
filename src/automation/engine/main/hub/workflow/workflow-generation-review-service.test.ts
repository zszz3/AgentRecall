import { describe, expect, test } from "vitest";
import type { WorkflowDraftState } from "../../../shared/types";
import { executeWorkflowGenerationReview, interruptWorkflowGenerationReviewState, runWorkflowGenerationReviewLifecycle } from "./workflow-generation-review-service";

const workflow = { workflowId: "wf", title: "Review", status: "draft", revision: 3, configuredAgentId: "manager", modelId: "manager-model", reviewerConfiguredAgentId: "reviewer", reviewerModelId: "review-model", objective: "Answer", definition: { workflowId: "wf", graphVersion: 1, objective: "Answer", nodes: [], edges: [] }, messages: [], reply: "", error: undefined, runProgress: [], runContextDocument: "", contextDocument: "", runIds: [], createdAt: 1, updatedAt: 1 } satisfies WorkflowDraftState;

describe("executeWorkflowGenerationReview", () => {
  test("returns a user-first unreviewed state when an active review is interrupted", () => {
    expect(interruptWorkflowGenerationReviewState({ ...workflow, generationReview: { status: "reviewing", reviewerConfiguredAgentId: "reviewer", reviewerModelId: "review-model", reviewedRevision: 3, updatedAt: 1 } }, 9)).toMatchObject({ generationReview: { status: "not_reviewed", updatedAt: 9 }, updatedAt: 9 });
  });
  test("binds approval to the exact workflow revision and reviewer route", async () => {
    const state = await executeWorkflowGenerationReview({ workflow, askReviewer: async () => ({ content: '{"verdict":"approve","reviewedRevision":3,"summary":"Good","findings":[],"scriptRisks":{},"suggestions":[]}' }), now: () => 9 });
    expect(state).toMatchObject({ status: "approved", reviewedRevision: 3, reviewerConfiguredAgentId: "reviewer", reviewerModelId: "review-model", updatedAt: 9 });
  });

  test("persists parse failures instead of implicitly approving", async () => {
    const state = await executeWorkflowGenerationReview({ workflow, askReviewer: async () => ({ content: "not-json" }), now: () => 9 });
    expect(state).toMatchObject({ status: "failed", reviewedRevision: 3, error: expect.any(String) });
  });

  test("does not publish a late result after the user interrupts it", async () => {
    const controller = new AbortController();
    let current: WorkflowDraftState = workflow;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = runWorkflowGenerationReviewLifecycle({
      workflow,
      signal: controller.signal,
      askReviewer: async () => { await waiting; throw controller.signal.reason; },
      publish: (next) => { current = next; },
      current: () => current,
      flush: async () => undefined,
      clone: (next) => structuredClone(next),
    });
    expect(current.generationReview?.status).toBe("reviewing");
    controller.abort(new Error("Review interrupted by user."));
    current = { ...current, generationReview: { status: "not_reviewed", reviewerConfiguredAgentId: workflow.reviewerConfiguredAgentId, reviewerModelId: workflow.reviewerModelId, reviewedRevision: workflow.revision, updatedAt: 2 } };
    release();
    await lifecycle;
    expect(current.generationReview?.status).toBe("not_reviewed");
  });
});
