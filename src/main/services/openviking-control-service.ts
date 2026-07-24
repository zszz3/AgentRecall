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
  stop(): Promise<OpenVikingRuntimeStatus>;
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
    void this.options.memory.importWorkspace(workspace.id).catch(() => {
      // The import service persists the failed state and error for the renderer to surface.
    });
    return workspace;
  }

  importWorkspace(workspaceId: string): Promise<OpenVikingImportJob> {
    this.requireEnabled();
    return this.options.memory.importWorkspace(workspaceId);
  }

  pauseImport(workspaceId: string): Promise<OpenVikingImportJob> {
    this.requireEnabled();
    return this.options.memory.pauseImport(workspaceId);
  }

  resumeImport(workspaceId: string): Promise<OpenVikingImportJob> {
    this.requireEnabled();
    return this.options.memory.resumeImport(workspaceId);
  }

  async search(workspaceId: string, query: string, limit?: number): Promise<OpenVikingMemoryItem[]> {
    this.requireEnabled();
    return this.options.memory.searchMemories(workspaceId, query, limit);
  }

  read(workspaceId: string, uri: string): Promise<string> {
    this.requireEnabled();
    return this.options.memory.readMemory(workspaceId, uri);
  }

  save(workspaceId: string, input: SaveOpenVikingMemoryInput): Promise<OpenVikingMemoryItem> {
    this.requireEnabled();
    return this.options.memory.saveMemory(workspaceId, input);
  }

  deleteMemory(workspaceId: string, uri: string): Promise<void> {
    this.requireEnabled();
    return this.options.memory.deleteMemory(workspaceId, uri);
  }

  async stopManaging(workspaceId: string): Promise<OpenVikingWorkspace> {
    this.requireEnabled();
    const workspace = await this.options.memory.stopManaging(workspaceId);
    await this.notifyStateChanged();
    return workspace;
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    this.requireEnabled();
    await this.options.memory.deleteWorkspace(workspaceId);
    await this.notifyStateChanged();
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

  async startRuntime(): Promise<OpenVikingRuntimeStatus> {
    this.requireEnabled();
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
}
