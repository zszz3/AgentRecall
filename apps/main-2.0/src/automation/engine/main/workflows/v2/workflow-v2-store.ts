import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
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
import {
  WorkflowV2WorkspaceTransaction,
  type WorkflowWorkspaceCommitResult,
  type WorkflowWorkspaceConflictPreview,
  type WorkflowWorkspaceDiffResult,
  type WorkflowWorkspacePreparation,
  type WorkflowWorkspaceRollbackResult,
} from "./workflow-v2-workspace-transaction";
import {
  WORKFLOW_TRANSACTION_EVENT_TYPES,
  WorkflowOperationTransitionError,
  canTransitionWorkflowOperation,
  isWorkflowCommitPlan,
  isWorkflowOperationRecord,
  sanitizeWorkflowOperationRecord,
  sanitizeWorkflowTransactionValue,
  type WorkflowCommitPlan,
  type WorkflowOperationRecord,
  type WorkflowOperationState,
} from "../../../shared/workflow-v2/transaction";

const storeWriteChains = new Map<string, Promise<void>>();

export class WorkflowV2FileStore {
  private readonly writeKey: string;

  constructor(private readonly rootDir: string) {
    if (!path.isAbsolute(rootDir)) throw new Error("Workflow V2 storage root must be an absolute path.");
    const resolved = path.resolve(rootDir);
    this.writeKey = process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
      operationLogPath: path.join(runDir, "operations.json"),
      commitPlanPath: path.join(runDir, "commit-plan.json"),
      cacheDir: path.join(runDir, "cache"),
    };
  }

  persistRunState(state: WorkflowV2PersistedRunState): Promise<void> {
    return this.enqueue(async () => {
      if (!isWorkflowV2PersistedRunState(state)) throw new Error("Workflow V2 persisted run state is malformed.");
      const layout = this.layout(state.workflowId, state.runId);
      const next = structuredClone(state);
      if (next.transaction) {
        const operations = await readOperationRecordsFile(layout.operationLogPath);
        applyTransactionLedgerState(next.transaction, operations, next.savedAt);
      }
      await atomicWriteJson(layout.runStatePath, next);
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
      const existing = await readDurableEventsFile(layout.eventLogPath);
      const bySequence = new Map(existing.map((event) => [event.sequence, event]));
      let lastSequence = existing.at(-1)?.sequence ?? -1;
      const pending: WorkflowV2DurableEvent[] = [];
      for (const event of input.events) {
        assertDurableEvent(event, input.workflowId, input.runId);
        const duplicate = bySequence.get(event.sequence);
        if (duplicate) {
          if (canonicalJson(duplicate) !== canonicalJson(event)) throw new Error(`Workflow V2 event sequence ${event.sequence} conflicts with durable history.`);
          continue;
        }
        if (event.sequence !== lastSequence + 1) throw new Error(`Workflow V2 event sequence must be monotonic; expected ${lastSequence + 1}, received ${event.sequence}.`);
        pending.push(structuredClone(event));
        bySequence.set(event.sequence, event);
        lastSequence = event.sequence;
      }
      if (pending.length > 0) await appendFile(layout.eventLogPath, pending.map((event) => `${stringifyJson(event)}\n`).join(""), "utf8");
    });
  }

  prepareWorkspaceTransaction(input: { workflowId: string; runId: string; sourceDir: string; baselineId: string; now?: number }): Promise<WorkflowWorkspacePreparation> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).prepare(input));
  }

  createWorkspaceSavepoint(input: { workflowId: string; runId: string; savepointId: string; nodeId: string; attempt: number; now?: number }): Promise<void> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).createSavepoint(input));
  }

  restoreWorkspaceSavepoint(input: { workflowId: string; runId: string; savepointId: string }): Promise<void> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).restoreSavepoint(input.savepointId));
  }

  commitWorkspaceTransaction(input: { workflowId: string; runId: string }): Promise<WorkflowWorkspaceCommitResult> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).commit());
  }

  discardWorkspaceTransaction(input: { workflowId: string; runId: string }): Promise<void> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).discard());
  }

  rollbackWorkspaceTransaction(input: { workflowId: string; runId: string }): Promise<WorkflowWorkspaceRollbackResult> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).rollbackCommitted());
  }

  inspectWorkspaceTransaction(input: { workflowId: string; runId: string }): Promise<WorkflowWorkspaceDiffResult> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).inspectDiff());
  }

  inspectWorkspaceConflicts(input: { workflowId: string; runId: string; paths: readonly string[] }): Promise<WorkflowWorkspaceConflictPreview[]> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).inspectConflictPreview(input.paths));
  }

  resolveWorkspaceConflict(input: { workflowId: string; runId: string; path: string; resolution: "isolated" | "current" | "manual"; expectedCurrentSha256?: string; content?: string }): Promise<WorkflowWorkspaceConflictPreview> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).resolveConflict(input));
  }

  inspectWorkspaceSavepointDiff(input: { workflowId: string; runId: string; savepointId: string }): Promise<WorkflowWorkspaceDiffResult> {
    return this.enqueueValue(() => this.workspaceTransaction(input.workflowId, input.runId).inspectDiffSinceSavepoint(input.savepointId));
  }

  persistCommitPlan(plan: WorkflowCommitPlan): Promise<WorkflowCommitPlan> {
    return this.enqueueValue(async () => {
      if (!isWorkflowCommitPlan(plan)) throw new Error("Workflow commit plan is malformed.");
      const layout = this.layout(plan.workflowId, plan.runId);
      await this.assertOperationTransactionIdentity(plan.workflowId, plan.runId, plan.transactionId);
      const sanitized = sanitizeWorkflowTransactionValue(plan);
      if (!isWorkflowCommitPlan(sanitized)) throw new Error("Workflow commit plan became malformed after sanitization.");
      const archivedPlanPath = path.join(layout.runDir, "commit-plans", `${createHash("sha256").update(plan.commitPlanId).digest("hex")}.json`);
      const existingContent = await readOptionalFile(archivedPlanPath);
      if (existingContent !== undefined) {
        const existing = parseJson(existingContent, `Workflow commit plan ${plan.commitPlanId}`);
        if (!isWorkflowCommitPlan(existing)) throw new Error("Stored workflow commit plan is malformed.");
        if (canonicalJson(existing) !== canonicalJson(sanitized)) throw new Error("Workflow commit plan is immutable and conflicts with the stored plan.");
        await atomicWriteJson(layout.commitPlanPath, existing);
        return structuredClone(existing);
      }
      await atomicWriteJson(archivedPlanPath, sanitized);
      await atomicWriteJson(layout.commitPlanPath, sanitized);
      return structuredClone(sanitized);
    });
  }

  async readCommitPlan(workflowId: string, runId: string): Promise<WorkflowCommitPlan | undefined> {
    await this.pendingWrites();
    const content = await readOptionalFile(this.layout(workflowId, runId).commitPlanPath);
    if (content === undefined) return undefined;
    const parsed = parseJson(content, `Workflow commit plan ${runId}`);
    if (!isWorkflowCommitPlan(parsed)) throw new Error("Stored workflow commit plan is malformed.");
    return structuredClone(parsed);
  }

  planOperation(input: { workflowId: string; record: WorkflowOperationRecord }): Promise<WorkflowOperationRecord> {
    return this.enqueueValue(async () => {
      const sanitized = {
        ...sanitizeWorkflowOperationRecord(input.record),
        semanticDigest: workflowOperationSemanticDigest(input.record),
      };
      if (!isWorkflowOperationRecord(sanitized) || sanitized.state !== "planned") throw new Error("Workflow operation plan is malformed.");
      await this.assertOperationTransactionIdentity(input.workflowId, sanitized.runId, sanitized.transactionId);
      const operationPath = this.layout(input.workflowId, sanitized.runId).operationLogPath;
      const operations = await readOperationRecordsFile(operationPath);
      const sameId = operations.find((item) => item.operationId === sanitized.operationId);
      const sameKey = operations.find((item) => item.idempotencyKey === sanitized.idempotencyKey);
      const existing = sameId ?? sameKey;
      if (existing) {
        if (!sameWorkflowOperationPlan(existing, sanitized)) throw new Error(`Workflow operation ${sanitized.operationId} conflicts with its durable semantic identity.`);
        return structuredClone(existing);
      }
      operations.push(sanitized);
      await atomicWriteJson(operationPath, operations);
      await this.syncTransactionCounters(input.workflowId, sanitized.runId, operations, sanitized.updatedAt);
      return structuredClone(sanitized);
    });
  }

  transitionOperation(input: {
    workflowId: string;
    runId: string;
    operationId: string;
    state: WorkflowOperationState;
    updatedAt: number;
    receipt?: unknown;
    error?: string;
  }): Promise<WorkflowOperationRecord> {
    return this.enqueueValue(async () => {
      const layout = this.layout(input.workflowId, input.runId);
      const operations = await readOperationRecordsFile(layout.operationLogPath);
      const index = operations.findIndex((item) => item.operationId === input.operationId);
      if (index < 0) throw new Error(`Workflow operation ${input.operationId} was not found.`);
      const current = operations[index]!;
      if (current.runId !== input.runId) throw new Error(`Workflow operation ${input.operationId} run identity does not match its storage location.`);
      await this.assertOperationTransactionIdentity(input.workflowId, input.runId, current.transactionId);
      if (input.updatedAt < current.updatedAt) throw new Error(`Workflow operation ${input.operationId} updatedAt must not move backwards.`);
      if (!canTransitionWorkflowOperation(current.state, input.state)) {
        throw new WorkflowOperationTransitionError(input.operationId, current.state, input.state);
      }
      if (current.state === input.state) return structuredClone(current);
      const next = sanitizeWorkflowOperationRecord({
        ...current,
        state: input.state,
        updatedAt: input.updatedAt,
        ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
      });
      if (!isWorkflowOperationRecord(next)) throw new Error(`Workflow operation ${input.operationId} transition is malformed.`);
      operations[index] = next;
      await atomicWriteJson(layout.operationLogPath, operations);
      await this.syncTransactionCounters(input.workflowId, input.runId, operations, input.updatedAt);
      return structuredClone(next);
    });
  }

  async readOperations(workflowId: string, runId: string): Promise<WorkflowOperationRecord[]> {
    await this.pendingWrites();
    return structuredClone(await readOperationRecordsFile(this.layout(workflowId, runId).operationLogPath));
  }

  resolveUnknownOperation(input: {
    workflowId: string;
    runId: string;
    operationId: string;
    verifiedState: "applied" | "compensated";
    actor: string;
    reason: string;
    updatedAt: number;
    evidence?: unknown;
  }): Promise<WorkflowOperationRecord> {
    return this.enqueueValue(async () => {
      const actorText = input.actor.trim();
      const reasonText = input.reason.trim();
      if (!actorText || actorText.length > 256 || !reasonText || reasonText.length > 2_000) {
        throw new Error("Workflow unknown operation resolution requires a bounded actor and reason.");
      }
      const actor = sanitizeWorkflowTransactionValue(actorText);
      const reason = sanitizeWorkflowTransactionValue(reasonText);
      if (typeof actor !== "string" || typeof reason !== "string") throw new Error("Workflow unknown operation resolution audit text is malformed.");
      const layout = this.layout(input.workflowId, input.runId);
      const operations = await readOperationRecordsFile(layout.operationLogPath);
      const index = operations.findIndex((item) => item.operationId === input.operationId);
      if (index < 0) throw new Error(`Workflow operation ${input.operationId} was not found.`);
      const current = operations[index]!;
      if (current.runId !== input.runId) throw new Error(`Workflow operation ${input.operationId} run identity does not match its storage location.`);
      await this.assertOperationTransactionIdentity(input.workflowId, input.runId, current.transactionId);
      if (current.state !== "unknown") throw new Error(`Workflow operation ${input.operationId} is not awaiting unknown-state resolution.`);
      if (input.updatedAt < current.updatedAt) throw new Error(`Workflow operation ${input.operationId} updatedAt must not move backwards.`);
      const next = sanitizeWorkflowOperationRecord({
        ...current,
        state: input.verifiedState,
        updatedAt: input.updatedAt,
        receipt: {
          ...(current.receipt !== undefined ? { originalReceipt: current.receipt } : {}),
          recoveryResolution: {
            actor,
            reason,
            verifiedState: input.verifiedState,
            resolvedAt: input.updatedAt,
            ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
          },
        },
      });
      if (!isWorkflowOperationRecord(next)) throw new Error(`Workflow operation ${input.operationId} resolution is malformed.`);
      operations[index] = next;
      await atomicWriteJson(layout.operationLogPath, operations);
      await this.syncTransactionCounters(input.workflowId, input.runId, operations, input.updatedAt, true);
      await this.appendResolvedOperationEvent(input.workflowId, input.runId, next);
      return structuredClone(next);
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
    await this.pendingWrites();
    const layout = this.layout(workflowId, runId);
    const content = await readOptionalFile(layout.runStatePath);
    if (content === undefined) return undefined;
    const parsed = parseJson(content, `Workflow V2 run state ${runId}`);
    if (!isWorkflowV2PersistedRunState(parsed)) {
      throw new Error(`Workflow V2 run state ${runId} is malformed or uses an unsupported schema.`);
    }
    const durableEventCount = (await readDurableEventsFile(layout.eventLogPath)).length;
    parsed.eventCount = Math.max(parsed.eventCount, durableEventCount);
    return structuredClone(parsed);
  }

  async readEvents(workflowId: string, runId: string): Promise<WorkflowV2DurableEvent[]> {
    await this.pendingWrites();
    const layout = this.layout(workflowId, runId);
    return readDurableEventsFile(layout.eventLogPath);
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
    await this.pendingWrites();
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

  private async syncTransactionCounters(
    workflowId: string,
    runId: string,
    operations: readonly WorkflowOperationRecord[],
    updatedAt: number,
    clearResolvedRecovery = false,
  ): Promise<void> {
    const statePath = this.layout(workflowId, runId).runStatePath;
    const content = await readOptionalFile(statePath);
    if (content === undefined) return;
    const parsed = parseJson(content, `Workflow V2 run state ${runId}`);
    if (!isWorkflowV2PersistedRunState(parsed)) throw new Error(`Workflow V2 run state ${runId} is malformed or uses an unsupported schema.`);
    if (!parsed.transaction) return;
    if (operations.some((operation) => operation.transactionId !== parsed.transaction!.transactionId)) {
      throw new Error("Workflow operation ledger transaction identity does not match the persisted run.");
    }
    const previousStatus = parsed.transaction.status;
    applyTransactionLedgerState(parsed.transaction, operations, updatedAt);
    if (clearResolvedRecovery && previousStatus === "recovery_required" && parsed.transaction.unknownOperationCount === 0) {
      parsed.transaction.status = "waiting_for_user";
    }
    parsed.savedAt = Math.max(parsed.savedAt, updatedAt);
    await atomicWriteJson(statePath, parsed);
  }

  private async assertOperationTransactionIdentity(workflowId: string, runId: string, transactionId: string): Promise<void> {
    const statePath = this.layout(workflowId, runId).runStatePath;
    const content = await readOptionalFile(statePath);
    if (content === undefined) throw new Error(`Workflow V2 run state ${runId} must be persisted before planning operations.`);
    const parsed = parseJson(content, `Workflow V2 run state ${runId}`);
    if (!isWorkflowV2PersistedRunState(parsed)) throw new Error(`Workflow V2 run state ${runId} is malformed or uses an unsupported schema.`);
    if (!parsed.transaction || parsed.transaction.transactionId !== transactionId) {
      throw new Error("Workflow operation transaction identity does not match the persisted run.");
    }
  }

  private async appendResolvedOperationEvent(workflowId: string, runId: string, operation: WorkflowOperationRecord): Promise<void> {
    const layout = this.layout(workflowId, runId);
    const existing = await readDurableEventsFile(layout.eventLogPath);
    const event: WorkflowV2DurableEvent = {
      sequence: existing.length,
      workflowId,
      runId,
      transactionId: operation.transactionId,
      nodeId: operation.nodeId,
      operationId: operation.operationId,
      type: operation.state === "compensated" ? "compensation_completed" : "operation_applied",
      at: operation.updatedAt,
      detail: `Unknown operation manually resolved as ${operation.state}.`,
    };
    assertDurableEvent(event, workflowId, runId);
    await mkdir(layout.runDir, { recursive: true });
    await appendFile(layout.eventLogPath, `${stringifyJson(event)}\n`, "utf8");
    const stateContent = await readOptionalFile(layout.runStatePath);
    if (stateContent === undefined) return;
    const state = parseJson(stateContent, `Workflow V2 run state ${runId}`);
    if (!isWorkflowV2PersistedRunState(state)) throw new Error(`Workflow V2 run state ${runId} is malformed or uses an unsupported schema.`);
    state.eventCount = Math.max(state.eventCount, event.sequence + 1);
    await atomicWriteJson(layout.runStatePath, state);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    return this.enqueueValue(operation);
  }

  private enqueueValue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pendingWrites();
    const pending = previous.then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    storeWriteChains.set(this.writeKey, settled);
    void settled.then(() => {
      if (storeWriteChains.get(this.writeKey) === settled) storeWriteChains.delete(this.writeKey);
    });
    return pending;
  }

  private pendingWrites(): Promise<void> {
    return storeWriteChains.get(this.writeKey) ?? Promise.resolve();
  }

  private workspaceTransaction(workflowId: string, runId: string): WorkflowV2WorkspaceTransaction {
    return new WorkflowV2WorkspaceTransaction(path.join(this.layout(workflowId, runId).runDir, "transaction-workspace"));
  }

  cleanupExpiredRuns(now = Date.now()): Promise<Array<{ workflowId: string; runId: string }>> {
    return this.enqueueValue(async () => {
      const workflowsRoot = path.resolve(this.rootDir, "workflows");
      const removed: Array<{ workflowId: string; runId: string }> = [];
      const workflows = await readDirectories(workflowsRoot);
      for (const workflowId of workflows) {
        const runsRoot = path.join(workflowsRoot, workflowId, "runs");
        for (const runId of await readDirectories(runsRoot)) {
          const layout = this.layout(workflowId, runId);
          const stateContent = await readOptionalFile(layout.runStatePath);
          if (!stateContent) continue;
          const parsed = parseJson(stateContent, "Workflow V2 persisted run state");
          if (!isWorkflowV2PersistedRunState(parsed) || !parsed.transaction) continue;
          if (parsed.transaction.retentionUntil > now) continue;
          if (parsed.transaction.status !== "committed" && parsed.transaction.status !== "rolled_back") continue;
          const resolvedRunDir = path.resolve(layout.runDir);
          if (!resolvedRunDir.startsWith(`${workflowsRoot}${path.sep}`)) throw new Error("Workflow V2 cleanup target escaped the storage root.");
          await rm(resolvedRunDir, { recursive: true, force: true });
          removed.push({ workflowId, runId });
        }
      }
      return removed;
    });
  }

  cleanupRunMaterials(workflowId: string, runId: string): Promise<void> {
    return this.enqueueValue(async () => {
      const workflowsRoot = path.resolve(this.rootDir, "workflows");
      const layout = this.layout(workflowId, runId);
      const runDirectory = await lstat(layout.runDir).catch((error) => isNodeError(error) && error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (!runDirectory || !runDirectory.isDirectory() || runDirectory.isSymbolicLink()) throw new Error("Workflow V2 run materials were not found in a safe directory.");
      const stateContent = await readOptionalFile(layout.runStatePath);
      if (!stateContent) throw new Error("Workflow V2 run materials were not found.");
      const parsed = parseJson(stateContent, "Workflow V2 persisted run state");
      if (!isWorkflowV2PersistedRunState(parsed) || !parsed.transaction) throw new Error("Workflow V2 run materials are not safe to clean.");
      if (parsed.transaction.status !== "committed" && parsed.transaction.status !== "rolled_back") {
        throw new Error("Only committed or fully rolled back Workflow V2 materials can be cleaned.");
      }
      const resolvedRunDir = path.resolve(layout.runDir);
      if (!resolvedRunDir.startsWith(`${workflowsRoot}${path.sep}`)) throw new Error("Workflow V2 cleanup target escaped the storage root.");
      await rm(resolvedRunDir, { recursive: true, force: true });
    });
  }
}

async function readDirectories(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
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

function sameWorkflowOperationPlan(left: WorkflowOperationRecord, right: WorkflowOperationRecord): boolean {
  return left.semanticDigest === right.semanticDigest;
}

function workflowOperationSemanticDigest(record: WorkflowOperationRecord): string {
  return createHash("sha256").update(canonicalJson({
    transactionId: record.transactionId,
    runId: record.runId,
    nodeId: record.nodeId,
    attempt: record.attempt,
    kind: record.kind,
    target: record.target,
    idempotencyKey: record.idempotencyKey,
    reversible: record.reversible,
    adapterId: record.adapterId ?? null,
    compensationAdapter: record.compensationAdapter ?? null,
    requestSummary: record.requestSummary ?? null,
  })).digest("hex");
}

function applyTransactionLedgerState(
  transaction: NonNullable<WorkflowV2PersistedRunState["transaction"]>,
  operations: readonly WorkflowOperationRecord[],
  updatedAt: number,
): void {
  if (operations.some((operation) => operation.transactionId !== transaction.transactionId)) {
    throw new Error("Workflow operation ledger transaction identity does not match the persisted run.");
  }

  transaction.operationCount = operations.length;
  transaction.unknownOperationCount = operations.filter((operation) => operation.state === "unknown").length;
  transaction.irreversibleOperationCount = operations.filter((operation) => !operation.reversible && operation.state !== "compensated" && operation.state !== "discarded").length;
  transaction.updatedAt = Math.max(transaction.updatedAt, updatedAt);
  if (transaction.unknownOperationCount > 0) transaction.status = "recovery_required";
  transaction.retentionUntil = Math.max(transaction.retentionUntil, transaction.updatedAt);
}

async function readDurableEventsFile(filePath: string): Promise<WorkflowV2DurableEvent[]> {
  const content = await readOptionalFile(filePath);
  if (content === undefined || !content.trim()) return [];
  const events = content.split("\n").filter((line) => line.trim()).map((line, index) => parseDurableEvent(line, index + 1));
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.sequence !== index) throw new Error(`Workflow V2 durable event history is not monotonic at sequence ${events[index]!.sequence}.`);
  }

  return events;
}

async function readOperationRecordsFile(filePath: string): Promise<WorkflowOperationRecord[]> {
  const content = await readOptionalFile(filePath);
  if (content === undefined || !content.trim()) return [];
  const parsed = parseJson(content, "Workflow operation ledger");
  if (!Array.isArray(parsed) || !parsed.every(isWorkflowOperationRecord)) throw new Error("Workflow operation ledger is malformed.");
  const operationIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const operation of parsed) {
    if (operationIds.has(operation.operationId) || idempotencyKeys.has(operation.idempotencyKey)) throw new Error("Workflow operation ledger contains duplicate identities.");
    operationIds.add(operation.operationId);
    idempotencyKeys.add(operation.idempotencyKey);
  }
  return structuredClone(parsed);
}

function assertDurableEvent(event: WorkflowV2DurableEvent, workflowId: string, runId: string): void {
  if (event.workflowId !== workflowId || event.runId !== runId) throw new Error("Workflow V2 event identity does not match its storage location.");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || !event.type.trim() || !Number.isFinite(event.at) || event.at < 0) {
    throw new Error("Workflow V2 durable event is malformed.");
  }
  if ((WORKFLOW_TRANSACTION_EVENT_TYPES as readonly string[]).includes(event.type)) {
    if (!event.transactionId?.trim()) throw new Error(`Workflow transaction event ${event.type} requires transactionId.`);
    if (event.type.startsWith("operation_") && (!event.operationId?.trim() || !event.nodeId?.trim())) {
      throw new Error(`Workflow transaction event ${event.type} requires operationId and nodeId.`);
    }
  }
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
