import type { IpcRenderer } from "electron";
import type {
  CreateTeamChatRoomRequest,
  ListTeamChatMessagesRequest,
  ResetTeamChatAgentSessionRequest,
  SendTeamChatMessageRequest,
  SendTeamChatMessageResult,
  TeamChatConnectionStatus,
  TeamChatEvent,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomSummary,
  UpdateTeamChatRoomRequest,
} from "../shared/team-chat";
import { TEAM_CHAT_CHANNELS } from "../shared/ipc/team-chat";

export type TeamChatIpcRenderer = Pick<IpcRenderer, "invoke" | "on" | "removeListener">;

export function createTeamChatApi(ipc: TeamChatIpcRenderer) {
  return {
    getConnectionStatus: (): Promise<TeamChatConnectionStatus> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.connectionStatus),
    connect: (connectionUrl?: string): Promise<TeamChatConnectionStatus> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.connectionConnect, connectionUrl === undefined ? {} : { connectionUrl }),
    useLocalDatabase: (): Promise<TeamChatConnectionStatus> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.connectionUseLocal),
    disconnect: (): Promise<TeamChatConnectionStatus> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.connectionDisconnect),
    listRooms: (): Promise<TeamChatRoomSummary[]> => ipc.invoke(TEAM_CHAT_CHANNELS.roomsList),
    getRoom: (roomId: string): Promise<TeamChatRoom | undefined> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.roomsGet, roomId),
    createRoom: (request: CreateTeamChatRoomRequest): Promise<TeamChatRoom> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.roomsCreate, request),
    updateRoom: (request: UpdateTeamChatRoomRequest): Promise<TeamChatRoom> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.roomsUpdate, request),
    archiveRoom: (roomId: string): Promise<void> => ipc.invoke(TEAM_CHAT_CHANNELS.roomsArchive, roomId),
    listMessages: (request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.messagesList, request),
    sendMessage: (request: SendTeamChatMessageRequest): Promise<SendTeamChatMessageResult> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.messagesSend, request),
    stopTurn: (rootMessageId: string): Promise<boolean> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.turnsStop, rootMessageId),
    resetAgentSession: (request: ResetTeamChatAgentSessionRequest): Promise<TeamChatRoom> =>
      ipc.invoke(TEAM_CHAT_CHANNELS.agentSessionReset, request),
    onEvent: (callback: (event: TeamChatEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: TeamChatEvent) => callback(event);
      ipc.on(TEAM_CHAT_CHANNELS.event, listener);
      return () => ipc.removeListener(TEAM_CHAT_CHANNELS.event, listener);
    },
  };
}

export type TeamChatApi = ReturnType<typeof createTeamChatApi>;
