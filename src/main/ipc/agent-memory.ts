import type { AgentMemoryDocument, AgentMemorySnapshot, CreateSelectedAgentMemoryInput } from "../../core/agent-memory";
import type {
  AgentMemoryEffectiveContext,
  AgentMemorySyncApplyResult,
  AgentMemorySyncPreview,
  AgentMemoryTarget,
} from "../../core/agent-memory-sync";
import { AGENT_MEMORY_IPC } from "../../shared/ipc/agent-memory";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface AgentMemoryIpcService {
  choose(): Promise<AgentMemorySnapshot | null>;
  refresh(): Promise<AgentMemorySnapshot | null>;
  read(relativePath: string): Promise<AgentMemoryDocument>;
  save(relativePath: string, content: string): Promise<AgentMemoryDocument>;
  create(input: CreateSelectedAgentMemoryInput): Promise<AgentMemoryDocument>;
  effectiveContext(target: AgentMemoryTarget): Promise<AgentMemoryEffectiveContext>;
  previewSync(sourceRelativePath: string, targets: AgentMemoryTarget[]): Promise<AgentMemorySyncPreview>;
  applySync(previewId: string): Promise<AgentMemorySyncApplyResult>;
  undoSync(undoId: string): Promise<AgentMemorySnapshot>;
}

export function registerAgentMemoryIpc(ipc: IpcMainRegistrar, service: AgentMemoryIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, AGENT_MEMORY_IPC.choose, () => service.choose()),
    registerIpcHandler(ipc, AGENT_MEMORY_IPC.refresh, () => service.refresh()),
    registerIpcHandler(ipc, AGENT_MEMORY_IPC.read, (_event, relativePath) => service.read(relativePath)),
    registerIpcHandler(ipc, AGENT_MEMORY_IPC.save, (_event, relativePath, content) => service.save(relativePath, content)),
    registerIpcHandler(ipc, AGENT_MEMORY_IPC.create, (_event, input) => service.create(input)),
    registerIpcHandler(ipc, AGENT_MEMORY_IPC.effectiveContext, (_event, target) => service.effectiveContext(target)),
    registerIpcHandler(ipc, AGENT_MEMORY_IPC.previewSync, (_event, sourceRelativePath, targets) =>
      service.previewSync(sourceRelativePath, targets)),
    registerIpcHandler(ipc, AGENT_MEMORY_IPC.applySync, (_event, previewId) => service.applySync(previewId)),
    registerIpcHandler(ipc, AGENT_MEMORY_IPC.undoSync, (_event, undoId) => service.undoSync(undoId)),
  ]);
}
