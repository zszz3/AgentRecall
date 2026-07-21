import path from "node:path";
import {
  createAgentMemoryFile,
  readAgentMemoryFile,
  saveAgentMemoryFile,
  scanAgentMemoryDirectory,
  type AgentMemoryDocument,
  type AgentMemorySnapshot,
  type CreateAgentMemoryInput,
  type CreateSelectedAgentMemoryInput,
} from "../../core/agent-memory";
import {
  applyPreparedAgentMemorySync,
  loadAgentMemoryEffectiveContext,
  prepareAgentMemorySync,
  undoPreparedAgentMemorySync,
  type AgentMemoryEffectiveContext,
  type AgentMemorySyncApplyResult,
  type AgentMemorySyncPreview,
  type AgentMemoryTarget,
  type PreparedAgentMemorySync,
  type PreparedAgentMemoryUndo,
} from "../../core/agent-memory-sync";

export interface AgentMemoryOperations {
  scanDirectory(directoryPath: string): Promise<AgentMemorySnapshot>;
  readFile(rootPath: string, relativePath: string): Promise<AgentMemoryDocument>;
  saveFile(rootPath: string, relativePath: string, content: string): Promise<AgentMemoryDocument>;
  createFile(rootPath: string, input: CreateAgentMemoryInput): Promise<AgentMemoryDocument>;
  loadEffectiveContext(snapshot: AgentMemorySnapshot, target: AgentMemoryTarget): Promise<AgentMemoryEffectiveContext>;
  prepareSync(
    snapshot: AgentMemorySnapshot,
    sourceRelativePath: string,
    targets: AgentMemoryTarget[],
  ): Promise<PreparedAgentMemorySync>;
  applySync(rootPath: string, prepared: PreparedAgentMemorySync): Promise<PreparedAgentMemoryUndo>;
  undoSync(rootPath: string, undo: PreparedAgentMemoryUndo): Promise<void>;
}

export interface AgentMemoryServiceOptions {
  chooseDirectory(): Promise<string | null>;
  operations?: AgentMemoryOperations;
}

const defaultOperations: AgentMemoryOperations = {
  scanDirectory: scanAgentMemoryDirectory,
  readFile: readAgentMemoryFile,
  saveFile: saveAgentMemoryFile,
  createFile: createAgentMemoryFile,
  loadEffectiveContext: loadAgentMemoryEffectiveContext,
  prepareSync: prepareAgentMemorySync,
  applySync: applyPreparedAgentMemorySync,
  undoSync: undoPreparedAgentMemorySync,
};

export class AgentMemoryService {
  private snapshot: AgentMemorySnapshot | null = null;
  private preparedSync: PreparedAgentMemorySync | null = null;
  private preparedUndo: PreparedAgentMemoryUndo | null = null;
  private readonly operations: AgentMemoryOperations;

  constructor(private readonly options: AgentMemoryServiceOptions) {
    this.operations = options.operations ?? defaultOperations;
  }

  async choose(): Promise<AgentMemorySnapshot | null> {
    const directoryPath = await this.options.chooseDirectory();
    if (!directoryPath) return null;
    const snapshot = await this.operations.scanDirectory(directoryPath);
    this.snapshot = snapshot;
    this.preparedSync = null;
    this.preparedUndo = null;
    return snapshot;
  }

  async refresh(): Promise<AgentMemorySnapshot | null> {
    if (!this.snapshot) return null;
    const snapshot = await this.operations.scanDirectory(this.snapshot.selectedDirectoryPath);
    this.snapshot = snapshot;
    this.preparedSync = null;
    return snapshot;
  }

  async read(relativePath: string): Promise<AgentMemoryDocument> {
    const snapshot = this.requireSelection();
    this.requireDiscoveredFile(snapshot, relativePath);
    return this.operations.readFile(snapshot.rootPath, relativePath);
  }

  async save(relativePath: string, content: string): Promise<AgentMemoryDocument> {
    const snapshot = this.requireSelection();
    this.requireDiscoveredFile(snapshot, relativePath);
    const saved = await this.operations.saveFile(snapshot.rootPath, relativePath, content);
    this.preparedSync = null;
    return saved;
  }

  async create(input: CreateSelectedAgentMemoryInput): Promise<AgentMemoryDocument> {
    const snapshot = this.requireSelection();
    const created = await this.operations.createFile(snapshot.rootPath, {
      ...input,
      directory: snapshot.selectedDirectory,
    });
    this.preparedSync = null;
    return created;
  }

  async effectiveContext(target: AgentMemoryTarget): Promise<AgentMemoryEffectiveContext> {
    return this.operations.loadEffectiveContext(this.requireSelection(), target);
  }

  async previewSync(
    sourceRelativePath: string,
    targets: AgentMemoryTarget[],
  ): Promise<AgentMemorySyncPreview> {
    const prepared = await this.operations.prepareSync(this.requireSelection(), sourceRelativePath, targets);
    this.preparedSync = prepared;
    return prepared.preview;
  }

  async applySync(previewId: string): Promise<AgentMemorySyncApplyResult> {
    const snapshot = this.requireSelection();
    if (!this.preparedSync || this.preparedSync.preview.id !== previewId) {
      throw new Error("Refresh the sync preview before applying changes.");
    }
    const prepared = this.preparedSync;
    const undo = await this.operations.applySync(snapshot.rootPath, prepared);
    this.preparedSync = null;
    this.preparedUndo = undo;
    const next = await this.operations.scanDirectory(snapshot.selectedDirectoryPath);
    this.snapshot = next;
    return {
      snapshot: next,
      undoId: undo.id,
      changedPaths: prepared.preview.items
        .filter((item) => item.action !== "unchanged")
        .map((item) => item.relativePath),
    };
  }

  async undoSync(undoId: string): Promise<AgentMemorySnapshot> {
    const snapshot = this.requireSelection();
    if (!this.preparedUndo || this.preparedUndo.id !== undoId) {
      throw new Error("This sync undo is no longer available.");
    }
    const undo = this.preparedUndo;
    await this.operations.undoSync(snapshot.rootPath, undo);
    this.preparedUndo = null;
    this.preparedSync = null;
    const next = await this.operations.scanDirectory(snapshot.selectedDirectoryPath);
    this.snapshot = next;
    return next;
  }

  private requireSelection(): AgentMemorySnapshot {
    if (!this.snapshot) throw new Error("Choose a directory before managing Agent memory.");
    return this.snapshot;
  }

  private requireDiscoveredFile(snapshot: AgentMemorySnapshot, relativePath: string): void {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!snapshot.files.some((file) => file.relativePath === normalized)) {
      throw new Error("The Agent memory file is not part of the selected directory context.");
    }
    const resolved = path.resolve(snapshot.rootPath, ...normalized.split("/"));
    const relative = path.relative(snapshot.rootPath, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("The Agent memory file must stay inside the selected project.");
    }
  }
}
