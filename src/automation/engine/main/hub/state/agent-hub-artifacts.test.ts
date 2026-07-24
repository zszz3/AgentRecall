import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { listWorkflowOutputs, reconcileWorkflowOutputArtifacts } from "./agent-hub-artifacts";

describe("listWorkflowOutputs", () => {
  test("lists only files from the requested workflow run directory", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "workflow-outputs-"));
    const current = path.join(workDir, "outputs", "workflow-a", "run-2");
    await mkdir(current, { recursive: true });
    await mkdir(path.join(workDir, "outputs", "workflow-a", "run-1"), { recursive: true });
    await mkdir(path.join(workDir, "outputs", "workflow-b", "run-2"), { recursive: true });
    await writeFile(path.join(current, "report.md"), "current");
    await writeFile(path.join(workDir, "outputs", "workflow-a", "run-1", "old.md"), "old");
    await writeFile(path.join(workDir, "outputs", "workflow-b", "run-2", "foreign.md"), "foreign");

    const files = await listWorkflowOutputs({ workDir }, workDir, "workflow-a", "run-2");

    expect(files).toEqual([{ name: "report.md", path: path.join(current, "report.md") }]);
  });
});

describe("reconcileWorkflowOutputArtifacts", () => {
  test("backfills Markdown files for completed runs created before artifact materialization", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "workflow-output-reconcile-"));
    const workflow = {
      workflowId: "workflow-a",
      workDir,
      workflowV2Plan: {
        definition: {
          nodes: [{
            id: "report",
            kind: "report",
            title: "Report",
            execModel: "llm",
            prompt: "Write report",
            outputFields: [{ key: "answer_markdown", required: true, valueType: "string" }],
          }],
        },
      },
    } as never;
    const run = {
      workflowId: "workflow-a",
      runId: "run-legacy",
      progress: [{ nodeId: "report", title: "Report", status: "completed", detail: "Done", outputs: { answer_markdown: "# Legacy report" } }],
    } as never;

    await reconcileWorkflowOutputArtifacts(workflow, run, workDir);

    const filePath = path.join(workDir, "outputs", "workflow-a", "run-legacy", "report-answer_markdown.md");
    expect(await readFile(filePath, "utf8")).toBe("# Legacy report\n");
  });
});
