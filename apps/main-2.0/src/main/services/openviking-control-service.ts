import type { AppSettings } from "../../core/platform";
import type {
  OpenVikingMemoryControl,
  OpenVikingMemoryChange,
  OpenVikingMemoryDetails,
  OpenVikingMemoryFeedbackKind,
} from "../../core/openviking-memory-control";
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
import type { OpenVikingMemoryIpcService } from "../ipc/openviking-memory";
import type { SaveOpenVikingMemoryInput } from "./openviking-client";
import type { OpenVikingDirectoryPreview, OpenVikingMemoryService } from "./openviking-memory-service";
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
  control: {
    getOpenVikingControlDiagnostics(limit?: number): Promise<OpenVikingDiagnosticsSnapshot["control"]>;
  };
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
    const [runtime, model, workspaces, control] = await Promise.all([
      this.options.runtime.getDiagnostics(),
      this.options.model.getStatus(),
      this.options.memory.listWorkspaces(),
      this.options.control.getOpenVikingControlDiagnostics(),
    ]);
    return {
      capturedAt: new Date().toISOString(),
      runtime,
      model,
      workspaces,
      control,
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

  readCommitChanges(
    workspaceId: string,
    memoryDiffUri: string,
  ): Promise<OpenVikingMemoryChange[]> {
    this.requireEnabled();
    return this.runDataOperation(
      workspaceId,
      () => this.options.memory.readCommitChanges(workspaceId, memoryDiffUri),
    );
  }

  async save(workspaceId: string, input: SaveOpenVikingMemoryInput): Promise<OpenVikingMemoryItem> {
    this.requireEnabled();
    const memory = await this.runDataOperation(
      workspaceId,
      () => this.options.memory.saveMemory(workspaceId, input),
    );
    await this.notifyStateChanged();
    return memory;
  }

  async deleteMemory(workspaceId: string, uri: string): Promise<void> {
    this.requireEnabled();
    await this.runDataOperation(workspaceId, () => this.options.memory.deleteMemory(workspaceId, uri));
    await this.notifyStateChanged();
  }

  memoryDetails(workspaceId: string, uri: string): Promise<OpenVikingMemoryDetails> {
    this.requireEnabled();
    return this.runDataOperation(
      workspaceId,
      () => this.options.memory.memoryDetails(workspaceId, uri),
    );
  }

  async feedback(
    workspaceId: string,
    uri: string,
    feedback: OpenVikingMemoryFeedbackKind,
    note?: string,
  ): Promise<OpenVikingMemoryControl> {
    this.requireEnabled();
    const control = await this.runDataOperation(
      workspaceId,
      () => this.options.memory.feedback(workspaceId, uri, feedback, "user", note),
    );
    await this.notifyStateChanged();
    return control;
  }

  async stopManaging(workspaceId: string): Promise<OpenVikingWorkspace> {
    this.requireEnabled();
    if (this.blockedWorkspaceIds.has(workspaceId)) {
      throw new Error("This memory directory is being updated.");
    }
    this.blockedWorkspaceIds.add(workspaceId);
    try {
      await this.waitForDataOperations(workspaceId);
      const workspace = await this.options.memory.stopManaging(workspaceId);
      await this.notifyStateChanged();
      return workspace;
    } finally {
      this.blockedWorkspaceIds.delete(workspaceId);
    }
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    this.requireEnabled();
    if (this.blockedWorkspaceIds.has(workspaceId)) {
      throw new Error("This memory directory is being updated.");
    }
    this.blockedWorkspaceIds.add(workspaceId);
    let runtimeWasRunning = false;
    let startedForCleanup = false;
    let deleted = false;
    let clearData = false;
    try {
      await this.waitForDataOperations(workspaceId);
      const runtimeStatus = await this.options.runtime.getStatus();
      runtimeWasRunning = runtimeStatus.state === "running";
      if (!runtimeWasRunning) {
        await this.options.runtime.startFromPersistedConfig();
        startedForCleanup = true;
      }
      await this.options.memory.deleteWorkspace(workspaceId);
      const remaining = (await this.options.memory.listWorkspaces())
        .filter((workspace) => workspace.id !== workspaceId);
      clearData = remaining.length === 0;
      deleted = true;
      await this.notifyStateChanged();
    } finally {
      this.blockedWorkspaceIds.delete(workspaceId);
      if (deleted) {
        if (clearData || startedForCleanup) await this.stopRuntime();
        if (clearData) await this.options.runtime.clearData();
      } else if (!runtimeWasRunning && startedForCleanup) {
        await this.options.runtime.stop().catch(() => undefined);
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
      return Promise.reject(new Error("This memory directory is being updated."));
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
