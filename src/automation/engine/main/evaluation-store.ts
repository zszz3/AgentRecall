import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
} from "../shared/evaluation/types";
import { ensureEvaluationSchema } from "./evaluation/schema";
const require = createRequire(import.meta.url);
interface Stmt {
  all(...p: unknown[]): unknown[];
  run(...p: unknown[]): { changes?: number };
}
interface DB {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}
type Row = Record<string, unknown>;

export class EvaluationStore {
  private db: DB | undefined;
  constructor(private readonly dbPath: string) {}
  async listDatasets(): Promise<EvaluationDataset[]> {
    const db = await this.open();
    return db
      .prepare("select * from evaluation_datasets order by updated_at desc")
      .all()
      .map((v) => this.dataset(db, v as Row));
  }
  async saveDataset(v: EvaluationDataset): Promise<EvaluationDataset> {
    const db = await this.open();
    db.exec("begin immediate");
    try {
      db.prepare(
        "insert into evaluation_datasets values(?,?,?,?,?) on conflict(id) do update set name=excluded.name,description=excluded.description,updated_at=excluded.updated_at",
      ).run(v.id, v.name, v.description, v.createdAt, v.updatedAt);
      db.prepare("delete from evaluation_dataset_items where dataset_id=?").run(
        v.id,
      );
      v.items.forEach((x, i) =>
        db
          .prepare("insert into evaluation_dataset_items values(?,?,?,?,?,?)")
          .run(
            x.id,
            v.id,
            x.input,
            x.expectedOutput ?? null,
            JSON.stringify(x.metadata),
            i,
          ),
      );
      db.exec("commit");
      return v;
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  }
  async deleteDataset(id: string) {
    return (
      Number(
        (await this.open())
          .prepare("delete from evaluation_datasets where id=?")
          .run(id).changes ?? 0,
      ) > 0
    );
  }
  async listEvaluators(): Promise<EvaluationEvaluator[]> {
    return (await this.open())
      .prepare("select * from evaluation_evaluators order by updated_at desc")
      .all()
      .map((v) => {
        const r = v as Row;
        return {
          id: String(r.id),
          name: String(r.name),
          kind: r.kind as EvaluationEvaluator["kind"],
          ...(r.prompt ? { prompt: String(r.prompt) } : {}),
          ...(r.runtime_id ? { runtimeId: String(r.runtime_id) } : {}),
          threshold: Number(r.threshold),
          enabled: Number(r.enabled) === 1,
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        };
      });
  }
  async saveEvaluator(v: EvaluationEvaluator) {
    (await this.open())
      .prepare(
        `insert into evaluation_evaluators
         (id, name, kind, prompt, runtime_id, threshold, enabled, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           name=excluded.name, kind=excluded.kind, prompt=excluded.prompt,
           agent_id=null, runtime_id=excluded.runtime_id, threshold=excluded.threshold,
           enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run(
        v.id,
        v.name,
        v.kind,
        v.prompt ?? null,
        v.runtimeId ?? null,
        v.threshold,
        v.enabled ? 1 : 0,
        v.createdAt,
        v.updatedAt,
      );
    return v;
  }
  async deleteEvaluator(id: string) {
    return (
      Number(
        (await this.open())
          .prepare("delete from evaluation_evaluators where id=?")
          .run(id).changes ?? 0,
      ) > 0
    );
  }
  async listExperiments(): Promise<EvaluationExperiment[]> {
    const db = await this.open();
    return db
      .prepare("select * from evaluation_experiments order by updated_at desc")
      .all()
      .map((v) => {
        const r = v as Row;
        return {
          id: String(r.id),
          name: String(r.name),
          datasetId: String(r.dataset_id),
          agentId: String(r.agent_id),
          repetitions: Number(r.repetitions),
          evaluatorIds: db
            .prepare(
              "select evaluator_id from evaluation_experiment_evaluators where experiment_id=? order by sequence",
            )
            .all(r.id)
            .map((x) => String((x as Row).evaluator_id)),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        };
      });
  }
  async saveExperiment(v: EvaluationExperiment) {
    const db = await this.open();
    db.exec("begin immediate");
    try {
      db.prepare(
        "insert into evaluation_experiments values(?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name,dataset_id=excluded.dataset_id,agent_id=excluded.agent_id,repetitions=excluded.repetitions,updated_at=excluded.updated_at",
      ).run(
        v.id,
        v.name,
        v.datasetId,
        v.agentId,
        v.repetitions,
        v.createdAt,
        v.updatedAt,
      );
      db.prepare(
        "delete from evaluation_experiment_evaluators where experiment_id=?",
      ).run(v.id);
      v.evaluatorIds.forEach((id, i) =>
        db
          .prepare("insert into evaluation_experiment_evaluators values(?,?,?)")
          .run(v.id, id, i),
      );
      db.exec("commit");
      return v;
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  }
  async deleteExperiment(id: string) {
    return (
      Number(
        (await this.open())
          .prepare("delete from evaluation_experiments where id=?")
          .run(id).changes ?? 0,
      ) > 0
    );
  }
  async listRuns(experimentId?: string): Promise<EvaluationRun[]> {
    const db = await this.open();
    const rows = experimentId
      ? db
          .prepare(
            "select * from evaluation_runs where experiment_id=? order by started_at desc",
          )
          .all(experimentId)
      : db
          .prepare("select * from evaluation_runs order by started_at desc")
          .all();
    return rows.map((v) => this.run(db, v as Row));
  }
  async deleteRun(id: string) {
    return (
      Number(
        (await this.open())
          .prepare("delete from evaluation_runs where id=?")
          .run(id).changes ?? 0,
      ) > 0
    );
  }
  async saveRun(v: EvaluationRun): Promise<EvaluationRun> {
    const db = await this.open();
    db.exec("begin immediate");
    try {
      db.prepare(
        "insert into evaluation_runs values(?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set status=excluded.status,finished_at=excluded.finished_at,average_score=excluded.average_score,minimum_score=excluded.minimum_score,pass_rate=excluded.pass_rate,total_duration_ms=excluded.total_duration_ms,error=excluded.error",
      ).run(
        v.id,
        v.experimentId,
        v.status,
        v.agentRevisionId ?? null,
        v.startedAt,
        v.finishedAt ?? null,
        v.averageScore ?? null,
        v.minimumScore ?? null,
        v.passRate ?? null,
        v.totalDurationMs ?? null,
        v.error ?? null,
      );
      db.prepare("delete from evaluation_case_results where run_id=?").run(
        v.id,
      );
      for (const c of v.results) {
        db.prepare(
          "insert into evaluation_case_results values(?,?,?,?,?,?,?,?,?)",
        ).run(
          c.id,
          v.id,
          c.datasetItemId,
          c.repetition,
          c.input,
          c.expectedOutput ?? null,
          c.output,
          c.error ?? null,
          c.durationMs,
        );
        for (const s of c.scores)
          db.prepare(
            `insert into evaluation_scores
             (case_result_id, evaluator_id, score, passed, reason, evidence_json,
              failed_criteria_json, duration_ms, token_count, estimated_cost)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            c.id,
            s.evaluatorId,
            s.score,
            s.passed ? 1 : 0,
            s.reason ?? null,
            s.evidence ? JSON.stringify(s.evidence) : null,
            s.failedCriteria ? JSON.stringify(s.failedCriteria) : null,
            s.durationMs,
            s.tokenCount ?? null,
            s.estimatedCost ?? null,
          );
      }
      db.exec("commit");
      return v;
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
  private dataset(db: DB, r: Row): EvaluationDataset {
    return {
      id: String(r.id),
      name: String(r.name),
      description: String(r.description),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      items: db
        .prepare(
          "select * from evaluation_dataset_items where dataset_id=? order by sequence",
        )
        .all(r.id)
        .map((v) => {
          const x = v as Row;
          return {
            id: String(x.id),
            input: String(x.input),
            ...(x.expected_output
              ? { expectedOutput: String(x.expected_output) }
              : {}),
            metadata: JSON.parse(String(x.metadata_json)),
            sequence: Number(x.sequence),
          };
        }),
    };
  }
  private run(db: DB, r: Row): EvaluationRun {
    const results = db
      .prepare(
        "select * from evaluation_case_results where run_id=? order by id",
      )
      .all(r.id)
      .map((v) => {
        const c = v as Row;
        return {
          id: String(c.id),
          runId: String(c.run_id),
          datasetItemId: String(c.dataset_item_id),
          repetition: Number(c.repetition),
          input: String(c.input),
          ...(c.expected_output
            ? { expectedOutput: String(c.expected_output) }
            : {}),
          output: String(c.output),
          ...(c.error ? { error: String(c.error) } : {}),
          durationMs: Number(c.duration_ms),
          scores: db
            .prepare("select * from evaluation_scores where case_result_id=?")
            .all(c.id)
            .map((v) => {
              const s = v as Row;
              return {
                evaluatorId: String(s.evaluator_id),
                score: Number(s.score),
                passed: Number(s.passed) === 1,
                ...(s.reason ? { reason: String(s.reason) } : {}),
                ...(s.evidence_json
                  ? { evidence: JSON.parse(String(s.evidence_json)) }
                  : {}),
                ...(s.failed_criteria_json
                  ? {
                      failedCriteria: JSON.parse(
                        String(s.failed_criteria_json),
                      ),
                    }
                  : {}),
                durationMs: Number(s.duration_ms),
                ...(s.token_count ? { tokenCount: Number(s.token_count) } : {}),
                ...(s.estimated_cost
                  ? { estimatedCost: Number(s.estimated_cost) }
                  : {}),
              };
            }),
        };
      });
    return {
      id: String(r.id),
      experimentId: String(r.experiment_id),
      status: r.status as EvaluationRun["status"],
      ...(r.agent_revision_id
        ? { agentRevisionId: String(r.agent_revision_id) }
        : {}),
      startedAt: Number(r.started_at),
      ...(r.finished_at ? { finishedAt: Number(r.finished_at) } : {}),
      ...(r.average_score != null
        ? { averageScore: Number(r.average_score) }
        : {}),
      ...(r.minimum_score != null
        ? { minimumScore: Number(r.minimum_score) }
        : {}),
      ...(r.pass_rate != null ? { passRate: Number(r.pass_rate) } : {}),
      ...(r.total_duration_ms != null
        ? { totalDurationMs: Number(r.total_duration_ms) }
        : {}),
      ...(r.error ? { error: String(r.error) } : {}),
      results,
    };
  }
  private async open(): Promise<DB> {
    if (this.db) return this.db;
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => DB;
    };
    const db = new DatabaseSync(this.dbPath);
    db.exec("pragma journal_mode=WAL");
    db.exec("pragma foreign_keys=ON");
    ensureEvaluationSchema(db);
    this.db = db;
    return db;
  }
}
