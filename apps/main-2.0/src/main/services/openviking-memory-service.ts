import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  OPENVIKING_ACCOUNT_ID,
  importTurnFingerprint,
  normalizeWorkspacePath,
  workspaceUserId,
  type OpenVikingImportActivity,
  type OpenVikingImportTaskDiagnostics,
  type OpenVikingMemoryItem,
  type OpenVikingWorkspace,
} from "../../core/openviking-memory";
import type {
  SearchOptions,
  SessionSearchResult,
  SessionTurnDetail,
  SessionTurnSummary,
} from "../../core/types";
import type {
  AddOpenVikingWorkspaceInput,
  CreateOpenVikingImportTaskInput,
  OpenVikingImportedTurnCheckpoint,
  OpenVikingImportJob,
  OpenVikingImportTask,
  OpenVikingImportTaskTurn,
  OpenVikingSessionCheckpoint,
  UpdateOpenVikingImportJobInput,
} from "../../core/postgres/openviking-memory-repository";
import type {
  OpenVikingClientPort,
  OpenVikingWorkspaceAuth,
  SaveOpenVikingMemoryInput,
} from "./openviking-client";

const execFileAsync = promisify(execFile);
const MAX_TURN_CONTENT = 12_000;
const IMPORT_CONCURRENCY = 2;

export interface OpenVikingDirectoryPreview {
  rootPath: string;
  displayName: string;
  identity: string;
  sessionCount: number;
  existingWorkspaceId: string | null;
  relinkWorkspaceId: string | null;
}

export interface OpenVikingImportSessionPreview {
  sessionKey: string;
  title: string;
  source: SessionSearchResult["source"];
  lastActivityAt: number;
  messageCount: number;
  state: "new" | "changed" | "importing" | "imported";
}

export interface OpenVikingMemoryStorePort {
  listOpenVikingWorkspaces(): Promise<OpenVikingWorkspace[]>;
  getOpenVikingWorkspace(id: string): Promise<OpenVikingWorkspace | null>;
  findOpenVikingWorkspaceByRootPath(rootPath: string): Promise<OpenVikingWorkspace | null>;
  findOpenVikingWorkspaceByIdentity(identity: string): Promise<OpenVikingWorkspace | null>;
  addOpenVikingWorkspace(input: AddOpenVikingWorkspaceInput): Promise<OpenVikingWorkspace>;
  relinkOpenVikingWorkspace(
    id: string,
    rootPath: string,
    displayName: string,
  ): Promise<OpenVikingWorkspace>;
  setOpenVikingWorkspaceManaged(id: string, managed: boolean): Promise<OpenVikingWorkspace>;
  deleteOpenVikingWorkspace(id: string): Promise<boolean>;
  searchSessions(options: SearchOptions): Promise<SessionSearchResult[]>;
  listSessionTurns(sessionKey: string): Promise<SessionTurnSummary[]>;
  getSessionTurn(sessionKey: string, turnId: string): Promise<SessionTurnDetail | null>;
  getOpenVikingImportJob(workspaceId: string): Promise<OpenVikingImportJob | null>;
  setOpenVikingImportSelection(
    workspaceId: string,
    sessionKeys: string[],
  ): Promise<OpenVikingImportJob>;
  updateOpenVikingImportJob(
    workspaceId: string,
    input: UpdateOpenVikingImportJobInput,
  ): Promise<OpenVikingImportJob>;
  hasOpenVikingImportedTurn(
    workspaceId: string,
    sourceTurnId: string,
    fingerprint: string,
  ): Promise<boolean>;
  listOpenVikingImportedTurns(
    workspaceId: string,
  ): Promise<OpenVikingImportedTurnCheckpoint[]>;
  recordOpenVikingImportedTurn(
    workspaceId: string,
    sourceTurnId: string,
    fingerprint: string,
  ): Promise<void>;
  listOpenVikingSessionCheckpoints(
    workspaceId: string,
  ): Promise<OpenVikingSessionCheckpoint[]>;
  recordOpenVikingSessionCheckpoint(
    workspaceId: string,
    sessionKey: string,
    sourceRevision: string,
    importedTurns: number,
  ): Promise<void>;
  syncOpenVikingImportTasks(
    workspaceId: string,
    inputs: CreateOpenVikingImportTaskInput[],
    activeRevisions: Array<{ sessionKey: string; sourceRevision: string }>,
  ): Promise<OpenVikingImportTask[]>;
  listOpenVikingImportTasks(workspaceId: string): Promise<OpenVikingImportTask[]>;
  beginOpenVikingImportTaskAttempt(taskId: string): Promise<OpenVikingImportTask>;
  waitForOpenVikingImportTask(taskId: string, remoteTaskId: string): Promise<void>;
  completeOpenVikingImportTask(taskId: string): Promise<void>;
  failOpenVikingImportTask(taskId: string, error: string): Promise<void>;
}

