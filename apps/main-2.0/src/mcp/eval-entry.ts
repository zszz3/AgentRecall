import { randomUUID } from "node:crypto";

import {
  datasetFolderCaseId,
  datasetFolderId,
  datasetFolderItems,
  readDatasetFolder,
  writeDatasetFolder,
} from "../core/evaluation/dataset-folder-io";
import { PostgresDatabase, type PostgresPool } from "../core/postgres/database";
import {
  isSqliteConnectionUrl,
  parseSqliteConnectionUrl,
  SqliteDatabase,
} from "../core/sqlite/database";
import type { EvaluationRepository } from "../core/storage/repositories";
import { EvaluationStore } from "../automation/engine/main/evaluation-store";
import { SqliteEvaluationStore } from "../automation/engine/main/sqlite-evaluation-store";
import type {
  EvaluationDataset,
  EvaluationDatasetItem,
} from "../automation/engine/shared/evaluation/types";

/**
 * Evaluation tools for the standalone MCP server.
 *
 * The process attaches to the running app's database without migrating it: the
 * app owns the schema, and an MCP client that happens to start first must not
 * race it into applying migrations. Reads therefore fail with a plain message
 * when the eval tables are not there yet rather than a raw SQL error.
 */

export interface EvalMcpCaseInput {
  input: string;
  expectedOutput?: string;
  /** Extra context handed to judges; stored as the case's `context` metadata. */
  context?: string;
}

export interface EvalMcpDatasetSummary {
  id: string;
  name: string;
  description: string;
  caseCount: number;
  updatedAt: number;
}

export interface EvalMcpDatasetDetail extends EvalMcpDatasetSummary {
  cases: Array<{ id: string; input: string; expectedOutput?: string; context?: string }>;
}

export interface EvalMcpGraphSummary {
  experimentId: string;
  name: string;
  datasetId: string;
  agentId: string;
  repetitions: number;
  /** True when the experiment runs a graph authored in the editor. */
  customGraph: boolean;
  skillName?: string;
}

export interface EvalMcpRunSummary {
  runId: string;
  experimentId: string;
  status: string;
  startedAt: number;
  passRate?: number;
  averageScore?: number;
  scoredCaseCount?: number;
  unscoredCaseCount?: number;
}

export interface EvalMcpRunReport extends EvalMcpRunSummary {
  /** Mean coverage of the planned judging over the scored cases. */
  coverage?: number;
  /**
   * Score per dimension across the run. The single average cannot say which
   * dimension a regression is in, which is usually the question being asked.
   */
  dimensions?: Array<{ dimension: string; score: number | null; weight: number }>;
  cases: Array<{
    caseId: string;
    passed: boolean;
    score?: number;
    coverage?: number;
    dimensions?: Array<{ dimension: string; score: number | null; met: number; unmet: number }>;
    unscoredReason?: string;
    /** Judges this case's source could not run, so their absence is not silent. */
    skippedEvaluatorIds?: string[];
    sessionKey?: string;
    steps: Array<{ node: string; type: string; status: string; reason?: string }>;
  }>;
}

/** Attaches to the app's PostgreSQL database for reading and writing evaluation data. */
export function openEvalStore(pool: PostgresPool): {
  store: EvaluationRepository;
  close: () => Promise<void>;
} {
  // No migrations and no advisory lock: this process is a guest of the schema.
  const database = new PostgresDatabase(pool, { migrations: [], migrationLock: false });
  return { store: new EvaluationStore(database), close: () => database.close() };
}

/** Attaches to the app's SQLite database for reading and writing evaluation data. */
export function openSqliteEvalStore(connectionUrlOrPath: string): {
  store: EvaluationRepository;
  close: () => Promise<void>;
} {
  const filePath = isSqliteConnectionUrl(connectionUrlOrPath)
    ? parseSqliteConnectionUrl(connectionUrlOrPath)
    : connectionUrlOrPath;
  // No migrations: this process is a guest of the app's schema.
  const database = SqliteDatabase.open(filePath, { migrations: [] });
  return { store: new SqliteEvaluationStore(database), close: () => database.close() };
}

export async function listEvalDatasets(store: EvaluationRepository): Promise<EvalMcpDatasetSummary[]> {
  return (await datasets(store)).map(toDatasetSummary);
}

export async function getEvalDataset(
  store: EvaluationRepository,
  datasetIdOrName: string,
): Promise<EvalMcpDatasetDetail | null> {
  const found = findDataset(await datasets(store), datasetIdOrName);
  if (!found) return null;
  return {
    ...toDatasetSummary(found),
    cases: found.items.map((item) => ({
      id: item.id,
      input: item.input,
      ...(item.expectedOutput !== undefined ? { expectedOutput: item.expectedOutput } : {}),
      ...(typeof item.metadata.context === "string" ? { context: item.metadata.context } : {}),
    })),
  };
}

