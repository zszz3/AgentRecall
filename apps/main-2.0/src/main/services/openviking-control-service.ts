import type { AppSettings } from "../../core/platform";
import type {
  OpenVikingDiagnosticsSnapshot,
  OpenVikingMemoryItem,
  OpenVikingMemorySnapshot,
  OpenVikingModelStatus,
  OpenVikingRuntimeInstallProgress,
  OpenVikingRuntimeDiagnostics,
  OpenVikingRuntimeStatus,
  OpenVikingWorkspace,
} from "../../core/openviking-memory";
import type { OpenVikingImportJob } from "../../core/postgres/openviking-memory-repository";
import type { OpenVikingMemoryIpcService } from "../ipc/openviking-memory";
import type { SaveOpenVikingMemoryInput } from "./openviking-client";
import type {
  OpenVikingDirectoryPreview,
  OpenVikingImportSessionPreview,
  OpenVikingMemoryService,
} from "./openviking-memory-service";
import type {
  OpenVikingRuntimeManifest,
  OpenVikingRuntimeService,
  OpenVikingServerConfig,
} from "./openviking-runtime-service";

interface RuntimePort {
  getStatus(): Promise<OpenVikingRuntimeStatus>;
  getDiagnostics(): Promise<OpenVikingRuntimeDiagnostics>;
  install(
    manifest: OpenVikingRuntimeManifest,
    onProgress?: (progress: OpenVikingRuntimeInstallProgress) => void,
  ): Promise<OpenVikingRuntimeStatus>;
  start(config: OpenVikingServerConfig): Promise<OpenVikingRuntimeStatus>;
  startFromPersistedConfig(): Promise<OpenVikingRuntimeStatus>;
  stop(): Promise<OpenVikingRuntimeStatus>;
  clearData(): Promise<void>;
}

export interface OpenVikingModelManagerPort {
  getStatus(): Promise<OpenVikingModelStatus>;
  install(model: "BAAI/bge-small-zh-v1.5"): Promise<OpenVikingModelStatus>;
}

interface OpenVikingControlServiceOptions {
  runtime: RuntimePort | OpenVikingRuntimeService;
  model: OpenVikingModelManagerPort;
  memory: OpenVikingMemoryService;
  getSettings(): AppSettings;
  chooseDirectory(): Promise<string | null>;
  resolveRuntimeManifest(
    onProgress: (progress: OpenVikingRuntimeInstallProgress) => void,
  ): Promise<OpenVikingRuntimeManifest | null>;
  serverConfig(): OpenVikingServerConfig | Promise<OpenVikingServerConfig>;
  onStateChanged?(): void | Promise<void>;
}

export class OpenVikingControlService implements OpenVikingMemoryIpcService {
  private runtimeInstallStatus: OpenVikingRuntimeStatus | null = null;
  private runtimeInstallation: Promise<OpenVikingRuntimeStatus> | null = null;
  private runtimeStart: Promise<OpenVikingRuntimeStatus> | null = null;
  private readonly activeDataOperations = new Map<string, Set<Promise<unknown>>>();
  private readonly blockedWorkspaceIds = new Set<string>();
  private readonly activeWorkspaceLifecycles = new Set<string>();

  constructor(private readonly options: OpenVikingControlServiceOptions) {}

  async snapshot(): Promise<OpenVikingMemorySnapshot> {
    const [runtime, model, workspaces] = await Promise.all([
      this.runtimeInstallStatus
        ? Promise.resolve(this.runtimeInstallStatus)
        : this.options.runtime.getStatus(),
      this.options.model.getStatus(),
      this.options.memory.listWorkspaces(),
    ]);
    return { runtime, model, workspaces };
  }

  async diagnostics(): Promise<OpenVikingDiagnosticsSnapshot> {
    this.requireEnabled();
    const [runtime, model, workspaces] = await Promise.all([
      this.options.runtime.getDiagnostics(),
      this.options.model.getStatus(),
      this.options.memory.listWorkspaces(),
    ]);
    const tasks = await this.options.memory.listImportTaskDiagnostics(
      runtime.status.state === "running",
    );
    return {
      capturedAt: new Date().toISOString(),
      runtime,
      model,
      workspaces,
      tasks,
    };
  }

