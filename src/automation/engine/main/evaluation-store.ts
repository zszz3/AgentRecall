import type { PostgresDatabase, PostgresQueryable } from "../../../core/postgres/database";
import type {
  EvaluationCaseResult,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationRunPage,
  EvaluationRunSummary,
  EvaluationScore,
  ListEvaluationRunsRequest,
} from "../shared/evaluation/types";

type Row = Record<string, unknown>;

export type EvaluationTrajectorySubject =
  | { type: "session"; sessionKey: string }
  | { type: "turn"; turnId: string }
  | { type: "span"; spanId: string };

export interface EvaluationTrajectoryResult {
  id: string;
  subject: EvaluationTrajectorySubject;
  evaluatorId?: string;
  metric: string;
  score?: number;
  label?: string;
  passed?: boolean;
  explanation?: string;
  evidence?: Record<string, unknown>;
  evaluatorVersion?: string;
  createdAt: number;
}

export class EvaluationStore {
  constructor(private readonly database: PostgresDatabase) {}

  async listDatasets(): Promise<EvaluationDataset[]> {
    const datasets = await this.database.query(
      "select * from agent_recall.evaluation_datasets order by updated_at desc",
    );
    return Promise.all(datasets.rows.map((row) => this.dataset(row)));
  }

  async saveDataset(value: EvaluationDataset): Promise<EvaluationDataset> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `insert into agent_recall.evaluation_datasets (
          id, name, description, created_at, updated_at
        ) values ($1, $2, $3, $4, $5)
        on conflict (id) do update set
          name = excluded.name,
          description = excluded.description,
          updated_at = excluded.updated_at`,
        [
          value.id,
          value.name,
          value.description,
          new Date(value.createdAt),
          new Date(value.updatedAt),
        ],
      );
      await transaction.query(
        "delete from agent_recall.evaluation_dataset_items where dataset_id = $1",
        [value.id],
      );
      for (const [sequence, item] of value.items.entries()) {
        await transaction.query(
          `insert into agent_recall.evaluation_dataset_items (
            id, dataset_id, input, expected_output, metadata, sequence
          ) values ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            item.id,
            value.id,
            item.input,
            item.expectedOutput ?? null,
            JSON.stringify(item.metadata),
            sequence,
          ],
        );
      }
    });
    return value;
  }

  async deleteDataset(id: string): Promise<boolean> {
    return (await this.database.query(
      "delete from agent_recall.evaluation_datasets where id = $1",
      [id],
    )).rowCount > 0;
  }

  async listEvaluators(): Promise<EvaluationEvaluator[]> {
    const result = await this.database.query(
      "select * from agent_recall.evaluation_evaluators order by updated_at desc",
    );
    return result.rows.map(mapEvaluator);
  }

  async saveEvaluator(value: EvaluationEvaluator): Promise<EvaluationEvaluator> {
    await this.database.query(
      `insert into agent_recall.evaluation_evaluators (
        id, name, kind, prompt, agent_id, runtime_id, threshold, enabled,
        created_at, updated_at
      ) values ($1, $2, $3, $4, null, $5, $6, $7, $8, $9)
      on conflict (id) do update set
        name = excluded.name,
        kind = excluded.kind,
        prompt = excluded.prompt,
        agent_id = null,
        runtime_id = excluded.runtime_id,
        threshold = excluded.threshold,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at`,
      [
        value.id,
        value.name,
        value.kind,
        value.prompt ?? null,
        value.runtimeId ?? null,
        value.threshold,
        value.enabled,
        new Date(value.createdAt),
        new Date(value.updatedAt),
      ],
    );
    return value;
  }

  async deleteEvaluator(id: string): Promise<boolean> {
    return (await this.database.query(
      "delete from agent_recall.evaluation_evaluators where id = $1",
      [id],
    )).rowCount > 0;
  }

  async listExperiments(): Promise<EvaluationExperiment[]> {
    const experiments = await this.database.query(
      "select * from agent_recall.evaluation_experiments order by updated_at desc",
    );
    return Promise.all(experiments.rows.map(async (row) => {
      const evaluators = await this.database.query<{ evaluator_id: string }>(
        `select evaluator_id
           from agent_recall.evaluation_experiment_evaluators
          where experiment_id = $1
          order by sequence`,
        [row.id],
      );
      return {
        id: String(row.id),
        name: String(row.name),
        datasetId: String(row.dataset_id),
        agentId: String(row.agent_id),
        repetitions: Number(row.repetitions),
        evaluatorIds: evaluators.rows.map((item) => item.evaluator_id),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      };
    }));
  }

  async saveExperiment(value: EvaluationExperiment): Promise<EvaluationExperiment> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `insert into agent_recall.evaluation_experiments (
          id, name, dataset_id, agent_id, repetitions, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (id) do update set
          name = excluded.name,
          dataset_id = excluded.dataset_id,
          agent_id = excluded.agent_id,
          repetitions = excluded.repetitions,
          updated_at = excluded.updated_at`,
        [
          value.id,
          value.name,
          value.datasetId,
          value.agentId,
          value.repetitions,
          new Date(value.createdAt),
          new Date(value.updatedAt),
        ],
      );
      await transaction.query(
        `delete from agent_recall.evaluation_experiment_evaluators
          where experiment_id = $1`,
        [value.id],
      );
      for (const [sequence, evaluatorId] of value.evaluatorIds.entries()) {
        await transaction.query(
          `insert into agent_recall.evaluation_experiment_evaluators (
            experiment_id, evaluator_id, sequence
          ) values ($1, $2, $3)`,
          [value.id, evaluatorId, sequence],
        );
      }
    });
    return value;
  }

  async deleteExperiment(id: string): Promise<boolean> {
    return (await this.database.query(
      "delete from agent_recall.evaluation_experiments where id = $1",
      [id],
    )).rowCount > 0;
  }

  async listRuns(input: ListEvaluationRunsRequest = {}): Promise<EvaluationRunPage> {
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
    const params: unknown[] = [];
    const filter = input.experimentId
      ? `where r.experiment_id = $${params.push(input.experimentId)}`
      : "";
    const total = await this.database.query<{ total: number }>(
      `select count(*)::integer as total
         from agent_recall.evaluation_runs r ${filter}`,
      params,
    );
    params.push(limit, offset);
    const rows = await this.database.query(
      `select r.*,
          (select count(*)::integer
             from agent_recall.evaluation_case_results c
            where c.run_id = r.id) as result_count,
          (select count(distinct c.id)::integer
             from agent_recall.evaluation_case_results c
             left join agent_recall.evaluation_scores s
               on s.case_result_id = c.id
            where c.run_id = r.id
              and (c.error is not null or s.passed = false)) as failed_result_count
         from agent_recall.evaluation_runs r
         ${filter}
        order by r.started_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return {
      items: rows.rows.map(mapRunSummary),
      total: Number(total.rows[0]?.total ?? 0),
      offset,
      limit,
    };
  }

  async getRun(id: string): Promise<EvaluationRun | undefined> {
    const result = await this.database.query(
      "select * from agent_recall.evaluation_runs where id = $1",
      [id],
    );
    const row = result.rows[0];
    return row ? this.run(row) : undefined;
  }

  async deleteRun(id: string): Promise<boolean> {
    return (await this.database.query(
      "delete from agent_recall.evaluation_runs where id = $1",
      [id],
    )).rowCount > 0;
  }

  async saveRun(value: EvaluationRun): Promise<EvaluationRun> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `insert into agent_recall.evaluation_runs (
          id, experiment_id, status, agent_revision_id, started_at, finished_at,
          average_score, minimum_score, pass_rate, total_duration_ms, error
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        on conflict (id) do update set
          status = excluded.status,
          finished_at = excluded.finished_at,
          average_score = excluded.average_score,
          minimum_score = excluded.minimum_score,
          pass_rate = excluded.pass_rate,
          total_duration_ms = excluded.total_duration_ms,
          error = excluded.error`,
        [
          value.id,
          value.experimentId,
          value.status,
          value.agentRevisionId ?? null,
          new Date(value.startedAt),
          value.finishedAt === undefined ? null : new Date(value.finishedAt),
          value.averageScore ?? null,
          value.minimumScore ?? null,
          value.passRate ?? null,
          value.totalDurationMs ?? null,
          value.error ?? null,
        ],
      );
      await transaction.query(
        "delete from agent_recall.evaluation_case_results where run_id = $1",
        [value.id],
      );
      for (const result of value.results) {
        await this.insertCaseResult(transaction, value.id, result);
      }
    });
    return value;
  }

  async saveTrajectoryResult(
    value: EvaluationTrajectoryResult,
  ): Promise<EvaluationTrajectoryResult> {
    const subjectId = trajectorySubjectId(value.subject);
    const references = trajectoryReferences(value.subject);
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `insert into agent_recall.evaluation_subjects (
          id, subject_type, session_key, turn_id, span_id
        ) values ($1, $2, $3, $4, $5)
        on conflict (id) do nothing`,
        [
          subjectId,
          value.subject.type,
          references.sessionKey,
          references.turnId,
          references.spanId,
        ],
      );
      await transaction.query(
        `insert into agent_recall.evaluation_results (
          id, subject_id, evaluator_id, metric, score, label, passed,
          explanation, evidence, evaluator_version, created_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
        )
        on conflict (id) do update set
          subject_id = excluded.subject_id,
          evaluator_id = excluded.evaluator_id,
          metric = excluded.metric,
          score = excluded.score,
          label = excluded.label,
          passed = excluded.passed,
          explanation = excluded.explanation,
          evidence = excluded.evidence,
          evaluator_version = excluded.evaluator_version,
          created_at = excluded.created_at`,
        [
          value.id,
          subjectId,
          value.evaluatorId ?? null,
          value.metric,
          value.score ?? null,
          value.label ?? null,
          value.passed ?? null,
          value.explanation ?? null,
          value.evidence ? JSON.stringify(value.evidence) : null,
          value.evaluatorVersion ?? null,
          new Date(value.createdAt),
        ],
      );
    });
    return value;
  }

  async listTrajectoryResults(
    subject: EvaluationTrajectorySubject,
  ): Promise<EvaluationTrajectoryResult[]> {
    const result = await this.database.query(
      `select *
         from agent_recall.evaluation_results
        where subject_id = $1
        order by created_at desc, id`,
      [trajectorySubjectId(subject)],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      subject,
      ...(row.evaluator_id ? { evaluatorId: String(row.evaluator_id) } : {}),
      metric: String(row.metric),
      ...(row.score !== null && row.score !== undefined ? { score: Number(row.score) } : {}),
      ...(row.label ? { label: String(row.label) } : {}),
      ...(typeof row.passed === "boolean" ? { passed: row.passed } : {}),
      ...(row.explanation ? { explanation: String(row.explanation) } : {}),
      ...(row.evidence ? { evidence: jsonRecord(row.evidence) } : {}),
      ...(row.evaluator_version ? { evaluatorVersion: String(row.evaluator_version) } : {}),
      createdAt: timestamp(row.created_at),
    }));
  }

  close(): void {
    // The application owns the shared PostgreSQL connection pool.
  }

  private async dataset(row: Row): Promise<EvaluationDataset> {
    const items = await this.database.query(
      `select *
         from agent_recall.evaluation_dataset_items
        where dataset_id = $1
        order by sequence`,
      [row.id],
    );
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      items: items.rows.map((item) => ({
        id: String(item.id),
        input: String(item.input),
        ...(item.expected_output ? { expectedOutput: String(item.expected_output) } : {}),
        metadata: jsonRecord(item.metadata),
        sequence: Number(item.sequence),
      })),
    };
  }

  private async run(row: Row): Promise<EvaluationRun> {
    const [caseRows, scoreRows] = await Promise.all([
      this.database.query(
        `select *
           from agent_recall.evaluation_case_results
          where run_id = $1
          order by id`,
        [row.id],
      ),
      this.database.query(
        `select s.*
           from agent_recall.evaluation_scores s
           join agent_recall.evaluation_case_results c
             on c.id = s.case_result_id
          where c.run_id = $1
          order by s.case_result_id, s.evaluator_id`,
        [row.id],
      ),
    ]);
    const scoresByCase = new Map<string, EvaluationScore[]>();
    for (const score of scoreRows.rows) {
      const caseId = String(score.case_result_id);
      const scores = scoresByCase.get(caseId) ?? [];
      scores.push(mapScore(score));
      scoresByCase.set(caseId, scores);
    }
    const results = caseRows.rows.map((result): EvaluationCaseResult => ({
      id: String(result.id),
      runId: String(result.run_id),
      datasetItemId: String(result.dataset_item_id),
      repetition: Number(result.repetition),
      input: String(result.input),
      ...(result.expected_output ? { expectedOutput: String(result.expected_output) } : {}),
      output: String(result.output),
      ...(result.error ? { error: String(result.error) } : {}),
      durationMs: Number(result.duration_ms),
      scores: scoresByCase.get(String(result.id)) ?? [],
    }));
    const {
      resultCount: _resultCount,
      failedResultCount: _failedResultCount,
      ...summary
    } = mapRunSummary(row);
    return { ...summary, results };
  }

  private async insertCaseResult(
    transaction: PostgresQueryable,
    runId: string,
    result: EvaluationCaseResult,
  ): Promise<void> {
    await transaction.query(
      `insert into agent_recall.evaluation_case_results (
        id, run_id, dataset_item_id, repetition, input, expected_output,
        output, error, duration_ms
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        result.id,
        runId,
        result.datasetItemId,
        result.repetition,
        result.input,
        result.expectedOutput ?? null,
        result.output,
        result.error ?? null,
        result.durationMs,
      ],
    );
    for (const score of result.scores) {
      await transaction.query(
        `insert into agent_recall.evaluation_scores (
          case_result_id, evaluator_id, score, passed, reason, evidence,
          failed_criteria, duration_ms, token_count, estimated_cost
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
        [
          result.id,
          score.evaluatorId,
          score.score,
          score.passed,
          score.reason ?? null,
          score.evidence ? JSON.stringify(score.evidence) : null,
          score.failedCriteria ? JSON.stringify(score.failedCriteria) : null,
          score.durationMs,
          score.tokenCount ?? null,
          score.estimatedCost ?? null,
        ],
      );
    }
  }
}

