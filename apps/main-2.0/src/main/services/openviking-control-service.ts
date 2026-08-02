import type { AppSettings } from "../../core/platform";
import type {
  OpenVikingMemoryItem,
  OpenVikingMemorySnapshot,
  OpenVikingModelStatus,
  OpenVikingRuntimeInstallProgress,
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
  private readonly activeDataOperations = new Set<Promise<unknown>>();
  private memoryAccessPaused = false;

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
    const managed = workspaces.filter((workspace) => workspace.managed);
    this.memoryAccessPaused = managed.length > 0
      && managed.every((workspace) => workspace.importState === "paused");
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
    this.memoryAccessPaused = true;
    try {
      const paused = await this.options.memory.pauseImport(workspaceId);
      await Promise.allSettled([...this.activeDataOperations]);
      await this.stopRuntime();
      return paused;
    } catch (error) {
      this.memoryAccessPaused = false;
      throw error;
    }
  }

  async resumeImport(workspaceId: string): Promise<OpenVikingImportJob> {
    this.requireEnabled();
    await this.startRuntime();
    this.memoryAccessPaused = false;
    return this.options.memory.resumeImport(workspaceId);
  }

  async search(workspaceId: string, query: string, limit?: number): Promise<OpenVikingMemoryItem[]> {
    this.requireEnabled();
    return this.runDataOperation(() => this.options.memory.searchMemories(workspaceId, query, limit));
  }

  read(workspaceId: string, uri: string): Promise<string> {
    this.requireEnabled();
    return this.runDataOperation(() => this.options.memory.readMemory(workspaceId, uri));
  }

  save(workspaceId: string, input: SaveOpenVikingMemoryInput): Promise<OpenVikingMemoryItem> {
    this.requireEnabled();
    return this.runDataOperation(() => this.options.memory.saveMemory(workspaceId, input));
  }

  deleteMemory(workspaceId: string, uri: string): Promise<void> {
    this.requireEnabled();
    return this.runDataOperation(() => this.options.memory.deleteMemory(workspaceId, uri));
  }

  async stopManaging(workspaceId: string): Promise<OpenVikingWorkspace> {
    this.requireEnabled();
    const workspace = await this.options.memory.stopManaging(workspaceId);
    await this.notifyStateChanged();
    return workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    this.requireEnabled();
    const previousMemoryAccessPaused = this.memoryAccessPaused;
    this.memoryAccessPaused = true;
    try {
      await this.options.memory.pauseImport(workspaceId);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("was not found")) {
        this.memoryAccessPaused = previousMemoryAccessPaused;
        throw error;
      }
    }
    await Promise.allSettled([...this.activeDataOperations]);
    if ((await this.options.runtime.getStatus()).state === "running") {
      await this.options.runtime.stop();
    }
    await this.options.memory.waitForImportToSettle(workspaceId);
    await this.options.runtime.startFromPersistedConfig();
    let keepRunning = false;
    let clearData = false;
    try {
      await this.options.memory.deleteWorkspace(workspaceId);
      const remaining = (await this.options.memory.listWorkspaces())
        .filter((workspace) => workspace.managed);
      keepRunning = remaining.some((workspace) => workspace.importState !== "paused");
      clearData = remaining.length === 0;
      this.memoryAccessPaused = remaining.length > 0 && !keepRunning;
      await this.notifyStateChanged();
    } finally {
      if (!keepRunning) await this.stopRuntime();
      if (clearData) await this.options.runtime.clearData();
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

  private runDataOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.memoryAccessPaused) {
      return Promise.reject(new Error("OpenViking is paused."));
    }
    const pending = operation();
    this.activeDataOperations.add(pending);
    void pending.then(
      () => this.activeDataOperations.delete(pending),
      () => this.activeDataOperations.delete(pending),
    );
    return pending;
  }
}
