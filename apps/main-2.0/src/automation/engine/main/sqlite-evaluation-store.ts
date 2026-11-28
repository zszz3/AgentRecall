import type { SQLInputValue } from "node:sqlite";
import type { SqliteDatabase, SqliteQueryable } from "../../../core/sqlite/database";
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
  EvaluationRunConsistency,
  EvaluationRunPage,
  EvaluationRunSummary,
  EvaluationScore,
  EvaluationScoringConfig,
  EvaluationStageDefinition,
  EvaluationVerdict,
  ListEvaluationRunsRequest,
} from "../shared/evaluation/types";
import type {
  EvaluationTrajectoryResult,
  EvaluationTrajectorySubject,
} from "../../../core/storage/types";

type Row = Record<string, unknown>;

export class SqliteEvaluationStore {
  constructor(private readonly database: SqliteDatabase) {}

  async listDatasets(): Promise<EvaluationDataset[]> {
    const datasets = this.database.all<Row>(
      "select * from evaluation_datasets order by updated_at desc",
    );
    return datasets.map((row) => this.dataset(row));
  }

  async saveDataset(value: EvaluationDataset): Promise<EvaluationDataset> {
    await this.database.transaction(async (tx) => {
      tx.run(
        `
          insert into evaluation_datasets (
            id, name, description, created_at, updated_at
          ) values (?, ?, ?, ?, ?)
          on conflict (id) do update set
            name = excluded.name,
            description = excluded.description,
            updated_at = excluded.updated_at
        `,
        value.id,
        value.name,
        value.description,
        Math.trunc(value.createdAt),
        Math.trunc(value.updatedAt),
      );
      tx.run("delete from evaluation_dataset_items where dataset_id = ?", value.id);
      for (const [sequence, item] of value.items.entries()) {
        tx.run(
          `
            insert into evaluation_dataset_items (
              id, dataset_id, input, expected_output, metadata, sequence
            ) values (?, ?, ?, ?, ?, ?)
          `,
          item.id,
          value.id,
          item.input,
          item.expectedOutput ?? null,
          JSON.stringify(item.metadata),
          sequence,
        );
      }
    });
    return value;
  }

  async deleteDataset(id: string): Promise<boolean> {
    return this.database.run("delete from evaluation_datasets where id = ?", id).changes > 0;
  }

  async listEvaluators(): Promise<EvaluationEvaluator[]> {
    const rows = this.database.all<Row>(
      "select * from evaluation_evaluators order by updated_at desc",
    );
    return rows.map(mapEvaluator);
  }

  async saveEvaluator(value: EvaluationEvaluator): Promise<EvaluationEvaluator> {
    this.database.run(
      `
        insert into evaluation_evaluators (
          id, name, kind, prompt, agent_id, runtime_id, threshold, enabled,
          dimension, priority, max_tool_failures,
          script_mode, script, command, command_args, subject, timeout_ms,
          max_turns, max_tool_calls, max_total_tokens, max_duration_ms,
          created_at, updated_at
        ) values (
          ?, ?, ?, ?, null, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?
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
          updated_at = excluded.updated_at
      `,
      value.id,
      value.name,
      value.kind,
      value.prompt ?? null,
      value.runtimeId ?? null,
      value.threshold,
      value.enabled ? 1 : 0,
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
      Math.trunc(value.createdAt),
      Math.trunc(value.updatedAt),
    );
    return value;
  }

  async deleteEvaluator(id: string): Promise<boolean> {
    return this.database.run("delete from evaluation_evaluators where id = ?", id).changes > 0;
  }

