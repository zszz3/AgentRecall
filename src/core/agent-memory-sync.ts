import { randomUUID } from "node:crypto";
import {
  createAgentMemoryFile,
  deleteAgentMemoryFile,
  readAgentMemoryFile,
  saveAgentMemoryFile,
  type AgentMemoryDocument,
  type AgentMemoryKind,
  type AgentMemorySnapshot,
} from "./agent-memory";

export type AgentMemoryTarget = "codex" | "claude" | "cursor";
export type AgentMemorySyncAction = "create" | "update" | "unchanged";
export type AgentMemoryDiffKind = "context" | "add" | "remove" | "meta";

export interface AgentMemoryEffectiveContext {
  target: AgentMemoryTarget;
  sources: AgentMemoryDocument[];
  content: string;
}

export interface AgentMemoryDiffLine {
  kind: AgentMemoryDiffKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface AgentMemorySyncPreviewItem {
  target: AgentMemoryTarget;
  relativePath: string;
  action: AgentMemorySyncAction;
  diff: AgentMemoryDiffLine[];
}

export interface AgentMemorySyncPreview {
  id: string;
  sourceRelativePath: string;
  items: AgentMemorySyncPreviewItem[];
}

export interface AgentMemorySyncApplyResult {
  snapshot: AgentMemorySnapshot;
  undoId: string;
  changedPaths: string[];
}

interface AgentMemorySyncChange {
  target: AgentMemoryTarget;
  relativePath: string;
  directory: string;
  kind: AgentMemoryKind;
  fileName?: string;
  beforeContent: string | null;
  afterContent: string;
}

export interface PreparedAgentMemorySync {
  preview: AgentMemorySyncPreview;
  changes: AgentMemorySyncChange[];
}

export interface PreparedAgentMemoryUndo {
  id: string;
  changes: AgentMemorySyncChange[];
}

const MAX_DIFF_LINES = 420;

export async function loadAgentMemoryEffectiveContext(
  snapshot: AgentMemorySnapshot,
  target: AgentMemoryTarget,
): Promise<AgentMemoryEffectiveContext> {
  const kinds = effectiveKindsForTarget(target);
  const sourceFiles = snapshot.files.filter((file) => kinds.includes(file.kind));
  const sources = await Promise.all(
    sourceFiles.map((file) => readAgentMemoryFile(snapshot.rootPath, file.relativePath)),
  );
  return {
    target,
    sources,
    content: sources
      .map((source) => `<!-- Source: ${source.relativePath} -->\n${source.content.trimEnd()}`)
      .join("\n\n"),
  };
}

export async function prepareAgentMemorySync(
  snapshot: AgentMemorySnapshot,
  sourceRelativePath: string,
  targets: AgentMemoryTarget[],
): Promise<PreparedAgentMemorySync> {
  const sourceFile = snapshot.files.find((file) => file.relativePath === sourceRelativePath);
  if (!sourceFile) throw new Error("The sync source is not part of the selected directory context.");
  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length === 0) throw new Error("Choose at least one Agent to sync.");
  const source = await readAgentMemoryFile(snapshot.rootPath, sourceRelativePath);
  const changes: AgentMemorySyncChange[] = [];

  for (const target of uniqueTargets) {
    const destination = destinationForTarget(snapshot.selectedDirectory, target);
    const beforeContent = await readOptionalMemoryContent(snapshot.rootPath, destination.relativePath);
    const afterContent = renderContentForTarget(source, target);
    changes.push({
      target,
      ...destination,
      beforeContent,
      afterContent,
    });
  }

  return {
    preview: {
      id: randomUUID(),
      sourceRelativePath,
      items: changes.map((change) => ({
        target: change.target,
        relativePath: change.relativePath,
        action: change.beforeContent === null
          ? "create"
          : change.beforeContent === change.afterContent
            ? "unchanged"
            : "update",
        diff: createLineDiff(change.beforeContent ?? "", change.afterContent),
      })),
    },
    changes,
  };
}

export async function applyPreparedAgentMemorySync(
  rootPath: string,
  prepared: PreparedAgentMemorySync,
): Promise<PreparedAgentMemoryUndo> {
  const changes = prepared.changes.filter((change) => change.beforeContent !== change.afterContent);
  await assertContentsMatch(rootPath, changes, "changed since the preview");
  const applied: AgentMemorySyncChange[] = [];
  try {
    for (const change of changes) {
      await writeSyncContent(rootPath, change, change.afterContent, change.beforeContent === null);
      applied.push(change);
    }
  } catch (error) {
    await restoreChanges(rootPath, applied.slice().reverse(), "beforeContent").catch(() => undefined);
    throw error;
  }
  return { id: randomUUID(), changes };
}