/**
 * Creates a dataset, or replaces the cases of an existing one.
 *
 * Replacement is total by design — an evaluation dataset is the specification a
 * run is measured against, and a partial merge would leave a run comparing
 * against something no caller asked for. Appending is a separate tool.
 */
export async function writeEvalDataset(
  store: EvaluationRepository,
  input: {
    name: string;
    description?: string;
    cases: readonly EvalMcpCaseInput[];
    datasetId?: string;
  },
): Promise<EvalMcpDatasetDetail> {
  const name = input.name.trim();
  if (!name) throw new Error("A dataset name is required.");
  if (input.cases.length === 0) throw new Error("A dataset needs at least one case.");
  const existing = findDataset(await datasets(store), input.datasetId ?? name);
  const now = Date.now();
  const id = existing?.id ?? input.datasetId?.trim() ?? `dataset-${randomUUID()}`;
  await store.saveDataset({
    id,
    name,
    description: input.description?.trim() ?? existing?.description ?? "",
    items: input.cases.map((item, index) => toDatasetItem(item, index)),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  const saved = await getEvalDataset(store, id);
  if (!saved) throw new Error(`The dataset was not readable after saving: ${id}`);
  return saved;
}

/**
 * Imports a dataset folder from disk.
 *
 * This is the half an agent cannot do for itself: it can already write
 * `dataset.md` and `cases/*.json` with its own file tools — that is what the
 * format is for — but only the app can take those files into its database. The
 * id follows the folder, so re-importing after an edit updates the same dataset.
 */
export async function importEvalDatasetFolder(
  store: EvaluationRepository,
  directory: string,
): Promise<EvalMcpDatasetDetail & { directory: string; errors: string[] }> {
  const folder = readDatasetFolder(directory);
  if (folder.cases.length === 0) {
    throw new Error(folder.errors[0] ?? `No cases were found in: ${directory}`);
  }
  const id = datasetFolderId(directory);
  const existing = (await datasets(store)).find((item) => item.id === id);
  const now = Date.now();
  await store.saveDataset({
    id,
    name: folder.manifest.name,
    description: folder.manifest.description,
    items: datasetFolderItems(id, folder.cases),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  const saved = await getEvalDataset(store, id);
  if (!saved) throw new Error(`The dataset was not readable after importing: ${id}`);
  return { ...saved, directory, errors: folder.errors };
}

/** Writes a dataset to disk in the folder format, for reading or editing by hand. */
export async function exportEvalDatasetFolder(
  store: EvaluationRepository,
  datasetIdOrName: string,
  directory: string,
): Promise<{ directory: string; caseCount: number }> {
  const dataset = findDataset(await datasets(store), datasetIdOrName);
  if (!dataset) throw new Error(`Dataset was not found: ${datasetIdOrName}`);
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

export async function addEvalDatasetCases(
  store: EvaluationRepository,
  input: { datasetId: string; cases: readonly EvalMcpCaseInput[] },
): Promise<EvalMcpDatasetDetail> {
  if (input.cases.length === 0) throw new Error("At least one case is required.");
  const existing = findDataset(await datasets(store), input.datasetId);
  if (!existing) throw new Error(`Dataset was not found: ${input.datasetId}`);
  const items = [
    ...existing.items,
    ...input.cases.map((item, index) => toDatasetItem(item, existing.items.length + index)),
  ];
  await store.saveDataset({ ...existing, items, updatedAt: Date.now() });
  const saved = await getEvalDataset(store, existing.id);
  if (!saved) throw new Error(`The dataset was not readable after saving: ${existing.id}`);
  return saved;
}

export async function listEvalEvaluators(
  store: EvaluationRepository,
): Promise<Array<{ id: string; name: string; kind: string; threshold: number; enabled: boolean }>> {
  return (await guard(() => store.listEvaluators())).map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    threshold: item.threshold,
    enabled: item.enabled,
  }));
}

export async function listEvalGraphs(store: EvaluationRepository): Promise<EvalMcpGraphSummary[]> {
  return (await guard(() => store.listExperiments())).map((item) => ({
    experimentId: item.id,
    name: item.name,
    datasetId: item.datasetId,
    agentId: item.agentId,
    repetitions: item.repetitions,
    customGraph: Boolean(item.graph),
    ...(item.skillName ? { skillName: item.skillName } : {}),
  }));
}

export async function listEvalRuns(
  store: EvaluationRepository,
  input: { experimentId?: string; limit?: number } = {},
): Promise<EvalMcpRunSummary[]> {
  const page = await guard(() => store.listRuns({
    ...(input.experimentId ? { experimentId: input.experimentId } : {}),
    limit: Math.max(1, Math.min(50, Math.floor(input.limit ?? 10))),
  }));
  return page.items.map((run) => ({
    runId: run.id,
    experimentId: run.experimentId,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.passRate !== undefined ? { passRate: run.passRate } : {}),
    ...(run.averageScore !== undefined ? { averageScore: run.averageScore } : {}),
    ...(run.scoredCaseCount !== undefined ? { scoredCaseCount: run.scoredCaseCount } : {}),
    ...(run.unscoredCaseCount !== undefined ? { unscoredCaseCount: run.unscoredCaseCount } : {}),
  }));
}

/**
 * A run with its per-case steps, which is what makes a failure diagnosable: the
 * reason a step produced nothing travels with the case rather than being lost
 * behind a score.
 */
export async function getEvalRunReport(
  store: EvaluationRepository,
  runId: string,
): Promise<EvalMcpRunReport | null> {
  const run = await guard(() => store.getRun(runId.trim()));
  if (!run) return null;
  return {
    runId: run.id,
    experimentId: run.experimentId,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.passRate !== undefined ? { passRate: run.passRate } : {}),
    ...(run.averageScore !== undefined ? { averageScore: run.averageScore } : {}),
    ...(run.scoredCaseCount !== undefined ? { scoredCaseCount: run.scoredCaseCount } : {}),
    ...(run.unscoredCaseCount !== undefined ? { unscoredCaseCount: run.unscoredCaseCount } : {}),
    ...(run.coverage !== undefined ? { coverage: run.coverage } : {}),
    ...(run.dimensions
      ? {
          dimensions: run.dimensions.map((dimension) => ({
            dimension: dimension.dimension,
            score: dimension.score,
            weight: dimension.weight,
          })),
        }
      : {}),
    cases: run.results.map((result) => ({
      caseId: result.id,
      // The dimension-weighted verdict when the run recorded one; a case can
      // clear its threshold with one check unmet.
      passed: result.unscoredReason === undefined && (result.passed ?? (
        result.gatePassed !== false
        && result.scores.length > 0
        && result.scores.every((score) => score.passed)
      )),
      ...(result.score !== undefined ? { score: result.score } : {}),
      ...(result.coverage !== undefined ? { coverage: result.coverage } : {}),
      ...(result.dimensions
        ? {
            dimensions: result.dimensions.map((dimension) => ({
              dimension: dimension.dimension,
              score: dimension.score,
              met: dimension.met,
              unmet: dimension.unmet,
            })),
          }
        : {}),
      ...(result.unscoredReason ? { unscoredReason: result.unscoredReason } : {}),
      ...(result.skippedEvaluatorIds && result.skippedEvaluatorIds.length > 0
        ? { skippedEvaluatorIds: result.skippedEvaluatorIds }
        : {}),
      ...(result.sessionKey ? { sessionKey: result.sessionKey } : {}),
      steps: (result.nodes ?? []).map((node) => ({
        node: node.nodeId,
        type: node.nodeType,
        status: node.status,
        ...(node.attribution?.reason ?? node.pendingReason
          ? { reason: node.attribution?.reason ?? node.pendingReason! }
          : {}),
      })),
    })),
  };
}

