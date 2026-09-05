import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type OpenVikingApplyCommitInput,
  type OpenVikingCommitRun,
  type OpenVikingMemoryChange,
  type OpenVikingOperationEvent,
  type OpenVikingRecallTrace,
} from "../../core/openviking-memory-control";
import { parseOpenVikingMemoryDiff } from "../../core/openviking-memory-diff";
import type { OpenVikingClientPort, OpenVikingWorkspaceAuth } from "./openviking-client";

interface OpenVikingHookStateFlusherOptions {
  stateDir: string;
  client: Pick<
    OpenVikingClientPort,
    "commitSession" | "getTask" | "readSessionArtifact" | "writeMemoryContent"
  >;
  withAuth<T>(
    workspaceId: string,
    operation: (auth: OpenVikingWorkspaceAuth) => Promise<T>,
  ): Promise<T>;
  control: {
    upsertOpenVikingCommitRun(run: OpenVikingCommitRun): Promise<void>;
    applyOpenVikingCommitResult(
      input: OpenVikingApplyCommitInput,
    ): Promise<Array<{ uri: string; content: string; title?: string }>>;
    recordOpenVikingOperationEvent(event: OpenVikingOperationEvent): Promise<void>;
    recordOpenVikingRecallTrace(trace: OpenVikingRecallTrace): Promise<void>;
  };
  onStateChanged?(): void | Promise<void>;
  snapshot?(): Promise<{
    modelSnapshot?: Record<string, unknown>;
    policySnapshot?: Record<string, unknown>;
  }>;
  idleMs?: number;
  intervalMs?: number;
}

interface HookTurnEvidence {
  id?: string;
  sourceTurnId?: string;
  inputChars?: number;
  toolCount?: number;
}

interface HookCommitTask {
  taskId?: string;
  trigger?: string;
  agent?: string;
  sourceSessionId?: string;
  evidenceIds?: string[];
  sourceTurnIds?: string[];
  tokenEstimate?: number;
  inputChars?: number;
  toolCount?: number;
  startedAt?: string;
  acceptedAt?: string;
}

interface HookCommitRequest extends Omit<HookCommitTask, "taskId" | "acceptedAt"> {
  requestId?: string;
}

