import { jsonrepair } from "jsonrepair";
import type {
  WorkflowCoreSnapshot,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
} from "../../automation/engine/shared/workflow/model";
import { validateWorkflowDefinition } from "../../automation/engine/shared/workflow/validation";
import { validateWorkflowNodeOutputs } from "../../automation/engine/shared/workflow/output";
import type { WorkflowEngine } from "../../automation/engine/main/workflows/workflow-engine";

function onlyAddsQuoteEscapes(original: string, repaired: string): boolean {
  let originalIndex = 0;
  let repairedIndex = 0;
  while (originalIndex < original.length && repairedIndex < repaired.length) {
    if (original[originalIndex] === repaired[repairedIndex]) {
      originalIndex += 1;
      repairedIndex += 1;
    } else if (
      repaired[repairedIndex] === "\\"
      && repaired[repairedIndex + 1] === '"'
      && original[originalIndex] === '"'
    ) {
      repairedIndex += 1;
    } else {
      return false;
    }
  }
  return originalIndex === original.length && repairedIndex === repaired.length;
}

export function parseWorkflowAgentOutputs(content: string, node?: WorkflowNode): Record<string, unknown> {
  const normalized = content.trim();
  const fenced = normalized.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu);
  const embeddedJsonFences = fenced
    ? []
    : [...normalized.matchAll(/```json\s*\n([\s\S]*?)\n```/giu)];
  const candidate = fenced?.[1]?.trim()
    ?? (embeddedJsonFences.length === 1 ? embeddedJsonFences[0]?.[1]?.trim() : undefined)
    ?? normalized;
  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const repaired = jsonrepair(candidate);
      // Model prose can omit quote escapes. Reject all other repairs so truncated
      // results and missing fields are never silently reconstructed.
      if (!onlyAddsQuoteEscapes(candidate, repaired)) throw error;
      value = JSON.parse(repaired) as unknown;
    } catch {
      throw new Error(`Agent output must be one JSON object: ${message}`, { cause: error });
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Agent output must be one JSON object.");
  }
  let outputs = value as Record<string, unknown>;
  // Planning and nodes with declared packet-like business fields keep their
  // original shape. Only a node's incompatible completion envelope is unwrapped.
  if (!node || validateWorkflowNodeOutputs(node, outputs).length === 0) return outputs;
  if (Object.hasOwn(outputs, "nodeId") && Object.hasOwn(outputs, "outputs")) {
    const allowedKeys = ["nodeId", "summary", "outputs", "proposals", "evidence", "risks", "nextStepSuggestions"];
    if (
      outputs.nodeId !== node.id
      || typeof outputs.summary !== "string" || !outputs.summary.trim()
      || !outputs.outputs || typeof outputs.outputs !== "object" || Array.isArray(outputs.outputs)
      || !Array.isArray(outputs.proposals) || outputs.proposals.length > 0
      || Object.keys(outputs).some((key) => !allowedKeys.includes(key))
      || ["evidence", "risks", "nextStepSuggestions"].some((key) => (
        outputs[key] !== undefined
        && (!Array.isArray(outputs[key]) || !outputs[key].every((item: unknown) => typeof item === "string"))
      ))
    ) {
      throw new Error("Workflow completion packet must match the active node, contain a non-empty summary and an outputs object, and use proposals: [].");
    }
    outputs = outputs.outputs as Record<string, unknown>;
  }
  // Older Review descriptions explicitly request these Chinese labels. Preserve
  // their exact meaning while leaving unknown verdicts to strict validation.
  if (node.kind === "review" && (outputs.verdict === "通过" || outputs.verdict === "驳回")) {
    return { ...outputs, verdict: outputs.verdict === "通过" ? "pass" : "revise" };
  }
  return outputs;
}

export interface WorkflowCoreRepository {
  listDefinitions(): Promise<WorkflowDefinition[]>;
  listRuns(workflowId?: string): Promise<WorkflowRun[]>;
  getDefinition(workflowId: string): Promise<WorkflowDefinition | undefined>;
  saveDefinition(definition: WorkflowDefinition): Promise<void>;
  deleteDefinition(workflowId: string): Promise<void>;
  markInterruptedRunsFailed(): Promise<void>;
}

export class WorkflowCoreService {
  constructor(private readonly dependencies: {
    repository: WorkflowCoreRepository;
    engine: WorkflowEngine;
    configuredAgentIds: () => ReadonlySet<string>;
  }) {}

  async initialize(): Promise<void> {
    await this.dependencies.repository.markInterruptedRunsFailed();
  }

  async ensureDefinitions(definitions: WorkflowDefinition[]): Promise<void> {
    const existing = new Map((await this.dependencies.repository.listDefinitions()).map((definition) => [definition.id, definition]));
    for (const definition of definitions) {
      const current = existing.get(definition.id);
      if (current?.isTemplate) continue;
      if (current && definition.isTemplate) {
        await this.saveDefinition({ ...definition, createdAt: current.createdAt });
        continue;
      }
      if (current) continue;
      await this.saveDefinition(definition);
    }
  }

  async snapshot(workflowId?: string): Promise<WorkflowCoreSnapshot> {
    const [definitions, runs] = await Promise.all([
      this.dependencies.repository.listDefinitions(),
      this.dependencies.repository.listRuns(workflowId),
    ]);
    return { definitions, runs };
  }

  async saveDefinition(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    const issues = validateWorkflowDefinition(definition, this.dependencies.configuredAgentIds());
    if (issues.length > 0) throw new Error(`${issues[0]!.path}: ${issues[0]!.message}`);
    await this.dependencies.repository.saveDefinition(definition);
    return structuredClone(definition);
  }

  async deleteDefinition(workflowId: string): Promise<void> {
    const definition = await this.dependencies.repository.getDefinition(workflowId);
    if (definition?.isTemplate) throw new Error("Workflow templates are read-only.");
    const runs = await this.dependencies.repository.listRuns(workflowId);
    if (runs.some((run) => run.status === "running" || run.status === "paused" || run.status === "waiting")) {
      throw new Error("Stop the active Workflow run before deleting it.");
    }
    await this.dependencies.repository.deleteDefinition(workflowId);
  }

  async startRun(workflowId: string, inputs: Record<string, unknown>): Promise<WorkflowRun> {
    const definition = await this.dependencies.repository.getDefinition(workflowId);
    if (!definition) throw new Error(`Workflow ${workflowId} does not exist.`);
    return this.dependencies.engine.start(definition, inputs);
  }

  retryNode(runId: string, nodeId: string): Promise<WorkflowRun> {
    return this.dependencies.engine.retryNode(runId, nodeId);
  }

  resolveApproval(runId: string, nodeId: string, outputs: Record<string, unknown>): Promise<WorkflowRun> {
    return this.dependencies.engine.resolveApproval(runId, nodeId, outputs);
  }

  cancelRun(runId: string): Promise<WorkflowRun> {
    return this.dependencies.engine.cancel(runId);
  }

  pauseRun(runId: string): Promise<WorkflowRun> {
    return this.dependencies.engine.pause(runId);
  }

  resumeRun(runId: string): Promise<WorkflowRun> {
    return this.dependencies.engine.resume(runId);
  }
}