  async listExperiments(): Promise<EvaluationExperiment[]> {
    const experiments = this.database.all<Row>(
      "select * from evaluation_experiments order by updated_at desc",
    );
    return experiments.map((row) => {
      const evaluators = this.database.all<{ evaluator_id: string }>(
        `
          select evaluator_id
          from evaluation_experiment_evaluators
          where experiment_id = ?
          order by sequence
        `,
        String(row.id),
      );
      return {
        id: String(row.id),
        name: String(row.name),
        datasetId: String(row.dataset_id),
        agentId: String(row.agent_id),
        repetitions: Number(row.repetitions),
        evaluatorIds: evaluators.map((item) => item.evaluator_id),
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
        stages: row.stages != null
          ? jsonValue(row.stages) as EvaluationStageDefinition[]
          : null,
        stageByEvaluatorId: row.stage_by_evaluator_id != null
          ? jsonValue(row.stage_by_evaluator_id) as Record<string, string>
          : null,
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      };
    });
  }

  async saveExperiment(value: EvaluationExperiment): Promise<EvaluationExperiment> {
    await this.database.transaction(async (tx) => {
      tx.run(
        `
          insert into evaluation_experiments (
            id, name, dataset_id, agent_id, repetitions, skill_name, skill_hash,
            graph, source, scoring, stages, stage_by_evaluator_id, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            stages = excluded.stages,
            stage_by_evaluator_id = excluded.stage_by_evaluator_id,
            updated_at = excluded.updated_at
        `,
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
        value.stages ? JSON.stringify(value.stages) : null,
        value.stageByEvaluatorId ? JSON.stringify(value.stageByEvaluatorId) : null,
        Math.trunc(value.createdAt),
        Math.trunc(value.updatedAt),
      );
      tx.run("delete from evaluation_experiment_evaluators where experiment_id = ?", value.id);
      for (const [sequence, evaluatorId] of value.evaluatorIds.entries()) {
        tx.run(
          `
            insert into evaluation_experiment_evaluators (
              experiment_id, evaluator_id, sequence
            ) values (?, ?, ?)
          `,
          value.id,
          evaluatorId,
          sequence,
        );
      }
    });
    return value;
  }

  async deleteExperiment(id: string): Promise<boolean> {
    return this.database.run("delete from evaluation_experiments where id = ?", id).changes > 0;
  }

  async listRuns(input: ListEvaluationRunsRequest = {}): Promise<EvaluationRunPage> {
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
    const filter = input.experimentId ? "where r.experiment_id = ?" : "";
    const filterParams: SQLInputValue[] = input.experimentId ? [input.experimentId] : [];
    const totalRow = this.database.get<{ total: number }>(
      `select count(*) as total from evaluation_runs r ${filter}`,
      ...filterParams,
    );
    const rows = this.database.all<Row>(
      `
        select r.*,
          (
            select count(*)
            from evaluation_case_results c
            where c.run_id = r.id
          ) as result_count,
          (
            select count(distinct c.id)
            from evaluation_case_results c
            left join evaluation_scores s on s.case_result_id = c.id
            where c.run_id = r.id
              and (c.error is not null or s.passed = 0)
          ) as failed_result_count
        from evaluation_runs r
        ${filter}
        order by r.started_at desc
        limit ? offset ?
      `,
      ...filterParams,
      limit,
      offset,
    );
    return {
      items: rows.map(mapRunSummary),
      total: Number(totalRow?.total ?? 0),
      offset,
      limit,
    };
  }

  async getRun(id: string): Promise<EvaluationRun | undefined> {
    const row = this.database.get<Row>("select * from evaluation_runs where id = ?", id);
    return row ? this.run(row) : undefined;
  }

  async deleteRun(id: string): Promise<boolean> {
    return this.database.run("delete from evaluation_runs where id = ?", id).changes > 0;
  }

