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
  OpenVikingRuntimeStatus,
  OpenVikingWorkspace,
} from "../../core/openviking-memory";
import { OPENVIKING_MEMORY_IPC } from "../../shared/ipc/openviking-memory";
import type { OpenVikingDirectoryPreview } from "../services/openviking-memory-service";
import type { SaveOpenVikingMemoryInput } from "../services/openviking-client";
import {
  combineIpcDisposers,
  registerIpcHandler,
  type IpcMainRegistrar,
} from "./register-ipc-handler";

export interface OpenVikingMemoryIpcService {
  snapshot(): Promise<OpenVikingMemorySnapshot>;
  diagnostics(): Promise<OpenVikingDiagnosticsSnapshot>;
  chooseDirectory(): Promise<OpenVikingDirectoryPreview | null>;
  previewDirectory(rootPath: string): Promise<OpenVikingDirectoryPreview>;
  addWorkspace(rootPath: string): Promise<OpenVikingWorkspace>;
  search(workspaceId: string, query: string, limit?: number): Promise<OpenVikingMemoryItem[]>;
  read(workspaceId: string, uri: string): Promise<string>;
  readCommitChanges(workspaceId: string, memoryDiffUri: string): Promise<OpenVikingMemoryChange[]>;
  memoryDetails(workspaceId: string, uri: string): Promise<OpenVikingMemoryDetails>;
  save(workspaceId: string, input: SaveOpenVikingMemoryInput): Promise<OpenVikingMemoryItem>;
  feedback(
    workspaceId: string,
    uri: string,
    feedback: OpenVikingMemoryFeedbackKind,
    note?: string,
  ): Promise<OpenVikingMemoryControl>;
  deleteMemory(workspaceId: string, uri: string): Promise<void>;
  stopManaging(workspaceId: string): Promise<OpenVikingWorkspace>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  installRuntime(): Promise<OpenVikingRuntimeStatus>;
  startRuntime(): Promise<OpenVikingRuntimeStatus>;
  restartRuntime(): Promise<OpenVikingRuntimeStatus>;
  stopRuntime(): Promise<OpenVikingRuntimeStatus>;
  installModel(model: "BAAI/bge-small-zh-v1.5"): Promise<OpenVikingModelStatus>;
}

export function registerOpenVikingMemoryIpc(
  ipc: IpcMainRegistrar,
  service: OpenVikingMemoryIpcService,
): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.snapshot, () => service.snapshot()),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.diagnostics, () => service.diagnostics()),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.chooseDirectory, () => service.chooseDirectory()),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.previewDirectory, (_event, rootPath) =>
      service.previewDirectory(rootPath)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.addWorkspace, (_event, rootPath) =>
      service.addWorkspace(rootPath)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.search, (_event, workspaceId, query, limit?) =>
      service.search(workspaceId, query, limit)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.read, (_event, workspaceId, uri) =>
      service.read(workspaceId, uri)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.readCommitChanges, (_event, workspaceId, memoryDiffUri) =>
      service.readCommitChanges(workspaceId, memoryDiffUri)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.details, (_event, workspaceId, uri) =>
      service.memoryDetails(workspaceId, uri)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.save, (_event, workspaceId, input) =>
      service.save(workspaceId, input)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.feedback, (_event, workspaceId, uri, input) =>
      service.feedback(workspaceId, uri, input.feedback, input.note)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.deleteMemory, (_event, workspaceId, uri) =>
      service.deleteMemory(workspaceId, uri)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.stopManaging, (_event, workspaceId) =>
      service.stopManaging(workspaceId)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.deleteWorkspace, (_event, workspaceId) =>
      service.deleteWorkspace(workspaceId)),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.installRuntime, () => service.installRuntime()),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.startRuntime, () => service.startRuntime()),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.restartRuntime, () => service.restartRuntime()),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.stopRuntime, () => service.stopRuntime()),
    registerIpcHandler(ipc, OPENVIKING_MEMORY_IPC.installModel, (_event, model) =>
      service.installModel(model)),
  ]);
}
