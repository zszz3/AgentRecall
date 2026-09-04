import { randomUUID } from "node:crypto";
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
import {
  datasetFolderCaseId,
  datasetFolderId,
  datasetFolderItems,
  readDatasetFolder,
  writeDatasetFolder,
} from "../../core/evaluation/dataset-folder-io";
import type { RunEvaluationInput } from "../../automation/engine/main/evaluation-runner";
import type { EvaluationStore } from "../../automation/engine/main/evaluation-store";
import type {
  EvaluationArtifactFile,
  EvaluationTrajectoryValue,
} from "../../core/evaluation/nodes/contracts";
import {
  isTechnicalWritingSkill,
  TECHNICAL_WRITING_JUDGE_PROMPT,
  TECHNICAL_WRITING_SKILL_ID,
} from "../../automation/engine/shared/evaluation/technical-writing-eval";

export type EvaluationAgentExecution = (
  input: {
    configuredAgentId: string;
    prompt: string;
    /** Injected with the task; carries the selected skill's instructions. */
    developerInstructions?: string;
    role: string;
    ownerReference: Record<string, string>;
  },
  signal?: AbortSignal,
) => Promise<{
  output: string;
  durationMs: number;
  /** Runtime-native ids used to link this run to its session. */
  executionReference?: { invocationId?: string; sessionId?: string; turnId?: string };
}>;

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
  /**
   * Reads the SKILL.md bytes and hash of an installed skill, so an experiment
   * bound to a skill injects that skill's instructions with the task and can
   * attribute its result to the exact text that ran.
   */
  readSkill?: (skillName: string) => Promise<{ content: string; hash: string } | null>;
  /**
   * Resolves the runtime session id an execution reported to the indexed
   * AgentRecall session. The trajectory half of a run is skipped when this and
   * `readTrajectory` are not both wired.
   */
  resolveSession?: (
    reference: { invocationId?: string; sessionId?: string; turnId?: string },
  ) => Promise<{ sessionKey: string } | null>;
  readTrajectory?: (sessionKey: string) => Promise<EvaluationTrajectoryValue | null>;
  /** Reads a session's answer, for evaluating a session that already happened. */
  readSessionArtifact?: (
    sessionKey: string,
  ) => Promise<{ output: string; files?: EvaluationArtifactFile[] } | null>;
  /** Reads an artifact folder from disk. */
  readFolderArtifact?: (
    path: string,
  ) => Promise<{ output: string; files?: EvaluationArtifactFile[] } | null>;
  /**
   * Which files a session's tool calls touched, so a fresh run's artifact is more
   * than its final message. Read after the session link, which is the first
   * moment the session is known.
   */
  readArtifactFiles?: (sessionKey: string) => Promise<EvaluationArtifactFile[] | null>;
  /**
   * Runs a judge the user wrote as code. Without it a script evaluator excuses
   * itself, which keeps it visible in the report instead of scoring zero.
   */
  runJudgeScript?: RunEvaluationInput["runJudgeScript"];
  /**
   * Opens a native directory picker, returning null when the user cancels. The
   * renderer never names a path of its own; the dialog is the only way in.
   */
  chooseDatasetDirectory?: (mode: "read" | "write") => Promise<string | null>;
}

interface ActiveEvaluationExecution {
  controller: AbortController;
  promise: Promise<unknown>;
}

export class EvaluationService {
  // Live controllers keyed by run id, so a polling client can cancel a
  // background run cooperatively.
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly activeExecutions = new Set<ActiveEvaluationExecution>();
  private closePromise: Promise<void> | undefined;
  private closing = false;

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

