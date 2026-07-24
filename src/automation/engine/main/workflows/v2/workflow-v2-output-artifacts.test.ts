import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import { materializeWorkflowV2OutputArtifacts } from "./workflow-v2-output-artifacts";

function node(outputFields: WorkflowV2LLMNode["outputFields"]): WorkflowV2LLMNode {
  return { id: "weekly-report", kind: "report", title: "Report", execModel: "llm", prompt: "Write report", outputFields };
}

describe("materializeWorkflowV2OutputArtifacts", () => {
  test("materializes legacy answer_markdown content into the current run output directory", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "workflow-artifact-"));
    const artifacts = await materializeWorkflowV2OutputArtifacts({
      workflowId: "wf-1",
      runId: "run-1",
      workDir,
      node: node([{ key: "answer_markdown", valueType: "string", required: true }]),
      output: { nodeId: "weekly-report", summary: "Done", outputs: { answer_markdown: "# Weekly\n\nDone." }, proposals: [] },
    });
    expect(artifacts[0]?.relativePath).toBe("outputs/wf-1/run-1/weekly-report-answer_markdown.md");
    expect(await readFile(artifacts[0]!.absolutePath, "utf8")).toBe("# Weekly\n\nDone.\n");
  });

  test("uses explicit artifact file names and serializes json output", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "workflow-artifact-"));
    const artifacts = await materializeWorkflowV2OutputArtifacts({
      workflowId: "wf-1",
      runId: "run-1",
      workDir,
      node: node([{ key: "data", valueType: "json", artifact: { format: "json", fileName: "weekly-data" } }]),
      output: { nodeId: "weekly-report", summary: "Done", outputs: { data: { count: 10 } }, proposals: [] },
    });
    expect(artifacts[0]?.relativePath).toBe("outputs/wf-1/run-1/weekly-data.json");
    expect(JSON.parse(await readFile(artifacts[0]!.absolutePath, "utf8"))).toEqual({ count: 10 });
  });

  test("accepts existing file outputs only inside the current run output directory", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "workflow-artifact-"));
    const outputRoot = path.join(workDir, "outputs", "wf-1", "run-1");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(path.join(outputRoot, "report.md"), "# Report\n", "utf8");
    const fileNode = node([{ key: "document", valueType: "file", required: true }]);
    await expect(materializeWorkflowV2OutputArtifacts({
      workflowId: "wf-1",
      runId: "run-1",
      workDir,
      node: fileNode,
      output: { nodeId: "weekly-report", summary: "Done", outputs: { document: "report.md" }, proposals: [] },
    })).resolves.toMatchObject([{ relativePath: "outputs/wf-1/run-1/report.md" }]);
    await expect(materializeWorkflowV2OutputArtifacts({
      workflowId: "wf-1",
      runId: "run-1",
      workDir,
      node: fileNode,
      output: { nodeId: "weekly-report", summary: "Done", outputs: { document: "../../outside.md" }, proposals: [] },
    })).rejects.toThrow("must stay inside");
  });
});
