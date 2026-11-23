import type { IpcRenderer } from "electron";
import { INSTRUCTIONS_IPC, type InstructionFile } from "../shared/ipc/instructions";

export function createInstructionsApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    listInstructionFiles: (): Promise<InstructionFile[]> => ipc.invoke(INSTRUCTIONS_IPC.list.channel),
    readInstructionFile: (file: string): Promise<string> => ipc.invoke(INSTRUCTIONS_IPC.read.channel, file),
    openInstructionFile: (file: string): Promise<void> => ipc.invoke(INSTRUCTIONS_IPC.open.channel, file),
    revealInstructionFile: (file: string): Promise<void> => ipc.invoke(INSTRUCTIONS_IPC.reveal.channel, file),
  };
}
