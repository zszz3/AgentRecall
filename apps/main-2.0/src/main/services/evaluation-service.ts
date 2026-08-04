import type {
  ConfiguredAgent,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationRunPage,
  ListEvaluationRunsRequest,
} from "../../automation/contracts";
import { runEvaluation } from "../../automation/engine/main/evaluation-runner";
import type { EvaluationStore } from "../../automation/engine/main/evaluation-store";

export type EvaluationAgentExecution = (
  configuredAgentId: string,
  prompt: string,
  signal?: AbortSignal,
) => Promise<{ output: string; durationMs: number }>;

// Rubric for auto-provisioned judges. The runner appends the JSON return
// contract (score/reason/evidence/failedCriteria) on its own. Exported so the
// managed-definition sync in ensureBuiltinJudge and its tests share one source.
export const BUILTIN_JUDGE_PROMPT = `You are an impartial evaluator judging an AI agent's response to a task.

Task given to the agent:
{{input}}

Agent's response:
{{output}}

Expected outcome (may be empty when the task has no fixed answer):
{{ground_truth}}

Judge the response on:
1. Task completion — did the response actually accomplish the task?
2. Accuracy — are the stated facts correct and consistent with the expected outcome when one is provided?
3. Quality — is the response complete, actionable, and free of irrelevant filler?

Score from 0 (failed completely) to 1 (fully accomplished). Be strict about task completion, but fair about wording differences. When no expected outcome is provided, judge completion and quality only.

Write the reason, evidence and failedCriteria fields in Chinese (简体中文).`;

export interface EvaluationServiceDependencies {
  store: EvaluationStore;
  agents: () => ConfiguredAgent[];
  executeAgent: EvaluationAgentExecution;
}

export class EvaluationService {
  // Live controllers keyed by run id, so a polling client can cancel a
  // background run cooperatively.
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(private readonly dependencies: EvaluationServiceDependencies) {}

  listDatasets(): Promise<EvaluationDataset[]> {
    return this.dependencies.store.listDatasets();
  }

  saveDataset(value: EvaluationDataset): Promise<EvaluationDataset> {
    return this.dependencies.store.saveDataset(value);
  }

  deleteDataset(id: string): Promise<unknown> {
    return this.dependencies.store.deleteDataset(id);
  }

