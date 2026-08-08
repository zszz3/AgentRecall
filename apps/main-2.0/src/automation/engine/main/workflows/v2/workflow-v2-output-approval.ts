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
  allowedFileWriteRoot?: string;
  runTask: (request: RunTaskRequest, approvalPolicy?: { allowedFileWriteRoot: string; workspaceOnly?: boolean; readOnly?: boolean }) => Promise<AppSnapshot>;
  workspaceOnly?: boolean;
  readOnly?: boolean;
}): Promise<AppSnapshot> {
  const allowedFileWriteRoot = input.allowedFileWriteRoot
    ? path.resolve(input.allowedFileWriteRoot)
    : path.resolve(input.workDir, workflowStoragePlanFor(input.workflowId, input.runId).outputDir);
  const relativeToWorkDir = path.relative(path.resolve(input.workDir), allowedFileWriteRoot);
  if (relativeToWorkDir.startsWith("..") || path.isAbsolute(relativeToWorkDir)) {
    throw new Error("Workflow V2 file-write approval root escapes its governed work directory.");
  }
  if (input.allowOutputWrite) mkdirSync(allowedFileWriteRoot, { recursive: true });
  return input.runTask(
    input.request,
    input.readOnly
      ? { allowedFileWriteRoot, readOnly: true }
      : input.allowOutputWrite ? { allowedFileWriteRoot, ...(input.workspaceOnly ? { workspaceOnly: true } : {}) } : undefined,
  );
}
