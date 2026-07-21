import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RegisterArtifactRequest, RegisteredArtifact } from "../../../shared/types";
import { resolveWorkDirFile } from "../../platform/local-file-preview";

type WorkflowFileRoot = { workDir?: string };

export async function registerArtifact(input: {
  request: RegisterArtifactRequest;
  workDir: string;
}): Promise<{ ok: boolean; error?: string; artifact?: RegisteredArtifact }> {
  const target = typeof input.request.target === "string" ? input.request.target.trim() : "";
  if (!target) return { ok: false, error: "artifacts_register requires a target session id." };

  const artifact: RegisteredArtifact = {
    id: `artifact_${randomUUID()}`,
    target,
    kind: "text",
    title: "",
    registeredAt: Date.now(),
  };
  if (typeof input.request.description === "string" && input.request.description.trim()) {
    artifact.description = input.request.description.trim();
  }

  if (typeof input.request.path === "string" && input.request.path.trim()) {
    let absolutePath: string;
    try {
      absolutePath = await resolveWorkDirFile(input.request.path, input.workDir, os.homedir());
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    artifact.kind = "file";
    artifact.path = absolutePath;
    artifact.title = (typeof input.request.title === "string" && input.request.title.trim()) || path.basename(absolutePath);
  } else if (typeof input.request.url === "string" && input.request.url.trim()) {
    artifact.kind = "url";
    artifact.url = input.request.url.trim();
    artifact.title = (typeof input.request.title === "string" && input.request.title.trim()) || input.request.url.trim();
  } else if (typeof input.request.content === "string" && input.request.content.length > 0) {
    artifact.kind = "text";
    artifact.content = input.request.content;
    artifact.title = (typeof input.request.title === "string" && input.request.title.trim()) || "Note";
  } else {
    return { ok: false, error: "artifacts_register requires one of path, url, or content." };
  }

  return { ok: true, artifact };
}

export async function listWorkflowOutputs(workflow: WorkflowFileRoot | undefined, defaultWorkDir: string, workflowId: string, runId: string): Promise<Array<{ name: string; path: string }>> {
  if (!workflow) return [];
  const workDir = workflow.workDir || defaultWorkDir;
  const safeWorkflowId = workflowId.replace(/[^a-zA-Z0-9_-]/g, "_") || "workflow";
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";
  const outputsDir = path.join(workDir, "outputs", safeWorkflowId, safeRunId);
  let entries: Dirent[];
  try {
    entries = await readdir(outputsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(outputsDir, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function workflowWorkDir(workflow: WorkflowFileRoot | undefined, defaultWorkDir: string): string | undefined {
  if (!workflow) return undefined;
  return workflow.workDir || defaultWorkDir;
}

export function allowedFileRoots(workflows: Iterable<WorkflowFileRoot>, defaultWorkDir: string): string[] {
  const roots = [defaultWorkDir];
  for (const workflow of workflows) {
    roots.push(workflow.workDir || defaultWorkDir);
  }
  return roots;
}

export function listArtifacts(artifacts: RegisteredArtifact[], target?: string): RegisteredArtifact[] {
  const filtered = target ? artifacts.filter((artifact) => artifact.target === target) : artifacts;
  return filtered.map((artifact) => ({ ...artifact }));
}