export async function undoPreparedAgentMemorySync(
  rootPath: string,
  undo: PreparedAgentMemoryUndo,
): Promise<void> {
  await assertAppliedContentsMatch(rootPath, undo.changes);
  const restored: AgentMemorySyncChange[] = [];
  try {
    for (const change of undo.changes.slice().reverse()) {
      if (change.beforeContent === null) {
        await deleteAgentMemoryFile(rootPath, change.relativePath);
      } else {
        await saveAgentMemoryFile(rootPath, change.relativePath, change.beforeContent);
      }
      restored.push(change);
    }
  } catch (error) {
    await restoreChanges(rootPath, restored.slice().reverse(), "afterContent").catch(() => undefined);
    throw error;
  }
}

function effectiveKindsForTarget(target: AgentMemoryTarget): AgentMemoryKind[] {
  if (target === "codex") return ["agents"];
  if (target === "claude") return ["claude"];
  return ["agents", "cursor"];
}

function destinationForTarget(directory: string, target: AgentMemoryTarget): Omit<AgentMemorySyncChange, "target" | "beforeContent" | "afterContent"> {
  const prefix = directory ? `${directory}/` : "";
  if (target === "codex") {
    return { relativePath: `${prefix}AGENTS.md`, directory, kind: "agents" };
  }
  if (target === "claude") {
    return { relativePath: `${prefix}CLAUDE.md`, directory, kind: "claude" };
  }
  return {
    relativePath: `${prefix}.cursor/rules/agent-recall.mdc`,
    directory,
    kind: "cursor",
    fileName: "agent-recall",
  };
}

function renderContentForTarget(source: AgentMemoryDocument, target: AgentMemoryTarget): string {
  const body = source.kind === "cursor" ? stripCursorFrontmatter(source.content) : source.content;
  if (target !== "cursor") return body;
  if (source.kind === "cursor") return source.content;
  return `---\ndescription: Shared project memory synced by AgentRecall\nalwaysApply: true\n---\n\n${body}`;
}

function stripCursorFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

async function readOptionalMemoryContent(rootPath: string, relativePath: string): Promise<string | null> {
  try {
    return (await readAgentMemoryFile(rootPath, relativePath)).content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertContentsMatch(
  rootPath: string,
  changes: AgentMemorySyncChange[],
  reason: string,
): Promise<void> {
  for (const change of changes) {
    const current = await readOptionalMemoryContent(rootPath, change.relativePath);
    if (current !== change.beforeContent) {
      throw new Error(`${change.relativePath} ${reason}. Refresh the preview before syncing.`);
    }
  }
}

async function assertAppliedContentsMatch(rootPath: string, changes: AgentMemorySyncChange[]): Promise<void> {
  for (const change of changes) {
    const current = await readOptionalMemoryContent(rootPath, change.relativePath);
    if (current !== change.afterContent) {
      throw new Error(`${change.relativePath} changed after the sync. Undo was not applied.`);
    }
  }
}

async function writeSyncContent(
  rootPath: string,
  change: AgentMemorySyncChange,
  content: string,
  create: boolean,
): Promise<void> {
  if (!create) {
    await saveAgentMemoryFile(rootPath, change.relativePath, content);
    return;
  }
  await createAgentMemoryFile(rootPath, {
    directory: change.directory,
    kind: change.kind,
    ...(change.fileName ? { fileName: change.fileName } : {}),
  });
  try {
    await saveAgentMemoryFile(rootPath, change.relativePath, content);
  } catch (error) {
    await deleteAgentMemoryFile(rootPath, change.relativePath).catch(() => undefined);
    throw error;
  }
}

async function restoreChanges(
  rootPath: string,
  changes: AgentMemorySyncChange[],
  contentKey: "beforeContent" | "afterContent",
): Promise<void> {
  for (const change of changes) {
    const content = change[contentKey];
    if (content === null) {
      await deleteAgentMemoryFile(rootPath, change.relativePath);
      continue;
    }
    const current = await readOptionalMemoryContent(rootPath, change.relativePath);
    await writeSyncContent(rootPath, change, content, current === null);
  }
}

function createLineDiff(before: string, after: string): AgentMemoryDiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const lines: AgentMemoryDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    lines.push({ kind: "context", text: beforeLines[index] ?? "", oldLine: index + 1, newLine: index + 1 });
  }
  for (let index = prefix; index < beforeLines.length - suffix; index += 1) {
    lines.push({ kind: "remove", text: beforeLines[index] ?? "", oldLine: index + 1, newLine: null });
  }
  for (let index = prefix; index < afterLines.length - suffix; index += 1) {
    lines.push({ kind: "add", text: afterLines[index] ?? "", oldLine: null, newLine: index + 1 });
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    const oldIndex = beforeLines.length - offset;
    const newIndex = afterLines.length - offset;
    lines.push({
      kind: "context",
      text: beforeLines[oldIndex] ?? "",
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
    });
  }
  return truncateDiff(lines);
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function truncateDiff(lines: AgentMemoryDiffLine[]): AgentMemoryDiffLine[] {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  const edge = Math.floor((MAX_DIFF_LINES - 1) / 2);
  return [
    ...lines.slice(0, edge),
    {
      kind: "meta",
      text: `${lines.length - edge * 2} lines omitted`,
      oldLine: null,
      newLine: null,
    },
    ...lines.slice(-edge),
  ];
}
