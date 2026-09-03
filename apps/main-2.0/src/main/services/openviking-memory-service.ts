import { randomUUID } from "node:crypto";
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
  canonicalOpenVikingMemoryUri,
  normalizeWorkspacePath,
  workspaceUserId,
  type OpenVikingMemoryItem,
  type OpenVikingWorkspace,
} from "../../core/openviking-memory";
import {
  defaultOpenVikingMemoryControl,
  type OpenVikingMemoryControl,
  type OpenVikingMemoryDetails,
  type OpenVikingMemoryEvidence,
  type OpenVikingMemoryFeedback,
  type OpenVikingMemoryFeedbackKind,
  type OpenVikingMemoryChange,
  type OpenVikingOperationEvent,
} from "../../core/openviking-memory-control";
import { parseOpenVikingMemoryDiff } from "../../core/openviking-memory-diff";
import type {
  AddOpenVikingWorkspaceInput,
  RecordOpenVikingMemoryFeedbackInput,
  SaveOpenVikingMemoryControlInput,
} from "../../core/postgres/openviking-memory-repository";
import type {
  OpenVikingClientPort,
  OpenVikingWorkspaceAuth,
  SaveOpenVikingMemoryInput,
} from "./openviking-client";

const execFileAsync = promisify(execFile);

export interface OpenVikingDirectoryPreview {
  rootPath: string;
  displayName: string;
  identity: string;
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
  listOpenVikingMemoryControls(workspaceId: string): Promise<OpenVikingMemoryControl[]>;
  getOpenVikingMemoryControl(workspaceId: string, uri: string): Promise<OpenVikingMemoryControl | null>;
  saveOpenVikingUserMemory(input: SaveOpenVikingMemoryControlInput): Promise<OpenVikingMemoryControl>;
  markOpenVikingMemoryDeleted(workspaceId: string, uri: string): Promise<void>;
  listOpenVikingMemoryEvidence(workspaceId: string, uri: string): Promise<OpenVikingMemoryEvidence[]>;
  listOpenVikingMemoryFeedback(workspaceId: string, uri: string): Promise<OpenVikingMemoryFeedback[]>;
  recordOpenVikingMemoryFeedback(
    input: RecordOpenVikingMemoryFeedbackInput,
  ): Promise<OpenVikingMemoryControl>;
  recordOpenVikingOperationEvent(event: OpenVikingOperationEvent): Promise<void>;
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
}

