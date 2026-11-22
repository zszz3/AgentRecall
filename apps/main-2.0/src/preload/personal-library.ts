import type { IpcRenderer } from "electron";
import type { LibraryAgentId } from "../core/library-agent-ids";
import type { LibraryMcpServer, LibraryMcpServers } from "../core/library-mcp-server";
import {
  PERSONAL_LIBRARY_IPC,
  type LibraryImportCandidate,
  type LibraryMcpImportCandidate,
  type LibraryMcpPreview,
  type LibraryPreview,
  type PersonalLibrarySnapshot,
} from "../shared/ipc/personal-library";

export function createPersonalLibraryApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    getPersonalLibrary: (): Promise<PersonalLibrarySnapshot> => ipc.invoke(PERSONAL_LIBRARY_IPC.snapshot.channel),
    savePersonalLibraryInstructions: (text: string): Promise<PersonalLibrarySnapshot> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.saveInstructions.channel, text),
    previewPersonalLibraryAgent: (id: LibraryAgentId, enabled: boolean): Promise<LibraryPreview> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.preview.channel, id, enabled),
    setPersonalLibraryAgentEnabled: (id: LibraryAgentId, enabled: boolean): Promise<PersonalLibrarySnapshot> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.setAgentEnabled.channel, id, enabled),
    resolvePersonalLibraryConflict: (id: LibraryAgentId, choice: "use-file" | "overwrite"): Promise<PersonalLibrarySnapshot> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.resolveConflict.channel, id, choice),
    listPersonalLibraryImports: (): Promise<LibraryImportCandidate[]> => ipc.invoke(PERSONAL_LIBRARY_IPC.importCandidates.channel),
    importPersonalLibraryParagraphs: (texts: string[], removeFromSources: boolean): Promise<PersonalLibrarySnapshot> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.importParagraphs.channel, texts, removeFromSources),
    savePersonalLibraryMcpServers: (servers: LibraryMcpServers): Promise<PersonalLibrarySnapshot> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.saveMcpServers.channel, servers),
    previewPersonalLibraryMcp: (id: LibraryAgentId, enabled: boolean): Promise<LibraryMcpPreview> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.previewMcp.channel, id, enabled),
    setPersonalLibraryMcpAgentEnabled: (id: LibraryAgentId, enabled: boolean): Promise<PersonalLibrarySnapshot> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.setMcpAgentEnabled.channel, id, enabled),
    overwritePersonalLibraryMcp: (id: LibraryAgentId): Promise<PersonalLibrarySnapshot> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.overwriteMcp.channel, id),
    listPersonalLibraryMcpImports: (): Promise<LibraryMcpImportCandidate[]> => ipc.invoke(PERSONAL_LIBRARY_IPC.mcpImportCandidates.channel),
    importPersonalLibraryMcpServers: (servers: Array<{ name: string; server: LibraryMcpServer }>): Promise<PersonalLibrarySnapshot> =>
      ipc.invoke(PERSONAL_LIBRARY_IPC.importMcpServers.channel, servers),
  };
}