function toDatasetItem(item: EvalMcpCaseInput, index: number): EvaluationDatasetItem {
  const input = item.input.trim();
  if (!input) throw new Error("Every case needs an input.");
  return {
    id: `case-${randomUUID()}`,
    input,
    ...(item.expectedOutput !== undefined ? { expectedOutput: item.expectedOutput } : {}),
    // Judges read `context` from metadata, so that is where it has to land.
    metadata: item.context !== undefined ? { context: item.context } : {},
    sequence: index,
  };
}

function toDatasetSummary(dataset: EvaluationDataset): EvalMcpDatasetSummary {
  return {
    id: dataset.id,
    name: dataset.name,
    description: dataset.description,
    caseCount: dataset.items.length,
    updatedAt: dataset.updatedAt,
  };
}

function findDataset(
  all: readonly EvaluationDataset[],
  idOrName: string,
): EvaluationDataset | undefined {
  const needle = idOrName.trim();
  if (!needle) return undefined;
  return all.find((item) => item.id === needle)
    ?? all.find((item) => item.name.trim().toLowerCase() === needle.toLowerCase());
}

function datasets(store: EvaluationRepository): Promise<EvaluationDataset[]> {
  return guard(() => store.listDatasets());
}

/**
 * Turns a missing-schema failure into an actionable message. The MCP client may
 * be started before the app has ever run, and a bare "relation does not exist"
 * tells the caller nothing about what to do.
 */
async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (
      /relation .*evaluation_.* does not exist|schema "agent_recall" does not exist|no such table:\s*evaluation_/i.test(
        message,
      )
    ) {
      throw new Error(
        "AgentRecall's evaluation tables are not set up yet. Open the app once, then retry.",
      );
    }
    throw cause;
  }
}