interface HookSessionState {
  workspaceId?: string;
  sessionId?: string;
  sourceSessionId?: string;
  agent?: string;
  pendingTokenEstimate?: number;
  pendingEvidence?: HookTurnEvidence[];
  submittedTurns?: unknown[];
  commitRequest?: HookCommitRequest;
  commitTasks?: HookCommitTask[];
  recallBlockedByTaskId?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface OpenVikingTaskRecord extends Record<string, unknown> {
  status?: unknown;
  result?: unknown;
  error?: unknown;
}

interface OpenVikingTaskResult extends Record<string, unknown> {
  archive_uri?: unknown;
  archiveUri?: unknown;
  memory_diff_uri?: unknown;
  memoryDiffUri?: unknown;
  memories_extracted?: unknown;
  memoriesExtracted?: unknown;
  token_usage?: unknown;
  tokenUsage?: unknown;
  stage_timings?: unknown;
  stageTimings?: unknown;
  stages?: unknown;
}

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_INTERVAL_MS = 10_000;
const COMMIT_REQUEST_STALE_MS = 5 * 60_000;
/** Ceiling for one remote commit task; past this a non-terminal task is failed, not polled forever. */
const COMMIT_TASK_TIMEOUT_MS = 30 * 60_000;
const SUBMITTED_TURN_STALE_MS = 24 * 60 * 60_000;
const STATE_LOCK_RETRY_MS = 10;
const STATE_LOCK_TIMEOUT_MS = 5_000;
const STATE_LOCK_STALE_MS = 30_000;

export class OpenVikingHookStateFlusher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(private readonly options: OpenVikingHookStateFlusherOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flushIdle().catch(() => {
        // Pending state and artifacts remain on disk for the next sweep.
      });
    }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async flushIdle(now = Date.now()): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    let changed = false;
    try {
      changed = await this.flushArtifacts() || changed;
      let names: string[];
      try {
        names = (await readdir(this.options.stateDir)).filter((name) => name.endsWith(".json"));
      } catch {
        return;
      }
      for (const name of names) {
        changed = await this.flushFile(path.join(this.options.stateDir, name), now) || changed;
      }
    } finally {
      this.flushing = false;
      if (changed) await this.options.onStateChanged?.();
    }
  }

  private async flushArtifacts(): Promise<boolean> {
    const [events, traces] = await Promise.all([
      this.flushArtifactDirectory("operation-events", async (value) => {
        await this.options.control.recordOpenVikingOperationEvent(value as unknown as OpenVikingOperationEvent);
      }),
      this.flushArtifactDirectory("recall-traces", async (value) => {
        await this.options.control.recordOpenVikingRecallTrace(value as unknown as OpenVikingRecallTrace);
      }),
    ]);
    return events || traces;
  }

  private async flushArtifactDirectory(
    name: string,
    persist: (value: Record<string, unknown>) => Promise<void>,
  ): Promise<boolean> {
    const directory = path.join(this.options.stateDir, name);
    let names: string[];
    try {
      names = (await readdir(directory)).filter((entry) => entry.endsWith(".json"));
    } catch {
      return false;
    }
    let changed = false;
    for (const entry of names) {
      const filePath = path.join(directory, entry);
      try {
        const value = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
        await persist(value);
        await rm(filePath, { force: true });
        changed = true;
      } catch {
        // Keep invalid or temporarily unpersisted artifacts for inspection/retry.
      }
    }
    return changed;
  }

  private async flushFile(filePath: string, now: number): Promise<boolean> {
    let state = await readState(filePath);
    if (!state) return false;
    let changed = false;

    const pruned = await this.pruneStaleSubmittedTurns(filePath, state, now);
    state = pruned.state;
    changed = pruned.changed || changed;

    if (state.workspaceId && state.sessionId && Array.isArray(state.commitTasks)) {
      const result = await this.processCommitTasks(state, now);
      if (result.completedTaskIds.size > 0) {
        const current = await withStateLock(filePath, async () => {
          const latest = await readState(filePath);
          if (!latest) return null;
          latest.commitTasks = (Array.isArray(latest.commitTasks) ? latest.commitTasks : [])
            .filter((task) => !result.completedTaskIds.has(String(task?.taskId || "")));
          if (result.lastOutcome?.state === "failed") {
            latest.recallBlockedByTaskId = result.lastOutcome.taskId;
          } else if (result.lastOutcome?.state === "completed") {
            delete latest.recallBlockedByTaskId;
          }
          await writeState(filePath, latest);
          return latest;
        });
        if (!current) return changed;
        state = current;
        changed = true;
      }
    }

    const pending = Number(state.pendingTokenEstimate || 0);
    const updatedAt = Date.parse(state.updatedAt || "");
    if (
      pending <= 0
      || !state.workspaceId
      || !state.sessionId
      || !Number.isFinite(updatedAt)
      || now - updatedAt < (this.options.idleMs ?? DEFAULT_IDLE_MS)
    ) return changed;
    const prepared = await this.prepareIdleCommit(filePath, now);
    if (!prepared) return changed;
    const { request, state: commitState } = prepared;
    const startedAt = request.startedAt!;
    let taskId: string;
    try {
      taskId = await this.options.withAuth(commitState.workspaceId!, async (auth) => (
        (await this.options.client.commitSession(auth, commitState.sessionId!)).taskId
      ));
    } catch (error) {
      await this.clearCommitRequest(filePath, request.requestId!);
      await this.options.control.recordOpenVikingOperationEvent({
        id: randomUUID(),
        workspaceId: commitState.workspaceId!,
        sessionId: commitState.sessionId!,
        phase: "commit",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - now),
        details: { trigger: "idle", error: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined);
      return changed;
    }

    const acceptedAt = new Date(now).toISOString();
    const { requestId: _requestId, ...taskFields } = request;
    const task: HookCommitTask = {
      taskId,
      ...taskFields,
      startedAt,
      acceptedAt,
    };
    const current = await this.acceptCommitRequest(filePath, request, task, acceptedAt);
    if (!current) return changed;
    await this.options.control.upsertOpenVikingCommitRun(toCommitRun(current, task, "running"));
    await this.options.control.recordOpenVikingOperationEvent({
      id: randomUUID(),
      workspaceId: current.workspaceId!,
      sessionId: current.sessionId!,
      taskId,
      phase: "commit",
      status: "completed",
      startedAt,
      completedAt: acceptedAt,
      durationMs: Math.max(0, Date.parse(acceptedAt) - now),
      details: {
        trigger: "idle",
        sourceTurnCount: request.sourceTurnIds?.length ?? 0,
        tokenEstimate: request.tokenEstimate ?? 0,
        inputChars: request.inputChars ?? 0,
        toolCount: request.toolCount ?? 0,
      },
    });
    return true;
  }

  private async pruneStaleSubmittedTurns(
    filePath: string,
    state: HookSessionState,
    now: number,
  ): Promise<{ state: HookSessionState; changed: boolean }> {
    const submittedTurns = Array.isArray(state.submittedTurns) ? state.submittedTurns : [];
    if (!submittedTurns.some((item) => !isActiveSubmittedTurn(item, now))) {
      return { state, changed: false };
    }
    return withStateLock(filePath, async () => {
      const current = await readState(filePath);
      if (!current) return { state, changed: false };
      const currentTurns = Array.isArray(current.submittedTurns) ? current.submittedTurns : [];
      const activeTurns = currentTurns.filter((item) => isActiveSubmittedTurn(item, now));
      if (activeTurns.length === currentTurns.length) {
        return { state: current, changed: false };
      }
      current.submittedTurns = activeTurns;
      await writeState(filePath, current);
      return { state: current, changed: true };
    });
  }

  private async prepareIdleCommit(
    filePath: string,
    now: number,
  ): Promise<{ state: HookSessionState; request: HookCommitRequest } | null> {
    return withStateLock(filePath, async () => {
      const current = await readState(filePath);
      if (!current?.workspaceId || !current.sessionId) return null;
      const pending = Math.max(0, Number(current.pendingTokenEstimate || 0));
      const updatedAt = Date.parse(current.updatedAt || "");
      if (
        pending <= 0
        || !Number.isFinite(updatedAt)
        || now - updatedAt < (this.options.idleMs ?? DEFAULT_IDLE_MS)
      ) return null;
      if (isActiveCommitRequest(current.commitRequest, now)) return null;

      const request = commitRequestFromState(current, "idle", now);
      current.commitRequest = request;
      await writeState(filePath, current);
      return { state: current, request };
    });
  }

  private async clearCommitRequest(filePath: string, requestId: string): Promise<void> {
    await withStateLock(filePath, async () => {
      const current = await readState(filePath);
      if (!current || current.commitRequest?.requestId !== requestId) return;
      delete current.commitRequest;
      await writeState(filePath, current);
    });
  }

  private async acceptCommitRequest(
    filePath: string,
    request: HookCommitRequest,
    task: HookCommitTask,
    acceptedAt: string,
  ): Promise<HookSessionState | null> {
    return withStateLock(filePath, async () => {
      const current = await readState(filePath);
      if (!current) return null;
      if (current.commitRequest?.requestId === request.requestId) delete current.commitRequest;
      removeCommittedPendingState(current, request);
      current.commitTasks = [
        ...(Array.isArray(current.commitTasks) ? current.commitTasks : [])
          .filter((item) => item?.taskId !== task.taskId),
        task,
      ].slice(-20);
      current.lastCommittedAt = acceptedAt;
      current.updatedAt = acceptedAt;
      await writeState(filePath, current);
      return current;
    });
  }

  private async processCommitTasks(
    state: HookSessionState,
    now: number,
  ): Promise<{
    completedTaskIds: Set<string>;
    lastOutcome?: { taskId: string; state: "completed" | "failed" };
  }> {
    const completedTaskIds = new Set<string>();
    let lastOutcome: { taskId: string; state: "completed" | "failed" } | undefined;
    for (const task of state.commitTasks ?? []) {
      const taskId = String(task?.taskId || "");
      if (!taskId) continue;
      const run = toCommitRun(state, task, "running");
      // Bound polling: a task stuck non-terminal, lost, or failing its locked-memory
      // restore would otherwise be re-polled every flush forever and pin its run
      // "running". Fail it past the commit window so recall recovers on the next commit.
      if (now - Date.parse(run.startedAt) >= COMMIT_TASK_TIMEOUT_MS) {
        const completedAt = new Date(now).toISOString();
        await this.recordFailedCommitTask(state, run, taskId, "OpenViking commit task timed out.", completedAt);
        completedTaskIds.add(taskId);
        lastOutcome = { taskId, state: "failed" };
        continue;
      }
      await this.options.control.upsertOpenVikingCommitRun(run);
      let remoteTask: OpenVikingTaskRecord | null;
      let userId: string;
      try {
        const loaded = await this.options.withAuth(state.workspaceId!, async (auth) => ({
          remoteTask: await this.options.client.getTask(auth, taskId) as OpenVikingTaskRecord | null,
          userId: auth.userId,
        }));
        remoteTask = loaded.remoteTask;
        userId = loaded.userId;
      } catch {
        continue;
      }
      if (!remoteTask) continue;
      const status = String(remoteTask.status || "").toLowerCase();
      if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        const completedAt = new Date(now).toISOString();
        await this.recordFailedCommitTask(state, run, taskId, taskError(remoteTask), completedAt);
        completedTaskIds.add(taskId);
        lastOutcome = { taskId, state: "failed" };
        continue;
      }
      if (!["completed", "succeeded", "success", "done"].includes(status)) continue;

      const result = (objectValue(remoteTask.result) ?? {}) as OpenVikingTaskResult;
      const archiveUri = stringValue(result.archive_uri) || stringValue(result.archiveUri);
      const memoryDiffUri = stringValue(result.memory_diff_uri) || stringValue(result.memoryDiffUri);
      let changes: OpenVikingMemoryChange[] = [];
      if (memoryDiffUri) {
        let memoryDiff: string;
        try {
          memoryDiff = await this.options.withAuth(state.workspaceId!, (auth) => (
            this.options.client.readSessionArtifact(auth, memoryDiffUri)
          ));
        } catch {
          continue;
        }
        try {
          changes = parseOpenVikingMemoryDiff(memoryDiff, userId);
        } catch (error) {
          const completedAt = new Date(now).toISOString();
          await this.recordFailedCommitTask(
            state,
            run,
            taskId,
            `Invalid OpenViking Memory Diff: ${error instanceof Error ? error.message : String(error)}`,
            completedAt,
          );
          completedTaskIds.add(taskId);
          lastOutcome = { taskId, state: "failed" };
          continue;
        }
      }
      const completedAt = new Date(now).toISOString();
      const completedRun: OpenVikingCommitRun = {
        ...run,
        state: "completed",
        ...(archiveUri ? { archiveUri } : {}),
        ...(memoryDiffUri ? { memoryDiffUri } : {}),
        ...(numberRecord(result.memories_extracted ?? result.memoriesExtracted)
          ? { memoriesExtracted: numberRecord(result.memories_extracted ?? result.memoriesExtracted)! }
          : {}),
        ...(objectValue(result.token_usage ?? result.tokenUsage)
          ? { tokenUsage: objectValue(result.token_usage ?? result.tokenUsage)! }
          : {}),
        completedAt,
        updatedAt: completedAt,
      };
      const snapshot: {
        modelSnapshot?: Record<string, unknown>;
        policySnapshot?: Record<string, unknown>;
      } = this.options.snapshot
        ? await this.options.snapshot().catch(() => ({}))
        : {};
      const conflicts = await this.options.control.applyOpenVikingCommitResult({
        run: completedRun,
        changes,
        ...(archiveUri ? { archiveUri } : {}),
        ...(memoryDiffUri ? { memoryDiffUri } : {}),
        ...(snapshot?.modelSnapshot ? { modelSnapshot: snapshot.modelSnapshot } : {}),
        policySnapshot: {
          trigger: completedRun.trigger,
          ...(snapshot?.policySnapshot ?? {}),
        },
      });
      let restored = 0;
      try {
        for (const conflict of conflicts) {
          await this.options.withAuth(state.workspaceId!, (auth) => (
            this.options.client.writeMemoryContent(
              auth,
              conflict.uri,
              conflict.content,
              conflict.title,
            )
          ));
          restored += 1;
        }
      } catch {
        continue;
      }
      await this.recordCompletedPhases(completedRun, changes, restored, remoteTask, result);
      completedTaskIds.add(taskId);
      lastOutcome = { taskId, state: "completed" };
    }
    return { completedTaskIds, ...(lastOutcome ? { lastOutcome } : {}) };
  }

  private async recordFailedCommitTask(
    state: HookSessionState,
    run: OpenVikingCommitRun,
    taskId: string,
    error: string,
    completedAt: string,
  ): Promise<void> {
    await this.options.control.upsertOpenVikingCommitRun({
      ...run,
      state: "failed",
      error,
      completedAt,
      updatedAt: completedAt,
    });
    await this.options.control.recordOpenVikingOperationEvent({
      id: randomUUID(),
      workspaceId: state.workspaceId!,
      sessionId: state.sessionId!,
      taskId,
      phase: "verify",
      status: "failed",
      startedAt: run.startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(run.startedAt)),
      details: { error },
    });
  }

  private async recordCompletedPhases(
    run: OpenVikingCommitRun,
    changes: OpenVikingMemoryChange[],
    restored: number,
    remoteTask: OpenVikingTaskRecord,
    result: OpenVikingTaskResult,
  ): Promise<void> {
    const completedAt = run.completedAt ?? run.updatedAt;
    const extracted = run.memoriesExtracted ?? {};
    const timings = stageTimings(remoteTask, result);
    const events: OpenVikingOperationEvent[] = [
      eventForPhase(run, "summary", "completed", completedAt, timings.get("summary"), {}),
      eventForPhase(run, "long-term-memory", "completed", completedAt, timings.get("long-term-memory"), {
        changeCount: changes.length,
        memoryChanges: changes,
        extracted,
      }),
      eventForPhase(
        run,
        "experience",
        Number(extracted.experiences || extracted.skills || extracted.cases || 0) > 0 ? "completed" : "skipped",
        completedAt,
        timings.get("experience"),
        { extracted },
      ),
      eventForPhase(run, "vectorize", "completed", completedAt, timings.get("vectorize"), {}),
      eventForPhase(run, "verify", "completed", completedAt, timings.get("verify"), {
        memoryDiffUri: run.memoryDiffUri,
        restoredLockedMemories: restored,
      }),
    ];
    await Promise.all(events.map((event) => this.options.control.recordOpenVikingOperationEvent(event)));
  }
}