  async saveRun(value: EvaluationRun): Promise<EvaluationRun> {
    await this.database.transaction(async (tx) => {
      tx.run(
        `
          insert into evaluation_runs (
            id, experiment_id, status, agent_revision_id, skill_hash, started_at, finished_at,
            average_score, minimum_score, pass_rate, total_duration_ms, error,
            engine, scored_case_count, unscored_case_count, coverage, dimensions, rubric_hash,
            consistency, scoring_version, stage_scores
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict (id) do update set
            status = excluded.status,
            finished_at = excluded.finished_at,
            average_score = excluded.average_score,
            minimum_score = excluded.minimum_score,
            pass_rate = excluded.pass_rate,
            total_duration_ms = excluded.total_duration_ms,
            error = excluded.error,
            scored_case_count = excluded.scored_case_count,
            unscored_case_count = excluded.unscored_case_count,
            coverage = excluded.coverage,
            dimensions = excluded.dimensions,
            consistency = excluded.consistency,
            skill_hash = coalesce(evaluation_runs.skill_hash, excluded.skill_hash),
            rubric_hash = coalesce(excluded.rubric_hash, evaluation_runs.rubric_hash),
            scoring_version = coalesce(excluded.scoring_version, evaluation_runs.scoring_version),
            engine = coalesce(excluded.engine, evaluation_runs.engine),
            stage_scores = coalesce(excluded.stage_scores, evaluation_runs.stage_scores)
        `,
        value.id,
        value.experimentId,
        value.status,
        value.agentRevisionId ?? null,
        value.skillHash ?? null,
        Math.trunc(value.startedAt),
        value.finishedAt === undefined ? null : Math.trunc(value.finishedAt),
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
        value.consistency ? JSON.stringify(value.consistency) : null,
        value.scoringVersion ?? null,
        value.stageScores && value.stageScores.length > 0
          ? JSON.stringify(value.stageScores)
          : null,
      );
      tx.run("delete from evaluation_case_results where run_id = ?", value.id);
      for (const result of value.results) {
        this.insertCaseResult(tx, value.id, result);
      }
    });
    return value;
  }

  async saveTrajectoryResult(
    value: EvaluationTrajectoryResult,
  ): Promise<EvaluationTrajectoryResult> {
    const subjectId = trajectorySubjectId(value.subject);
    const references = trajectoryReferences(value.subject);
    await this.database.transaction(async (tx) => {
      tx.run(
        `
          insert or ignore into evaluation_subjects (
            id, subject_type, session_key, turn_id, span_id
          ) values (?, ?, ?, ?, ?)
        `,
        subjectId,
        value.subject.type,
        references.sessionKey,
        references.turnId,
        references.spanId,
      );
      tx.run(
        `
          insert into evaluation_results (
            id, subject_id, evaluator_id, metric, score, label, passed,
            explanation, evidence, evaluator_version, created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            created_at = excluded.created_at
        `,
        value.id,
        subjectId,
        value.evaluatorId ?? null,
        value.metric,
        value.score ?? null,
        value.label ?? null,
        value.passed === undefined ? null : value.passed ? 1 : 0,
        value.explanation ?? null,
        value.evidence ? JSON.stringify(value.evidence) : null,
        value.evaluatorVersion ?? null,
        Math.trunc(value.createdAt),
      );
    });
    return value;
  }

  async listTrajectoryResults(
    subject: EvaluationTrajectorySubject,
  ): Promise<EvaluationTrajectoryResult[]> {
    const rows = this.database.all<Row>(
      `
        select *
        from evaluation_results
        where subject_id = ?
        order by created_at desc, id
      `,
      trajectorySubjectId(subject),
    );
    return rows.map((row) => ({
      id: String(row.id),
      subject,
      ...(row.evaluator_id ? { evaluatorId: String(row.evaluator_id) } : {}),
      metric: String(row.metric),
      ...(row.score !== null && row.score !== undefined ? { score: Number(row.score) } : {}),
      ...(row.label ? { label: String(row.label) } : {}),
      ...(row.passed !== null && row.passed !== undefined ? { passed: Boolean(row.passed) } : {}),
      ...(row.explanation ? { explanation: String(row.explanation) } : {}),
      ...(row.evidence ? { evidence: jsonRecord(row.evidence) } : {}),
      ...(row.evaluator_version ? { evaluatorVersion: String(row.evaluator_version) } : {}),
      createdAt: timestamp(row.created_at),
    }));
  }

  close(): void {
    // The application owns the shared SQLite database handle.
  }

