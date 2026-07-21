import type {
  AnswerWorkflowGateRequest,
  PauseWorkflowNodeRequest,
  ReviseWorkflowV2RunRequest,
  ResolveWorkflowV2InterventionRequest,
  RunWorkflowRequest,
  StartWorkflowNodeRequest,
  StopWorkflowRunRequest,
  SubmitWorkflowScriptInputRequest,
  WorkflowOperationResult,
} from "../../../shared/workflow/commands";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowRuntime } from "../../workflows/workflow-runtime";
import type { WorkflowStore } from "../../workflow-store";
import { WorkflowRunRevisionService } from "./workflow-run-revision-service";

export class WorkflowRunService {
  constructor(private readonly deps: {
    runtime: WorkflowRuntime;
    store: WorkflowStore;
    cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
    changed: () => void;
    now: () => number;
  }) {}

  run(input: RunWorkflowRequest): WorkflowOperationResult {
    const result = this.deps.runtime.runWorkflow(input);
    if (result.ok || !result.error) return result;
    const workflow = this.deps.store.workflows.get(input.workflowId);
    if (!workflow) return result;
    this.deps.store.workflows.set(workflow.workflowId, this.deps.cloneDraft({
      ...workflow,
      error: result.error,
      updatedAt: this.deps.now(),
    }));
    this.deps.changed();
    return result;
  }

  pauseNode(input: PauseWorkflowNodeRequest): Promise<WorkflowOperationResult> {
    return this.deps.runtime.pauseWorkflowNode(input);
  }

  revise(input: ReviseWorkflowV2RunRequest): Promise<WorkflowOperationResult> {
    return new WorkflowRunRevisionService(this.deps).reviseAndResume(input);
  }

  resolveIntervention(input: ResolveWorkflowV2InterventionRequest): Promise<WorkflowOperationResult> {
    return this.deps.runtime.resolveWorkflowV2Intervention(input);
  }

  stop(input: StopWorkflowRunRequest): Promise<WorkflowOperationResult> {
    return this.deps.runtime.stopWorkflowRun(input);
  }

  startNode(input: StartWorkflowNodeRequest): Promise<WorkflowOperationResult> {
    return this.deps.runtime.startWorkflowNode(input);
  }

  answerGate(input: AnswerWorkflowGateRequest): Promise<WorkflowOperationResult> {
    return this.deps.runtime.answerWorkflowGate(input);
  }

  submitScriptInput(input: SubmitWorkflowScriptInputRequest): Promise<WorkflowOperationResult> {
    return this.deps.runtime.submitWorkflowScriptInput(input);
  }
}
