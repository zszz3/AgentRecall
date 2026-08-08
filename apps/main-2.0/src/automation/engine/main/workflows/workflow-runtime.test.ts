import { describe, expect, test, vi } from "vitest";
import type { WorkflowV2NodeCompletionLedger, WorkflowV2NodeCompletionSubmission } from "../../shared/workflow-v2/completion";
import type { WorkflowV2WorkerOutput } from "../../shared/workflow-v2/packets";
import { WorkflowRuntime } from "./workflow-runtime";
import type { WorkflowRuntimeDependencies, WorkflowV2StorePort } from "./workflow-runtime-ports";

describe("WorkflowRuntime node completion storage", () => {
  test("uses storage initialized after the runtime was constructed", async () => {
    const output: WorkflowV2WorkerOutput = {
      nodeId: "node-1",
      summary: "Completed",
      outputs: { result: "done" },
      proposals: [],
    };
    const submission: WorkflowV2NodeCompletionSubmission = {
      submissionId: "submission-1",
      digest: "a".repeat(64),
      status: "submitted",
      output,
      submittedAt: 2,
    };
    const ledger: WorkflowV2NodeCompletionLedger = {
      schemaVersion: 1,
      workflowId: "workflow-1",
      runId: "run-1",
      nodeId: "node-1",
      executionId: "execution-1",
      attempt: 1,
      startedAt: 1,
      updatedAt: 1,
      submissions: [],
    };
    const beginNodeCompletionExecution = vi.fn(async () => ledger);
    const submitNodeCompletion = vi.fn(async () => submission);
    const readLatestNodeCompletionSubmission = vi.fn(async () => submission);
    const resolveNodeCompletionSubmission = vi.fn(async () => ({ ...submission, status: "accepted" as const }));
    let store: WorkflowV2StorePort | undefined;
    const runtime = new WorkflowRuntime({
      snapshot: () => ({
        workflowStore: {
          runs: [{
            workflowId: "workflow-1",
            runId: "run-1",
            progress: [{ nodeId: "node-1", status: "running" }],
          }],
        },
      }),
      createWorkflowV2Store: () => store,
    } as unknown as WorkflowRuntimeDependencies);

    store = {
      persistRunState: vi.fn(),
      appendEvents: vi.fn(),
      beginNodeCompletionExecution,
      submitNodeCompletion,
      readLatestNodeCompletionSubmission,
      resolveNodeCompletionSubmission,
    };

    await expect(runtime.beginNodeCompletionExecution({
      workflowId: "workflow-1",
      runId: "run-1",
      nodeId: "node-1",
      executionId: "execution-1",
      attempt: 1,
      startedAt: 1,
    })).resolves.toBe(ledger);
    await expect(runtime.submitNodeCompletion({
      workflowId: "workflow-1",
      runId: "run-1",
      nodeId: "node-1",
      executionId: "execution-1",
      output,
    })).resolves.toBe(submission);
    await expect(runtime.readLatestNodeCompletionSubmission({
      workflowId: "workflow-1",
      runId: "run-1",
      nodeId: "node-1",
      executionId: "execution-1",
    })).resolves.toBe(submission);
    await expect(runtime.resolveNodeCompletionSubmission({
      workflowId: "workflow-1",
      runId: "run-1",
      nodeId: "node-1",
      executionId: "execution-1",
      submissionId: "submission-1",
      status: "accepted",
    })).resolves.toMatchObject({ status: "accepted" });

    expect(beginNodeCompletionExecution).toHaveBeenCalledOnce();
    expect(submitNodeCompletion).toHaveBeenCalledOnce();
    expect(readLatestNodeCompletionSubmission).toHaveBeenCalledOnce();
    expect(resolveNodeCompletionSubmission).toHaveBeenCalledOnce();
  });
});
