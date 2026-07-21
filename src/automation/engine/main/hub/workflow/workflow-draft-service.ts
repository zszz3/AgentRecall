import type { AppSnapshot } from "../../../shared/types";
import type { CreateWorkflowDraftRequest, PatchWorkflowDraftRequest } from "../../../shared/workflow/commands";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowStore } from "../../workflow-store";

export class WorkflowDraftService {
  constructor(private readonly deps: {
    store: WorkflowStore;
    maxWorkflowCount: number;
    createWorkflowId: () => string;
    now: () => number;
    normalizeConfiguredAgentId: (configuredAgentId: string | undefined) => string;
    normalizeModelId: (configuredAgentId: string | undefined, modelId: string | undefined) => string;
    cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
    patchDraft: (draft: WorkflowDraftState, patch: PatchWorkflowDraftRequest) => WorkflowDraftState;
    clearDraftRequests: () => void;
    changed: () => void;
    snapshot: () => AppSnapshot;
  }) {}

  replace(draft: WorkflowDraftState | undefined): AppSnapshot {
    if (!draft) {
      this.deps.store.clearWorkflows();
      this.deps.clearDraftRequests();
      this.deps.store.clearRuns();
      this.deps.changed();
      return this.deps.snapshot();
    }
    const normalized = this.deps.cloneDraft(draft);
    this.deps.store.setWorkflow(normalized.workflowId, normalized);
    this.deps.store.activeId = normalized.workflowId;
    this.deps.changed();
    return this.deps.snapshot();
  }

  create(input: CreateWorkflowDraftRequest = {}): AppSnapshot {
    if (this.deps.store.workflowCount() >= this.deps.maxWorkflowCount) return this.deps.snapshot();
    const now = this.deps.now();
    const workflowId = this.deps.createWorkflowId();
    const configuredAgentId = this.deps.normalizeConfiguredAgentId(input.configuredAgentId);
    const modelId = this.deps.normalizeModelId(configuredAgentId, input.modelId);
    const reviewerConfiguredAgentId = this.deps.normalizeConfiguredAgentId(input.reviewerConfiguredAgentId ?? configuredAgentId);
    const reviewerModelId = this.deps.normalizeModelId(reviewerConfiguredAgentId, input.reviewerModelId ?? (reviewerConfiguredAgentId === configuredAgentId ? modelId : undefined));
    const workflow = this.deps.cloneDraft({
      workflowId,
      sourceType: "user",
      topologyLocked: false,
      title: input.title?.trim() || "Untitled workflow",
      status: "draft",
      revision: 1,
      configuredAgentId,
      modelId,
      reviewerConfiguredAgentId,
      reviewerModelId,
      objective: "",
      definition: { workflowId, graphVersion: 1, objective: "", nodes: [], edges: [] },
      messages: [],
      reply: "",
      error: undefined,
      runProgress: [],
      runContextDocument: "",
      contextDocument: "",
      runIds: [],
      createdAt: now,
      updatedAt: now,
    });
    this.deps.store.setWorkflow(workflow.workflowId, workflow);
    this.deps.store.activeId = workflow.workflowId;
    this.deps.changed();
    return this.deps.snapshot();
  }

  patch(input: PatchWorkflowDraftRequest): AppSnapshot {
    const current = this.deps.store.getWorkflow(input.workflowId);
    if (!current) return this.deps.snapshot();
    const next = this.deps.patchDraft(current, input);
    this.deps.store.setWorkflow(next.workflowId, next);
    this.deps.store.activeId = next.workflowId;
    this.deps.changed();
    return this.deps.snapshot();
  }
}