export interface OpenVikingCredentialStorePort {
  get(workspaceId: string): Promise<OpenVikingWorkspaceAuth | null>;
  set(workspaceId: string, auth: OpenVikingWorkspaceAuth): Promise<void>;
  delete(workspaceId: string): Promise<void>;
}

interface OpenVikingMemoryServiceOptions {
  store: OpenVikingMemoryStorePort;
  client: OpenVikingClientPort;
  credentials: OpenVikingCredentialStorePort;
  inspectDirectory?: (rootPath: string) => Promise<string>;
  resolveIdentity?: (rootPath: string) => Promise<string>;
  createId?: () => string;
  sleep?: (durationMs: number) => Promise<void>;
}

interface ImportCandidate {
  session: SessionSearchResult;
  summary: SessionTurnSummary;
  detail: SessionTurnDetail;
  user: string;
  assistant: string;
  fingerprint: string;
  sourceTurnId: string;
}

export class OpenVikingMemoryService {
  private readonly inspectDirectory: NonNullable<OpenVikingMemoryServiceOptions["inspectDirectory"]>;
  private readonly resolveIdentity: NonNullable<OpenVikingMemoryServiceOptions["resolveIdentity"]>;
  private readonly createId: NonNullable<OpenVikingMemoryServiceOptions["createId"]>;
  private readonly sleep: NonNullable<OpenVikingMemoryServiceOptions["sleep"]>;
  private readonly activeImports = new Map<string, Promise<OpenVikingImportJob>>();
  private readonly followUpImports = new Map<string, Promise<OpenVikingImportJob>>();
  private readonly selectionWrites = new Map<string, Promise<OpenVikingImportJob>>();
  private readonly importActivities = new Map<string, OpenVikingImportActivity>();

  constructor(private readonly options: OpenVikingMemoryServiceOptions) {
    this.inspectDirectory = options.inspectDirectory ?? inspectDirectory;
    this.resolveIdentity = options.resolveIdentity ?? ((rootPath) => resolveDirectoryIdentity(rootPath));
    this.createId = options.createId ?? randomUUID;
    this.sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  }

  async listWorkspaces(): Promise<OpenVikingWorkspace[]> {
    const workspaces = await this.options.store.listOpenVikingWorkspaces();
    return workspaces.map((workspace) => {
      const importActivity = this.importActivities.get(workspace.id);
      return importActivity ? { ...workspace, importActivity } : workspace;
    });
  }

