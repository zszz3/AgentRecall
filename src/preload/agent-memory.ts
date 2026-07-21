import type { IpcRenderer } from "electron";
import type { AgentMemoryDocument, AgentMemorySnapshot, CreateSelectedAgentMemoryInput } from "../core/agent-memory";
import type {
  AgentMemoryEffectiveContext,
  AgentMemorySyncApplyResult,
  AgentMemorySyncPreview,
  AgentMemoryTarget,
} from "../core/agent-memory-sync";
import { AGENT_MEMORY_IPC } from "../shared/ipc/agent-memory";

export type AgentMemoryIpcRenderer = Pick<IpcRenderer, "invoke">;

export function createAgentMemoryApi(ipc: AgentMemoryIpcRenderer) {
  return {
    chooseAgentMemoryDirectory: (): Promise<AgentMemorySnapshot | null> => ipc.invoke(AGENT_MEMORY_IPC.choose.channel),
    refreshAgentMemories: (): Promise<AgentMemorySnapshot | null> => ipc.invoke(AGENT_MEMORY_IPC.refresh.channel),
    readAgentMemory: (relativePath: string): Promise<AgentMemoryDocument> =>
      ipc.invoke(AGENT_MEMORY_IPC.read.channel, relativePath),
    saveAgentMemory: (relativePath: string, content: string): Promise<AgentMemoryDocument> =>
      ipc.invoke(AGENT_MEMORY_IPC.save.channel, relativePath, content),
    createAgentMemory: (input: CreateSelectedAgentMemoryInput): Promise<AgentMemoryDocument> =>
      ipc.invoke(AGENT_MEMORY_IPC.create.channel, input),
    getAgentMemoryEffectiveContext: (target: AgentMemoryTarget): Promise<AgentMemoryEffectiveContext> =>
      ipc.invoke(AGENT_MEMORY_IPC.effectiveContext.channel, target),
    previewAgentMemorySync: (
      sourceRelativePath: string,
      targets: AgentMemoryTarget[],
    ): Promise<AgentMemorySyncPreview> => ipc.invoke(AGENT_MEMORY_IPC.previewSync.channel, sourceRelativePath, targets),
    applyAgentMemorySync: (previewId: string): Promise<AgentMemorySyncApplyResult> =>
      ipc.invoke(AGENT_MEMORY_IPC.applySync.channel, previewId),
    undoAgentMemorySync: (undoId: string): Promise<AgentMemorySnapshot> =>
      ipc.invoke(AGENT_MEMORY_IPC.undoSync.channel, undoId),
  };
}

export type AgentMemoryApi = ReturnType<typeof createAgentMemoryApi>;
