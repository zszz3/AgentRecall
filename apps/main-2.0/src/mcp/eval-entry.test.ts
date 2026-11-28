import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SqliteEvaluationStore } from "../automation/engine/main/sqlite-evaluation-store";
import { SqliteDatabase, toSqliteConnectionUrl } from "../core/sqlite/database";
import { SQLITE_MIGRATIONS } from "../core/sqlite/schema";
import {
  addEvalDatasetCases,
  exportEvalDatasetFolder,
  getEvalDataset,
  getEvalRunReport,
  importEvalDatasetFolder,
  listEvalDatasets,
  listEvalGraphs,
  listEvalRuns,
  openSqliteEvalStore,
  writeEvalDataset,
} from "./eval-entry";

describe("evaluation MCP tools", () => {
  let database: SqliteDatabase;
  let store: SqliteEvaluationStore;

  beforeEach(async () => {
    database = SqliteDatabase.open(":memory:", {
      migrations: SQLITE_MIGRATIONS,
    });
    await database.initialize();
    store = new SqliteEvaluationStore(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it("creates a dataset and reads it back with its cases", async () => {
    const created = await writeEvalDataset(store, {
      name: "Login regression",
      description: "cases about the login flow",
      cases: [
        { input: "why does login fail?", expectedOutput: "expired token", context: "auth module" },
        { input: "how do we refresh it?" },
      ],
    });

    expect(created.caseCount).toBe(2);
    expect(created.cases[0]).toMatchObject({
      input: "why does login fail?",
      expectedOutput: "expired token",
      context: "auth module",
    });
    expect(created.cases[1]!.context).toBeUndefined();
    await expect(listEvalDatasets(store)).resolves.toMatchObject([
      { name: "Login regression", caseCount: 2 },
    ]);
  });

  it("finds a dataset by name as well as by id", async () => {
    const created = await writeEvalDataset(store, {
      name: "Named dataset",
      cases: [{ input: "one" }],
    });

    await expect(getEvalDataset(store, "Named dataset")).resolves.toMatchObject({ id: created.id });
    await expect(getEvalDataset(store, created.id)).resolves.toMatchObject({ id: created.id });
    await expect(getEvalDataset(store, "missing")).resolves.toBeNull();
  });

  it("replaces every case when writing an existing dataset", async () => {
    // Replacement is total on purpose: a dataset is the specification a run is
    // measured against, so a silent merge would change what a score means.
    const created = await writeEvalDataset(store, {
      name: "Replaceable",
      cases: [{ input: "old one" }, { input: "old two" }],
    });

    const replaced = await writeEvalDataset(store, {
      datasetId: created.id,
      name: "Replaceable",
      cases: [{ input: "new only" }],
    });

    expect(replaced.id).toBe(created.id);
    expect(replaced.cases.map((item) => item.input)).toEqual(["new only"]);
  });

  it("appends cases without disturbing the existing ones", async () => {
    const created = await writeEvalDataset(store, {
      name: "Growing",
      cases: [{ input: "first" }],
    });

    const grown = await addEvalDatasetCases(store, {
      datasetId: created.id,
      cases: [{ input: "second" }],
    });

    expect(grown.cases.map((item) => item.input)).toEqual(["first", "second"]);
    expect(grown.cases[0]!.id).toBe(created.cases[0]!.id);
  });

  it("refuses a dataset with no cases or no name", async () => {
    await expect(writeEvalDataset(store, { name: "Empty", cases: [] }))
      .rejects.toThrow(/at least one case/i);
    await expect(writeEvalDataset(store, { name: "  ", cases: [{ input: "x" }] }))
      .rejects.toThrow(/name is required/i);
    await expect(writeEvalDataset(store, { name: "Blank case", cases: [{ input: "   " }] }))
      .rejects.toThrow(/needs an input/i);
  });

  it("reports which experiments run an authored graph", async () => {
    const dataset = await writeEvalDataset(store, { name: "For graphs", cases: [{ input: "x" }] });
    const now = Date.now();
    await store.saveExperiment({
      id: "experiment-derived",
      name: "Derived",
      datasetId: dataset.id,
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      createdAt: now,
      updatedAt: now,
    });
    await store.saveExperiment({
      id: "experiment-authored",
      name: "Authored",
      datasetId: dataset.id,
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      graph: {
        version: 1,
        spec: { name: "authored", version: 1, nodes: [{ id: "task", type: "task_source" }] },
        layout: {},
      },
      createdAt: now,
      updatedAt: now,
    });

    const graphs = await listEvalGraphs(store);

    expect(graphs.find((item) => item.experimentId === "experiment-derived")!.customGraph).toBe(false);
    expect(graphs.find((item) => item.experimentId === "experiment-authored")!.customGraph).toBe(true);
  });

  it("reports a run's steps and why a case produced nothing", async () => {
    const dataset = await writeEvalDataset(store, { name: "For runs", cases: [{ input: "x" }] });
    const now = Date.now();
    await store.saveExperiment({
      id: "experiment-1",
      name: "Runs",
      datasetId: dataset.id,
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      createdAt: now,
      updatedAt: now,
    });
    await store.saveRun({
      id: "run-1",
      experimentId: "experiment-1",
      status: "failed",
      engine: "graph",
      startedAt: now,
      scoredCaseCount: 0,
      unscoredCaseCount: 1,
      results: [
        {
          id: "run-1:case-1:1",
          runId: "run-1",
          datasetItemId: "case-1",
          repetition: 1,
          input: "x",
          output: "",
          durationMs: 1,
          unscoredReason: "judge_runtime_not_configured",
          sessionKey: "claude:thread-1",
          scores: [],
          nodes: [
            {
              nodeId: "judge",
              nodeType: "llm_judge",
              nodeVersion: 1,
              role: "judge",
              status: "excused",
              attribution: { type: "infra_failure", reason: "judge_runtime_not_configured" },
            },
          ],
        },
      ],
    });

    await expect(listEvalRuns(store, { experimentId: "experiment-1" }))
      .resolves.toMatchObject([{ runId: "run-1", status: "failed", unscoredCaseCount: 1 }]);
    const report = await getEvalRunReport(store, "run-1");
    expect(report!.cases[0]).toMatchObject({
      passed: false,
      unscoredReason: "judge_runtime_not_configured",
      sessionKey: "claude:thread-1",
      steps: [{ node: "judge", status: "excused", reason: "judge_runtime_not_configured" }],
    });
    await expect(getEvalRunReport(store, "missing")).resolves.toBeNull();
  });
  it("reports the dimension breakdown, not only the average", async () => {
    // An agent asked "did the change regress anything" needs to know which
    // dimension moved; one average cannot answer that.
    const now = Date.now();
    const dataset = await writeEvalDataset(store, {
      name: "Dimensions",
      description: "",
      cases: [{ input: "x" }],
    });
    await store.saveExperiment({
      id: "experiment-2",
      name: "dimension run",
      datasetId: dataset.id,
      agentId: "agent-1",
      evaluatorIds: [],
      repetitions: 1,
      createdAt: now,
      updatedAt: now,
    });
    await store.saveRun({
      id: "run-2",
      experimentId: "experiment-2",
      status: "completed",
      engine: "graph",
      startedAt: now,
      scoredCaseCount: 1,
      unscoredCaseCount: 0,
      coverage: 0.75,
      dimensions: [
        { dimension: "correctness", score: 0.9, weight: 4, scoredCaseCount: 1 },
        { dimension: "brevity", score: 0.2, weight: 1, scoredCaseCount: 1 },
      ],
      results: [{
        id: "run-2:case-1:1",
        runId: "run-2",
        datasetItemId: "case-1",
        repetition: 1,
        input: "x",
        output: "y",
        durationMs: 1,
        score: 0.76,
        passed: true,
        coverage: 0.75,
        dimensions: [
          {
            dimension: "correctness",
            score: 0.9,
            weight: 4,
            decided: 1,
            undecided: 0,
            met: 1,
            unmet: 0,
          },
          {
            dimension: "brevity",
            score: 0.2,
            weight: 1,
            decided: 1,
            undecided: 0,
            met: 0,
            unmet: 1,
          },
        ],
        skippedEvaluatorIds: ["tool-failures"],
        scores: [],
      }],
    });

    const report = await getEvalRunReport(store, "run-2");

    expect(report).toMatchObject({
      coverage: 0.75,
      dimensions: [
        { dimension: "correctness", score: 0.9, weight: 4 },
        { dimension: "brevity", score: 0.2, weight: 1 },
      ],
    });
    // Passing with one dimension unmet is exactly the case a per-check reading
    // would get wrong.
    expect(report!.cases[0]).toMatchObject({
      passed: true,
      score: 0.76,
      skippedEvaluatorIds: ["tool-failures"],
      dimensions: [
        { dimension: "correctness", score: 0.9, met: 1, unmet: 0 },
        { dimension: "brevity", score: 0.2, met: 0, unmet: 1 },
      ],
    });
  });
  it("imports a dataset folder and re-imports it as the same dataset", async () => {
    // Whether an agent or a person edits the files, the folder is the source of
    // truth; a second import must update rather than pile up a near-copy.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-folder-"));
    fs.mkdirSync(path.join(root, "cases"));
    fs.writeFileSync(path.join(root, "dataset.md"), [
      "---",
      "name: Login regression",
      "description: cases about the login flow",
      "---",
      "",
      "# Login regression",
      "",
      "Prose here is documentation and is not imported.",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(
      path.join(root, "cases", "001-expired-token.json"),
      JSON.stringify({ input: "why does login fail?", expectedOutput: "expired token", context: "auth" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "cases", "002-refresh.json"),
      JSON.stringify({ input: "how do we refresh it?" }),
      "utf8",
    );
    fs.writeFileSync(path.join(root, "cases", "003-broken.json"), "{ not json", "utf8");

    const imported = await importEvalDatasetFolder(store, root);

    expect(imported).toMatchObject({ name: "Login regression", caseCount: 2 });
    expect(imported.cases.map((item) => item.input))
      .toEqual(["why does login fail?", "how do we refresh it?"]);
    expect(imported.cases[0]!.context).toBe("auth");
    // Case ids are namespaced by the dataset because the store keys them
    // globally; the leading number is ordering, not identity, so it is dropped.
    expect(imported.cases[0]!.id).toBe(`${imported.id}:expired-token`);
    // A file that could not be read is named, never dropped in silence.
    expect(imported.errors.join(" ")).toContain("003-broken.json");

    fs.writeFileSync(
      path.join(root, "cases", "003-broken.json"),
      JSON.stringify({ input: "and if the refresh fails?" }),
      "utf8",
    );
    const reimported = await importEvalDatasetFolder(store, root);

    expect(reimported.id).toBe(imported.id);
    expect(reimported.caseCount).toBe(3);
    expect(await listEvalDatasets(store)).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("exports a dataset as a folder that imports back unchanged", async () => {
    const created = await writeEvalDataset(store, {
      name: "Round trip",
      description: "written by the app",
      cases: [
        { input: "first", expectedOutput: "1", context: "counting" },
        { input: "second" },
      ],
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-export-"));

    const written = await exportEvalDatasetFolder(store, "Round trip", root);

    expect(written.caseCount).toBe(2);
    expect(fs.existsSync(path.join(root, "dataset.md"))).toBe(true);
    const imported = await importEvalDatasetFolder(store, root);
    expect(imported.name).toBe("Round trip");
    expect(imported.cases.map((item) => [item.input, item.expectedOutput, item.context]))
      .toEqual(created.cases.map((item) => [item.input, item.expectedOutput, item.context]));

    // Exporting the imported copy again must not prefix the case ids a second
    // time; a file's id is the user's own label for the case.
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "eval-export-2-"));
    await exportEvalDatasetFolder(store, imported.id, second);
    const twice = await importEvalDatasetFolder(store, second);
    expect(twice.cases.map((item) => item.id.slice(twice.id.length + 1)))
      .toEqual(imported.cases.map((item) => item.id.slice(imported.id.length + 1)));

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });

  it("refuses a folder with nothing readable in it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-empty-"));

    await expect(importEvalDatasetFolder(store, root)).rejects.toThrow();
    await expect(importEvalDatasetFolder(store, path.join(root, "missing")))
      .rejects.toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("opens SQLite evaluation stores and translates missing-table errors cleanly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-sqlite-"));
    const uninitializedPath = path.join(dir, "empty.sqlite");
    const uninit = openSqliteEvalStore(toSqliteConnectionUrl(uninitializedPath));
    try {
      await expect(listEvalDatasets(uninit.store)).rejects.toThrow(/Open the app once, then retry/i);
    } finally {
      await uninit.close();
    }

    const dbPath = path.join(dir, "agent-recall.sqlite");
    const initDb = SqliteDatabase.open(dbPath, { migrations: SQLITE_MIGRATIONS });
    await initDb.initialize();
    await initDb.close();

    const opened = openSqliteEvalStore(toSqliteConnectionUrl(dbPath));
    try {
      const saved = await writeEvalDataset(opened.store, {
        name: "SQLite eval suite",
        cases: [{ input: "Check WAL", expectedOutput: "enabled" }],
      });
      expect(saved.caseCount).toBe(1);
      await expect(listEvalDatasets(opened.store)).resolves.toMatchObject([
        { name: "SQLite eval suite", caseCount: 1 },
      ]);
    } finally {
      await opened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