function mapEvaluator(row: Row): EvaluationEvaluator {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as EvaluationEvaluator["kind"],
    ...(row.prompt ? { prompt: String(row.prompt) } : {}),
    ...(row.runtime_id ? { runtimeId: String(row.runtime_id) } : {}),
    threshold: Number(row.threshold),
    enabled: Boolean(row.enabled),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapRunSummary(row: Row): EvaluationRunSummary {
  return {
    id: String(row.id),
    experimentId: String(row.experiment_id),
    status: row.status as EvaluationRun["status"],
    ...(row.agent_revision_id ? { agentRevisionId: String(row.agent_revision_id) } : {}),
    startedAt: timestamp(row.started_at),
    ...(row.finished_at ? { finishedAt: timestamp(row.finished_at) } : {}),
    ...(row.average_score !== null && row.average_score !== undefined
      ? { averageScore: Number(row.average_score) }
      : {}),
    ...(row.minimum_score !== null && row.minimum_score !== undefined
      ? { minimumScore: Number(row.minimum_score) }
      : {}),
    ...(row.pass_rate !== null && row.pass_rate !== undefined
      ? { passRate: Number(row.pass_rate) }
      : {}),
    ...(row.total_duration_ms !== null && row.total_duration_ms !== undefined
      ? { totalDurationMs: Number(row.total_duration_ms) }
      : {}),
    ...(row.error ? { error: String(row.error) } : {}),
    resultCount: Number(row.result_count ?? 0),
    failedResultCount: Number(row.failed_result_count ?? 0),
  };
}

function mapScore(row: Row): EvaluationScore {
  return {
    evaluatorId: String(row.evaluator_id),
    score: Number(row.score),
    passed: Boolean(row.passed),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    ...(row.evidence ? { evidence: jsonArray(row.evidence) } : {}),
    ...(row.failed_criteria ? { failedCriteria: jsonArray(row.failed_criteria) } : {}),
    durationMs: Number(row.duration_ms),
    ...(row.token_count !== null && row.token_count !== undefined
      ? { tokenCount: Number(row.token_count) }
      : {}),
    ...(row.estimated_cost !== null && row.estimated_cost !== undefined
      ? { estimatedCost: Number(row.estimated_cost) }
      : {}),
  };
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value));
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function jsonArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function trajectorySubjectId(subject: EvaluationTrajectorySubject): string {
  switch (subject.type) {
    case "session":
      return `session:${subject.sessionKey}`;
    case "turn":
      return `turn:${subject.turnId}`;
    case "span":
      return `span:${subject.spanId}`;
  }
}

function trajectoryReferences(subject: EvaluationTrajectorySubject): {
  sessionKey: string | null;
  turnId: string | null;
  spanId: string | null;
} {
  return {
    sessionKey: subject.type === "session" ? subject.sessionKey : null,
    turnId: subject.type === "turn" ? subject.turnId : null,
    spanId: subject.type === "span" ? subject.spanId : null,
  };
}
