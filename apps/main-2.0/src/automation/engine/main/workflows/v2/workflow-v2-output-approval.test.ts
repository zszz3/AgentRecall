import path from "node:path";
import os from "node:os";
import { mkdtemp, stat } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { runWorkflowV2TaskWithOutputPolicy } from "./workflow-v2-output-approval";

describe("runWorkflowV2TaskWithOutputPolicy", () => {
  test("grants only the current workflow run output root to worker tasks", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "workflow-output-policy-"));
    const runTask = vi.fn(async () => ({ tasks: [] }) as never);
    const request = {
      prompt: "write report",
      configuredAgentId: "agent-1",
      workDir,
    };
    await runWorkflowV2TaskWithOutputPolicy({
      workflowId: "wf-1",
      runId: "run-1",
      workDir,
      request,
      allowOutputWrite: true,
      runTask,
    });
    expect(runTask).toHaveBeenCalledWith(request, {
      allowedFileWriteRoot: path.resolve(workDir, "outputs/wf-1/run-1"),
    });
    await expect(stat(path.resolve(workDir, "outputs/wf-1/run-1"))).resolves.toMatchObject({});
  });

  test("routes approval-requiring supervisor actions through the standard Approval Broker", async () => {
    const runTask = vi.fn(async () => ({ tasks: [] }) as never);
    const request = { prompt: "review", configuredAgentId: "agent-1" };
    await runWorkflowV2TaskWithOutputPolicy({
      workflowId: "wf-1",
      runId: "run-1",
      workDir: "C:/repo",
      request,
      allowOutputWrite: false,
      runTask,
    });
    expect(runTask).toHaveBeenCalledWith(request, undefined);
  });

  test("enforces the read-only Approval Broker policy for reviewer tasks", async () => {
    const runTask = vi.fn(async () => ({ tasks: [] }) as never);
    const request = { prompt: "review", configuredAgentId: "review-agent" };
    await runWorkflowV2TaskWithOutputPolicy({
      workflowId: "wf-1",
      runId: "run-1",
      workDir: "C:/repo",
      request,
      allowOutputWrite: false,
      readOnly: true,
      runTask,
    });
    expect(runTask).toHaveBeenCalledWith(request, {
      allowedFileWriteRoot: path.resolve("C:/repo", "outputs/wf-1/run-1"),
      readOnly: true,
    });
  });
});
