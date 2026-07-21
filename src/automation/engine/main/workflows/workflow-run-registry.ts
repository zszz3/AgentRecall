export interface ActiveWorkflowRun {
  workflowId: string;
  runId: string;
  pausedNodeIds: Set<string>;
  pausedTaskIds: Set<string>;
  gatedNodeIds: Set<string>;
  taskIdByNodeId: Map<string, string>;
  manualPauseReasonByNodeId?: Map<string, string>;
  abortControllerByNodeId?: Map<string, AbortController>;
}

export class WorkflowRunRegistry {
  private readonly activeRuns = new Map<string, ActiveWorkflowRun>();
  private readonly stopRequests = new Set<string>();

  register(run: ActiveWorkflowRun): void {
    this.stopRequests.delete(run.runId);
    this.activeRuns.set(run.runId, run);
  }

  get(runId: string): ActiveWorkflowRun | undefined {
    return this.activeRuns.get(runId);
  }

  has(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  release(runId: string): void {
    this.activeRuns.delete(runId);
  }

  requestStop(runId: string): ActiveWorkflowRun | undefined {
    this.stopRequests.add(runId);
    return this.activeRuns.get(runId);
  }

  isStopRequested(runId: string): boolean {
    return this.stopRequests.has(runId);
  }
}
