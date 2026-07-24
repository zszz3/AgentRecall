import type { RuntimeConversation } from "../../automation/contracts";
import type {
  ListTeamChatMessagesRequest,
  TeamChatDispatch,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomSummary,
} from "../../shared/team-chat";

export interface TeamChatDispatchUpdate {
  status: TeamChatDispatch["status"];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface TeamChatAgentSession {
  roomId: string;
  agentId: string;
  runtimeId: string;
  channelId: string;
  modelId: string;
  runtimeConversation: RuntimeConversation;
  lastContextMessageId?: string;
  updatedAt: string;
}

export interface TeamChatContextPage {
  messages: TeamChatMessage[];
  truncated: boolean;
}

export interface TeamChatStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listRooms(): Promise<TeamChatRoomSummary[]>;
  getRoom(roomId: string): Promise<TeamChatRoom | undefined>;
  createRoom(room: TeamChatRoom): Promise<TeamChatRoom>;
  updateRoom(room: TeamChatRoom): Promise<TeamChatRoom>;
  archiveRoom(roomId: string, updatedAt: string): Promise<void>;
  listMessages(request: ListTeamChatMessagesRequest): Promise<TeamChatMessagePage>;
  listMessagesAfter(roomId: string, afterMessageId: string, limit: number): Promise<TeamChatContextPage>;
  insertMessage(message: TeamChatMessage): Promise<TeamChatMessage>;
  insertDispatch(dispatch: TeamChatDispatch): Promise<TeamChatDispatch>;
  updateDispatch(dispatchId: string, patch: TeamChatDispatchUpdate): Promise<void>;
  markRunningDispatchesInterrupted(updatedAt: string): Promise<void>;
  listAgentSessions(roomId: string): Promise<TeamChatAgentSession[]>;
  upsertAgentSession(session: TeamChatAgentSession): Promise<void>;
  deleteAgentSession(roomId: string, agentId: string): Promise<void>;
}
