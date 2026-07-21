import path from "node:path";
import { mkdirSync } from "node:fs";
import type { AppSnapshot, RunTaskRequest } from "../../../shared/types";
import { workflowStoragePlanFor } from "../../../shared/workflow-v2/runtime-utils";

export function runWorkflowV2TaskWithOutputPolicy(input: {
  workflowId: string;
  runId: string;
  workDir: string;
  request: RunTaskRequest;
  allowOutputWrite: boolean;
  runTask: (request: RunTaskRequest, approvalPolicy?: { allowedFileWriteRoot: string }) => Promise<AppSnapshot>;
}): Promise<AppSnapshot> {
  const allowedFileWriteRoot = path.resolve(
    input.workDir,
    workflowStoragePlanFor(input.workflowId, input.runId).outputDir,
  );
  if (input.allowOutputWrite) mkdirSync(allowedFileWriteRoot, { recursive: true });
  return input.runTask(
    input.request,
    input.allowOutputWrite ? { allowedFileWriteRoot } : undefined,
  );
}
