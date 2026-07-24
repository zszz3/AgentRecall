import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
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
  OpenVikingImportJob,
  UpdateOpenVikingImportJobInput,
} from "../../core/postgres/openviking-memory-repository";
import type {
  OpenVikingClientPort,
  OpenVikingWorkspaceAuth,
  SaveOpenVikingMemoryInput,
} from "./openviking-client";

const execFileAsync = promisify(execFile);
const MAX_TURN_CONTENT = 12_000;
const MAX_TASK_POLLS = 1_200;

export interface OpenVikingDirectoryPreview {
  rootPath: string;
  displayName: string;
  identity: string;
  sessionCount: number;
  existingWorkspaceId: string | null;
  relinkWorkspaceId: string | null;
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
  updateOpenVikingImportJob(
    workspaceId: string,
    input: UpdateOpenVikingImportJobInput,
  ): Promise<OpenVikingImportJob>;
  hasOpenVikingImportedTurn(
    workspaceId: string,
    sourceTurnId: string,
    fingerprint: string,
  ): Promise<boolean>;
  recordOpenVikingImportedTurn(
    workspaceId: string,
    sourceTurnId: string,
    fingerprint: string,
  ): Promise<void>;
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

  constructor(private readonly options: OpenVikingMemoryServiceOptions) {
    this.inspectDirectory = options.inspectDirectory ?? inspectDirectory;
    this.resolveIdentity = options.resolveIdentity ?? ((rootPath) => resolveDirectoryIdentity(rootPath));
    this.createId = options.createId ?? randomUUID;
    this.sleep = options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  }

  listWorkspaces(): Promise<OpenVikingWorkspace[]> {
    return this.options.store.listOpenVikingWorkspaces();
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
        prioritizePinned: false,
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
      await this.options.client.deleteWorkspaceUser(OPENVIKING_ACCOUNT_ID, userId).catch(() => undefined);
      throw error;
    }
  }

  async importWorkspace(workspaceId: string): Promise<OpenVikingImportJob> {
    const workspace = await this.requireWorkspace(workspaceId);
    const existingJob = await this.options.store.getOpenVikingImportJob(workspaceId);
    if (existingJob?.state === "paused") return existingJob;
    const auth = await this.requireAuth(workspace);
    const sessions = await this.options.store.searchSessions({
      projectPath: workspace.rootPath,
      environmentId: "local",
      limit: 10_000,
      excludeSubagents: true,
      sortBy: "created",
      prioritizePinned: false,
    });
    const candidates = await this.collectCandidates(sessions);
    let importedTurns = Math.min(existingJob?.importedTurns ?? 0, candidates.length);
    let currentSession = existingJob?.cursorSessionKey ?? null;
    await this.options.store.updateOpenVikingImportJob(workspaceId, {
      state: "running",
      importedTurns,
      totalTurns: candidates.length,
      cursorSessionKey: currentSession,
      lastError: null,
    });
    try {
      for (const session of sessions) {
        const sessionCandidates = candidates.filter((candidate) => candidate.session.sessionKey === session.sessionKey);
        let appended = false;
        currentSession = session.sessionKey;
        for (const candidate of sessionCandidates) {
          const currentJob = await this.options.store.getOpenVikingImportJob(workspaceId);
          if (currentJob?.state === "paused") return currentJob;
          if (await this.options.store.hasOpenVikingImportedTurn(
            workspaceId,
            candidate.sourceTurnId,
            candidate.fingerprint,
          )) {
            continue;
          }
          await this.options.client.appendMessages(
            auth,
            deterministicImportSessionId(workspaceId, session.sessionKey),
            [
              {
                role: "user",
                content: candidate.user,
                ...(candidate.detail.startedAt ? { createdAt: candidate.detail.startedAt } : {}),
              },
              {
                role: "assistant",
                content: candidate.assistant,
                ...(candidate.detail.endedAt ? { createdAt: candidate.detail.endedAt } : {}),
              },
            ],
          );
          await this.options.store.recordOpenVikingImportedTurn(
            workspaceId,
            candidate.sourceTurnId,
            candidate.fingerprint,
          );
          appended = true;
          importedTurns += 1;
          await this.options.store.updateOpenVikingImportJob(workspaceId, {
            state: "running",
            importedTurns,
            totalTurns: candidates.length,
            cursorSessionKey: currentSession,
            lastError: null,
          });
        }
        if (appended) {
          const task = await this.options.client.commitSession(
            auth,
            deterministicImportSessionId(workspaceId, session.sessionKey),
          );
          await this.waitForTask(auth, task.taskId);
        }
      }
      return this.options.store.updateOpenVikingImportJob(workspaceId, {
        state: "completed",
        importedTurns,
        totalTurns: candidates.length,
        cursorSessionKey: null,
        lastError: null,
      });
    } catch (error) {
      await this.options.store.updateOpenVikingImportJob(workspaceId, {
        state: "failed",
        importedTurns,
        totalTurns: candidates.length,
        cursorSessionKey: currentSession,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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

  async resumeImport(workspaceId: string): Promise<OpenVikingImportJob> {
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
    const workspace = await this.requireWorkspace(workspaceId);
    await this.options.client.deleteWorkspaceUser(OPENVIKING_ACCOUNT_ID, workspace.userId);
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

  private async waitForTask(auth: OpenVikingWorkspaceAuth, taskId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_TASK_POLLS; attempt += 1) {
      const task = await this.options.client.getTask(auth, taskId);
      const status = typeof task?.status === "string" ? task.status.toLowerCase() : "";
      if (["completed", "succeeded", "success", "done"].includes(status)) return;
      if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        const message = typeof task?.error === "string" ? task.error : `OpenViking task ${taskId} ${status}.`;
        throw new Error(message);
      }
      await this.sleep(500);
    }
    throw new Error(`OpenViking task ${taskId} did not finish in time.`);
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

export class OpenVikingWorkspaceCredentialStore implements OpenVikingCredentialStorePort {
  private readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(path.resolve(rootDir), "workspace-credentials.json");
  }

  async get(workspaceId: string): Promise<OpenVikingWorkspaceAuth | null> {
    return (await this.read())[workspaceId] ?? null;
  }

  async set(workspaceId: string, auth: OpenVikingWorkspaceAuth): Promise<void> {
    const current = await this.read();
    current[workspaceId] = auth;
    await this.write(current);
  }

  async delete(workspaceId: string): Promise<void> {
    const current = await this.read();
    delete current[workspaceId];
    await this.write(current);
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
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

export function deterministicImportSessionId(workspaceId: string, sessionKey: string): string {
  return `agentrecall_${createHash("sha256")
    .update(`${workspaceId}\0${sessionKey}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
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
