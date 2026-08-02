import { createHash } from "node:crypto";
import type {
  WorkflowDraftState,
  WorkflowImportMapping,
  WorkflowImportPreview,
  WorkflowOfficialOriginSnapshot,
  WorkflowPortableErrorCode,
  WorkflowPortableFileV1,
  WorkflowV2Definition,
} from "../../../shared/types";
import type { AgentChannel, ConfiguredAgent } from "../../../shared/types";
import { isModelForChannel } from "../../../shared/models";
import { validateWorkflowV2Definition } from "../../../shared/workflow-v2/validation";
import { analyzeWorkflowV2Script, maximumWorkflowV2ScriptRisk } from "../../workflows/v2/workflow-v2-script-analysis";

export const WORKFLOW_PORTABLE_MAX_BYTES = 5 * 1024 * 1024;
export const WORKFLOW_PORTABLE_EXTENSION = ".agentrecall-workflow.json";

export class WorkflowPortableError extends Error {
  constructor(readonly code: WorkflowPortableErrorCode, message: string) {
    super(message);
    this.name = "WorkflowPortableError";
  }
}

export function sanitizeWorkflowPortableDefinition(definition: WorkflowV2Definition): {
  definition: WorkflowV2Definition;
  removedSecretValueCount: number;
} {
  const next = structuredClone(definition);
  let removedSecretValueCount = 0;
  for (const node of next.nodes) {
    if (node.execModel !== "script") continue;
    node.script.parameters = node.script.parameters.map((parameter) => {
      if (parameter.valueType !== "secret") return parameter;
      const cleaned = { ...parameter };
      if ("defaultValue" in cleaned) {
        delete cleaned.defaultValue;
        removedSecretValueCount += 1;
      }
      if ("literalValue" in cleaned) {
        delete cleaned.literalValue;
        removedSecretValueCount += 1;
      }
      return cleaned;
    });
  }
  return { definition: next, removedSecretValueCount };
}

export function portableFileFromWorkflow(workflow: WorkflowDraftState): {
  file: WorkflowPortableFileV1;
  removedSecretValueCount: number;
} {
  if (workflow.sourceType === "official") {
    throw new WorkflowPortableError("WORKFLOW_EXPORT_OFFICIAL_FORBIDDEN", "Official workflows must be cloned before export.");
  }
  const sanitized = sanitizeWorkflowPortableDefinition(workflow.definition);
  const rootOrigin = workflow.origin?.rootOrigin;
  return {
    file: {
      format: "agentrecall.workflow",
      schemaVersion: 1,
      workflow: {
        workflowId: workflow.workflowId,
        revision: workflow.revision,
        title: workflow.title,
        objective: workflow.objective,
        executionDefaults: {
          configuredAgentId: workflow.configuredAgentId,
          modelId: workflow.modelId,
          reviewerConfiguredAgentId: workflow.reviewerConfiguredAgentId,
          reviewerModelId: workflow.reviewerModelId,
        },
        definition: sanitized.definition,
        ...(rootOrigin ? { rootOrigin: portableRootOrigin(rootOrigin) } : {}),
      },
    },
    removedSecretValueCount: sanitized.removedSecretValueCount,
  };
}

