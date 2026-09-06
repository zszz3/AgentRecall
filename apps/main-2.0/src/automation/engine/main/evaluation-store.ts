import type { PostgresDatabase, PostgresQueryable } from "../../../core/postgres/database";
import type {
  EvaluationArtifactFile,
  EvaluationCaseArtifact,
  EvaluationCaseResult,
  EvaluationDataset,
  EvaluationDimensionScore,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationExperimentGraph,
  EvaluationNodeRecord,
  EvaluationRun,
  EvaluationRunPage,
  EvaluationRunSummary,
  EvaluationScore,
  EvaluationScoringConfig,
  EvaluationVerdict,
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
        dimension, priority, max_tool_failures,
        script_mode, script, command, command_args, subject, timeout_ms,
        max_turns, max_tool_calls, max_total_tokens, max_duration_ms,
        created_at, updated_at
      ) values (
        $1, $2, $3, $4, null, $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14::jsonb, $15, $16,
        $17, $18, $19, $20,
        $21, $22
      )
      on conflict (id) do update set
        name = excluded.name,
        kind = excluded.kind,
        prompt = excluded.prompt,
        agent_id = null,
        runtime_id = excluded.runtime_id,
        threshold = excluded.threshold,
        enabled = excluded.enabled,
        dimension = excluded.dimension,
        priority = excluded.priority,
        max_tool_failures = excluded.max_tool_failures,
        script_mode = excluded.script_mode,
        script = excluded.script,
        command = excluded.command,
        command_args = excluded.command_args,
        subject = excluded.subject,
        timeout_ms = excluded.timeout_ms,
        max_turns = excluded.max_turns,
        max_tool_calls = excluded.max_tool_calls,
        max_total_tokens = excluded.max_total_tokens,
        max_duration_ms = excluded.max_duration_ms,
        updated_at = excluded.updated_at`,
      [
        value.id,
        value.name,
        value.kind,
        value.prompt ?? null,
        value.runtimeId ?? null,
        value.threshold,
        value.enabled,
        value.dimension ?? null,
        value.priority ?? null,
        value.maxToolFailures ?? null,
        value.scriptMode ?? null,
        value.script ?? null,
        value.command ?? null,
        value.commandArgs ? JSON.stringify(value.commandArgs) : null,
        value.subject ?? null,
        value.timeoutMs ?? null,
        value.maxTurns ?? null,
        value.maxToolCalls ?? null,
        value.maxTotalTokens ?? null,
        value.maxDurationMs ?? null,
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
        skillName: row.skill_name != null ? String(row.skill_name) : null,
        skillHash: row.skill_hash != null ? String(row.skill_hash) : null,
        graph: row.graph != null
          ? jsonValue(row.graph) as EvaluationExperimentGraph
          : null,
        ...(row.source
          ? { source: row.source as NonNullable<EvaluationExperiment["source"]> }
          : {}),
        scoring: row.scoring != null
          ? jsonValue(row.scoring) as EvaluationScoringConfig
          : null,
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      };
    }));
  }

  async saveExperiment(value: EvaluationExperiment): Promise<EvaluationExperiment> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `insert into agent_recall.evaluation_experiments (
          id, name, dataset_id, agent_id, repetitions, skill_name, skill_hash,
          graph, source, scoring, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12)
        on conflict (id) do update set
          name = excluded.name,
          dataset_id = excluded.dataset_id,
          agent_id = excluded.agent_id,
          repetitions = excluded.repetitions,
          skill_name = excluded.skill_name,
          skill_hash = excluded.skill_hash,
          graph = excluded.graph,
          source = excluded.source,
          scoring = excluded.scoring,
          updated_at = excluded.updated_at`,
        [
          value.id,
          value.name,
          value.datasetId,
          value.agentId,
          value.repetitions,
          value.skillName ?? null,
          value.skillHash ?? null,
          value.graph ? JSON.stringify(value.graph) : null,
          value.source ?? null,
          value.scoring ? JSON.stringify(value.scoring) : null,
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
          id, experiment_id, status, agent_revision_id, skill_hash, started_at, finished_at,
          average_score, minimum_score, pass_rate, total_duration_ms, error,
          engine, scored_case_count, unscored_case_count, coverage, dimensions, rubric_hash
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18
        )
        on conflict (id) do update set
          status = excluded.status,
          finished_at = excluded.finished_at,
          average_score = excluded.average_score,
          minimum_score = excluded.minimum_score,
          pass_rate = excluded.pass_rate,
          total_duration_ms = excluded.total_duration_ms,
          error = excluded.error,
          engine = excluded.engine,
          scored_case_count = excluded.scored_case_count,
          unscored_case_count = excluded.unscored_case_count,
          coverage = excluded.coverage,
          dimensions = excluded.dimensions,
          skill_hash = coalesce(agent_recall.evaluation_runs.skill_hash, excluded.skill_hash),
          rubric_hash = coalesce(excluded.rubric_hash, agent_recall.evaluation_runs.rubric_hash)`,
        [
          value.id,
          value.experimentId,
          value.status,
          value.agentRevisionId ?? null,
          value.skillHash ?? null,
          new Date(value.startedAt),
          value.finishedAt === undefined ? null : new Date(value.finishedAt),
          value.averageScore ?? null,
          value.minimumScore ?? null,
          value.passRate ?? null,
          value.totalDurationMs ?? null,
          value.error ?? null,
          value.engine ?? null,
          value.scoredCaseCount ?? null,
          value.unscoredCaseCount ?? null,
          value.coverage ?? null,
          value.dimensions ? JSON.stringify(value.dimensions) : null,
          value.rubricHash ?? null,
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
    const [caseRows, scoreRows, nodeRows, verdictRows] = await Promise.all([
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
          order by s.case_result_id, s.evaluator_id, s.dimension`,
        [row.id],
      ),
      this.database.query(
        `select n.*
           from agent_recall.evaluation_case_nodes n
           join agent_recall.evaluation_case_results c
             on c.id = n.case_result_id
          where c.run_id = $1
          order by n.case_result_id, n.sequence`,
        [row.id],
      ),
      this.database.query(
        `select v.*
           from agent_recall.evaluation_case_verdicts v
           join agent_recall.evaluation_case_results c
             on c.id = v.case_result_id
          where c.run_id = $1
          order by v.case_result_id, v.node_id, v.sequence`,
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
    // Keyed by case and then node rather than by a joined string: case ids
    // already contain the separator characters an id key would need.
    const verdictsByCaseNode = new Map<string, Map<string, EvaluationVerdict[]>>();
    for (const verdict of verdictRows.rows) {
      const caseId = String(verdict.case_result_id);
      const byNode = verdictsByCaseNode.get(caseId) ?? new Map<string, EvaluationVerdict[]>();
      const nodeId = String(verdict.node_id);
      byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), mapVerdict(verdict)]);
      verdictsByCaseNode.set(caseId, byNode);
    }
    const nodesByCase = new Map<string, EvaluationNodeRecord[]>();
    for (const node of nodeRows.rows) {
      const caseId = String(node.case_result_id);
      const nodes = nodesByCase.get(caseId) ?? [];
      nodes.push(mapNodeRecord(
        node,
        verdictsByCaseNode.get(caseId)?.get(String(node.node_id)) ?? [],
      ));
      nodesByCase.set(caseId, nodes);
    }
    const results = caseRows.rows.map((result): EvaluationCaseResult => {
      const nodes = nodesByCase.get(String(result.id)) ?? [];
      return {
        id: String(result.id),
        runId: String(result.run_id),
        datasetItemId: String(result.dataset_item_id),
        repetition: Number(result.repetition),
        input: String(result.input),
        ...(result.expected_output ? { expectedOutput: String(result.expected_output) } : {}),
        output: String(result.output),
        ...(result.artifact_origin_kind
          ? {
              artifact: {
                origin: {
                  kind: String(result.artifact_origin_kind) as
                    EvaluationCaseArtifact["origin"]["kind"],
                  ...(result.artifact_origin_reference
                    ? { reference: String(result.artifact_origin_reference) }
                    : {}),
                },
                ...(result.artifact_files
                  ? { files: jsonObjectArray<EvaluationArtifactFile>(result.artifact_files) }
                  : {}),
              },
            }
          : {}),
        ...(result.error ? { error: String(result.error) } : {}),
        durationMs: Number(result.duration_ms),
        scores: scoresByCase.get(String(result.id)) ?? [],
        // Absent on runs recorded before the graph engine; those keep only the
        // case and score rows they were written with.
        ...(nodes.length > 0 ? { nodes } : {}),
        ...(result.session_key ? { sessionKey: String(result.session_key) } : {}),
        ...(result.skill_name && result.skill_hash
          ? {
              skillInjection: {
                skillName: String(result.skill_name),
                skillHash: String(result.skill_hash),
                contentLength: Number(result.skill_content_length ?? 0),
              },
            }
          : {}),
        ...(result.unscored_reason ? { unscoredReason: String(result.unscored_reason) } : {}),
        ...(typeof result.gate_passed === "boolean" ? { gatePassed: result.gate_passed } : {}),
        ...(result.score !== null && result.score !== undefined
          ? { score: Number(result.score) }
          : {}),
        ...(typeof result.passed === "boolean" ? { passed: result.passed } : {}),
        ...(result.coverage !== null && result.coverage !== undefined
          ? { coverage: Number(result.coverage) }
          : {}),
        ...(result.dimensions
          ? { dimensions: jsonObjectArray<EvaluationDimensionScore>(result.dimensions) }
          : {}),
        ...(result.by_label
          ? { byLabel: jsonRecord(result.by_label) as EvaluationCaseResult["byLabel"] }
          : {}),
        ...(result.skipped_evaluator_ids
          ? { skippedEvaluatorIds: jsonArray(result.skipped_evaluator_ids) as string[] }
          : {}),
      };
    });
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
        output, error, duration_ms, session_key, skill_name, skill_hash,
        skill_content_length, unscored_reason, gate_passed,
        score, passed, coverage, dimensions, by_label, skipped_evaluator_ids,
        artifact_origin_kind, artifact_origin_reference, artifact_files
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19::jsonb, $20::jsonb, $21::jsonb, $22, $23, $24::jsonb
      )`,
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
        result.sessionKey ?? null,
        result.skillInjection?.skillName ?? null,
        result.skillInjection?.skillHash ?? null,
        result.skillInjection?.contentLength ?? null,
        result.unscoredReason ?? null,
        result.gatePassed ?? null,
        result.score ?? null,
        result.passed ?? null,
        result.coverage ?? null,
        result.dimensions ? JSON.stringify(result.dimensions) : null,
        result.byLabel ? JSON.stringify(result.byLabel) : null,
        result.skippedEvaluatorIds && result.skippedEvaluatorIds.length > 0
          ? JSON.stringify(result.skippedEvaluatorIds)
          : null,
        result.artifact?.origin.kind ?? null,
        result.artifact?.origin.reference ?? null,
        // An empty list is stored as null: "no files" and "files not observed"
        // are different answers, and only the second one is what an absent
        // artifact file list means.
        result.artifact?.files && result.artifact.files.length > 0
          ? JSON.stringify(result.artifact.files)
          : null,
      ],
    );
    await this.insertCaseNodes(transaction, result);
    for (const score of result.scores) {
      await transaction.query(
        `insert into agent_recall.evaluation_scores (
          case_result_id, evaluator_id, score, passed, reason, evidence,
          failed_criteria, duration_ms, token_count, estimated_cost, dimension
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
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
          // One LLM judge can emit several independently scored dimensions.
          // The database key includes this value, so legacy single-verdict
          // evaluators use their id as the same stable default as the scorer.
          score.dimension ?? score.evaluatorId,
        ],
      );
    }
  }

  private async insertCaseNodes(
    transaction: PostgresQueryable,
    result: EvaluationCaseResult,
  ): Promise<void> {
    const nodes = result.nodes ?? [];
    for (const [index, node] of nodes.entries()) {
      await transaction.query(
        `insert into agent_recall.evaluation_case_nodes (
          case_result_id, node_id, node_type, node_version, role, status,
          pending_reason, pending_upstream, started_at, finished_at, duration_ms,
          attribution, produced_outputs, facts, sequence
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15
        )`,
        [
          result.id,
          node.nodeId,
          node.nodeType,
          node.nodeVersion,
          node.role,
          node.status,
          node.pendingReason ?? null,
          node.pendingUpstream ? JSON.stringify(node.pendingUpstream) : null,
          node.startedAt === undefined ? null : new Date(node.startedAt),
          node.finishedAt === undefined ? null : new Date(node.finishedAt),
          node.durationMs ?? null,
          node.attribution ? JSON.stringify(node.attribution) : null,
          node.producedOutputs ? JSON.stringify(node.producedOutputs) : null,
          node.facts ? JSON.stringify(node.facts) : null,
          index,
        ],
      );
      for (const [verdictIndex, verdict] of (node.verdicts ?? []).entries()) {
        await transaction.query(
          `insert into agent_recall.evaluation_case_verdicts (
            case_result_id, verdict_id, node_id, node_type, evaluator_id, status,
            raw, threshold, labels, reason, evidence, failed_criteria, duration_ms, sequence
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14
          )`,
          [
            result.id,
            verdict.verdictId,
            verdict.sourceNodeId,
            verdict.sourceNodeType,
            verdict.evaluatorId ?? null,
            verdict.status,
            verdict.raw ?? null,
            verdict.threshold ?? null,
            JSON.stringify(verdict.labels),
            verdict.reason ?? null,
            verdict.evidence ? JSON.stringify(verdict.evidence) : null,
            verdict.failedCriteria ? JSON.stringify(verdict.failedCriteria) : null,
            verdict.durationMs ?? null,
            verdictIndex,
          ],
        );
      }
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
    ...(row.dimension ? { dimension: String(row.dimension) } : {}),
    ...(row.priority ? { priority: row.priority as EvaluationEvaluator["priority"] } : {}),
    ...(row.max_tool_failures !== null && row.max_tool_failures !== undefined
      ? { maxToolFailures: Number(row.max_tool_failures) }
      : {}),
    ...(row.script_mode
      ? { scriptMode: row.script_mode as EvaluationEvaluator["scriptMode"] }
      : {}),
    ...(row.script ? { script: String(row.script) } : {}),
    ...(row.command ? { command: String(row.command) } : {}),
    ...(row.command_args ? { commandArgs: jsonValue(row.command_args) as string[] } : {}),
    ...(row.subject ? { subject: row.subject as EvaluationEvaluator["subject"] } : {}),
    ...(row.timeout_ms !== null && row.timeout_ms !== undefined
      ? { timeoutMs: Number(row.timeout_ms) }
      : {}),
    ...(row.max_turns !== null && row.max_turns !== undefined
      ? { maxTurns: Number(row.max_turns) }
      : {}),
    ...(row.max_tool_calls !== null && row.max_tool_calls !== undefined
      ? { maxToolCalls: Number(row.max_tool_calls) }
      : {}),
    ...(row.max_total_tokens !== null && row.max_total_tokens !== undefined
      ? { maxTotalTokens: Number(row.max_total_tokens) }
      : {}),
    ...(row.max_duration_ms !== null && row.max_duration_ms !== undefined
      ? { maxDurationMs: Number(row.max_duration_ms) }
      : {}),
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
    ...(row.skill_hash ? { skillHash: String(row.skill_hash) } : {}),
    ...(row.rubric_hash ? { rubricHash: String(row.rubric_hash) } : {}),
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
    ...(row.engine === "graph" ? { engine: "graph" as const } : {}),
    ...(row.scored_case_count !== null && row.scored_case_count !== undefined
      ? { scoredCaseCount: Number(row.scored_case_count) }
      : {}),
    ...(row.unscored_case_count !== null && row.unscored_case_count !== undefined
      ? { unscoredCaseCount: Number(row.unscored_case_count) }
      : {}),
    ...(row.coverage !== null && row.coverage !== undefined
      ? { coverage: Number(row.coverage) }
      : {}),
    ...(row.dimensions
      ? {
          dimensions: jsonObjectArray<
            NonNullable<EvaluationRun["dimensions"]>[number]
          >(row.dimensions),
        }
      : {}),
    resultCount: Number(row.result_count ?? 0),
    failedResultCount: Number(row.failed_result_count ?? 0),
  };
}

function mapScore(row: Row): EvaluationScore {
  return {
    evaluatorId: String(row.evaluator_id),
    score: Number(row.score),
    passed: Boolean(row.passed),
    ...(row.dimension ? { dimension: String(row.dimension) } : {}),
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

function mapNodeRecord(row: Row, verdicts: EvaluationVerdict[]): EvaluationNodeRecord {
  return {
    nodeId: String(row.node_id),
    nodeType: String(row.node_type),
    nodeVersion: Number(row.node_version),
    role: row.role as EvaluationNodeRecord["role"],
    status: row.status as EvaluationNodeRecord["status"],
    ...(row.pending_reason
      ? { pendingReason: row.pending_reason as EvaluationNodeRecord["pendingReason"] }
      : {}),
    ...(row.pending_upstream ? { pendingUpstream: jsonArray(row.pending_upstream) } : {}),
    ...(row.started_at ? { startedAt: timestamp(row.started_at) } : {}),
    ...(row.finished_at ? { finishedAt: timestamp(row.finished_at) } : {}),
    ...(row.duration_ms !== null && row.duration_ms !== undefined
      ? { durationMs: Number(row.duration_ms) }
      : {}),
    ...(row.attribution
      ? {
          attribution: jsonRecord(row.attribution) as unknown as
            EvaluationNodeRecord["attribution"],
        }
      : {}),
    ...(row.produced_outputs ? { producedOutputs: jsonArray(row.produced_outputs) } : {}),
    ...(row.facts ? { facts: jsonRecord(row.facts) } : {}),
    ...(verdicts.length > 0 ? { verdicts } : {}),
  };
}

function mapVerdict(row: Row): EvaluationVerdict {
  return {
    verdictId: String(row.verdict_id),
    ...(row.evaluator_id ? { evaluatorId: String(row.evaluator_id) } : {}),
    labels: Object.fromEntries(
      Object.entries(jsonRecord(row.labels)).map(([key, value]) => [key, String(value)]),
    ),
    status: row.status as EvaluationVerdict["status"],
    ...(row.raw !== null && row.raw !== undefined ? { raw: Number(row.raw) } : {}),
    ...(row.threshold !== null && row.threshold !== undefined
      ? { threshold: Number(row.threshold) }
      : {}),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    ...(row.evidence ? { evidence: jsonArray(row.evidence) } : {}),
    ...(row.failed_criteria ? { failedCriteria: jsonArray(row.failed_criteria) } : {}),
    sourceNodeId: String(row.node_id),
    sourceNodeType: String(row.node_type),
    ...(row.duration_ms !== null && row.duration_ms !== undefined
      ? { durationMs: Number(row.duration_ms) }
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

/** For jsonb columns holding objects, where `jsonArray`'s stringifying would lose them. */
function jsonObjectArray<T>(value: unknown): T[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed as T[] : [];
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