  private dataset(row: Row): EvaluationDataset {
    const items = this.database.all<Row>(
      `
        select *
        from evaluation_dataset_items
        where dataset_id = ?
        order by sequence
      `,
      String(row.id),
    );
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      items: items.map((item) => ({
        id: String(item.id),
        input: String(item.input),
        ...(item.expected_output ? { expectedOutput: String(item.expected_output) } : {}),
        metadata: jsonRecord(item.metadata),
        sequence: Number(item.sequence),
      })),
    };
  }

  private run(row: Row): EvaluationRun {
    const runId = String(row.id);
    const caseRows = this.database.all<Row>(
      "select * from evaluation_case_results where run_id = ? order by id",
      runId,
    );
    const scoreRows = this.database.all<Row>(
      `
        select s.*
        from evaluation_scores s
        join evaluation_case_results c on c.id = s.case_result_id
        where c.run_id = ?
        order by s.case_result_id, s.evaluator_id, s.dimension
      `,
      runId,
    );
    const nodeRows = this.database.all<Row>(
      `
        select n.*
        from evaluation_case_nodes n
        join evaluation_case_results c on c.id = n.case_result_id
        where c.run_id = ?
        order by n.case_result_id, n.sequence
      `,
      runId,
    );
    const verdictRows = this.database.all<Row>(
      `
        select v.*
        from evaluation_case_verdicts v
        join evaluation_case_results c on c.id = v.case_result_id
        where c.run_id = ?
        order by v.case_result_id, v.node_id, v.sequence
      `,
      runId,
    );

    const scoresByCase = new Map<string, EvaluationScore[]>();
    for (const score of scoreRows) {
      const caseId = String(score.case_result_id);
      const scores = scoresByCase.get(caseId) ?? [];
      scores.push(mapScore(score));
      scoresByCase.set(caseId, scores);
    }
    const verdictsByCaseNode = new Map<string, Map<string, EvaluationVerdict[]>>();
    for (const verdict of verdictRows) {
      const caseId = String(verdict.case_result_id);
      const byNode = verdictsByCaseNode.get(caseId) ?? new Map<string, EvaluationVerdict[]>();
      const nodeId = String(verdict.node_id);
      byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), mapVerdict(verdict)]);
      verdictsByCaseNode.set(caseId, byNode);
    }
    const nodesByCase = new Map<string, EvaluationNodeRecord[]>();
    for (const node of nodeRows) {
      const caseId = String(node.case_result_id);
      const nodes = nodesByCase.get(caseId) ?? [];
      nodes.push(mapNodeRecord(
        node,
        verdictsByCaseNode.get(caseId)?.get(String(node.node_id)) ?? [],
      ));
      nodesByCase.set(caseId, nodes);
    }
    const results = caseRows.map((result): EvaluationCaseResult => {
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
        ...(result.gate_passed !== null && result.gate_passed !== undefined
          ? { gatePassed: Boolean(result.gate_passed) }
          : {}),
        ...(result.score !== null && result.score !== undefined
          ? { score: Number(result.score) }
          : {}),
        ...(result.passed !== null && result.passed !== undefined
          ? { passed: Boolean(result.passed) }
          : {}),
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
          ? { skippedEvaluatorIds: jsonArray(result.skipped_evaluator_ids) }
          : {}),
        ...(result.skipped_stage_ids
          ? { skippedStageIds: jsonArray(result.skipped_stage_ids) }
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

  private insertCaseResult(
    tx: SqliteQueryable,
    runId: string,
    result: EvaluationCaseResult,
  ): void {
    tx.run(
      `
        insert into evaluation_case_results (
          id, run_id, dataset_item_id, repetition, input, expected_output,
          output, error, duration_ms, session_key, skill_name, skill_hash,
          skill_content_length, unscored_reason, gate_passed,
          score, passed, coverage, dimensions, by_label, skipped_evaluator_ids,
          artifact_origin_kind, artifact_origin_reference, artifact_files,
          skipped_stage_ids
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
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
      result.gatePassed === undefined ? null : result.gatePassed ? 1 : 0,
      result.score ?? null,
      result.passed === undefined ? null : result.passed ? 1 : 0,
      result.coverage ?? null,
      result.dimensions ? JSON.stringify(result.dimensions) : null,
      result.byLabel ? JSON.stringify(result.byLabel) : null,
      result.skippedEvaluatorIds && result.skippedEvaluatorIds.length > 0
        ? JSON.stringify(result.skippedEvaluatorIds)
        : null,
      result.artifact?.origin.kind ?? null,
      result.artifact?.origin.reference ?? null,
      result.artifact?.files && result.artifact.files.length > 0
        ? JSON.stringify(result.artifact.files)
        : null,
      result.skippedStageIds && result.skippedStageIds.length > 0
        ? JSON.stringify(result.skippedStageIds)
        : null,
    );
    this.insertCaseNodes(tx, result);
    for (const score of result.scores) {
      tx.run(
        `
          insert into evaluation_scores (
            case_result_id, evaluator_id, score, passed, reason, evidence,
            failed_criteria, duration_ms, token_count, estimated_cost, dimension
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        result.id,
        score.evaluatorId,
        score.score,
        score.passed ? 1 : 0,
        score.reason ?? null,
        score.evidence ? JSON.stringify(score.evidence) : null,
        score.failedCriteria ? JSON.stringify(score.failedCriteria) : null,
        score.durationMs,
        score.tokenCount ?? null,
        score.estimatedCost ?? null,
        score.dimension ?? score.evaluatorId,
      );
    }
  }

  private insertCaseNodes(
    tx: SqliteQueryable,
    result: EvaluationCaseResult,
  ): void {
    const nodes = result.nodes ?? [];
    for (const [index, node] of nodes.entries()) {
      tx.run(
        `
          insert into evaluation_case_nodes (
            case_result_id, node_id, node_type, node_version, role, status,
            pending_reason, pending_upstream, started_at, finished_at, duration_ms,
            attribution, produced_outputs, facts, sequence
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        result.id,
        node.nodeId,
        node.nodeType,
        node.nodeVersion,
        node.role,
        node.status,
        node.pendingReason ?? null,
        node.pendingUpstream ? JSON.stringify(node.pendingUpstream) : null,
        node.startedAt === undefined ? null : Math.trunc(node.startedAt),
        node.finishedAt === undefined ? null : Math.trunc(node.finishedAt),
        node.durationMs ?? null,
        node.attribution ? JSON.stringify(node.attribution) : null,
        node.producedOutputs ? JSON.stringify(node.producedOutputs) : null,
        node.facts ? JSON.stringify(node.facts) : null,
        index,
      );
      for (const [verdictIndex, verdict] of (node.verdicts ?? []).entries()) {
        tx.run(
          `
            insert into evaluation_case_verdicts (
              case_result_id, verdict_id, node_id, node_type, evaluator_id, status,
              raw, threshold, labels, reason, evidence, failed_criteria, duration_ms, sequence
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
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
    ...(row.scoring_version !== null && row.scoring_version !== undefined
      ? { scoringVersion: Number(row.scoring_version) }
      : {}),
    startedAt: timestamp(row.started_at),
    ...(row.finished_at !== null && row.finished_at !== undefined
      ? { finishedAt: timestamp(row.finished_at) }
      : {}),
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
    ...(row.stage_scores
      ? {
          stageScores: jsonObjectArray<
            NonNullable<EvaluationRun["stageScores"]>[number]
          >(row.stage_scores),
        }
      : {}),
    ...(row.consistency
      ? { consistency: jsonValue(row.consistency) as EvaluationRunConsistency }
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
    ...(row.started_at !== null && row.started_at !== undefined
      ? { startedAt: timestamp(row.started_at) }
      : {}),
    ...(row.finished_at !== null && row.finished_at !== undefined
      ? { finishedAt: timestamp(row.finished_at) }
      : {}),
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
  if (typeof value === "bigint") return Number(value);
  const asNum = Number(value);
  return Number.isFinite(asNum) ? asNum : Date.parse(String(value));
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