export function parseWorkflowPortableFile(content: string): {
  file: WorkflowPortableFileV1;
  contentDigest: string;
  removedSecretValueCount: number;
  definitionErrors: string[];
  definitionWarnings: string[];
} {
  if (Buffer.byteLength(content, "utf8") > WORKFLOW_PORTABLE_MAX_BYTES) {
    throw new WorkflowPortableError("WORKFLOW_IMPORT_FILE_TOO_LARGE", "Workflow file exceeds the 5 MiB limit.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new WorkflowPortableError("WORKFLOW_IMPORT_INVALID_JSON", "Workflow file is not valid JSON.");
  }
  const root = strictRecord(raw, ["format", "schemaVersion", "workflow"], "workflow file");
  if (root.format !== "agentrecall.workflow") {
    throw new WorkflowPortableError("WORKFLOW_IMPORT_FORMAT_UNSUPPORTED", "Unsupported Workflow file format.");
  }
  if (root.schemaVersion !== 1) {
    throw new WorkflowPortableError("WORKFLOW_IMPORT_VERSION_UNSUPPORTED", "Unsupported Workflow file schema version.");
  }
  const workflow = strictRecord(
    root.workflow,
    ["workflowId", "revision", "title", "objective", "executionDefaults", "definition", "rootOrigin"],
    "workflow",
  );
  const executionDefaults = strictRecord(
    workflow.executionDefaults,
    ["configuredAgentId", "modelId", "reviewerConfiguredAgentId", "reviewerModelId"],
    "execution defaults",
  );
  const workflowId = requiredString(workflow.workflowId, "workflow.workflowId");
  const revision = positiveInteger(workflow.revision, "workflow.revision");
  const title = requiredString(workflow.title, "workflow.title");
  const objective = requiredString(workflow.objective, "workflow.objective");
  const definition = workflow.definition as WorkflowV2Definition;
  if (!isRecord(definition) || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) {
    throw schemaError("workflow.definition must be a Workflow V2 definition object.");
  }
  if (definition.workflowId !== workflowId) {
    throw schemaError("workflow.workflowId must match workflow.definition.workflowId.");
  }
  const rootOrigin = workflow.rootOrigin === undefined ? undefined : parseRootOrigin(workflow.rootOrigin);
  const file: WorkflowPortableFileV1 = {
    format: "agentrecall.workflow",
    schemaVersion: 1,
    workflow: {
      workflowId,
      revision,
      title,
      objective,
      executionDefaults: {
        configuredAgentId: stringValue(executionDefaults.configuredAgentId, "configuredAgentId"),
        modelId: stringValue(executionDefaults.modelId, "modelId"),
        reviewerConfiguredAgentId: requiredString(executionDefaults.reviewerConfiguredAgentId, "reviewerConfiguredAgentId"),
        reviewerModelId: requiredString(executionDefaults.reviewerModelId, "reviewerModelId"),
      },
      definition: structuredClone(definition),
      ...(rootOrigin ? { rootOrigin } : {}),
    },
  };
  const sanitized = sanitizeWorkflowPortableDefinition(file.workflow.definition);
  file.workflow.definition = sanitized.definition;
  let validation;
  try {
    validation = validateWorkflowV2Definition(file.workflow.definition);
  } catch {
    throw schemaError("workflow.definition contains invalid node or edge fields.");
  }
  return {
    file,
    contentDigest: createHash("sha256").update(content, "utf8").digest("hex"),
    removedSecretValueCount: sanitized.removedSecretValueCount,
    definitionErrors: validation.errors,
    definitionWarnings: validation.warnings,
  };
}

export function workflowImportPreview(input: {
  previewToken: string;
  fileName: string;
  content: string;
  readiness?: WorkflowImportPreview["readiness"];
}): { preview: WorkflowImportPreview; file: WorkflowPortableFileV1 } {
  const parsed = parseWorkflowPortableFile(input.content);
  const scripts = parsed.file.workflow.definition.nodes
    .filter((node) => node.execModel === "script")
    .map((node) => {
      if (node.execModel !== "script") throw new Error("Expected a script node.");
      const analysis = analyzeWorkflowV2Script(node.script);
      return {
        nodeId: node.id,
        title: node.title,
        effectiveRisk: maximumWorkflowV2ScriptRisk(node.script.managerRisk.level, analysis.minimumRisk),
        capabilities: analysis.detectedCapabilities,
        uncertain: analysis.uncertain || !node.script.managerRisk.rationale.trim(),
      };
    });
  return {
    file: parsed.file,
    preview: {
      previewToken: input.previewToken,
      contentDigest: parsed.contentDigest,
      fileName: input.fileName,
      sourceWorkflowId: parsed.file.workflow.workflowId,
      sourceRevision: parsed.file.workflow.revision,
      title: parsed.file.workflow.title,
      objective: parsed.file.workflow.objective,
      schemaVersion: 1,
      nodeCount: parsed.file.workflow.definition.nodes.length,
      edgeCount: parsed.file.workflow.definition.edges.length,
      scripts,
      removedSecretValueCount: parsed.removedSecretValueCount,
      ...(parsed.file.workflow.rootOrigin ? { rootOrigin: parsed.file.workflow.rootOrigin } : {}),
      definitionErrors: parsed.definitionErrors,
      definitionWarnings: parsed.definitionWarnings,
      readiness: input.readiness ?? { ready: true, issues: [] },
    },
  };
}

export function workflowImportModelMappingKey(configuredAgentId: string, modelId: string): string {
  return `${configuredAgentId}\u0000${modelId}`;
}

export function applyWorkflowImportMappings(input: {
  file: WorkflowPortableFileV1;
  mapping: WorkflowImportMapping;
  configuredAgents: Iterable<ConfiguredAgent>;
  channels: AgentChannel[];
}): WorkflowPortableFileV1 {
  const next = structuredClone(input.file);
  const agents = new Map([...input.configuredAgents].map((agent) => [agent.id, agent]));
  const agentMappings = input.mapping.agentMappings ?? {};
  const modelMappings = input.mapping.modelMappings ?? {};

  const mapRoute = (configuredAgentId: string, modelId: string): { configuredAgentId: string; modelId: string } => {
    const explicitlyMappedAgent = agentMappings[configuredAgentId];
    const explicitlyMappedModel = modelMappings[workflowImportModelMappingKey(configuredAgentId, modelId)];
    const targetAgentId = explicitlyMappedAgent ?? configuredAgentId;
    const targetAgent = agents.get(targetAgentId);
    if (!targetAgent) {
      if (explicitlyMappedAgent || explicitlyMappedModel) throw new WorkflowPortableError("WORKFLOW_IMPORT_MAPPING_INVALID", `Mapped Agent ${targetAgentId} is unavailable.`);
      return { configuredAgentId, modelId };
    }
    const targetModelId = explicitlyMappedModel ?? (explicitlyMappedAgent ? targetAgent.modelId : modelId);
    if (!isModelForChannel(targetAgent.runtimeAgentId, targetAgent.channelId, targetModelId, input.channels)) {
      if (!explicitlyMappedAgent && !explicitlyMappedModel) return { configuredAgentId, modelId };
      throw new WorkflowPortableError("WORKFLOW_IMPORT_MAPPING_INVALID", `Mapped model ${targetModelId} is unavailable for Agent ${targetAgentId}.`);
    }
    return { configuredAgentId: targetAgentId, modelId: targetModelId };
  };

  const defaults = next.workflow.executionDefaults;
  const sourceWorkflowAgentId = defaults.configuredAgentId;
  if (defaults.configuredAgentId) {
    const workflowRoute = mapRoute(defaults.configuredAgentId, defaults.modelId);
    defaults.configuredAgentId = workflowRoute.configuredAgentId;
    defaults.modelId = workflowRoute.modelId;
  }
  const reviewerRoute = mapRoute(defaults.reviewerConfiguredAgentId, defaults.reviewerModelId);
  defaults.reviewerConfiguredAgentId = reviewerRoute.configuredAgentId;
  defaults.reviewerModelId = reviewerRoute.modelId;

  for (const node of next.workflow.definition.nodes) {
    if (node.execModel !== "llm") continue;
    const sourceAgentId = node.configuredAgentId ?? sourceWorkflowAgentId;
    const sourceAgent = agents.get(sourceAgentId);
    const sourceModelId = node.modelId ?? sourceAgent?.modelId ?? "default";
    const route = mapRoute(sourceAgentId, sourceModelId);
    if (node.configuredAgentId) node.configuredAgentId = route.configuredAgentId;
    if (node.modelId) node.modelId = route.modelId;
  }
  return next;
}

export function safeWorkflowExportFileName(title: string): string {
  const safe = title.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-").replace(/[. ]+$/gu, "").slice(0, 120) || "workflow";
  return `${safe}${WORKFLOW_PORTABLE_EXTENSION}`;
}

function portableRootOrigin(origin: WorkflowOfficialOriginSnapshot & { trust?: unknown }): WorkflowOfficialOriginSnapshot {
  return {
    kind: "official",
    workflowId: origin.workflowId,
    title: origin.title,
    revision: origin.revision,
    clonedAt: origin.clonedAt,
  };
}

function parseRootOrigin(value: unknown): WorkflowOfficialOriginSnapshot {
  const raw = strictRecord(value, ["kind", "workflowId", "title", "revision", "clonedAt"], "root origin");
  if (raw.kind !== "official") throw schemaError("rootOrigin.kind must be official.");
  return {
    kind: "official",
    workflowId: requiredString(raw.workflowId, "rootOrigin.workflowId"),
    title: requiredString(raw.title, "rootOrigin.title"),
    revision: positiveInteger(raw.revision, "rootOrigin.revision"),
    clonedAt: nonnegativeNumber(raw.clonedAt, "rootOrigin.clonedAt"),
  };
}

function strictRecord(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw schemaError(`${label} must be an object.`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw schemaError(`${label} contains unknown field ${unknown[0]}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw schemaError(`${field} must be a non-empty string.`);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw schemaError(`${field} must be a string.`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw schemaError(`${field} must be a positive integer.`);
  return Number(value);
}

function nonnegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw schemaError(`${field} must be a non-negative number.`);
  return value;
}

function schemaError(message: string): WorkflowPortableError {
  return new WorkflowPortableError("WORKFLOW_IMPORT_SCHEMA_INVALID", message);
}
