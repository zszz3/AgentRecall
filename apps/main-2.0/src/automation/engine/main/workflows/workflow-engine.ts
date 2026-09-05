import { workflowNodeInputKey } from "../../shared/workflow/model";
import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunEventType,
} from "../../shared/workflow/model";
import { validateWorkflowNodeOutputs } from "../../shared/workflow/output";
import {
  deriveWorkflowRunStatus,
  invalidateWorkflowDownstream,
  readyWorkflowNodeIds,
} from "../../shared/workflow/scheduler";
import { validateWorkflowDefinition } from "../../shared/workflow/validation";

export interface WorkflowEngineStore {
  getRun(runId: string): Promise<WorkflowRun | undefined>;
  saveRun(run: WorkflowRun): Promise<void>;
}

export interface WorkflowExecutionInput<N extends WorkflowNode = WorkflowNode> {
  run: WorkflowRun;
  node: N;
  resolvedInputs: Record<string, unknown>;
  workDir?: string;
  signal: AbortSignal;
}

export interface WorkflowNodeExecutor<N extends WorkflowNode = WorkflowNode> {
  execute(input: WorkflowExecutionInput<N>): Promise<Record<string, unknown>>;
  cancel?(runId: string, nodeId: string): Promise<void>;
}

export interface WorkflowEngineOptions {
  store: WorkflowEngineStore;
  executors: Partial<Record<Exclude<WorkflowNode["kind"], "approval">, WorkflowNodeExecutor>>;
  createId: () => string;
  defaultWorkDir?: () => string;
  now?: () => number;
  // Fired once a run reaches a terminal status (completed/failed/cancelled),
  // so callers can drop per-run caches; pause/resume does not fire it.
  onRunSettled?: (runId: string) => void;
}

function cloneRun(run: WorkflowRun): WorkflowRun {
  return structuredClone(run);
}

function runError(error: unknown): { code: string; message: string } {
  return { code: "execution_failed", message: error instanceof Error ? error.message : String(error) };
}

export class WorkflowEngine {
  private readonly store: WorkflowEngineStore;
  private readonly executors: WorkflowEngineOptions["executors"];
  private readonly createId: () => string;
  private readonly defaultWorkDir: () => string;
  private readonly now: () => number;
  private readonly onRunSettled?: (runId: string) => void;
  private readonly controllers = new Map<string, AbortController>();
  private readonly driveEpochs = new Map<string, number>();

  constructor(options: WorkflowEngineOptions) {
    this.store = options.store;
    this.executors = options.executors;
    this.createId = options.createId;
    this.defaultWorkDir = options.defaultWorkDir ?? (() => process.cwd());
    this.now = options.now ?? Date.now;
    this.onRunSettled = options.onRunSettled;
  }

  private workDir(definition: WorkflowDefinition): string {
    return definition.workDir || this.defaultWorkDir();
  }

  async start(definition: WorkflowDefinition, inputs: Record<string, unknown>): Promise<WorkflowRun> {
    const definitionIssues = validateWorkflowDefinition(definition);
    if (definitionIssues.length > 0) throw new Error(`Invalid Workflow definition: ${definitionIssues[0]!.path}: ${definitionIssues[0]!.message}`);
    for (const input of definition.inputs) {
      if (input.required && (!Object.hasOwn(inputs, input.key) || inputs[input.key] === undefined)) {
        throw new Error(`Required Workflow input ${input.key} is missing.`);
      }
    }
    const run: WorkflowRun = {
      id: this.createId(),
      workflowId: definition.id,
      definition: structuredClone(definition),
      inputs: structuredClone(inputs),
      status: "running",
      nodeRuns: Object.fromEntries(definition.nodes.map((node) => [node.id, {
        nodeId: node.id,
        status: "pending",
        attempt: 0,
      } satisfies WorkflowNodeRun])),
      events: [],
      startedAt: this.now(),
    };
    this.record(run, "run_started");
    await this.store.saveRun(run);
    this.startDrive(run);
    return cloneRun(run);
  }

  async retryNode(runId: string, nodeId: string): Promise<WorkflowRun> {
    const current = await this.requiredRun(runId);
    if (!current.definition.nodes.some((node) => node.id === nodeId)) throw new Error(`Workflow node ${nodeId} does not exist.`);
    const next = invalidateWorkflowDownstream(current.definition, current, [nodeId]);
    this.record(next, "node_retried", { nodeId, attempt: next.nodeRuns[nodeId]?.attempt });
    await this.store.saveRun(next);
    this.startDrive(next);
    return cloneRun(next);
  }