  async chooseDirectory(): Promise<OpenVikingDirectoryPreview | null> {
    this.requireEnabled();
    const selected = await this.options.chooseDirectory();
    return selected ? this.options.memory.previewDirectory(selected) : null;
  }

  previewDirectory(rootPath: string): Promise<OpenVikingDirectoryPreview> {
    this.requireEnabled();
    return this.options.memory.previewDirectory(rootPath);
  }

  async addWorkspace(rootPath: string): Promise<OpenVikingWorkspace> {
    this.requireEnabled();
    const workspace = await this.options.memory.addWorkspace(rootPath);
    await this.notifyStateChanged();
    return workspace;
  }

  listImportSessions(workspaceId: string): Promise<OpenVikingImportSessionPreview[]> {
    this.requireEnabled();
    return this.options.memory.listImportSessions(workspaceId);
  }

  importWorkspace(
    workspaceId: string,
    selectedSessionKeys?: string[],
  ): Promise<OpenVikingImportJob> {
    this.requireEnabled();
    return this.options.memory.importWorkspace(workspaceId, selectedSessionKeys);
  }

  async syncManagedWorkspaces(): Promise<void> {
    this.requireEnabled();
    const workspaces = await this.options.memory.listWorkspaces();
    const listedWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    for (const workspaceId of this.blockedWorkspaceIds) {
      if (!listedWorkspaceIds.has(workspaceId) && !this.activeWorkspaceLifecycles.has(workspaceId)) {
        this.blockedWorkspaceIds.delete(workspaceId);
      }
    }
    for (const workspace of workspaces) {
      if (workspace.managed && workspace.importState === "paused") {
        this.blockedWorkspaceIds.add(workspace.id);
      } else if (!this.activeWorkspaceLifecycles.has(workspace.id)) {
        this.blockedWorkspaceIds.delete(workspace.id);
      }
    }
    for (const workspace of workspaces) {
      if (
        !workspace.managed
        || !["queued", "running", "completed"].includes(workspace.importState)
      ) continue;
      void this.options.memory.importWorkspace(workspace.id).catch(() => {
        // Each import persists its own failure for the renderer to surface.
      });
    }
  }

  async pauseImport(workspaceId: string): Promise<OpenVikingImportJob> {
    this.requireEnabled();
    const wasBlocked = this.blockedWorkspaceIds.has(workspaceId);
    let pauseApplied = false;
    this.activeWorkspaceLifecycles.add(workspaceId);
    this.blockedWorkspaceIds.add(workspaceId);
    try {
      const paused = await this.options.memory.pauseImport(workspaceId);
      pauseApplied = true;
      await this.waitForDataOperations(workspaceId);
      await this.options.memory.waitForImportToSettle(workspaceId);
      const otherAccessibleWorkspace = (await this.options.memory.listWorkspaces()).some((workspace) =>
        workspace.id !== workspaceId
        && (!workspace.managed || workspace.importState !== "paused"));
      if (!otherAccessibleWorkspace) await this.stopRuntime();
      return paused;
    } catch (error) {
      if (!wasBlocked && !pauseApplied) this.blockedWorkspaceIds.delete(workspaceId);
      throw error;
    } finally {
      this.activeWorkspaceLifecycles.delete(workspaceId);
    }
  }

  async resumeImport(workspaceId: string): Promise<OpenVikingImportJob> {
    this.requireEnabled();
    this.activeWorkspaceLifecycles.add(workspaceId);
    try {
      if ((await this.options.runtime.getStatus()).state !== "running") {
        await this.startRuntime();
      }
      const resumed = await this.options.memory.resumeImport(workspaceId);
      this.blockedWorkspaceIds.delete(workspaceId);
      return resumed;
    } finally {
      this.activeWorkspaceLifecycles.delete(workspaceId);
    }
  }

  async search(workspaceId: string, query: string, limit?: number): Promise<OpenVikingMemoryItem[]> {
    this.requireEnabled();
    return this.runDataOperation(
      workspaceId,
      () => this.options.memory.searchMemories(workspaceId, query, limit),
    );
  }

  read(workspaceId: string, uri: string): Promise<string> {
    this.requireEnabled();
    return this.runDataOperation(workspaceId, () => this.options.memory.readMemory(workspaceId, uri));
  }