export class OpenVikingMemoryService {
  private readonly inspectDirectory: NonNullable<OpenVikingMemoryServiceOptions["inspectDirectory"]>;
  private readonly resolveIdentity: NonNullable<OpenVikingMemoryServiceOptions["resolveIdentity"]>;
  private readonly createId: NonNullable<OpenVikingMemoryServiceOptions["createId"]>;
  private workspaceMutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: OpenVikingMemoryServiceOptions) {
    this.inspectDirectory = options.inspectDirectory ?? inspectDirectory;
    this.resolveIdentity = options.resolveIdentity ?? ((rootPath) => resolveDirectoryIdentity(rootPath));
    this.createId = options.createId ?? randomUUID;
  }

  listWorkspaces(): Promise<OpenVikingWorkspace[]> {
    return this.options.store.listOpenVikingWorkspaces();
  }

  async previewDirectory(inputPath: string): Promise<OpenVikingDirectoryPreview> {
    const rootPath = normalizeWorkspacePath(await this.inspectDirectory(inputPath));
    const [identity, existing] = await Promise.all([
      this.resolveIdentity(rootPath),
      this.options.store.findOpenVikingWorkspaceByRootPath(rootPath),
    ]);
    const identityWorkspace = existing
      ? null
      : await this.options.store.findOpenVikingWorkspaceByIdentity(identity);
    return {
      rootPath,
      displayName: path.basename(rootPath),
      identity,
      existingWorkspaceId: existing?.id ?? null,
      relinkWorkspaceId: identityWorkspace?.id ?? null,
    };
  }

  addWorkspace(inputPath: string): Promise<OpenVikingWorkspace> {
    return this.runWorkspaceMutation(async () => {
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
    });
  }

  stopManaging(workspaceId: string): Promise<OpenVikingWorkspace> {
    return this.runWorkspaceMutation(
      () => this.options.store.setOpenVikingWorkspaceManaged(workspaceId, false),
    );
  }

  deleteWorkspace(workspaceId: string): Promise<void> {
    return this.runWorkspaceMutation(async () => {
      const workspace = await this.options.store.getOpenVikingWorkspace(workspaceId);
      if (!workspace) {
        await this.options.credentials.delete(workspaceId);
        return;
      }
      const auth = await this.requireAuth(workspace);
      await this.options.client.deleteWorkspaceUser(auth);
      await this.options.store.deleteOpenVikingWorkspace(workspaceId);
      await this.options.credentials.delete(workspaceId);
    });
  }

  async searchMemories(
    workspaceId: string,
    query: string,
    limit?: number,
  ): Promise<OpenVikingMemoryItem[]> {
    const details: Record<string, unknown> = {
      source: "memory-page",
      userQuery: query,
      contextualQuery: query,
      searchedScopes: [workspaceId],
      targetUri: "viking://user/memories",
      limit: limit ?? 20,
    };
    return this.runObserved(workspaceId, "search", async () => {
      const workspace = await this.requireWorkspace(workspaceId);
      const [memories, controls] = await Promise.all([
        this.options.client.searchMemories(
          await this.requireAuth(workspace),
          query,
          limit,
        ),
        this.options.store.listOpenVikingMemoryControls(workspaceId),
      ]);
      const controlsByUri = new Map(controls.map((control) => [control.uri, control]));
      const results = memories.map((memory) => withControl(
        { ...memory, workspaceId },
        controlsByUri.get(memory.id) ?? defaultOpenVikingMemoryControl(workspaceId, memory.id),
      ));
      details.candidateCount = memories.length;
      details.returnedCount = results.length;
      details.searchedTypes = [...new Set(results.map((memory) => memory.memoryType))];
      return results;
    }, details);
  }

  async readMemory(workspaceId: string, uri: string): Promise<string> {
    return this.runObserved(workspaceId, "read", async () => {
      const workspace = await this.requireWorkspace(workspaceId);
      const memoryUri = canonicalOpenVikingMemoryUri(uri, workspace.userId);
      const control = await this.options.store.getOpenVikingMemoryControl(workspaceId, memoryUri);
      if (control?.locked && control.lockedContent !== undefined) return control.lockedContent;
      return this.options.client.readMemory(await this.requireAuth(workspace), memoryUri);
    }, { uri: canonicalOpenVikingMemoryUri(uri) });
  }

  async readCommitChanges(
    workspaceId: string,
    memoryDiffUri: string,
  ): Promise<OpenVikingMemoryChange[]> {
    const workspace = await this.requireWorkspace(workspaceId);
    const content = await this.options.client.readSessionArtifact(
      await this.requireAuth(workspace),
      memoryDiffUri,
    );
    return parseOpenVikingMemoryDiff(content, workspace.userId);
  }

  async saveMemory(
    workspaceId: string,
    input: SaveOpenVikingMemoryInput,
  ): Promise<OpenVikingMemoryItem> {
    return this.runObserved(workspaceId, "save", async () => {
      const workspace = await this.requireWorkspace(workspaceId);
      const memoryUri = input.uri
        ? canonicalOpenVikingMemoryUri(input.uri, workspace.userId)
        : undefined;
      const existing = memoryUri
        ? await this.options.store.getOpenVikingMemoryControl(workspaceId, memoryUri)
        : null;
      const saved = await this.options.client.saveMemory(await this.requireAuth(workspace), {
        ...input,
        ...(memoryUri ? { uri: memoryUri } : {}),
      });
      const control = await this.options.store.saveOpenVikingUserMemory({
        workspaceId,
        uri: saved.id,
        title: input.title.trim(),
        content: input.content,
        source: existing || (memoryUri && !/\/manual\//u.test(memoryUri)) ? "user-edit" : "manual",
      });
      return withControl({ ...saved, workspaceId }, control);
    }, { uri: input.uri ?? null, contentChars: input.content.length });
  }

  async deleteMemory(workspaceId: string, uri: string): Promise<void> {
    await this.runObserved(workspaceId, "delete", async () => {
      const workspace = await this.requireWorkspace(workspaceId);
      const memoryUri = canonicalOpenVikingMemoryUri(uri, workspace.userId);
      await this.options.client.deleteMemory(await this.requireAuth(workspace), memoryUri);
      await this.options.store.markOpenVikingMemoryDeleted(workspaceId, memoryUri);
    }, { uri: canonicalOpenVikingMemoryUri(uri) });
  }

  async memoryDetails(workspaceId: string, uri: string): Promise<OpenVikingMemoryDetails> {
    const workspace = await this.requireWorkspace(workspaceId);
    const memoryUri = canonicalOpenVikingMemoryUri(uri, workspace.userId);
    const [control, evidence, feedback] = await Promise.all([
      this.options.store.getOpenVikingMemoryControl(workspaceId, memoryUri),
      this.options.store.listOpenVikingMemoryEvidence(workspaceId, memoryUri),
      this.options.store.listOpenVikingMemoryFeedback(workspaceId, memoryUri),
    ]);
    return {
      control: control ?? {
        ...defaultOpenVikingMemoryControl(workspaceId, memoryUri),
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      evidence,
      feedback,
    };
  }

  async feedback(
    workspaceId: string,
    uri: string,
    feedback: OpenVikingMemoryFeedbackKind,
    actor = "user",
    note?: string,
  ): Promise<OpenVikingMemoryControl> {
    return this.runObserved(workspaceId, "feedback", async () => {
      const workspace = await this.requireWorkspace(workspaceId);
      const memoryUri = canonicalOpenVikingMemoryUri(uri, workspace.userId);
      return this.options.store.recordOpenVikingMemoryFeedback({
        id: randomUUID(),
        workspaceId,
        memoryUri,
        feedback,
        actor,
        ...(note?.trim() ? { note: note.trim() } : {}),
        createdAt: new Date().toISOString(),
      });
    }, { uri: canonicalOpenVikingMemoryUri(uri), feedback, actor });
  }

  private async requireWorkspace(workspaceId: string): Promise<OpenVikingWorkspace> {
    const workspace = await this.options.store.getOpenVikingWorkspace(workspaceId);
    if (!workspace) throw new Error(`OpenViking workspace ${workspaceId} was not found.`);
    return workspace;
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

  private runWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.workspaceMutationQueue.then(operation);
    this.workspaceMutationQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async runObserved<T>(
    workspaceId: string,
    phase: string,
    operation: () => Promise<T>,
    details?: Record<string, unknown>,
  ): Promise<T> {
    const id = randomUUID();
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      const completed = Date.now();
      await this.options.store.recordOpenVikingOperationEvent({
        id,
        workspaceId,
        phase,
        status: "failed",
        startedAt,
        completedAt: new Date(completed).toISOString(),
        durationMs: completed - started,
        details: {
          ...details,
          error: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => undefined);
      throw error;
    }
    const completed = Date.now();
    await this.options.store.recordOpenVikingOperationEvent({
      id,
      workspaceId,
      phase,
      status: "completed",
      startedAt,
      completedAt: new Date(completed).toISOString(),
      durationMs: completed - started,
      ...(details ? { details } : {}),
    }).catch(() => undefined);
    return value;
  }
}

function withControl(
  memory: OpenVikingMemoryItem,
  control: Pick<
    OpenVikingMemoryControl,
    | "memoryType"
    | "authority"
    | "lifecycle"
    | "locked"
    | "evidenceStatus"
    | "evidenceCount"
    | "title"
    | "lockedContent"
  >,
): OpenVikingMemoryItem {
  return {
    ...memory,
    ...(control.title ? { title: control.title } : {}),
    ...(control.locked && control.lockedContent !== undefined
      ? { content: control.lockedContent }
      : {}),
    memoryType: control.memoryType,
    authority: control.authority,
    lifecycle: control.lifecycle,
    locked: control.locked,
    evidenceStatus: control.evidenceStatus,
    evidenceCount: control.evidenceCount,
  };
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
  } catch {
    // A repository without origin makes `git config --get` exit non-zero.
  }
  try {
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
  try {
    const url = new URL(remote);
    if (!url.hostname) throw new Error("Git remote URL does not have a network host.");
    return `${url.hostname.toLowerCase()}/${stripGitSuffix(url.pathname.replace(/^\/+/u, ""))}`;
  } catch {
    const scp = /^(?:[^@]+@)?([^:]+):(.+)$/u.exec(remote);
    if (scp && !/^[A-Za-z]:[\\/]/u.test(remote)) {
      return `${scp[1].toLowerCase()}/${stripGitSuffix(scp[2])}`;
    }
    return stripGitSuffix(remote.replaceAll("\\", "/"));
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/\/+$/u, "").replace(/\.git$/iu, "");
}