  async listImportTaskDiagnostics(queryRemote: boolean): Promise<OpenVikingImportTaskDiagnostics[]> {
    const workspaces = await this.options.store.listOpenVikingWorkspaces();
    const tasks = (await Promise.all(
      workspaces.map((workspace) => this.options.store.listOpenVikingImportTasks(workspace.id)),
    ))
      .flat()
      .sort((left, right) => {
        const activeDifference = Number(isActiveImportTask(right.state))
          - Number(isActiveImportTask(left.state));
        return activeDifference || right.updatedAt.localeCompare(left.updatedAt);
      })
      .slice(0, 200);

    return Promise.all(tasks.map(async (task) => {
      const diagnostic: OpenVikingImportTaskDiagnostics = {
        id: task.id,
        workspaceId: task.workspaceId,
        sessionKey: task.sessionKey,
        sessionTitle: task.sessionTitle,
        position: task.position,
        turnCount: task.payload.primary.length,
        state: task.state,
        attemptCount: task.attemptCount,
        ...(task.remoteTaskId ? { remoteTaskId: task.remoteTaskId } : {}),
        ...(task.lastError ? { lastError: diagnosticMessage(task.lastError) } : {}),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
      if (
        !queryRemote
        || !task.remoteTaskId
        || !isActiveImportTask(task.state)
        || !this.options.client.getTaskIfRunning
      ) return diagnostic;

      const auth = await this.options.credentials.get(task.workspaceId);
      if (!auth) return diagnostic;
      try {
        const remoteTask = await this.options.client.getTaskIfRunning(auth, task.remoteTaskId);
        if (!remoteTask) return diagnostic;
        const remoteState = diagnosticString(remoteTask.status);
        const remoteStage = diagnosticString(remoteTask.stage ?? remoteTask.phase);
        const remoteError = diagnosticString(remoteTask.error);
        return {
          ...diagnostic,
          ...(remoteState ? { remoteState } : {}),
          ...(remoteStage ? { remoteStage } : {}),
          ...(remoteError ? { remoteError } : {}),
        };
      } catch (error) {
        return {
          ...diagnostic,
          remoteError: diagnosticMessage(error instanceof Error ? error.message : String(error)),
        };
      }
    }));
  }

  async previewDirectory(inputPath: string): Promise<OpenVikingDirectoryPreview> {
    const rootPath = normalizeWorkspacePath(await this.inspectDirectory(inputPath));
    const [identity, sessions, existing] = await Promise.all([
      this.resolveIdentity(rootPath),
      this.options.store.searchSessions({
        projectPath: rootPath,
        environmentId: "local",
        limit: 10_000,
        excludeSubagents: true,
        prioritizeFavorites: false,
      }),
      this.options.store.findOpenVikingWorkspaceByRootPath(rootPath),
    ]);
    const identityWorkspace = existing
      ? null
      : await this.options.store.findOpenVikingWorkspaceByIdentity(identity);
    return {
      rootPath,
      displayName: path.basename(rootPath),
      identity,
      sessionCount: sessions.length,
      existingWorkspaceId: existing?.id ?? null,
      relinkWorkspaceId: identityWorkspace?.id ?? null,
    };
  }

  async addWorkspace(inputPath: string): Promise<OpenVikingWorkspace> {
    const preview = await this.previewDirectory(inputPath);
    if (preview.existingWorkspaceId) {
      const existing = await this.options.store.getOpenVikingWorkspace(preview.existingWorkspaceId);
      if (!existing) throw new Error("Retained OpenViking workspace was not found.");
      if (existing.managed) {
        throw new Error(`Directory is already managed by workspace ${preview.existingWorkspaceId}.`);
      }
      await this.requireAuth(existing);
      return this.options.store.setOpenVikingWorkspaceManaged(existing.id, true);
    }
    if (preview.relinkWorkspaceId) {
      const relinked = await this.options.store.relinkOpenVikingWorkspace(
        preview.relinkWorkspaceId,
        preview.rootPath,
        preview.displayName,
      );
      await this.requireAuth(relinked);
      return relinked.managed
        ? relinked
        : this.options.store.setOpenVikingWorkspaceManaged(relinked.id, true);
    }
    const id = this.createId();
    const userId = workspaceUserId(preview.identity);
    const auth = await this.options.client.ensureWorkspaceUser({
      accountId: OPENVIKING_ACCOUNT_ID,
      userId,
    });
    await this.options.credentials.set(id, auth);
    try {
      return await this.options.store.addOpenVikingWorkspace({
        id,
        userId,
        rootPath: preview.rootPath,
        identity: preview.identity,
        displayName: preview.displayName,
      });
    } catch (error) {
      await this.options.credentials.delete(id);
      await this.options.client.deleteWorkspaceUser(auth).catch(() => undefined);
      throw error;
    }
  }

  async listImportSessions(workspaceId: string): Promise<OpenVikingImportSessionPreview[]> {
    const workspace = await this.requireWorkspace(workspaceId);
    const [sessions, checkpoints, job] = await Promise.all([
      this.options.store.searchSessions({
        projectPath: workspace.rootPath,
        environmentId: "local",
        limit: 10_000,
        excludeSubagents: true,
        sortBy: "activity",
        prioritizeFavorites: false,
      }),
      this.options.store.listOpenVikingSessionCheckpoints(workspaceId),
      this.options.store.getOpenVikingImportJob(workspaceId),
    ]);
    const checkpointBySession = new Map(
      checkpoints.map((checkpoint) => [checkpoint.sessionKey, checkpoint]),
    );
    const importingSessionKeys = new Set(
      job && ["queued", "running", "paused"].includes(job.state)
        ? job.selectedSessionKeys ?? []
        : [],
    );
    return sessions.map((session) => {
      const checkpoint = checkpointBySession.get(session.sessionKey);
      const imported = checkpoint?.sourceRevision === sessionImportRevision(session);
      return {
        sessionKey: session.sessionKey,
        title: session.displayTitle,
        source: session.source,
        lastActivityAt: session.lastActivityAt,
        messageCount: session.messageCount,
        state: imported
          ? "imported"
          : importingSessionKeys.has(session.sessionKey)
            ? "importing"
            : checkpoint
              ? "changed"
              : "new",
      };
    });
  }

  importWorkspace(
    workspaceId: string,
    selectedSessionKeys?: string[],
  ): Promise<OpenVikingImportJob> {
    const existing = this.activeImports.get(workspaceId);
    if (existing) {
      if (selectedSessionKeys === undefined) return existing;
      const selectionWrite = this.mergeImportSelection(workspaceId, selectedSessionKeys);
      const scheduled = this.followUpImports.get(workspaceId);
      if (scheduled) return selectionWrite.then(() => scheduled);
      const followUp = (async () => {
        await selectionWrite;
        const current = await existing;
        const latestSelectionWrite = this.selectionWrites.get(workspaceId);
        if (latestSelectionWrite) await latestSelectionWrite;
        const latest = await this.requireImportJob(workspaceId);
        if (current.state === "paused" || latest.state === "paused") return latest;
        if (this.activeImports.get(workspaceId) === existing) {
          this.activeImports.delete(workspaceId);
        }
        return this.importWorkspace(workspaceId);
      })();
      this.followUpImports.set(workspaceId, followUp);
      const clearFollowUp = () => {
        if (this.followUpImports.get(workspaceId) === followUp) {
          this.followUpImports.delete(workspaceId);
        }
      };
      void followUp.then(clearFollowUp, clearFollowUp);
      return followUp;
    }
    const pending = this.performImportWorkspace(workspaceId, selectedSessionKeys);
    this.activeImports.set(workspaceId, pending);
    const clear = () => {
      if (this.activeImports.get(workspaceId) === pending) {
        this.activeImports.delete(workspaceId);
        this.importActivities.delete(workspaceId);
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async performImportWorkspace(
    workspaceId: string,
    selectedSessionKeys?: string[],
  ): Promise<OpenVikingImportJob> {
    const workspace = await this.requireWorkspace(workspaceId);
    if (selectedSessionKeys !== undefined) {
      await this.mergeImportSelection(workspaceId, selectedSessionKeys);
    }
    const existingJob = await this.options.store.getOpenVikingImportJob(workspaceId);
    if (existingJob?.state === "paused") return existingJob;
    if (existingJob && existingJob.state !== "running") {
      await this.options.store.updateOpenVikingImportJob(workspaceId, {
        state: "running",
        importedTurns: existingJob.importedTurns,
        totalTurns: existingJob.totalTurns,
        cursorSessionKey: existingJob.cursorSessionKey,
        lastError: null,
      });
    }
    const auth = await this.requireAuth(workspace);
    try {
      const settled = await this.settleDispatchedTasks(workspaceId, auth);
      if (!settled) return this.requireImportJob(workspaceId);
    } catch (error) {
      await this.options.store.updateOpenVikingImportJob(workspaceId, {
        state: "failed",
        importedTurns: existingJob?.importedTurns ?? 0,
        totalTurns: existingJob?.totalTurns ?? 0,
        cursorSessionKey: existingJob?.cursorSessionKey ?? null,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.importActivities.set(workspaceId, { phase: "scanning" });
    const discoveredSessions = await this.options.store.searchSessions({
      projectPath: workspace.rootPath,
      environmentId: "local",
      limit: 10_000,
      excludeSubagents: true,
      sortBy: "created",
      prioritizeFavorites: false,
    });
    const selectedSessionKeySet = existingJob?.selectedSessionKeys
      ? new Set(existingJob.selectedSessionKeys)
      : null;
    const sessions = selectedSessionKeySet
      ? discoveredSessions.filter((session) => selectedSessionKeySet.has(session.sessionKey))
      : discoveredSessions;
    if (selectedSessionKeySet && sessions.length === 0) {
      throw new Error("The selected sessions are no longer available in this directory.");
    }
    const sessionCheckpoints = await this.options.store.listOpenVikingSessionCheckpoints(workspaceId);
    const checkpointBySession = new Map(
      sessionCheckpoints.map((checkpoint) => [checkpoint.sessionKey, checkpoint]),
    );
    const revisionBySession = new Map(
      sessions.map((session) => [session.sessionKey, sessionImportRevision(session)]),
    );
    const changedSessions = sessions.filter((session) =>
      checkpointBySession.get(session.sessionKey)?.sourceRevision
        !== revisionBySession.get(session.sessionKey));
    const candidates = await this.collectCandidates(changedSessions);
    const candidatesBySession = new Map<string, ImportCandidate[]>();
    for (const candidate of candidates) {
      const entries = candidatesBySession.get(candidate.session.sessionKey) ?? [];
      entries.push(candidate);
      candidatesBySession.set(candidate.session.sessionKey, entries);
    }
    const importedTurnCheckpoints = await this.options.store.listOpenVikingImportedTurns(workspaceId);
    const importedCandidates = new Set(
      importedTurnCheckpoints.map((checkpoint) =>
        importedTurnCheckpointKey(checkpoint.sourceTurnId, checkpoint.fingerprint)),
    );
    const unchangedTurns = sessionCheckpoints.reduce((total, checkpoint) =>
      checkpoint.sourceRevision === revisionBySession.get(checkpoint.sessionKey)
        ? total + checkpoint.importedTurns
        : total, 0);
    let importedTurns = unchangedTurns + candidates.filter((candidate) =>
      importedCandidates.has(importedTurnCheckpointKey(candidate.sourceTurnId, candidate.fingerprint))).length;
    const totalTurns = unchangedTurns + candidates.length;
    let currentSession = existingJob?.cursorSessionKey ?? null;
    await this.options.store.updateOpenVikingImportJob(workspaceId, {
      state: "running",
      importedTurns,
      totalTurns,
      cursorSessionKey: currentSession,
      lastError: null,
    });
    const taskInputs: CreateOpenVikingImportTaskInput[] = [];
    for (const session of changedSessions) {
      const sourceRevision = revisionBySession.get(session.sessionKey)!;
      const primary = (candidatesBySession.get(session.sessionKey) ?? [])
        .filter((candidate) => !importedCandidates.has(
          importedTurnCheckpointKey(candidate.sourceTurnId, candidate.fingerprint),
        ));
      if (primary.length === 0) continue;
      taskInputs.push({
        id: deterministicImportTaskId(
          workspaceId,
          session.sessionKey,
          sourceRevision,
          primary,
        ),
        position: taskInputs.length,
        workspaceId,
        sessionKey: session.sessionKey,
        sourceRevision,
        sessionTitle: session.displayTitle,
        payload: {
          context: [],
          primary: primary.map(importTaskTurn),
          keepRecentCount: 0,
        },
      });
    }
    const tasks = await this.options.store.syncOpenVikingImportTasks(
      workspaceId,
      taskInputs,
      changedSessions.map((session) => ({
        sessionKey: session.sessionKey,
        sourceRevision: revisionBySession.get(session.sessionKey)!,
      })),
    );
    const taskPosition = new Map(tasks.map((task, index) => [task.id, index + 1]));
    const sessionPosition = new Map(
      changedSessions.map((session, index) => [session.sessionKey, index + 1]),
    );
    let progressWrites = Promise.resolve();
    const persistProgress = (sessionKey: string) => {
      progressWrites = progressWrites.then(async () => {
        importedTurns = unchangedTurns + candidates.filter((candidate) =>
          importedCandidates.has(importedTurnCheckpointKey(
            candidate.sourceTurnId,
            candidate.fingerprint,
          ))).length;
        await this.options.store.updateOpenVikingImportJob(workspaceId, {
          state: "running",
          importedTurns,
          totalTurns,
          cursorSessionKey: sessionKey,
          lastError: null,
        });
      });
      return progressWrites;
    };
    try {
      const taskGroups = new Map<string, OpenVikingImportTask[]>();
      for (const task of tasks) {
        const group = taskGroups.get(task.sessionKey) ?? [];
        group.push(task);
        taskGroups.set(task.sessionKey, group);
      }
      const groups = [...taskGroups.values()];
      let nextGroup = 0;
      let firstError: unknown;
      const workers = Array.from(
        { length: Math.min(IMPORT_CONCURRENCY, Math.max(1, groups.length)) },
        async () => {
          while (nextGroup < groups.length && !firstError) {
            const group = groups[nextGroup++];
            for (const [batchIndex, task] of group.entries()) {
              if (firstError) return;
              if (task.state === "completed") {
                for (const turn of task.payload.primary) {
                  importedCandidates.add(importedTurnCheckpointKey(turn.sourceTurnId, turn.fingerprint));
                }
                continue;
              }
              currentSession = task.sessionKey;
              try {
                const completed = await this.runImportTask(
                  workspaceId,
                  auth,
                  task,
                  taskPosition.get(task.id) ?? 1,
                  tasks.length,
                  sessionPosition.get(task.sessionKey) ?? 1,
                  changedSessions.length,
                  batchIndex + 1,
                  group.length,
                );
                if (!completed) return;
                for (const turn of task.payload.primary) {
                  importedCandidates.add(importedTurnCheckpointKey(turn.sourceTurnId, turn.fingerprint));
                }
                await persistProgress(task.sessionKey);
              } catch (error) {
                if ((await this.requireImportJob(workspaceId)).state === "paused") return;
                firstError ??= error;
                await this.options.store.failOpenVikingImportTask(
                  task.id,
                  error instanceof Error ? error.message : String(error),
                );
                return;
              }
            }
          }
        },
      );
      await Promise.all(workers);
      await progressWrites;
      if (firstError) throw firstError;
      for (const session of changedSessions) {
        const sessionCandidates = candidatesBySession.get(session.sessionKey) ?? [];
        if (!sessionCandidates.every((candidate) => importedCandidates.has(
          importedTurnCheckpointKey(candidate.sourceTurnId, candidate.fingerprint),
        ))) continue;
        await this.options.store.recordOpenVikingSessionCheckpoint(
          workspaceId,
          session.sessionKey,
          revisionBySession.get(session.sessionKey)!,
          sessionCandidates.length,
        );
      }
      const currentJob = await this.requireImportJob(workspaceId);
      if (currentJob.state === "paused") return currentJob;
      return this.options.store.updateOpenVikingImportJob(workspaceId, {
        state: "completed",
        importedTurns,
        totalTurns,
        cursorSessionKey: null,
        lastError: null,
      });
    } catch (error) {
      await this.options.store.updateOpenVikingImportJob(workspaceId, {
        state: "failed",
        importedTurns,
        totalTurns,
        cursorSessionKey: currentSession,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private mergeImportSelection(
    workspaceId: string,
    selectedSessionKeys: string[],
  ): Promise<OpenVikingImportJob> {
    const normalizedSelection = [...new Set(
      selectedSessionKeys.map((key) => key.trim()).filter(Boolean),
    )];
    if (normalizedSelection.length === 0) {
      return Promise.reject(new Error("Select at least one session to import."));
    }
    const previous = this.selectionWrites.get(workspaceId);
    const write = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
      const current = await this.requireImportJob(workspaceId);
      const merged = [...new Set([
        ...(current.selectedSessionKeys ?? []),
        ...normalizedSelection,
      ])];
      return this.options.store.setOpenVikingImportSelection(workspaceId, merged);
    });
    this.selectionWrites.set(workspaceId, write);
    const clear = () => {
      if (this.selectionWrites.get(workspaceId) === write) {
        this.selectionWrites.delete(workspaceId);
      }
    };
    void write.then(clear, clear);
    return write;
  }

  private async settleDispatchedTasks(
    workspaceId: string,
    auth: OpenVikingWorkspaceAuth,
  ): Promise<boolean> {
    const tasks = (await this.options.store.listOpenVikingImportTasks(workspaceId))
      .filter((task) => task.state === "waiting" && task.remoteTaskId);
    const taskGroups = new Map<string, OpenVikingImportTask[]>();
    for (const task of tasks) {
      const group = taskGroups.get(task.sessionKey) ?? [];
      group.push(task);
      taskGroups.set(task.sessionKey, group);
    }
    const groups = [...taskGroups.values()];
    let nextGroup = 0;
    let paused = false;
    let firstError: unknown;
    const workers = Array.from(
      { length: Math.min(IMPORT_CONCURRENCY, groups.length) },
      async () => {
        while (nextGroup < groups.length && !paused && !firstError) {
          const group = groups[nextGroup++];
          for (const [batchIndex, task] of group.entries()) {
            this.importActivities.set(workspaceId, {
              phase: "extracting",
              sessionTitle: task.sessionTitle,
              currentTask: tasks.indexOf(task) + 1,
              totalTasks: tasks.length,
              currentBatch: batchIndex + 1,
              totalBatches: group.length,
            });
            try {
              const result = await this.waitForTask(workspaceId, auth, task.remoteTaskId!);
              if (result === "paused") {
                paused = true;
                return;
              }
              if (result === "completed") {
                await this.options.store.completeOpenVikingImportTask(task.id);
              }
            } catch (error) {
              firstError ??= error;
              return;
            }
          }
        }
      },
    );
    await Promise.all(workers);
    if (firstError) throw firstError;
    return !paused;
  }

  private async runImportTask(
    workspaceId: string,
    auth: OpenVikingWorkspaceAuth,
    task: OpenVikingImportTask,
    currentTask: number,
    totalTasks: number,
    currentSession: number,
    totalSessions: number,
    currentBatch: number,
    totalBatches: number,
  ): Promise<boolean> {
    const activity = (phase: OpenVikingImportActivity["phase"]) => {
      this.importActivities.set(workspaceId, {
        phase,
        sessionTitle: task.sessionTitle,
        currentTask,
        totalTasks,
        currentSession,
        totalSessions,
        currentBatch,
        totalBatches,
      });
    };
    if (task.state === "waiting" && task.remoteTaskId) {
      activity("extracting");
      const resumed = await this.waitForTask(workspaceId, auth, task.remoteTaskId);
      if (resumed === "paused") return false;
      if (resumed === "completed") {
        await this.options.store.completeOpenVikingImportTask(task.id);
        return true;
      }
    }
    if ((await this.requireImportJob(workspaceId)).state === "paused") return false;
    await this.options.store.beginOpenVikingImportTaskAttempt(task.id);
    const importSessionId = deterministicImportSessionId(workspaceId, task.sessionKey);
    activity("uploading");
    for (const turn of [...task.payload.context, ...task.payload.primary]) {
      await this.options.client.appendMessages(auth, importSessionId, [
        {
          role: "user",
          content: turn.user,
          ...(turn.startedAt ? { createdAt: turn.startedAt } : {}),
        },
        {
          role: "assistant",
          content: turn.assistant,
          ...(turn.endedAt ? { createdAt: turn.endedAt } : {}),
        },
      ]);
    }
    activity("extracting");
    const committed = await this.options.client.commitSession(
      auth,
      importSessionId,
      task.payload.keepRecentCount ?? 0,
    );
    await this.options.store.waitForOpenVikingImportTask(task.id, committed.taskId);
    const result = await this.waitForTask(workspaceId, auth, committed.taskId);
    if (result !== "completed") return false;
    await this.options.store.completeOpenVikingImportTask(task.id);
    return true;
  }

  async pauseImport(workspaceId: string): Promise<OpenVikingImportJob> {
    const current = await this.requireImportJob(workspaceId);
    return this.options.store.updateOpenVikingImportJob(workspaceId, {
      state: "paused",
      importedTurns: current.importedTurns,
      totalTurns: current.totalTurns,
      cursorSessionKey: current.cursorSessionKey,
      lastError: current.lastError,
    });
  }

  async waitForImportToSettle(workspaceId: string): Promise<void> {
    for (;;) {
      const pending = [
        this.activeImports.get(workspaceId),
        this.followUpImports.get(workspaceId),
      ].filter((operation): operation is Promise<OpenVikingImportJob> => operation !== undefined);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  async resumeImport(workspaceId: string): Promise<OpenVikingImportJob> {
    await this.waitForImportToSettle(workspaceId);
    const current = await this.requireImportJob(workspaceId);
    const queued = await this.options.store.updateOpenVikingImportJob(workspaceId, {
      state: "queued",
      importedTurns: current.importedTurns,
      totalTurns: current.totalTurns,
      cursorSessionKey: current.cursorSessionKey,
      lastError: null,
    });
    void this.importWorkspace(workspaceId).catch(() => {
      // The import loop persists its failure for the renderer to surface.
    });
    return queued;
  }

  retryImport(workspaceId: string): Promise<OpenVikingImportJob> {
    return this.resumeImport(workspaceId);
  }

  stopManaging(workspaceId: string): Promise<OpenVikingWorkspace> {
    return this.options.store.setOpenVikingWorkspaceManaged(workspaceId, false);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.options.store.getOpenVikingWorkspace(workspaceId);
    if (!workspace) {
      await this.options.credentials.delete(workspaceId);
      return;
    }
    const auth = await this.options.client.ensureWorkspaceUser({
      accountId: OPENVIKING_ACCOUNT_ID,
      userId: workspace.userId,
    });
    await this.options.client.deleteWorkspaceUser(auth);
    await this.options.store.deleteOpenVikingWorkspace(workspaceId);
    await this.options.credentials.delete(workspaceId);
  }

  async searchMemories(
    workspaceId: string,
    query: string,
    limit = 20,
  ): Promise<OpenVikingMemoryItem[]> {
    const workspace = await this.requireWorkspace(workspaceId);
    const memories = await this.options.client.searchMemories(
      await this.requireAuth(workspace),
      query,
      limit,
    );
    return memories.map((memory) => ({ ...memory, workspaceId }));
  }

  async readMemory(workspaceId: string, uri: string): Promise<string> {
    const workspace = await this.requireWorkspace(workspaceId);
    return this.options.client.readMemory(await this.requireAuth(workspace), uri);
  }

  async saveMemory(
    workspaceId: string,
    input: SaveOpenVikingMemoryInput,
  ): Promise<OpenVikingMemoryItem> {
    const workspace = await this.requireWorkspace(workspaceId);
    const saved = await this.options.client.saveMemory(await this.requireAuth(workspace), input);
    return { ...saved, workspaceId };
  }

  async deleteMemory(workspaceId: string, uri: string): Promise<void> {
    const workspace = await this.requireWorkspace(workspaceId);
    await this.options.client.deleteMemory(await this.requireAuth(workspace), uri);
  }

  private async collectCandidates(sessions: SessionSearchResult[]): Promise<ImportCandidate[]> {
    const candidates: ImportCandidate[] = [];
    for (const session of sessions) {
      const turns = await this.options.store.listSessionTurns(session.sessionKey);
      for (const summary of turns) {
        if (summary.synthetic || summary.status !== "completed") continue;
        const turn = await this.options.store.getSessionTurn(session.sessionKey, summary.id);
        if (!turn) continue;
        const user = truncate(turn.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content.trim())
          .filter(Boolean)
          .join("\n\n"));
        const assistant = truncate(turn.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content.trim())
          .filter(Boolean)
          .join("\n\n"));
        if (!user || !assistant) continue;
        const sourceTurnId = `${session.sessionKey}:${summary.turnIndex}`;
        candidates.push({
          session,
          summary,
          detail: turn,
          user,
          assistant,
          sourceTurnId,
          fingerprint: importTurnFingerprint({
            source: session.source,
            sessionId: session.sessionKey,
            turnIndex: summary.turnIndex,
            user,
            assistant,
          }),
        });
      }
    }
    return candidates;
  }

  private async waitForTask(
    workspaceId: string,
    auth: OpenVikingWorkspaceAuth,
    taskId: string,
  ): Promise<"completed" | "paused" | "missing"> {
    for (;;) {
      if ((await this.options.store.getOpenVikingImportJob(workspaceId))?.state === "paused") {
        return "paused";
      }
      const task = await this.options.client.getTask(auth, taskId);
      if (!task) return "missing";
      const status = typeof task?.status === "string" ? task.status.toLowerCase() : "";
      if (["completed", "succeeded", "success", "done"].includes(status)) return "completed";
      if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        const message = typeof task?.error === "string" ? task.error : `OpenViking task ${taskId} ${status}.`;
        throw new Error(message);
      }
      await this.sleep(500);
    }
  }

  private async requireWorkspace(workspaceId: string): Promise<OpenVikingWorkspace> {
    const workspace = await this.options.store.getOpenVikingWorkspace(workspaceId);
    if (!workspace) throw new Error(`OpenViking workspace ${workspaceId} was not found.`);
    return workspace;
  }

  private async requireImportJob(workspaceId: string): Promise<OpenVikingImportJob> {
    const job = await this.options.store.getOpenVikingImportJob(workspaceId);
    if (!job) throw new Error(`OpenViking import job for ${workspaceId} was not found.`);
    return job;
  }

  private async requireAuth(workspace: OpenVikingWorkspace): Promise<OpenVikingWorkspaceAuth> {
    const existing = await this.options.credentials.get(workspace.id);
    if (existing) return existing;
    const created = await this.options.client.ensureWorkspaceUser({
      accountId: OPENVIKING_ACCOUNT_ID,
      userId: workspace.userId,
    });
    await this.options.credentials.set(workspace.id, created);
    return created;
  }
}

function isActiveImportTask(state: OpenVikingImportTask["state"]): boolean {
  return state === "queued" || state === "uploading" || state === "waiting";
}

function diagnosticString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? diagnosticMessage(value)
    : undefined;
}

function diagnosticMessage(message: string): string {
  return message.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function sessionImportRevision(session: SessionSearchResult): string {
  return createHash("sha256")
    .update(JSON.stringify([
      session.source,
      session.sessionKey,
      session.fileMtimeMs,
      session.fileSize,
      session.lastActivityAt,
      session.messageCount,
    ]), "utf8")
    .digest("hex");
}

function importedTurnCheckpointKey(sourceTurnId: string, fingerprint: string): string {
  return `${sourceTurnId}\0${fingerprint}`;
}

export class OpenVikingWorkspaceCredentialStore implements OpenVikingCredentialStorePort {
  private readonly filePath: string;
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.filePath = path.join(path.resolve(rootDir), "workspace-credentials.json");
  }

  async get(workspaceId: string): Promise<OpenVikingWorkspaceAuth | null> {
    await this.updateQueue;
    return (await this.read())[workspaceId] ?? null;
  }

  set(workspaceId: string, auth: OpenVikingWorkspaceAuth): Promise<void> {
    return this.enqueueUpdate(async () => {
      const current = await this.read();
      current[workspaceId] = auth;
      await this.write(current);
    });
  }

  delete(workspaceId: string): Promise<void> {
    return this.enqueueUpdate(async () => {
      const current = await this.read();
      delete current[workspaceId];
      await this.write(current);
    });
  }

  private enqueueUpdate(update: () => Promise<void>): Promise<void> {
    const pending = this.updateQueue.then(update);
    this.updateQueue = pending.catch(() => undefined);
    return pending;
  }

  private async read(): Promise<Record<string, OpenVikingWorkspaceAuth>> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, OpenVikingWorkspaceAuth>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async write(value: Record<string, OpenVikingWorkspaceAuth>): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true });
    }
    await chmod(this.filePath, 0o600);
  }
}

export function deterministicImportSessionId(
  workspaceId: string,
  sessionKey: string,
  chunkAnchor?: string,
): string {
  return `agentrecall_${createHash("sha256")
    .update(`${workspaceId}\0${sessionKey}${chunkAnchor ? `\0${chunkAnchor}` : ""}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function deterministicImportTaskId(
  workspaceId: string,
  sessionKey: string,
  sourceRevision: string,
  primary: ImportCandidate[],
): string {
  return `openviking_task_${createHash("sha256")
    .update(JSON.stringify([
      workspaceId,
      sessionKey,
      sourceRevision,
      primary.map((candidate) => [candidate.sourceTurnId, candidate.fingerprint]),
    ]), "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function importTaskTurn(candidate: ImportCandidate): OpenVikingImportTaskTurn {
  return {
    sourceTurnId: candidate.sourceTurnId,
    fingerprint: candidate.fingerprint,
    user: candidate.user,
    assistant: candidate.assistant,
    ...(candidate.detail.startedAt ? { startedAt: candidate.detail.startedAt } : {}),
    ...(candidate.detail.endedAt ? { endedAt: candidate.detail.endedAt } : {}),
  };
}

export async function resolveDirectoryIdentity(
  rootPath: string,
  options: {
    runGit?: (rootPath: string, args: string[]) => Promise<string>;
    createId?: () => string;
  } = {},
): Promise<string> {
  const runGit = options.runGit ?? runGitCommand;
  try {
    const remote = (await runGit(rootPath, ["config", "--get", "remote.origin.url"])).trim();
    if (remote) return `repo:${normalizeGitRemote(remote)}`;
    const firstCommit = (await runGit(rootPath, ["rev-list", "--max-parents=0", "HEAD"])).trim();
    if (firstCommit) return `repo-commit:${firstCommit}`;
  } catch {
    // Ordinary directories receive an application-persisted UUID.
  }
  return `directory:${(options.createId ?? randomUUID)()}`;
}

async function inspectDirectory(rootPath: string): Promise<string> {
  const resolved = await realpath(normalizeWorkspacePath(rootPath));
  if (!(await stat(resolved)).isDirectory()) throw new Error("OpenViking workspace must be a directory.");
  return resolved;
}

async function runGitCommand(rootPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return result.stdout;
}

function normalizeGitRemote(remote: string): string {
  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/u.exec(remote);
  if (scp && !/^[A-Za-z]:[\\/]/u.test(remote)) {
    return `${scp[1].toLowerCase()}/${stripGitSuffix(scp[2])}`;
  }
  try {
    const url = new URL(remote);
    return `${url.hostname.toLowerCase()}/${stripGitSuffix(url.pathname.replace(/^\/+/u, ""))}`;
  } catch {
    return stripGitSuffix(remote.replaceAll("\\", "/"));
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/\/+$/u, "").replace(/\.git$/iu, "");
}

function truncate(value: string): string {
  return value.length > MAX_TURN_CONTENT ? value.slice(0, MAX_TURN_CONTENT) : value;
}