  async resolveApproval(runId: string, nodeId: string, outputs: Record<string, unknown>): Promise<WorkflowRun> {
    const run = await this.requiredRun(runId);
    const node = run.definition.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== "approval") throw new Error(`Workflow approval node ${nodeId} does not exist.`);
    const state = run.nodeRuns[nodeId];
    if (state?.status !== "waiting") throw new Error(`Workflow approval node ${nodeId} is not waiting.`);
    const validationIssues = validateWorkflowNodeOutputs(node, outputs);
    if (validationIssues.length > 0) throw new Error(`${validationIssues[0]!.path}: ${validationIssues[0]!.message}`);
    if (typeof outputs.decision === "string" && !node.options.some((option) => option.value === outputs.decision)) {
      throw new Error("outputs.decision: Approval decision is not one of the declared options.");
    }
    state.status = "completed";
    state.outputs = structuredClone(outputs);
    state.finishedAt = this.now();
    delete state.error;
    run.status = "running";
    this.record(run, "approval_resolved", { nodeId, attempt: state.attempt });
    await this.store.saveRun(run);
    this.startDrive(run);
    return cloneRun(run);
  }

  async pause(runId: string): Promise<WorkflowRun> {
    const active = await this.requiredRun(runId);
    if (active.status === "paused") return cloneRun(active);
    if (active.status !== "running") throw new Error(`Workflow Run ${runId} is not running.`);
    this.controllers.get(runId)?.abort();
    await Promise.allSettled(active.definition.nodes.map(async (node) => {
      if (active.nodeRuns[node.id]?.status !== "running") return;
      await this.executors[node.kind as Exclude<WorkflowNode["kind"], "approval">]?.cancel?.(runId, node.id);
    }));

    const run = await this.requiredRun(runId);
    if (run.status !== "running") return cloneRun(run);
    for (const state of Object.values(run.nodeRuns)) {
      if (state.status !== "ready" && state.status !== "running") continue;
      state.status = "pending";
      delete state.resolvedInputs;
      delete state.outputs;
      delete state.error;
      delete state.startedAt;
      delete state.finishedAt;
    }
    run.status = "paused";
    delete run.finishedAt;
    this.record(run, "run_paused");
    await this.store.saveRun(run);
    return cloneRun(run);
  }

  async resume(runId: string): Promise<WorkflowRun> {
    const run = await this.requiredRun(runId);
    if (run.status === "running") return cloneRun(run);
    if (run.status !== "paused") throw new Error(`Workflow Run ${runId} is not paused.`);
    run.status = "running";
    delete run.finishedAt;
    this.record(run, "run_resumed");
    await this.store.saveRun(run);
    this.startDrive(run);
    return cloneRun(run);
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    const run = await this.requiredRun(runId);
    this.controllers.get(runId)?.abort();
    await Promise.allSettled(run.definition.nodes.map(async (node) => {
      if (run.nodeRuns[node.id]?.status !== "running") return;
      await this.executors[node.kind as Exclude<WorkflowNode["kind"], "approval">]?.cancel?.(runId, node.id);
    }));
    for (const state of Object.values(run.nodeRuns)) {
      if (state.status === "pending" || state.status === "ready" || state.status === "running" || state.status === "waiting") {
        state.status = "cancelled";
        state.finishedAt = this.now();
      }
    }
    run.status = "cancelled";
    run.finishedAt = this.now();
    this.record(run, "run_cancelled");
    await this.store.saveRun(run);
    this.onRunSettled?.(runId);
    return cloneRun(run);
  }

  private record(
    run: WorkflowRun,
    type: WorkflowRunEventType,
    details: Pick<WorkflowRunEvent, "nodeId" | "attempt" | "durationMs" | "errorCode"> = {},
  ): void {
    const previousSequence = run.events.at(-1)?.sequence ?? 0;
    run.events.push({ sequence: previousSequence + 1, type, timestamp: this.now(), ...details });
  }

  private startDrive(run: WorkflowRun): void {
    // Supersede any loop still driving this run: it holds a stale copy whose
    // next save would roll back the state this call just persisted.
    this.controllers.get(run.id)?.abort();
    const epoch = (this.driveEpochs.get(run.id) ?? 0) + 1;
    this.driveEpochs.set(run.id, epoch);
    void this.driveInBackground(run, epoch).catch(() => undefined);
  }

  private async driveInBackground(run: WorkflowRun, epoch: number): Promise<void> {
    try {
      await this.drive(run, epoch);
    } catch (error) {
      if (this.driveEpochs.get(run.id) !== epoch) return;
      const current = await this.store.getRun(run.id);
      if (!current || current.status !== "running") return;
      const failure = runError(error);
      for (const state of Object.values(current.nodeRuns)) {
        if (state.status !== "ready" && state.status !== "running") continue;
        state.status = "failed";
        state.error = failure;
        state.finishedAt = this.now();
        this.record(current, "node_failed", {
          nodeId: state.nodeId,
          attempt: state.attempt,
          durationMs: state.startedAt === undefined ? undefined : Math.max(0, state.finishedAt - state.startedAt),
          errorCode: failure.code,
        });
      }
      current.status = "failed";
      current.finishedAt = this.now();
      this.record(current, "run_failed", { errorCode: failure.code });
      await this.store.saveRun(current);
      this.onRunSettled?.(current.id);
    } finally {
      if (this.driveEpochs.get(run.id) === epoch) this.driveEpochs.delete(run.id);
    }
  }

  private async requiredRun(runId: string): Promise<WorkflowRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Workflow Run ${runId} does not exist.`);
    return run;
  }

  private resolveInputs(run: WorkflowRun, node: WorkflowNode): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const input of node.inputs) {
      let value: unknown;
      if (input.source === "workflow") value = run.inputs[input.workflowInputKey];
      if (input.source === "node") value = run.nodeRuns[input.nodeId]?.outputs?.[input.outputKey];
      const required = input.source === "workflow"
        ? run.definition.inputs.find((candidate) => candidate.key === input.workflowInputKey)?.required
        : run.definition.nodes.find((candidate) => candidate.id === input.nodeId)?.outputs.find((output) => output.key === input.outputKey)?.required;
      const key = workflowNodeInputKey(input);
      if (required && value === undefined) throw new Error(`Required node input ${node.id}.${key} is unavailable.`);
      resolved[key] = structuredClone(value);
    }
    return resolved;
  }

  private async drive(inputRun: WorkflowRun, epoch: number): Promise<WorkflowRun> {
    const run = cloneRun(inputRun);
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const superseded = (): boolean => this.driveEpochs.get(run.id) !== epoch;
    // Nodes still marked running were left behind by the superseded loop's
    // executors; requeue them so this loop owns their execution (the same
    // requeue semantics pause/resume already use).
    for (const state of Object.values(run.nodeRuns)) {
      if (state.status !== "running") continue;
      state.status = "ready";
      delete state.startedAt;
      delete state.finishedAt;
    }
    try {
      while (!controller.signal.aborted && !superseded()) {
        const readyIds = readyWorkflowNodeIds(run.definition, run);
        if (readyIds.length === 0) break;

        const executable: Array<{ node: WorkflowNode; state: WorkflowNodeRun; resolvedInputs: Record<string, unknown>; executor: WorkflowNodeExecutor }> = [];
        for (const nodeId of readyIds) {
          const node = run.definition.nodes.find((candidate) => candidate.id === nodeId)!;
          const state = run.nodeRuns[nodeId]!;
          state.attempt += 1;
          state.startedAt = this.now();
          delete state.finishedAt;
          delete state.outputs;
          delete state.error;
          try {
            state.resolvedInputs = this.resolveInputs(run, node);
          } catch (error) {
            state.status = "failed";
            state.error = runError(error);
            state.finishedAt = this.now();
            this.record(run, "node_failed", { nodeId, attempt: state.attempt, errorCode: state.error.code });
            continue;
          }
          if (node.kind === "approval") {
            state.status = "waiting";
            this.record(run, "node_waiting", { nodeId, attempt: state.attempt });
            continue;
          }
          const executor = this.executors[node.kind];
          if (!executor) {
            state.status = "failed";
            state.error = { code: "executor_unavailable", message: `No ${node.kind} executor is configured.` };
            state.finishedAt = this.now();
            this.record(run, "node_failed", { nodeId, attempt: state.attempt, errorCode: state.error.code });
            continue;
          }
          state.status = "running";
          this.record(run, "node_started", { nodeId, attempt: state.attempt });
          executable.push({ node, state, resolvedInputs: state.resolvedInputs, executor });
        }
        if (superseded()) return this.requiredRun(run.id);
        await this.store.saveRun(run);

        const results = await Promise.all(executable.map(async (item) => {
          try {
            const outputs = await item.executor.execute({
              run: cloneRun(run),
              node: item.node,
              resolvedInputs: item.resolvedInputs,
              workDir: this.workDir(run.definition),
              signal: controller.signal,
            });
            return { item, outputs } as const;
          } catch (error) {
            return { item, error } as const;
          }
        }));

        if (controller.signal.aborted || superseded()) return this.requiredRun(run.id);
        for (const result of results) {
          const { state, node } = result.item;
          if ("error" in result) {
            state.status = "failed";
            state.error = runError(result.error);
            state.finishedAt = this.now();
            this.record(run, "node_failed", {
              nodeId: node.id,
              attempt: state.attempt,
              durationMs: Math.max(0, state.finishedAt - (state.startedAt ?? state.finishedAt)),
              errorCode: state.error.code,
            });
            continue;
          }
          const validationIssues = validateWorkflowNodeOutputs(node, result.outputs);
          if (validationIssues.length > 0) {
            state.status = "failed";
            state.error = {
              code: "invalid_output",
              message: validationIssues[0]!.message,
              fieldPath: validationIssues[0]!.path,
            };
            state.finishedAt = this.now();
            this.record(run, "node_failed", {
              nodeId: node.id,
              attempt: state.attempt,
              durationMs: Math.max(0, state.finishedAt - (state.startedAt ?? state.finishedAt)),
              errorCode: state.error.code,
            });
            continue;
          }
          state.status = "completed";
          state.outputs = structuredClone(result.outputs);
          state.finishedAt = this.now();
          this.record(run, "node_completed", {
            nodeId: node.id,
            attempt: state.attempt,
            durationMs: Math.max(0, state.finishedAt - (state.startedAt ?? state.finishedAt)),
          });
        }

        let revised = false;
        for (const result of results) {
          const { node, state } = result.item;
          if (node.kind !== "review" || state.status !== "completed" || state.outputs?.verdict !== "revise") continue;
          if (node.onReject === "revise" && state.attempt <= node.maxRevisions) {
            const feedback = String(state.outputs.feedback);
            const previousFeedback = Object.fromEntries(node.targetNodeIds.map((targetNodeId) => [
              targetNodeId,
              run.nodeRuns[targetNodeId]?.revisionFeedback ?? [],
            ]));
            const next = invalidateWorkflowDownstream(run.definition, run, node.targetNodeIds);
            for (const targetNodeId of node.targetNodeIds) {
              const target = next.nodeRuns[targetNodeId];
              if (target) target.revisionFeedback = [...previousFeedback[targetNodeId]!, feedback];
            }
            run.nodeRuns = next.nodeRuns;
            run.status = "running";
            this.record(run, "review_revised", { nodeId: node.id, attempt: state.attempt });
            revised = true;
          } else {
            state.status = "failed";
            state.error = { code: "review_rejected", message: String(state.outputs.feedback ?? "Review rejected the output.") };
            state.finishedAt = this.now();
            this.record(run, "node_failed", {
              nodeId: node.id,
              attempt: state.attempt,
              durationMs: Math.max(0, state.finishedAt - (state.startedAt ?? state.finishedAt)),
              errorCode: state.error.code,
            });
          }
          break;
        }
        if (superseded() || controller.signal.aborted) return this.requiredRun(run.id);
        await this.store.saveRun(run);
        if (revised) continue;
      }

      // An aborted loop must not derive a status from its stale clone: pause/cancel
      // already persisted the run's real state, and saving here would resurrect it.
      if (superseded() || controller.signal.aborted) return this.requiredRun(run.id);
      run.status = deriveWorkflowRunStatus(run.definition, run);
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        run.finishedAt = this.now();
        this.record(run, run.status === "completed" ? "run_completed" : run.status === "failed" ? "run_failed" : "run_cancelled");
        this.onRunSettled?.(run.id);
      }
      await this.store.saveRun(run);
      return cloneRun(run);
    } finally {
      if (this.controllers.get(run.id) === controller) this.controllers.delete(run.id);
    }
  }
}
