import path from "node:path";
import type {
  AppendWorkflowContextRequest,
  WorkflowArtifactReference,
} from "../../../shared/types";

export function contextAppendLimitError(input: {
  request: AppendWorkflowContextRequest;
  maxContextAppendChars: number;
  maxArtifactsPerAppend: number;
  maxTextArtifactChars: number;
}): string | undefined {
  if (input.request.report.length + input.request.handoff.length > input.maxContextAppendChars) {
    return `Workflow context append exceeds ${input.maxContextAppendChars} characters.`;
  }
  const artifacts = input.request.artifacts ?? [];
  if (artifacts.length > input.maxArtifactsPerAppend) {
    return `Workflow context append exceeds ${input.maxArtifactsPerAppend} artifacts.`;
  }
  const oversizedArtifact = artifacts.find(
    (artifact) => artifact.kind === "text" && (artifact.content ?? "").length > input.maxTextArtifactChars,
  );
  if (oversizedArtifact) {
    return `Workflow text artifact ${oversizedArtifact.title} exceeds ${input.maxTextArtifactChars} characters.`;
  }
  return undefined;
}

export function formatWorkflowContextAppend(
  report: string,
  handoff: string,
  artifacts: WorkflowArtifactReference[] = [],
  nodeId?: string,
): string {
  const sections = [`## ${nodeId ? `Node ${nodeId}` : "Workflow"} Context Update`];
  const trimmedReport = report.trim();
  if (trimmedReport) sections.push("### Work Completion Report", trimmedReport);
  const trimmedHandoff = handoff.trim();
  if (trimmedHandoff) sections.push("### Handoff", trimmedHandoff);
  const artifactLines = artifacts
    .slice(0, 20)
    .map((artifact) => {
      if (artifact.kind === "text") return `- ${artifact.title}: ${artifact.content ?? ""}`.trim();
      if (artifact.kind === "file") return `- ${artifact.title}: ${path.basename(artifact.path ?? "")}`;
      return `- ${artifact.title}: ${artifact.url ?? ""}`;
    })
    .filter((line) => line.length > 2);
  if (artifactLines.length > 0) sections.push("### Artifacts", artifactLines.join("\n"));
  return sections.join("\n").trim();
}
