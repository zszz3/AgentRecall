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
    registerIpcHandler(ipc, PERSONAL_LIBRARY_IPC.dismissRetiredKept, () => service.dismissRetiredKept()),
  ]);
}
