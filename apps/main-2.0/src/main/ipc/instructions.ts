import type { InstructionCatalogService } from "../services/instruction-catalog-service";
import { INSTRUCTIONS_IPC } from "../../shared/ipc/instructions";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export function registerInstructionsIpc(ipc: IpcMainRegistrar, service: InstructionCatalogService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, INSTRUCTIONS_IPC.list, () => service.list()),
    registerIpcHandler(ipc, INSTRUCTIONS_IPC.read, (_event, file) => service.read(file)),
    registerIpcHandler(ipc, INSTRUCTIONS_IPC.open, (_event, file) => service.open(file)),
    registerIpcHandler(ipc, INSTRUCTIONS_IPC.reveal, (_event, file) => service.reveal(file)),
  ]);
}
