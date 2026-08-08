import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import { workflowStoragePlanFor } from "../../../shared/workflow-v2/runtime-utils";
import { materializeWorkflowV2AcceptedReviewCandidate } from "./workflow-v2-review-override";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Workflow V2 accepted review candidate", () => {
  test("materializes strict-atomic artifacts only in the isolated workspace and preserves runtime evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-review-override-"));
    temporaryRoots.push(root);
    const sourceWorkDir = path.join(root, "source");
    const workspaceDir = path.join(root, "isolated");
    await Promise.all([mkdir(sourceWorkDir, { recursive: true }), mkdir(workspaceDir, { recursive: true })]);
    const node: WorkflowV2LLMNode = {
      id: "report",
      kind: "report",
      title: "Report",
      execModel: "llm",
      executionMode: "one-shot",
      prompt: "Write the report.",
      outputFields: [{ key: "report_markdown", required: true, artifact: { format: "markdown" } }],
    };
    const candidate = {
      nodeId: node.id,
      summary: "Candidate report",
      outputs: { report_markdown: "# Accepted" },
      proposals: [],
      acceptance: { outcome: "degraded" as const, issues: [{ code: "quality_override", severity: "warning" as const, detail: "Accepted by a human." }], changedPaths: ["report.md"], operationIds: ["operation-1"] },
      scriptReceipt: { exitCode: 0, signal: null, timedOut: false, stderrSummary: "", stdoutDigest: "stdout", operationDigest: "operation", effectState: "workspace_changed" as const },
    };
    const prepareCalls: unknown[] = [];

    const accepted = await materializeWorkflowV2AcceptedReviewCandidate({
      workflowId: "workflow-review",
      runId: "run-review",
      sourceWorkDir,
      baselineId: "baseline-review",
      transactionMode: "strict_atomic",
      node,
      candidate,
      prepareWorkspaceTransaction: async (input) => {
        prepareCalls.push(input);
        return { workspaceDir };
      },
    });

    const relativeArtifact = path.join(workflowStoragePlanFor("workflow-review", "run-review").outputDir, "report-report_markdown.md");
    expect(await readFile(path.join(workspaceDir, relativeArtifact), "utf8")).toBe("# Accepted\n");
    await expect(stat(path.join(sourceWorkDir, relativeArtifact))).rejects.toMatchObject({ code: "ENOENT" });
    expect(prepareCalls).toEqual([{ workflowId: "workflow-review", runId: "run-review", sourceDir: sourceWorkDir, baselineId: "baseline-review" }]);
    expect(accepted).toMatchObject({ acceptance: candidate.acceptance, scriptReceipt: candidate.scriptReceipt });
    expect(accepted).not.toBe(candidate);
  });
});
