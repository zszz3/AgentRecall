import type { PersonalLibraryService } from "../services/personal-library-service";
import { PERSONAL_LIBRARY_IPC } from "../../shared/ipc/personal-library";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export function registerPersonalLibraryIpc(ipc: IpcMainRegistrar, service: PersonalLibraryService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.snapshot, () => service.snapshot()),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.saveInstructions, (_event, text) => service.saveInstructions(text)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.preview, (_event, id, enabled) => service.preview(id, enabled)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.setAgentEnabled, (_event, id, enabled) => service.setAgentEnabled(id, enabled)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.resolveConflict, (_event, id, choice) => service.resolveConflict(id, choice)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.importCandidates, () => service.importCandidates()),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.importParagraphs, (_event, texts, remove) => service.importParagraphs(texts, remove)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.saveMcpServers, (_event, servers) => service.saveMcpServers(servers)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.previewMcp, (_event, id, enabled) => service.previewMcp(id, enabled)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.setMcpAgentEnabled, (_event, id, enabled) => service.setMcpAgentEnabled(id, enabled)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.overwriteMcp, (_event, id) => service.overwriteMcp(id)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.mcpImportCandidates, () => service.mcpImportCandidates()),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.importMcpServers, (_event, servers) => service.importMcpServers(servers)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.saveFiles, (_event, kind, items) => service.saveFiles(kind, items)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.previewFiles, (_event, kind, id, enabled) => service.previewFiles(kind, id, enabled)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.setFilesAgentEnabled, (_event, kind, id, enabled) => service.setFilesAgentEnabled(kind, id, enabled)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.overwriteFiles, (_event, kind, id) => service.overwriteFiles(kind, id)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.fileImportCandidates, (_event, kind) => service.fileImportCandidates(kind)),
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.importFiles, (_event, kind, items) => service.importFiles(kind, items)),
  ]);
}
