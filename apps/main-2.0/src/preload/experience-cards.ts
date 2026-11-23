import type { IpcRenderer } from "electron";
import { EXPERIENCE_CARDS_IPC, type ExperienceCardStatus, type MemoryCard } from "../shared/ipc/experience-cards";

export function createExperienceCardsApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    getExperienceCardStatus: (): Promise<ExperienceCardStatus> => ipc.invoke(EXPERIENCE_CARDS_IPC.getStatus.channel),
    listExperienceCards: (options: { query: string; includeSuperseded: boolean }): Promise<MemoryCard[]> =>
      ipc.invoke(EXPERIENCE_CARDS_IPC.list.channel, options),
    deleteExperienceCard: (id: string): Promise<void> => ipc.invoke(EXPERIENCE_CARDS_IPC.remove.channel, id),
    retryExperienceExtraction: (sessionKey: string | null): Promise<number> =>
      ipc.invoke(EXPERIENCE_CARDS_IPC.retryFailed.channel, sessionKey),
  };
}
