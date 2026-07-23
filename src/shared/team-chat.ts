export type TeamChatConnectionState = "unconfigured" | "connecting" | "ready" | "error";
export type TeamChatConnectionMode = "local" | "external";
export type TeamChatSenderType = "human" | "agent" | "system";
export type TeamChatMessageStatus = "final" | "error";
export type TeamChatDispatchStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "skipped";

export interface TeamChatConnectionStatus {
  state: TeamChatConnectionState;
  mode?: TeamChatConnectionMode;
  databaseLabel?: string;
  error?: string;
}

export interface TeamChatRoomAgent {
  roomId: string;
  agentId: string;
  displayName: string;
  runtimeId: string;
  channelId: string;
  modelId: string;
  enabled: boolean;
  position: number;
  joinedAt: string;
  continuationAvailable: boolean;
  hasActiveConversation: boolean;
  conversationUpdatedAt?: string;
}

export interface TeamChatRoomSummary {
  id: string;
  name: string;
  workDir: string;
  archived: boolean;
  agentCount: number;
  lastMessage?: string;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamChatRoom {
  id: string;
  name: string;
  workDir: string;
  archived: boolean;
  agents: TeamChatRoomAgent[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamChatMessage {
  id: string;
  roomId: string;
  senderType: TeamChatSenderType;
  senderAgentId?: string;
  senderName: string;
  content: string;
  rootMessageId: string;
  sourceMessageId?: string;
  hop: number;
  status: TeamChatMessageStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TeamChatDispatch {
  id: string;
  roomId: string;
  rootMessageId: string;
  sourceMessageId: string;
  targetAgentId: string;
  hop: number;
  status: TeamChatDispatchStatus;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTeamChatRoomRequest {
  name: string;
  workDir: string;
  agentIds: string[];
}

export interface UpdateTeamChatRoomRequest {
  roomId: string;
  name?: string;
  workDir?: string;
  agentIds?: string[];
}

export interface ListTeamChatMessagesRequest {
  roomId: string;
  before?: string;
  limit?: number;
}

export interface TeamChatMessagePage {
  messages: TeamChatMessage[];
  nextBefore?: string;
}

export interface SendTeamChatMessageRequest {
  roomId: string;
  content: string;
}

export interface ResetTeamChatAgentSessionRequest {
  roomId: string;
  agentId: string;
}

export interface SendTeamChatMessageResult {
  message: TeamChatMessage;
  rootMessageId: string;
}

export type TeamChatEvent =
  | { type: "connection-changed"; status: TeamChatConnectionStatus }
  | { type: "rooms-changed" }
  | { type: "agent-session-changed"; roomId: string; agentId: string }
  | { type: "message-created"; roomId: string; rootMessageId: string; message: TeamChatMessage }
  | {
      type: "dispatch-started";
      roomId: string;
      rootMessageId: string;
      dispatchId: string;
      agentId: string;
      agentName: string;
    }
  | {
      type: "dispatch-delta";
      roomId: string;
      rootMessageId: string;
      dispatchId: string;
      agentId: string;
      content: string;
    }
  | {
      type: "dispatch-finished";
      roomId: string;
      rootMessageId: string;
      dispatchId: string;
      agentId: string;
      status: Extract<TeamChatDispatchStatus, "completed" | "failed" | "interrupted">;
      error?: string;
    }
  | { type: "turn-finished"; roomId: string; rootMessageId: string };