function eventForPhase(
  run: OpenVikingCommitRun,
  phase: string,
  status: OpenVikingOperationEvent["status"],
  completedAt: string,
  timing: StageTiming | undefined,
  details: Record<string, unknown>,
): OpenVikingOperationEvent {
  const startedAt = timing?.startedAt ?? completedAt;
  const finishedAt = timing?.completedAt ?? completedAt;
  return {
    id: `${run.taskId}:${phase}`,
    workspaceId: run.workspaceId,
    sessionId: run.sessionId,
    taskId: run.taskId,
    phase,
    status,
    startedAt,
    completedAt: finishedAt,
    ...(timing?.durationMs === undefined ? {} : { durationMs: timing.durationMs }),
    details: {
      timingSource: timing ? "remote-task" : "completion-marker",
      ...details,
    },
  };
}

interface StageTiming {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

function stageTimings(
  remoteTask: OpenVikingTaskRecord,
  result: OpenVikingTaskResult,
): Map<string, StageTiming> {
  const output = new Map<string, StageTiming>();
  const candidates = [
    result.stage_timings,
    result.stageTimings,
    result.stages,
    remoteTask.stage_timings,
    remoteTask.stageTimings,
    remoteTask.stages,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const value of candidate) addStageTiming(output, value);
      continue;
    }
    const record = objectValue(candidate);
    if (!record) continue;
    for (const [name, value] of Object.entries(record)) addStageTiming(output, value, name);
  }
  return output;
}

