import { createHash, randomUUID } from "node:crypto";
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
import {
  isWorkflowV2NodeCompletionLedger,
  WORKFLOW_V2_COMPLETION_LEDGER_SCHEMA_VERSION,
  type WorkflowV2NodeCompletionLedger,
  type WorkflowV2NodeCompletionSubmission,
  type WorkflowV2NodeCompletionSubmissionStatus,
} from "../../../shared/workflow-v2/completion";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";

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

  beginNodeCompletionExecution(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    attempt: number;
    startedAt: number;
  }): Promise<WorkflowV2NodeCompletionLedger> {
    return this.enqueueValue(async () => {
      const existing = await this.readNodeCompletionLedgerFile(input);
      if (existing) {
        if (existing.attempt !== input.attempt) throw new Error("Workflow node completion execution attempt does not match its durable ledger.");
        return structuredClone(existing);
      }
      const ledger: WorkflowV2NodeCompletionLedger = {
        schemaVersion: WORKFLOW_V2_COMPLETION_LEDGER_SCHEMA_VERSION,
        ...input,
        updatedAt: input.startedAt,
        submissions: [],
      };
      await atomicWriteJson(this.nodeCompletionLedgerPath(input), ledger);
      return structuredClone(ledger);
    });
  }

  submitNodeCompletion(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    output: WorkflowV2WorkerOutput;
    submittedAt: number;
  }): Promise<WorkflowV2NodeCompletionSubmission> {
    return this.enqueueValue(async () => {
      const ledger = await this.readNodeCompletionLedgerFile(input);
      if (!ledger) throw new Error("Workflow node completion execution is not active.");
      if (input.output.nodeId !== input.nodeId) throw new Error("Workflow node completion output identity does not match the active node.");
      const digest = completionDigest(input.output);
      const duplicate = [...ledger.submissions].reverse().find((submission) => submission.digest === digest && submission.status !== "rejected" && submission.status !== "superseded");
      if (duplicate) return structuredClone(duplicate);
      for (const submission of ledger.submissions) {
        if (submission.status === "submitted") {
          submission.status = "superseded";
          submission.resolvedAt = input.submittedAt;
        }
      }
      const submission: WorkflowV2NodeCompletionSubmission = {
        submissionId: randomUUID(),
        digest,
        status: "submitted",
        output: structuredClone(input.output),
        submittedAt: input.submittedAt,
      };
      ledger.submissions.push(submission);
      ledger.updatedAt = input.submittedAt;
      await atomicWriteJson(this.nodeCompletionLedgerPath(input), ledger);
      return structuredClone(submission);
    });
  }

  async readLatestNodeCompletionSubmission(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
  }): Promise<WorkflowV2NodeCompletionSubmission | undefined> {
    await this.writeChain;
    const ledger = await this.readNodeCompletionLedgerFile(input);
    const submission = [...(ledger?.submissions ?? [])].reverse().find((candidate) => candidate.status === "submitted");
    return submission ? structuredClone(submission) : undefined;
  }

  resolveNodeCompletionSubmission(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    executionId: string;
    submissionId: string;
    status: Extract<WorkflowV2NodeCompletionSubmissionStatus, "consumed" | "accepted" | "rejected">;
    resolvedAt: number;
    reason?: string;
  }): Promise<WorkflowV2NodeCompletionSubmission> {
    return this.enqueueValue(async () => {
      const ledger = await this.readNodeCompletionLedgerFile(input);
      if (!ledger) throw new Error("Workflow node completion execution was not found.");
      const submission = ledger.submissions.find((candidate) => candidate.submissionId === input.submissionId);
      if (!submission) throw new Error("Workflow node completion submission was not found.");
      if (submission.status === input.status) return structuredClone(submission);
      if (submission.status !== "submitted" && !(submission.status === "consumed" && input.status === "accepted")) {
        throw new Error(`Workflow node completion submission cannot transition from ${submission.status} to ${input.status}.`);
      }
      submission.status = input.status;
      submission.resolvedAt = input.resolvedAt;
      if (input.reason) submission.reason = input.reason;
      ledger.updatedAt = input.resolvedAt;
      await atomicWriteJson(this.nodeCompletionLedgerPath(input), ledger);
      return structuredClone(submission);
    });
  }

  private nodeCompletionLedgerPath(input: { workflowId: string; runId: string; nodeId: string; executionId: string }): string {
    const layout = this.layout(input.workflowId, input.runId);
    const nodeKey = createHash("sha256").update(input.nodeId).digest("hex");
    const executionKey = createHash("sha256").update(input.executionId).digest("hex");
    return path.join(layout.runDir, "completion-submissions", nodeKey, `${executionKey}.json`);
  }

  private async readNodeCompletionLedgerFile(input: { workflowId: string; runId: string; nodeId: string; executionId: string }): Promise<WorkflowV2NodeCompletionLedger | undefined> {
    const content = await readOptionalFile(this.nodeCompletionLedgerPath(input));
    if (content === undefined) return undefined;
    const parsed = parseJson(content, `Workflow V2 node completion ledger ${input.nodeId}`);
    if (!isWorkflowV2NodeCompletionLedger(parsed)) throw new Error(`Workflow V2 node completion ledger ${input.nodeId} is malformed.`);
    if (parsed.workflowId !== input.workflowId || parsed.runId !== input.runId || parsed.nodeId !== input.nodeId || parsed.executionId !== input.executionId) {
      throw new Error("Workflow V2 node completion ledger identity does not match its storage location.");
    }
    return structuredClone(parsed);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    return this.enqueueValue(operation);
  }

  private enqueueValue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writeChain.then(operation);
    this.writeChain = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

function completionDigest(output: WorkflowV2WorkerOutput): string {
  return createHash("sha256").update(canonicalJson(output)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Workflow node completion output is not JSON serializable.");
  return serialized;
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