  // Idempotently provisions the built-in LLM judge bound to the execution
  // agent's own channel, so skill regression suites never require the user to
  // configure a separate judge runtime first. The judge is code-managed: one
  // per channel, and a persisted definition that drifted from the code (e.g.
  // an older rubric) is synced back on the next call.
  async ensureBuiltinJudge(configuredAgentId: string): Promise<EvaluationEvaluator> {
    const agent = this.dependencies.agents().find((item) => item.id === configuredAgentId);
    if (!agent) throw new Error(`Evaluation Agent not found: ${configuredAgentId}`);
    const id = `builtin-judge-${agent.channelId}`;
    const name = `Built-in Judge (${agent.channelId})`;
    const existing = (await this.dependencies.store.listEvaluators()).find(
      (item) => item.id === id,
    );
    if (
      existing
      && existing.prompt === BUILTIN_JUDGE_PROMPT
      && existing.name === name
      && existing.runtimeId === agent.channelId
    ) {
      return existing;
    }
    const now = Date.now();
    return this.dependencies.store.saveEvaluator({
      id,
      name,
      kind: "llm_judge",
      prompt: BUILTIN_JUDGE_PROMPT,
      runtimeId: agent.channelId,
      threshold: 0.6,
      enabled: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  listEvaluators(): Promise<EvaluationEvaluator[]> {
    return this.dependencies.store.listEvaluators();
  }

  saveEvaluator(value: EvaluationEvaluator): Promise<EvaluationEvaluator> {
    return this.dependencies.store.saveEvaluator(value);
  }

  deleteEvaluator(id: string): Promise<unknown> {
    return this.dependencies.store.deleteEvaluator(id);
  }

  listExperiments(): Promise<EvaluationExperiment[]> {
    return this.dependencies.store.listExperiments();
  }

  async configuredAgentReferences(agentIds: ReadonlySet<string>): Promise<Array<{ agentId: string; location: string }>> {
    if (agentIds.size === 0) return [];
    return (await this.dependencies.store.listExperiments())
      .filter((experiment) => agentIds.has(experiment.agentId))
      .map((experiment) => ({
        agentId: experiment.agentId,
        location: `Evaluation experiment ${experiment.name || experiment.id}`,
      }));
  }

  saveExperiment(value: EvaluationExperiment): Promise<EvaluationExperiment> {
    return this.dependencies.store.saveExperiment(value);
  }

  deleteExperiment(id: string): Promise<unknown> {
    return this.dependencies.store.deleteExperiment(id);
  }

  listRuns(input?: ListEvaluationRunsRequest): Promise<EvaluationRunPage> {
    return this.dependencies.store.listRuns(input);
  }

  getRun(id: string): Promise<EvaluationRun | undefined> {
    return this.dependencies.store.getRun(id);
  }

  deleteRun(id: string): Promise<unknown> {
    return this.dependencies.store.deleteRun(id);
  }

  // Blocking execution used by the Experiments workbench: the run is
  // persisted once, after every case has finished.
  async runExperiment(experimentId: string): Promise<EvaluationRun> {
    const input = await this.prepareExperimentRun(experimentId);
    const run = await runEvaluation(input);
    return this.dependencies.store.saveRun(run);
  }

  // Background execution used by skill regression suites: the run row is
  // persisted before execution starts and updated after every case, so
  // clients can poll progress and cancel cooperatively. Returns the run id
  // immediately.
  async startExperiment(experimentId: string): Promise<string> {
    const input = await this.prepareExperimentRun(experimentId);
    const runId = `eval-run-${Date.now()}`;
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    await this.dependencies.store.saveRun({
      id: runId,
      experimentId,
      status: "running",
      ...(input.agentRevisionId ? { agentRevisionId: input.agentRevisionId } : {}),
      startedAt: Date.now(),
      results: [],
    });
    void (async () => {
      try {
        await runEvaluation({
          ...input,
          runId,
          signal: controller.signal,
          onRunUpdate: async (run) => {
            await this.dependencies.store.saveRun(run);
          },
        });
      } catch (cause) {
        await this.persistFailedRun(runId, experimentId, cause);
      } finally {
        this.activeRuns.delete(runId);
      }
    })();
    return runId;
  }

  cancelRun(runId: string): void {
    this.activeRuns.get(runId)?.abort();
  }

  private async prepareExperimentRun(experimentId: string): Promise<{
    experiment: EvaluationExperiment;
    dataset: EvaluationDataset;
    evaluators: EvaluationEvaluator[];
    agentRevisionId?: string;
    execute: EvaluationAgentExecution;
    executeJudge: (runtimeId: string, prompt: string) => ReturnType<EvaluationAgentExecution>;
  }> {
    const experiment = (await this.dependencies.store.listExperiments()).find(
      (item) => item.id === experimentId,
    );
    if (!experiment) throw new Error(`Evaluation experiment not found: ${experimentId}`);

    const dataset = (await this.dependencies.store.listDatasets()).find(
      (item) => item.id === experiment.datasetId,
    );
    if (!dataset) throw new Error(`Evaluation dataset not found: ${experiment.datasetId}`);

    const agents = this.dependencies.agents();
    const targetAgent = agents.find((item) => item.id === experiment.agentId);
    if (!targetAgent) throw new Error(`Evaluation Agent not found: ${experiment.agentId}`);

    const evaluators = await this.dependencies.store.listEvaluators();
    const judgesByRuntime = new Map<string, ConfiguredAgent>();
    for (const evaluator of evaluators) {
      if (
        !experiment.evaluatorIds.includes(evaluator.id) ||
        !evaluator.enabled ||
        evaluator.kind !== "llm_judge"
      ) {
        continue;
      }
      const runtimeId = evaluator.runtimeId?.trim();
      if (!runtimeId) {
        throw new Error(`LLM Judge ${evaluator.name || evaluator.id} does not have a Runtime channel.`);
      }
      const judge = agents.find(
        (item) =>
          item.channelId === runtimeId &&
          (item.agentType !== "composed" || item.managed),
      );
      if (!judge) {
        throw new Error(
          `Runtime channel ${runtimeId} does not have an execution Agent for LLM Judge.`,
        );
      }
      judgesByRuntime.set(runtimeId, judge);
    }
    return {
      experiment,
      dataset,
      evaluators,
      ...(targetAgent.currentRevisionId
        ? { agentRevisionId: targetAgent.currentRevisionId }
        : {}),
      execute: this.dependencies.executeAgent,
      executeJudge: (runtimeId, prompt) => {
        const judge = judgesByRuntime.get(runtimeId);
        if (!judge) {
          throw new Error(
            `Runtime channel ${runtimeId} does not have an execution Agent for LLM Judge.`,
          );
        }
        return this.dependencies.executeAgent(judge.id, prompt);
      },
    };
  }

  private async persistFailedRun(
    runId: string,
    experimentId: string,
    cause: unknown,
  ): Promise<void> {
    const existing = await this.dependencies.store.getRun(runId);
    try {
      await this.dependencies.store.saveRun({
        id: runId,
        experimentId,
        status: "failed",
        startedAt: existing?.startedAt ?? Date.now(),
        finishedAt: Date.now(),
        error: cause instanceof Error ? cause.message : String(cause),
        results: existing?.results ?? [],
      });
    } catch {
      // The run row stays "running" only if persistence itself is broken.
    }
  }

  close(): void {
    for (const controller of this.activeRuns.values()) controller.abort();
    this.activeRuns.clear();
    this.dependencies.store.close();
  }
}
