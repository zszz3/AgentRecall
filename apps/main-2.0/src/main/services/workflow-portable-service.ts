import { randomUUID } from "node:crypto";
import type {
  AppSnapshot,
  WorkflowExportResult,
  WorkflowImportMapping,
  WorkflowImportPreview,
  WorkflowPortableFileV1,
} from "../../automation/contracts";
import type { AgentHub } from "../../automation/engine/main/hub/agent-hub";
import {
  portableFileFromWorkflow,
  safeWorkflowExportFileName,
  WorkflowPortableError,
  workflowImportPreview,
} from "../../automation/engine/main/hub/workflow/workflow-portable-file";

export interface WorkflowPortableFileSelection {
  fileName: string;
  content: string;
}

export interface WorkflowPortableServiceDependencies {
  hub: AgentHub;
  chooseImportFile: () => Promise<WorkflowPortableFileSelection | undefined>;
  chooseExportPath: (defaultFileName: string) => Promise<string | undefined>;
  writeExportFile: (filePath: string, content: string) => Promise<void>;
  now?: () => number;
}

interface PendingPreview {
  file: WorkflowPortableFileV1;
  fileName: string;
  expiresAt: number;
  hasDefinitionErrors: boolean;
  consuming: boolean;
}

const PREVIEW_TTL_MS = 10 * 60_000;

export class WorkflowPortableService {
  private readonly previews = new Map<string, PendingPreview>();
  private readonly now: () => number;

  constructor(private readonly dependencies: WorkflowPortableServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  cloneOfficialWorkflow(workflowId: string): Promise<AppSnapshot> {
    return this.dependencies.hub.cloneOfficialWorkflow(workflowId);
  }

  async beginImport(): Promise<WorkflowImportPreview | undefined> {
    const selected = await this.dependencies.chooseImportFile();
    if (!selected) return undefined;
    this.expirePreviews();
    const previewToken = `workflow_import_${randomUUID()}`;
    const prepared = workflowImportPreview({
      previewToken,
      fileName: selected.fileName,
      content: selected.content,
    });
    prepared.preview.readiness = this.dependencies.hub.portableWorkflowReadiness(prepared.file);
    this.previews.set(previewToken, {
      file: prepared.file,
      fileName: selected.fileName,
      expiresAt: this.now() + PREVIEW_TTL_MS,
      hasDefinitionErrors: prepared.preview.definitionErrors.length > 0,
      consuming: false,
    });
    return prepared.preview;
  }

  async confirmImport(previewToken: string, mapping: WorkflowImportMapping = {}): Promise<AppSnapshot> {
    this.expirePreviews();
    const pending = this.previews.get(previewToken);
    if (!pending) {
      throw new WorkflowPortableError("WORKFLOW_IMPORT_PREVIEW_EXPIRED", "Workflow import preview has expired. Choose the file again.");
    }
    if (pending.consuming) {
      throw new WorkflowPortableError("WORKFLOW_IMPORT_PREVIEW_EXPIRED", "Workflow import is already being confirmed.");
    }
    if (pending.hasDefinitionErrors) {
      throw new WorkflowPortableError("WORKFLOW_IMPORT_DEFINITION_INVALID", "Workflow definition must be valid before import.");
    }
    pending.consuming = true;
    try {
      const snapshot = await this.dependencies.hub.importPortableWorkflow(pending.file, pending.fileName, mapping);
      this.previews.delete(previewToken);
      return snapshot;
    } catch (error) {
      pending.consuming = false;
      throw error;
    }
  }

  cancelImport(previewToken: string): void {
    if (!this.previews.get(previewToken)?.consuming) this.previews.delete(previewToken);
  }

  async exportWorkflow(workflowId: string): Promise<WorkflowExportResult> {
    const workflow = this.dependencies.hub.snapshot().workflowStore.workflows.find((item) => item.workflowId === workflowId);
    if (!workflow) {
      throw new WorkflowPortableError("WORKFLOW_EXPORT_SOURCE_NOT_FOUND", "Workflow was not found.");
    }
    const portable = portableFileFromWorkflow(workflow);
    const filePath = await this.dependencies.chooseExportPath(safeWorkflowExportFileName(workflow.title));
    if (!filePath) return { status: "cancelled" };
    try {
      await this.dependencies.writeExportFile(filePath, `${JSON.stringify(portable.file, null, 2)}\n`);
    } catch (error) {
      throw new WorkflowPortableError("WORKFLOW_EXPORT_WRITE_FAILED", error instanceof Error ? error.message : "Workflow export failed.");
    }
    return {
      status: "exported",
      fileName: filePath.split(/[\\/]/u).at(-1) ?? safeWorkflowExportFileName(workflow.title),
      removedSecretValueCount: portable.removedSecretValueCount,
    };
  }

  private expirePreviews(): void {
    const now = this.now();
    for (const [token, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(token);
    }
  }
}
