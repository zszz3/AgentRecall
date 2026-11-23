import { EXPERIENCE_CARDS_IPC, type ExperienceCardStatus, type MemoryCard } from "../../shared/ipc/experience-cards";
import { combineIpcDisposers, registerIpcHandler, type IpcMainRegistrar } from "./register-ipc-handler";

export interface ExperienceCardsIpcService {
  status(): Promise<ExperienceCardStatus>;
  listCards(options: { query: string; includeSuperseded: boolean }): Promise<MemoryCard[]>;
  deleteCard(id: string): Promise<void>;
  retryFailed(sessionKey: string | null): Promise<number>;
}

export function registerExperienceCardsIpc(ipc: IpcMainRegistrar, service: ExperienceCardsIpcService): () => void {
  return combineIpcDisposers([
    registerIpcHandler(ipc, EXPERIENCE_CARDS_IPC.getStatus, () => service.status()),
    registerIpcHandler(ipc, EXPERIENCE_CARDS_IPC.list, (_event, options) => service.listCards(options)),
    registerIpcHandler(ipc, EXPERIENCE_CARDS_IPC.remove, (_event, id) => service.deleteCard(id)),
    registerIpcHandler(ipc, EXPERIENCE_CARDS_IPC.retryFailed, (_event, sessionKey) => service.retryFailed(sessionKey)),
  ]);
}
