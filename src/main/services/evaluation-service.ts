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
) => Promise<{ output: string; durationMs: number }>;

export interface EvaluationServiceDependencies {
  store: EvaluationStore;
  agents: () => ConfiguredAgent[];
  executeAgent: EvaluationAgentExecution;
}

export class EvaluationService {
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

  async runExperiment(experimentId: string): Promise<EvaluationRun> {
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
    const run = await runEvaluation({
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
    });
    return this.dependencies.store.saveRun(run);
  }

  close(): void {
    this.dependencies.store.close();
  }
}
