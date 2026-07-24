import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowV2Node,
  WorkflowV2OutputArtifactFormat,
  WorkflowV2OutputFieldDef,
} from "../../../shared/workflow-v2/definition";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import { workflowStoragePlanFor } from "../../../shared/workflow-v2/runtime-utils";

const ARTIFACT_EXTENSIONS: Record<WorkflowV2OutputArtifactFormat, string> = {
  markdown: ".md",
  text: ".txt",
  json: ".json",
  html: ".html",
  csv: ".csv",
};

export interface WorkflowV2MaterializedArtifact {
  fieldKey: string;
  relativePath: string;
  absolutePath: string;
}

export async function materializeWorkflowV2OutputArtifacts(input: {
  workflowId: string;
  runId: string;
  workDir: string;
  node: WorkflowV2Node;
  output: WorkflowV2WorkerOutput;
  validateFileOutputs?: boolean;
}): Promise<WorkflowV2MaterializedArtifact[]> {
  const outputRoot = path.resolve(
    input.workDir,
    workflowStoragePlanFor(input.workflowId, input.runId).outputDir,
  );
  const artifacts: WorkflowV2MaterializedArtifact[] = [];

  for (const field of input.node.outputFields) {
    const value = input.output.outputs[field.key];
    if (field.valueType === "file") {
      if (input.validateFileOutputs === false) continue;
      if (value === undefined && field.required === false) continue;
      artifacts.push(await validateExistingOutputFile(input.workDir, outputRoot, field, value));
      continue;
    }

    const format = field.artifact?.format ?? legacyArtifactFormat(field);
    if (!format || value === undefined || value === null) continue;
    const content = artifactContent(field, format, value);
    const fileName = artifactFileName(input.node.id, field, format);
    const absolutePath = path.join(outputRoot, fileName);
    await writeOutputFileAtomically(outputRoot, absolutePath, content);
    artifacts.push({
      fieldKey: field.key,
      absolutePath,
      relativePath: normalizeRelativePath(path.relative(input.workDir, absolutePath)),
    });
  }

  return artifacts;
}

function legacyArtifactFormat(field: WorkflowV2OutputFieldDef): WorkflowV2OutputArtifactFormat | undefined {
  return /(?:^|_)markdown$/i.test(field.key) ? "markdown" : undefined;
}

function artifactContent(field: WorkflowV2OutputFieldDef, format: WorkflowV2OutputArtifactFormat, value: unknown): string {
  if (format === "json") return `${JSON.stringify(value, null, 2)}\n`;
  if (typeof value !== "string") {
    throw new Error(`Workflow V2 output field ${field.key} must contain string content for its ${format} artifact.`);
  }
  return value.endsWith("\n") ? value : `${value}\n`;
}

function artifactFileName(nodeId: string, field: WorkflowV2OutputFieldDef, format: WorkflowV2OutputArtifactFormat): string {
  const extension = ARTIFACT_EXTENSIONS[format];
  const configured = field.artifact?.fileName?.trim();
  if (configured) return path.extname(configured) ? configured : `${configured}${extension}`;
  return `${safeFileSegment(nodeId)}-${safeFileSegment(field.key)}${extension}`;
}

async function validateExistingOutputFile(
  workDir: string,
  outputRoot: string,
  field: WorkflowV2OutputFieldDef,
  value: unknown,
): Promise<WorkflowV2MaterializedArtifact> {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Workflow V2 file output field ${field.key} must contain a non-empty file path.`);
  }
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : value.replaceAll("\\", "/").startsWith("outputs/")
      ? path.resolve(workDir, value)
      : path.resolve(outputRoot, value);
  assertInsideOutputRoot(outputRoot, candidate, field.key);
  const metadata = await stat(candidate).catch(() => undefined);
  if (!metadata?.isFile()) {
    throw new Error(`Workflow V2 file output field ${field.key} does not reference an existing file in the current run output directory.`);
  }
  return {
    fieldKey: field.key,
    absolutePath: candidate,
    relativePath: normalizeRelativePath(path.relative(workDir, candidate)),
  };
}

async function writeOutputFileAtomically(outputRoot: string, absolutePath: string, content: string): Promise<void> {
  assertInsideOutputRoot(outputRoot, absolutePath, path.basename(absolutePath));
  await mkdir(outputRoot, { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function assertInsideOutputRoot(outputRoot: string, candidate: string, fieldKey: string): void {
  const relative = path.relative(outputRoot, candidate);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Workflow V2 output field ${fieldKey} must stay inside the current run output directory.`);
}

function safeFileSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "output";
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}
