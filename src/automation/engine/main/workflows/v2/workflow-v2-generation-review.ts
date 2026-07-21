import type { WorkflowV2Definition, WorkflowV2ScriptRiskLevel } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2GenerationReviewFinding, WorkflowV2GenerationReviewResult } from "../../../shared/workflow-v2/generation-review";

const riskLevels = new Set<WorkflowV2ScriptRiskLevel>(["safe", "read", "write", "dangerous"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonPayload(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  return JSON.parse((fenced?.[1] ?? trimmed).trim());
}

export function workflowV2GenerationReviewPrompt(input: { definition: WorkflowV2Definition; revision: number }): string {
  return [
    "You are the independent adversarial Workflow Reviewer. Review the exact immutable draft revision below.",
    "Challenge missing or redundant nodes, over- or under-decomposition, invalid topology, wrong execution modes, deterministic work assigned to LLMs, incomplete typed inputs or outputs, weak completion criteria, understated script risk, and concrete user-experience failure paths.",
    "Every blocking finding must identify a concrete execution, safety, correctness, or usability failure. Do not block on cosmetic preferences, stylistic alternatives, or remote theoretical edge cases.",
    "Do not edit the workflow. Return only one JSON object with verdict, reviewedRevision, summary, findings, scriptRisks, and suggestions.",
    "For every script node, scriptRisks must include safe, read, write, or dangerous plus a rationale. Verdict revise is required when any blocking finding exists.",
    `Revision: ${input.revision}`,
    `Workflow definition:\n${JSON.stringify(input.definition, null, 2)}`,
  ].join("\n\n");
}

export function parseWorkflowV2GenerationReview(input: { definition: WorkflowV2Definition; revision: number; content: string }): WorkflowV2GenerationReviewResult {
  const root = record(jsonPayload(input.content));
  if (!root) throw new Error("Workflow review must be a JSON object.");
  if (root.verdict !== "approve" && root.verdict !== "revise") throw new Error("Workflow review verdict must be approve or revise.");
  if (root.reviewedRevision !== input.revision) throw new Error("Workflow review revision does not match the current draft.");
  if (typeof root.summary !== "string" || !root.summary.trim()) throw new Error("Workflow review summary is required.");
  const nodeIds = new Set(input.definition.nodes.map((node) => node.id));
  if (!Array.isArray(root.findings)) throw new Error("Workflow review findings must be an array.");
  const findings: WorkflowV2GenerationReviewFinding[] = root.findings.map((value) => {
    const finding = record(value);
    if (!finding || (finding.severity !== "blocking" && finding.severity !== "warning") || typeof finding.summary !== "string" || typeof finding.failurePath !== "string") throw new Error("Workflow review finding is invalid.");
    if (finding.nodeId !== undefined && (typeof finding.nodeId !== "string" || !nodeIds.has(finding.nodeId))) throw new Error(`Workflow review references unknown node ${String(finding.nodeId)}.`);
    return { severity: finding.severity, ...(typeof finding.nodeId === "string" ? { nodeId: finding.nodeId } : {}), summary: finding.summary.trim(), failurePath: finding.failurePath.trim() };
  });
  if (root.verdict === "approve" && findings.some((finding) => finding.severity === "blocking")) throw new Error("Workflow review cannot approve with blocking findings.");
  const riskRecord = record(root.scriptRisks);
  if (!riskRecord) throw new Error("Workflow review scriptRisks is required.");
  const scriptRisks: WorkflowV2GenerationReviewResult["scriptRisks"] = {};
  for (const node of input.definition.nodes) {
    if (node.execModel !== "script") continue;
    const risk = record(riskRecord[node.id]);
    if (!risk || !riskLevels.has(risk.level as WorkflowV2ScriptRiskLevel) || typeof risk.rationale !== "string" || !risk.rationale.trim()) throw new Error(`Workflow review must assess script node ${node.id}.`);
    scriptRisks[node.id] = { level: risk.level as WorkflowV2ScriptRiskLevel, rationale: risk.rationale.trim() };
  }
  const suggestions = Array.isArray(root.suggestions) ? root.suggestions.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
  return { verdict: root.verdict, reviewedRevision: input.revision, summary: root.summary.trim(), findings, scriptRisks, suggestions };
}
