import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  isWorkflowV2CacheEntryMetadata,
  isWorkflowV2PersistedRunState,
  type WorkflowV2CacheEntryMetadata,
  type WorkflowV2DurableEvent,
  type WorkflowV2PersistedRunState,
  type WorkflowV2StorageLayout,
} from "../../../shared/workflow-v2/storage";

export class WorkflowV2FileStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {
    if (!path.isAbsolute(rootDir)) throw new Error("Workflow V2 storage root must be an absolute path.");
  }

  layout(workflowId: string, runId: string): WorkflowV2StorageLayout {
    assertSafeSegment(workflowId, "workflow id");
    assertSafeSegment(runId, "run id");
    const workflowDir = path.join(this.rootDir, "workflows", workflowId);
    const runDir = path.join(workflowDir, "runs", runId);
    return {
      workflowDir,
      workflowStatePath: path.join(workflowDir, "state.json"),
      runDir,
      runStatePath: path.join(runDir, "state.json"),
      eventLogPath: path.join(runDir, "events.jsonl"),
      cacheDir: path.join(runDir, "cache"),
    };
  }

  persistRunState(state: WorkflowV2PersistedRunState): Promise<void> {
    return this.enqueue(async () => {
      if (!isWorkflowV2PersistedRunState(state)) throw new Error("Workflow V2 persisted run state is malformed.");
      const layout = this.layout(state.workflowId, state.runId);
      await atomicWriteJson(layout.runStatePath, state);
    });
  }

  appendEvents(input: {
    workflowId: string;
    runId: string;
    events: readonly WorkflowV2DurableEvent[];
  }): Promise<void> {
    return this.enqueue(async () => {
      if (input.events.length === 0) return;
      const layout = this.layout(input.workflowId, input.runId);
      await mkdir(layout.runDir, { recursive: true });
      const content = input.events.map((event) => `${stringifyJson(event)}\n`).join("");
      await appendFile(layout.eventLogPath, content, "utf8");
    });
  }

  persistCacheEntry(entry: WorkflowV2CacheEntryMetadata): Promise<void> {
    return this.enqueue(async () => {
      if (!isWorkflowV2CacheEntryMetadata(entry)) throw new Error("Workflow V2 cache entry is malformed.");
      assertSafeSegment(entry.workflowId, "workflow id");
      assertSafeSegment(entry.nodeId, "node id");
      const layout = this.layout(entry.workflowId, `cache-graph-${entry.graphVersion}`);
      const cachePath = path.join(layout.workflowDir, "cache", `graph-${entry.graphVersion}`, `${entry.nodeId}.json`);
      await atomicWriteJson(cachePath, entry);
    });
  }

  async readRunState(workflowId: string, runId: string): Promise<WorkflowV2PersistedRunState | undefined> {
    const layout = this.layout(workflowId, runId);
    const content = await readOptionalFile(layout.runStatePath);
    if (content === undefined) return undefined;
    const parsed = parseJson(content, `Workflow V2 run state ${runId}`);
    if (!isWorkflowV2PersistedRunState(parsed)) {
      throw new Error(`Workflow V2 run state ${runId} is malformed or uses an unsupported schema.`);
    }
    return structuredClone(parsed);
  }

  async readEvents(workflowId: string, runId: string): Promise<WorkflowV2DurableEvent[]> {
    const layout = this.layout(workflowId, runId);
    const content = await readOptionalFile(layout.eventLogPath);
    if (content === undefined || !content.trim()) return [];
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line, index) => parseDurableEvent(line, index + 1));
  }

  async readCacheEntry(
    workflowId: string,
    graphVersion: number,
    nodeId: string,
  ): Promise<WorkflowV2CacheEntryMetadata | undefined> {
    assertSafeSegment(workflowId, "workflow id");
    assertSafeSegment(nodeId, "node id");
    if (!Number.isSafeInteger(graphVersion) || graphVersion <= 0) {
      throw new Error("Workflow V2 cache graph version must be a positive safe integer.");
    }
    const workflowDir = path.join(this.rootDir, "workflows", workflowId);
    const cachePath = path.join(workflowDir, "cache", `graph-${graphVersion}`, `${nodeId}.json`);
    const content = await readOptionalFile(cachePath);
    if (content === undefined) return undefined;
    const parsed = parseJson(content, `Workflow V2 cache entry ${nodeId}`);
    if (!isWorkflowV2CacheEntryMetadata(parsed)) {
      throw new Error(`Workflow V2 cache entry ${nodeId} is malformed.`);
    }
    return structuredClone(parsed);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.writeChain.then(operation);
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${stringifyJson(value, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function stringifyJson(value: unknown, space?: number): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new Error("Workflow V2 durable state cannot contain non-finite numbers.");
    }
    return item;
  }, space);
  if (serialized === undefined) throw new Error("Workflow V2 durable state is not JSON serializable.");
  return serialized;
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
}

function parseDurableEvent(line: string, lineNumber: number): WorkflowV2DurableEvent {
  const value = parseJson(line, `Workflow V2 event line ${lineNumber}`);
  if (!isRecord(value)) throw new Error(`Workflow V2 event line ${lineNumber} must be an object.`);
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) {
    throw new Error(`Workflow V2 event line ${lineNumber} has an invalid sequence.`);
  }
  if (typeof value.workflowId !== "string" || !value.workflowId.trim()) {
    throw new Error(`Workflow V2 event line ${lineNumber} has an invalid workflow id.`);
  }
  if (typeof value.runId !== "string" || !value.runId.trim()) {
    throw new Error(`Workflow V2 event line ${lineNumber} has an invalid run id.`);
  }
  if (typeof value.type !== "string" || !value.type.trim()) {
    throw new Error(`Workflow V2 event line ${lineNumber} has an invalid type.`);
  }
  if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < 0) {
    throw new Error(`Workflow V2 event line ${lineNumber} has an invalid timestamp.`);
  }
  return structuredClone(value) as unknown as WorkflowV2DurableEvent;
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`Workflow V2 ${label} is not a safe path segment.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
