import type { WorkflowRunNodeStatus, WorkflowRunProgressItem } from "../../../../shared/types";
import {
  truncateWorkflowContext,
  workflowStoragePlanDocument,
  workflowStoragePlanFor,
  type WorkflowStoragePlan,
} from "../../../../shared/workflow-v2/runtime-utils";

export {
  truncateWorkflowContext,
  workflowStoragePlanDocument,
  workflowStoragePlanFor,
  type WorkflowStoragePlan,
} from "../../../../shared/workflow-v2/runtime-utils";

export const WORKFLOW_THINKING_MESSAGE = "Agent is thinking...";
const WORKFLOW_OUTPUT_DOCUMENT_EXTENSIONS = "md|markdown|txt|json|yaml|yml|html|htm";

export function isMarkdownFilePath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path.split(/[?#]/)[0] ?? "");
}

export function workflowAssistantDisplayContent(content: string): string {
  return content;
}

export interface WorkflowOutputDocument {
  path: string;
  title: string;
}

function cleanWorkflowOutputPath(value: string): string {
  return value.replace(/[),.;:!?]+$/g, "").replace(/^["'`(]+|["'`]+$/g, "");
}

function isWorkflowOutputDocumentMention(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 80), index).toLowerCase();
  return /产物|产出|输出|生成|创建|写入|更新|保存|文档|报告|deliverable|output|artifact|created|generated|wrote|written|saved|document|report/.test(prefix);
}

export function extractWorkflowOutputDocuments(...sources: string[]): WorkflowOutputDocument[] {
  const docs = new Map<string, WorkflowOutputDocument>();
  const extensionPattern = WORKFLOW_OUTPUT_DOCUMENT_EXTENSIONS;
  const markdownLinkPattern = new RegExp(String.raw`\[[^\]]+\]\(([^)]+\.(?:${extensionPattern})(?:#[^)]+)?)\)`, "gi");
  const pathPattern = new RegExp(
    String.raw`(?:^|[\s"'` + "`" + String.raw`(])((?:~\/|\/|\.{1,2}\/|[\w.-]+\/)[^\s"'` + "`" + String.raw`()<>]*\.(?:${extensionPattern})(?:#[^\s"'` + "`" + String.raw`()<>]*)?)`,
    "gi",
  );

  for (const source of sources) {
    const text = source || "";
    const matches: Array<{ index: number; path: string }> = [];
    for (const pattern of [markdownLinkPattern, pathPattern]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text))) {
        const rawPath = cleanWorkflowOutputPath(match[1] ?? "");
        if (!rawPath || rawPath.startsWith("http://") || rawPath.startsWith("https://")) continue;
        const index = match.index + match[0].indexOf(match[1] ?? "");
        if (!isWorkflowOutputDocumentMention(text, index)) continue;
        matches.push({ index, path: rawPath.split("#")[0] ?? rawPath });
      }
    }
    for (const item of matches.sort((left, right) => left.index - right.index)) {
      if (docs.has(item.path)) continue;
      docs.set(item.path, {
        path: item.path,
        title: item.path.split(/[\\/]/).filter(Boolean).at(-1) ?? item.path,
      });
    }
  }
  return [...docs.values()];
}

export function extractWorkflowOutputDocumentsForPlan(plan: WorkflowStoragePlan, ...sources: string[]): WorkflowOutputDocument[] {
  const outputPrefix = `${plan.outputDir.replace(/\/+$/g, "")}/`;
  return extractWorkflowOutputDocuments(...sources).filter((document) => document.path.startsWith(outputPrefix));
}

export function workflowRunProgressSummary(progress: WorkflowRunProgressItem[]): string {
  if (progress.length === 0) return "Not started";
  const completed = progress.filter((item) => item.status === "completed").length;
  const running = progress.filter((item) => item.status === "running").length;
  const failed = progress.filter((item) => item.status === "failed").length;
  const queued = progress.filter((item) => item.status === "queued").length;
  const started = Math.min(progress.length, completed + running + failed);
  const headline = failed > 0 ? `Failed ${started}/${progress.length}` : completed === progress.length ? `Completed ${progress.length}/${progress.length}` : `Running ${started}/${progress.length}`;
  const details = [
    completed > 0 ? `${completed} done` : "",
    failed > 0 ? `${failed} failed` : "",
    queued > 0 ? `${queued} queued` : "",
  ].filter(Boolean);
  return details.length > 0 ? `${headline} · ${details.join(" · ")}` : headline;
}

export function workflowRunStatusLabel(status: WorkflowRunNodeStatus): string {
  if (status === "completed") return "completed";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "paused") return "paused";
  if (status === "awaiting_input") return "needs you";
  return "queued";
}
