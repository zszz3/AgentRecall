import { z } from "zod";
import { TEAM_CHAT_CHANNELS } from "../../shared/ipc/team-chat";
import type { TeamChatService } from "../team-chat/team-chat-service";

interface TeamChatIpcMainLike {
  handle(channel: string, handler: (event: unknown, value?: unknown) => unknown): void;
  removeHandler?(channel: string): void;
}

interface RegisterTeamChatIpcOptions {
  ipc: TeamChatIpcMainLike;
  service: TeamChatService;
  send: (channel: string, payload: unknown) => void;
  ensureReady?: () => Promise<void>;
}

const idSchema = z.string().trim().min(1).max(200);
const agentIdsSchema = z.array(idSchema).min(1).max(24).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Room Agents must be unique." });
  }
});
const roomCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  workDir: z.string().trim().max(4_096),
  agentIds: agentIdsSchema,
}).strict();
const roomUpdateSchema = z.object({
  roomId: idSchema,
  name: z.string().trim().min(1).max(120).optional(),
  workDir: z.string().trim().max(4_096).optional(),
  agentIds: agentIdsSchema.optional(),
}).strict();
const messageListSchema = z.object({
  roomId: idSchema,
  before: idSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const messageSendSchema = z.object({
  roomId: idSchema,
  content: z.string().trim().min(1).max(100_000),
}).strict();
const agentSessionResetSchema = z.object({
  roomId: idSchema,
  agentId: idSchema,
}).strict();

export function registerTeamChatIpc({ ipc, service, send, ensureReady }: RegisterTeamChatIpcOptions): () => void {
  const channels: string[] = [];
  const handle = (
    channel: string,
    handler: (value: unknown) => unknown,
    options: { requiresReady?: boolean } = {},
  ): void => {
    channels.push(channel);
    ipc.handle(channel, async (_event, value) => {
      if (options.requiresReady !== false) await ensureReady?.();
      return handler(value);
    });
  };

  handle(TEAM_CHAT_CHANNELS.connectionStatus, () => service.getConnectionStatus(), { requiresReady: false });
  handle(TEAM_CHAT_CHANNELS.connectionConnect, () => service.connect());
  handle(TEAM_CHAT_CHANNELS.connectionUseLocal, () => service.useLocalDatabase());
  handle(TEAM_CHAT_CHANNELS.connectionDisconnect, () => service.disconnect(), { requiresReady: false });
  handle(TEAM_CHAT_CHANNELS.roomsList, () => service.listRooms());
  handle(TEAM_CHAT_CHANNELS.roomsGet, (value) => service.getRoom(idSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.roomsCreate, (value) => service.createRoom(roomCreateSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.roomsUpdate, (value) => service.updateRoom(roomUpdateSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.roomsArchive, (value) => service.archiveRoom(idSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.messagesList, (value) => service.listMessages(messageListSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.messagesSend, (value) => service.sendMessage(messageSendSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.turnsStop, (value) => service.stopTurn(idSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.agentSessionReset, (value) => {
    const request = agentSessionResetSchema.parse(value);
    return service.resetAgentSession(request.roomId, request.agentId);
  });

  const unsubscribe = service.subscribe((event) => send(TEAM_CHAT_CHANNELS.event, event));
  return () => {
    unsubscribe();
    for (const channel of channels) ipc.removeHandler?.(channel);
  };
}