function addStageTiming(
  output: Map<string, StageTiming>,
  value: unknown,
  fallbackName = "",
): void {
  const record = objectValue(value);
  if (!record) return;
  const phase = normalizeStageName(
    stringValue(record.phase)
      || stringValue(record.name)
      || stringValue(record.stage)
      || fallbackName,
  );
  if (!phase) return;
  const startedAt = validDate(record.started_at) ?? validDate(record.startedAt) ?? undefined;
  const completedAt = validDate(record.completed_at) ?? validDate(record.completedAt) ?? undefined;
  const rawDuration = Number(record.duration_ms ?? record.durationMs);
  const durationMs = Number.isFinite(rawDuration) && rawDuration >= 0 ? Math.floor(rawDuration) : undefined;
  output.set(phase, {
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function normalizeStageName(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  if (["summarize", "summary"].includes(normalized)) return "summary";
  if (["memory", "memories", "long-term-memory", "longterm-memory"].includes(normalized)) {
    return "long-term-memory";
  }
  if (["experience", "experiences", "skills", "cases"].includes(normalized)) return "experience";
  if (["vector", "vectors", "vectorize", "index", "indexing"].includes(normalized)) return "vectorize";
  if (["verify", "verification", "finalize"].includes(normalized)) return "verify";
  return "";
}

function toCommitRun(
  state: HookSessionState,
  task: HookCommitTask,
  runState: OpenVikingCommitRun["state"],
): OpenVikingCommitRun {
  const startedAt = validDate(task.startedAt) ?? validDate(task.acceptedAt) ?? new Date().toISOString();
  const updatedAt = validDate(task.acceptedAt) ?? startedAt;
  return {
    taskId: String(task.taskId || ""),
    workspaceId: state.workspaceId!,
    sessionId: state.sessionId!,
    ...(task.sourceSessionId || state.sourceSessionId
      ? { sourceSessionId: String(task.sourceSessionId || state.sourceSessionId) }
      : {}),
    ...(task.agent || state.agent ? { agent: String(task.agent || state.agent) } : {}),
    trigger: String(task.trigger || "unknown"),
    state: runState,
    sourceTurnIds: Array.isArray(task.sourceTurnIds)
      ? task.sourceTurnIds.filter((value): value is string => typeof value === "string")
      : [],
    tokenEstimate: Math.max(0, Math.floor(Number(task.tokenEstimate || 0))),
    startedAt,
    updatedAt,
  };
}

function taskError(task: OpenVikingTaskRecord): string {
  if (typeof task.error === "string") return task.error;
  const error = objectValue(task.error);
  return stringValue(error?.message) || "OpenViking commit task failed.";
}

function commitRequestFromState(
  state: HookSessionState,
  trigger: string,
  now: number,
): HookCommitRequest {
  const evidence = Array.isArray(state.pendingEvidence) ? state.pendingEvidence : [];
  const evidenceIds = evidence
    .map((item) => String(item?.id || ""))
    .filter(Boolean);
  return {
    requestId: randomUUID(),
    trigger,
    agent: state.agent || "unknown",
    ...(state.sourceSessionId ? { sourceSessionId: state.sourceSessionId } : {}),
    evidenceIds,
    sourceTurnIds: [...new Set(evidence
      .map((item) => String(item?.sourceTurnId || item?.id || ""))
      .filter(Boolean))],
    tokenEstimate: Math.max(0, Math.floor(Number(state.pendingTokenEstimate || 0))),
    inputChars: evidence.reduce(
      (total, item) => total + Math.max(0, Number(item?.inputChars || 0)),
      0,
    ),
    toolCount: evidence.reduce(
      (total, item) => total + Math.max(0, Number(item?.toolCount || 0)),
      0,
    ),
    startedAt: new Date(now).toISOString(),
  };
}

function isActiveCommitRequest(request: HookCommitRequest | undefined, now: number): boolean {
  const startedAt = Date.parse(request?.startedAt || "");
  return Boolean(request?.requestId)
    && Number.isFinite(startedAt)
    && now - startedAt < COMMIT_REQUEST_STALE_MS;
}

function removeCommittedPendingState(
  state: HookSessionState,
  request: HookCommitRequest,
): void {
  const committedIds = new Set(request.evidenceIds ?? request.sourceTurnIds ?? []);
  state.pendingEvidence = (Array.isArray(state.pendingEvidence) ? state.pendingEvidence : [])
    .filter((item) => !committedIds.has(String(item?.id || "")));
  state.pendingTokenEstimate = Math.max(
    0,
    Number(state.pendingTokenEstimate || 0) - Math.max(0, Number(request.tokenEstimate || 0)),
  );
  if (state.pendingTokenEstimate <= 0 && state.pendingEvidence.length === 0) {
    state.pendingSince = null;
  }
}

function isActiveSubmittedTurn(value: unknown, now: number): boolean {
  const record = objectValue(value);
  const submittedAt = Date.parse(stringValue(record?.submittedAt));
  return Number.isFinite(submittedAt) && now - submittedAt <= SUBMITTED_TURN_STALE_MS;
}

async function withStateLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs >= STATE_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring OpenViking hook state lock: ${filePath}`);
      await new Promise((resolve) => setTimeout(resolve, STATE_LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function readState(filePath: string): Promise<HookSessionState | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as HookSessionState;
  } catch {
    return null;
  }
}

async function writeState(filePath: string, state: HookSessionState): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberRecord(value: unknown): Record<string, number> | null {
  const record = objectValue(value);
  if (!record) return null;
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}
