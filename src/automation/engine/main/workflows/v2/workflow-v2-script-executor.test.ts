import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec, type WorkflowV2Definition, type WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import { executeWorkflowV2Script } from "./workflow-v2-script-executor";
import { workflowV2ScriptCapabilityDigest, workflowV2ScriptOperationDigest } from "./workflow-v2-script-analysis";

const execFileAsync = promisify(execFile);

describe("workflow-v2 script executor", () => {
  test("executes an auto-authorized inline typescript transform", async () => {
    const node = {
      id: "echo",
      kind: "transform",
      title: "Echo",
      execModel: "script" as const,
      executionMode: "script" as const,
      outputFields: [{ key: "result", required: true }],
      script: {
        executable: { kind: "inline" as const, language: "typescript" as const, code: "return { result: 'ok' };" },
        parameters: [],
        capabilities: [],
        managerRisk: { level: "safe" as const, rationale: "Pure in-memory transform." },
        outputSchema: { type: "object" as const, required: ["result"] },
      },
    };
    const workDir = process.cwd();
    const output = await executeWorkflowV2Script({
      node,
      workDir,
      upstreamOutputs: [],
      signal: new AbortController().signal,
      timeoutMs: 2_000,
      inputs: {},
      authorization: { decision: "auto_allow", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: "echo", risk: "safe", capabilities: [], capabilityDigest: workflowV2ScriptCapabilityDigest([]), operationDigest: workflowV2ScriptOperationDigest({ workflowId: "wf", graphVersion: 1, runId: "run", node, workDir, inputs: {} }) },
    });

    expect(output.outputs).toEqual({ result: "ok" });
  });

  test("rejects an authorization whose capability digest does not match", async () => {
    await expect(executeWorkflowV2Script({
      node: { id: "echo", kind: "transform", title: "Echo", execModel: "script", executionMode: "script", outputFields: [], script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return {};" }) },
      workDir: process.cwd(), upstreamOutputs: [], signal: new AbortController().signal, timeoutMs: 2_000, inputs: {},
      authorization: { decision: "auto_allow", workflowId: "wf", graphVersion: 1, runId: "run", nodeId: "echo", risk: "safe", capabilities: [], capabilityDigest: "stale", operationDigest: "stale" },
    })).rejects.toThrow("capability digest");
  });

  test("collects staged, unstaged, and untracked files inside the selected absolute directory", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "workflow-git-scope-"));
    const reviewDirectory = path.join(repository, "src");
    const outsideDirectory = path.join(repository, "outside");
    await mkdir(reviewDirectory);
    await mkdir(outsideDirectory);
    await execFileAsync("git", ["init"], { cwd: repository });
    await writeFile(path.join(reviewDirectory, "modified.txt"), "before\n", "utf8");
    await writeFile(path.join(outsideDirectory, "ignored.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await execFileAsync("git", ["-c", "user.name=AgentRecall Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repository });
    await writeFile(path.join(reviewDirectory, "modified.txt"), "after\n", "utf8");
    await writeFile(path.join(reviewDirectory, "staged.txt"), "staged\n", "utf8");
    await execFileAsync("git", ["add", "src/staged.txt"], { cwd: repository });
    await writeFile(path.join(reviewDirectory, "untracked.txt"), "untracked\n", "utf8");
    await writeFile(path.join(outsideDirectory, "ignored.txt"), "outside change\n", "utf8");

    const manifest = JSON.parse(await readFile(
      path.resolve("src/automation/engine/shared/bundled-workflows/code-change-review/workflow.json"),
      "utf8",
    )) as { definition: WorkflowV2Definition };
    const node = manifest.definition.nodes.find((candidate): candidate is WorkflowV2ScriptNode => candidate.id === "collect_changes" && candidate.execModel === "script");
    expect(node).toBeDefined();
    const inputs = { review_directory: reviewDirectory };
    const capabilities = ["workspace_read", "process_spawn", "shell_execute"] as const;
    const output = await executeWorkflowV2Script({
      node: node!,
      workDir: repository,
      upstreamOutputs: [],
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      inputs,
      authorization: {
        decision: "allow_once",
        approvalRequestId: "approval-git-scope",
        workflowId: manifest.definition.workflowId,
        graphVersion: manifest.definition.graphVersion,
        runId: "run-git-scope",
        nodeId: node!.id,
        risk: "dangerous",
        capabilities: [...capabilities],
        capabilityDigest: workflowV2ScriptCapabilityDigest(capabilities),
        operationDigest: workflowV2ScriptOperationDigest({
          workflowId: manifest.definition.workflowId,
          graphVersion: manifest.definition.graphVersion,
          runId: "run-git-scope",
          node: node!,
          workDir: repository,
          inputs,
        }),
      },
    });

    expect(output.outputs).toMatchObject({
      review_directory: await realpath(reviewDirectory),
      staged_files: ["src/staged.txt"],
      unstaged_files: ["src/modified.txt"],
      untracked_files: ["src/untracked.txt"],
      changed_files: ["src/modified.txt", "src/staged.txt", "src/untracked.txt"],
    });
    expect(output.outputs.changed_files).not.toContain("outside/ignored.txt");
  });
});