  /**
   * Imports a dataset folder the user picks.
   *
   * The dataset id is derived from the folder path, so re-importing after editing
   * the files updates the same dataset instead of leaving a pile of near-copies —
   * the folder is the source of truth, and this keeps the app's copy tracking it.
   */
  async importDatasetFolder(): Promise<
    { dataset: EvaluationDataset; directory: string; errors: string[] } | null
  > {
    this.assertOpen();
    const directory = await this.dependencies.chooseDatasetDirectory?.("read");
    if (!directory) return null;
    const folder = readDatasetFolder(directory);
    if (folder.cases.length === 0) {
      throw new Error(folder.errors[0] ?? `没有读到任何用例：${directory}`);
    }
    const existing = (await this.dependencies.store.listDatasets())
      .find((item) => item.id === datasetFolderId(directory));
    const now = Date.now();
    const dataset = await this.dependencies.store.saveDataset({
      id: datasetFolderId(directory),
      name: folder.manifest.name,
      description: folder.manifest.description,
      items: datasetFolderItems(datasetFolderId(directory), folder.cases),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return { dataset, directory, errors: folder.errors };
  }

  /** Writes a dataset to a folder the user picks, in the same format. */
  async exportDatasetFolder(
    datasetId: string,
  ): Promise<{ directory: string; caseCount: number } | null> {
    this.assertOpen();
    const dataset = (await this.dependencies.store.listDatasets())
      .find((item) => item.id === datasetId);
    if (!dataset) throw new Error(`Evaluation dataset not found: ${datasetId}`);
    const directory = await this.dependencies.chooseDatasetDirectory?.("write");
    if (!directory) return null;
    const written = writeDatasetFolder(directory, {
      name: dataset.name,
      description: dataset.description,
      cases: dataset.items.map((item) => ({
        id: datasetFolderCaseId(dataset.id, item.id),
        input: item.input,
        ...(item.expectedOutput !== undefined ? { expectedOutput: item.expectedOutput } : {}),
        ...(typeof item.metadata.context === "string" ? { context: item.metadata.context } : {}),
        metadata: item.metadata,
      })),
    });
    return { directory, caseCount: written.caseCount };
  }

  // Idempotently provisions the built-in LLM judge bound to the execution
  // agent's own channel, so skill regression suites never require the user to
  // configure a separate judge runtime first. The judge is code-managed: one
  // per channel, and a persisted definition that drifted from the code (e.g.
  // an older rubric) is synced back on the next call.
  async ensureBuiltinJudge(
    configuredAgentId: string,
    skillName?: string,
  ): Promise<EvaluationEvaluator> {
    const agent = this.dependencies.agents().find((item) => item.id === configuredAgentId);
    if (!agent) throw new Error(`Evaluation Agent not found: ${configuredAgentId}`);
    const technicalWriting = isTechnicalWritingSkill(skillName ?? "");
    const id = technicalWriting
      ? `builtin-judge-${agent.channelId}-${TECHNICAL_WRITING_SKILL_ID}`
      : `builtin-judge-${agent.channelId}`;
    const name = technicalWriting
      ? `Technical Writing Judge (${agent.channelId})`
      : `Built-in Judge (${agent.channelId})`;
    const prompt = technicalWriting ? TECHNICAL_WRITING_JUDGE_PROMPT : BUILTIN_JUDGE_PROMPT;
    const threshold = technicalWriting ? 0.75 : 0.6;
    const existing = (await this.dependencies.store.listEvaluators()).find(
      (item) => item.id === id,
    );
    if (
      existing
      && existing.prompt === prompt
      && existing.name === name
      && existing.runtimeId === agent.channelId
      && existing.threshold === threshold
      && existing.enabled
    ) {
      return existing;
    }
    const now = Date.now();
    return this.dependencies.store.saveEvaluator({
      id,
      name,
      kind: "llm_judge",
      prompt,
      runtimeId: agent.channelId,
      threshold,
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
    this.assertOpen();
    const controller = new AbortController();
    return this.trackExecution(controller, async () => {
      const input = await this.prepareExperimentRun(experimentId);
      const run = await runEvaluation({
        ...input,
        signal: controller.signal,
      });
      return this.dependencies.store.saveRun(run);
    });
  }

  // Background execution used by skill regression suites: the run row is
  // persisted before execution starts and updated after every case, so
  // clients can poll progress and cancel cooperatively. Returns the run id
  // immediately.
  async startExperiment(
    experimentId: string,
    options: { skillHash?: string | null } = {},
  ): Promise<string> {
    this.assertOpen();
    const controller = new AbortController();
    let resolveStarted!: (runId: string) => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<string>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });

    const execution = this.trackExecution(controller, async () => {
      const input = await this.prepareExperimentRun(experimentId);
      const runId = `eval-run-${Date.now()}-${randomUUID()}`;
      this.activeRuns.set(runId, controller);
      try {
        await this.dependencies.store.saveRun({
          id: runId,
          experimentId,
          status: "running",
          ...(input.agentRevisionId ? { agentRevisionId: input.agentRevisionId } : {}),
          ...(options.skillHash ? { skillHash: options.skillHash } : {}),
          startedAt: Date.now(),
          results: [],
        });
        resolveStarted(runId);
        try {
          await runEvaluation({
            ...input,
            runId,
            ...(options.skillHash ? { skillHash: options.skillHash } : {}),
            signal: controller.signal,
            onRunUpdate: async (run) => {
              await this.dependencies.store.saveRun(run);
            },
          });
        } catch (cause) {
          await this.persistFailedRun(runId, experimentId, cause);
        }
      } finally {
        this.activeRuns.delete(runId);
      }
    });
    void execution.catch(rejectStarted);
    return started;
  }

  cancelRun(runId: string): void {
    this.activeRuns.get(runId)?.abort();
  }

  private async prepareExperimentRun(experimentId: string): Promise<{
    experiment: EvaluationExperiment;
    dataset: EvaluationDataset;
    evaluators: EvaluationEvaluator[];
    agentRevisionId?: string;
    readSkill?: EvaluationServiceDependencies["readSkill"];
    resolveSession?: EvaluationServiceDependencies["resolveSession"];
    readTrajectory?: EvaluationServiceDependencies["readTrajectory"];
    readSessionArtifact?: EvaluationServiceDependencies["readSessionArtifact"];
    readFolderArtifact?: EvaluationServiceDependencies["readFolderArtifact"];
    readArtifactFiles?: EvaluationServiceDependencies["readArtifactFiles"];
    runJudgeScript?: EvaluationServiceDependencies["runJudgeScript"];
    execute: EvaluationAgentExecution;
    executeJudge: NonNullable<RunEvaluationInput["executeJudge"]>;
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
      ...(this.dependencies.readSkill ? { readSkill: this.dependencies.readSkill } : {}),
      ...(this.dependencies.resolveSession
        ? { resolveSession: this.dependencies.resolveSession }
        : {}),
      ...(this.dependencies.readTrajectory
        ? { readTrajectory: this.dependencies.readTrajectory }
        : {}),
      ...(this.dependencies.readSessionArtifact
        ? { readSessionArtifact: this.dependencies.readSessionArtifact }
        : {}),
      ...(this.dependencies.readFolderArtifact
        ? { readFolderArtifact: this.dependencies.readFolderArtifact }
        : {}),
      ...(this.dependencies.readArtifactFiles
        ? { readArtifactFiles: this.dependencies.readArtifactFiles }
        : {}),
      ...(this.dependencies.runJudgeScript
        ? { runJudgeScript: this.dependencies.runJudgeScript }
        : {}),
      execute: this.dependencies.executeAgent,
      executeJudge: (runtimeId, prompt, role, ownerReference, signal) => {
        const judge = judgesByRuntime.get(runtimeId);
        if (!judge) {
          throw new Error(
            `Runtime channel ${runtimeId} does not have an execution Agent for LLM Judge.`,
          );
        }
        return this.dependencies.executeAgent({
          configuredAgentId: judge.id,
          prompt,
          role,
          ownerReference,
        }, signal);
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

  close(): Promise<void> {
    this.closing = true;
    this.closePromise ??= this.closeActiveExecutions();
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new Error("Evaluation service is shutting down.");
    }
  }

  private trackExecution<T>(
    controller: AbortController,
    operation: () => Promise<T>,
  ): Promise<T> {
    const active: ActiveEvaluationExecution = {
      controller,
      promise: Promise.resolve(),
    };
    const promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.activeExecutions.delete(active);
      });
    active.promise = promise;
    this.activeExecutions.add(active);
    return promise;
  }

  private async closeActiveExecutions(): Promise<void> {
    const active = [...this.activeExecutions];
    for (const execution of active) execution.controller.abort();
    await Promise.allSettled(active.map((execution) => execution.promise));
    this.activeRuns.clear();
    this.dependencies.store.close();
  }
}