  save(workspaceId: string, input: SaveOpenVikingMemoryInput): Promise<OpenVikingMemoryItem> {
    this.requireEnabled();
    return this.runDataOperation(workspaceId, () => this.options.memory.saveMemory(workspaceId, input));
  }

  deleteMemory(workspaceId: string, uri: string): Promise<void> {
    this.requireEnabled();
    return this.runDataOperation(workspaceId, () => this.options.memory.deleteMemory(workspaceId, uri));
  }

  async stopManaging(workspaceId: string): Promise<OpenVikingWorkspace> {
    this.requireEnabled();
    const wasBlocked = this.blockedWorkspaceIds.has(workspaceId);
    let pausedForStop = false;
    this.activeWorkspaceLifecycles.add(workspaceId);
    try {
      const current = (await this.options.memory.listWorkspaces())
        .find((workspace) => workspace.id === workspaceId);
      if (current && ["queued", "running"].includes(current.importState)) {
        this.blockedWorkspaceIds.add(workspaceId);
        await this.options.memory.pauseImport(workspaceId);
        pausedForStop = true;
        await this.waitForDataOperations(workspaceId);
        await this.options.memory.waitForImportToSettle(workspaceId);
      }
      const workspace = await this.options.memory.stopManaging(workspaceId);
      this.blockedWorkspaceIds.delete(workspaceId);
      await this.notifyStateChanged();
      return workspace;
    } catch (error) {
      if (!wasBlocked && !pausedForStop) this.blockedWorkspaceIds.delete(workspaceId);
      throw error;
    } finally {
      this.activeWorkspaceLifecycles.delete(workspaceId);
    }
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    this.requireEnabled();
    const wasBlocked = this.blockedWorkspaceIds.has(workspaceId);
    this.activeWorkspaceLifecycles.add(workspaceId);
    this.blockedWorkspaceIds.add(workspaceId);
    let pauseApplied = false;
    let runtimeWasRunning = false;
    let reusedRunningRuntime = false;
    let startedForCleanup = false;
    let deleted = false;
    let keepRunning = false;
    let clearData = false;
    try {
      try {
        await this.options.memory.pauseImport(workspaceId);
        pauseApplied = true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("was not found")) throw error;
      }
      await this.waitForDataOperations(workspaceId);
      const runtimeStatus = await this.options.runtime.getStatus();
      runtimeWasRunning = runtimeStatus.state === "running";
      const otherWorkspaces = (await this.options.memory.listWorkspaces())
        .filter((workspace) => workspace.id !== workspaceId);
      reusedRunningRuntime = runtimeWasRunning
        && otherWorkspaces.some((workspace) =>
          !workspace.managed || workspace.importState !== "paused");
      if (runtimeWasRunning && !reusedRunningRuntime) await this.options.runtime.stop();
      await this.options.memory.waitForImportToSettle(workspaceId);
      if (!reusedRunningRuntime) {
        await this.options.runtime.startFromPersistedConfig();
        startedForCleanup = true;
      }
      await this.options.memory.deleteWorkspace(workspaceId);
      const remaining = (await this.options.memory.listWorkspaces())
        .filter((workspace) => workspace.id !== workspaceId);
      keepRunning = remaining.some((workspace) =>
        !workspace.managed || workspace.importState !== "paused");
      clearData = remaining.length === 0;
      for (const workspace of remaining) {
        if (workspace.managed && workspace.importState === "paused") {
          this.blockedWorkspaceIds.add(workspace.id);
        } else if (!this.activeWorkspaceLifecycles.has(workspace.id)) {
          this.blockedWorkspaceIds.delete(workspace.id);
        }
      }
      this.blockedWorkspaceIds.delete(workspaceId);
      deleted = true;
      await this.notifyStateChanged();
    } finally {
      this.activeWorkspaceLifecycles.delete(workspaceId);
      if (!deleted && !wasBlocked && !pauseApplied) {
        this.blockedWorkspaceIds.delete(workspaceId);
      }
      if (deleted) {
        if (!keepRunning) await this.stopRuntime();
        if (clearData) await this.options.runtime.clearData();
      } else if (!runtimeWasRunning && startedForCleanup) {
        await this.options.runtime.stop().catch(() => undefined);
      } else if (runtimeWasRunning && !reusedRunningRuntime && !startedForCleanup) {
        await this.options.runtime.startFromPersistedConfig().catch(() => undefined);
      }
    }
  }

  installRuntime(): Promise<OpenVikingRuntimeStatus> {
    this.requireEnabled();
    if (this.runtimeInstallation) return this.runtimeInstallation;
    const installation = this.performRuntimeInstall()
      .finally(() => {
        if (this.runtimeInstallation === installation) {
          this.runtimeInstallation = null;
        }
      });
    this.runtimeInstallation = installation;
    return installation;
  }

  private async performRuntimeInstall(): Promise<OpenVikingRuntimeStatus> {
    const reportProgress = (progress: OpenVikingRuntimeInstallProgress) => {
      this.runtimeInstallStatus = {
        state: "installing",
        version: this.runtimeInstallStatus?.version,
        progress,
      };
    };
    reportProgress({ phase: "resolving-runtime" });
    try {
      const manifest = await this.options.resolveRuntimeManifest(reportProgress);
      if (!manifest) {
        throw new Error("OpenViking runtime is not available for this build and platform.");
      }
      this.runtimeInstallStatus = {
        state: "installing",
        version: manifest.version,
        progress: { phase: "downloading-runtime" },
      };
      return await this.options.runtime.install(manifest, reportProgress);
    } finally {
      this.runtimeInstallStatus = null;
    }
  }

  startRuntime(): Promise<OpenVikingRuntimeStatus> {
    this.requireEnabled();
    if (this.runtimeStart) return this.runtimeStart;
    const starting = this.performRuntimeStart()
      .finally(() => {
        if (this.runtimeStart === starting) {
          this.runtimeStart = null;
        }
      });
    this.runtimeStart = starting;
    return starting;
  }

  private async performRuntimeStart(): Promise<OpenVikingRuntimeStatus> {
    const model = await this.options.model.getStatus();
    if (!model.installed) throw new Error("Download the local embedding model before starting OpenViking.");
    const status = await this.options.runtime.start(await this.options.serverConfig());
    await this.notifyStateChanged();
    return status;
  }

  restartRuntime(): Promise<OpenVikingRuntimeStatus> {
    this.requireEnabled();
    if (this.runtimeStart) return this.runtimeStart;
    const restarting = this.performRuntimeRestart()
      .finally(() => {
        if (this.runtimeStart === restarting) {
          this.runtimeStart = null;
        }
      });
    this.runtimeStart = restarting;
    return restarting;
  }

  private async performRuntimeRestart(): Promise<OpenVikingRuntimeStatus> {
    await this.options.runtime.stop();
    return this.performRuntimeStart();
  }

  async stopRuntime(): Promise<OpenVikingRuntimeStatus> {
    const status = await this.options.runtime.stop();
    await this.notifyStateChanged();
    return status;
  }

  installModel(model: "BAAI/bge-small-zh-v1.5"): Promise<OpenVikingModelStatus> {
    this.requireEnabled();
    return this.options.model.install(model);
  }

  private requireEnabled(): void {
    if (!this.options.getSettings().openVikingMemoryEnabled) {
      throw new Error("OpenViking memory is disabled in Settings.");
    }
  }

  private async notifyStateChanged(): Promise<void> {
    try {
      await this.options.onStateChanged?.();
    } catch {
      // Hook metadata is derived state; it must not make the owning operation fail.
    }
  }

  private runDataOperation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    if (this.blockedWorkspaceIds.has(workspaceId)) {
      return Promise.reject(new Error("OpenViking is paused."));
    }
    const pending = operation();
    const workspaceOperations = this.activeDataOperations.get(workspaceId) ?? new Set<Promise<unknown>>();
    workspaceOperations.add(pending);
    this.activeDataOperations.set(workspaceId, workspaceOperations);
    void pending.then(
      () => this.removeDataOperation(workspaceId, pending),
      () => this.removeDataOperation(workspaceId, pending),
    );
    return pending;
  }

  private async waitForDataOperations(workspaceId: string): Promise<void> {
    await Promise.allSettled([...(this.activeDataOperations.get(workspaceId) ?? [])]);
  }

  private removeDataOperation(workspaceId: string, pending: Promise<unknown>): void {
    const workspaceOperations = this.activeDataOperations.get(workspaceId);
    if (!workspaceOperations) return;
    workspaceOperations.delete(pending);
    if (workspaceOperations.size === 0) this.activeDataOperations.delete(workspaceId);
  }
}
