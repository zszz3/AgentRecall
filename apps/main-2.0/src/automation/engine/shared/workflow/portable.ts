import type { WorkflowV2Definition, WorkflowV2ScriptCapability, WorkflowV2ScriptRiskLevel } from "../workflow-v2/definition";

export interface WorkflowReadinessIssue {
  code: "AGENT_MISSING" | "MODEL_UNAVAILABLE" | "REQUIRED_TOOL_MISSING" | "SECRET_VALUE_REQUIRED";
  scope: "workflow" | "reviewer" | "node";
  nodeId?: string;
  field: string;
  message: string;
  configuredAgentId?: string;
  modelId?: string;
}

export interface WorkflowReadinessResult {
  ready: boolean;
  issues: WorkflowReadinessIssue[];
}

export interface WorkflowImportMapping {
  agentMappings?: Record<string, string>;
  modelMappings?: Record<string, string>;
}

export interface WorkflowOfficialOriginSnapshot {
  kind: "official";
  workflowId: string;
  title: string;
  revision: number;
  clonedAt: number;
}

export interface WorkflowOriginMetadata {
  importedFrom?: {
    fileName: string;
    workflowId: string;
    title: string;
    revision: number;
    importedAt: number;
  };
  rootOrigin?: WorkflowOfficialOriginSnapshot & { trust: "catalog" | "file_claim" };
}

export interface WorkflowPortableFileV1 {
  format: "agentrecall.workflow";
  schemaVersion: 1;
  workflow: {
    workflowId: string;
    revision: number;
    title: string;
    objective: string;
    executionDefaults: {
      configuredAgentId: string;
      modelId: string;
    };
    definition: WorkflowV2Definition;
    rootOrigin?: WorkflowOfficialOriginSnapshot;
  };
}

export interface WorkflowImportPreview {
  previewToken: string;
  contentDigest: string;
  fileName: string;
  sourceWorkflowId: string;
  sourceRevision: number;
  title: string;
  objective: string;
  schemaVersion: 1;
  nodeCount: number;
  edgeCount: number;
  scripts: Array<{
    nodeId: string;
    title: string;
    effectiveRisk: WorkflowV2ScriptRiskLevel;
    capabilities: WorkflowV2ScriptCapability[];
    uncertain: boolean;
  }>;
  removedSecretValueCount: number;
  rootOrigin?: WorkflowOfficialOriginSnapshot;
  definitionErrors: string[];
  definitionWarnings: string[];
  readiness: WorkflowReadinessResult;
}

export interface ConfirmWorkflowImportRequest extends WorkflowImportMapping {
  previewToken: string;
}

export interface WorkflowExportResult {
  status: "exported" | "cancelled";
  fileName?: string;
  removedSecretValueCount?: number;
}

export type WorkflowPortableErrorCode =
  | "WORKFLOW_CLONE_SOURCE_NOT_FOUND"
  | "WORKFLOW_CLONE_SOURCE_NOT_OFFICIAL"
  | "WORKFLOW_IMPORT_FILE_TOO_LARGE"
  | "WORKFLOW_IMPORT_INVALID_JSON"
  | "WORKFLOW_IMPORT_FORMAT_UNSUPPORTED"
  | "WORKFLOW_IMPORT_VERSION_UNSUPPORTED"
  | "WORKFLOW_IMPORT_SCHEMA_INVALID"
  | "WORKFLOW_IMPORT_DEFINITION_INVALID"
  | "WORKFLOW_IMPORT_PREVIEW_EXPIRED"
  | "WORKFLOW_IMPORT_MAPPING_INVALID"
  | "WORKFLOW_IMPORT_PERSIST_FAILED"
  | "WORKFLOW_EXPORT_SOURCE_NOT_FOUND"
  | "WORKFLOW_EXPORT_OFFICIAL_FORBIDDEN"
  | "WORKFLOW_EXPORT_DEFINITION_INVALID"
  | "WORKFLOW_EXPORT_WRITE_FAILED";
