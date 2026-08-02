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
const memberSchema = z.object({
  memberId: idSchema.optional(),
  configuredAgentId: idSchema,
  displayName: z.string().trim().min(1).max(120),
}).strict();
const membersSchema = z.array(memberSchema).max(24).superRefine((members, context) => {
  const memberIds = members
    .map((member) => member.memberId)
    .filter((memberId): memberId is string => Boolean(memberId));
  if (new Set(memberIds).size !== memberIds.length) {
    context.addIssue({ code: "custom", message: "Studio employee IDs must be unique." });
  }
  const names = members.map((member) => member.displayName.toLocaleLowerCase());
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "Studio employee names must be unique." });
  }
});
const roomCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  workDir: z.string().trim().max(4_096),
  members: membersSchema.refine((members) => members.length > 0, "Select at least one employee for the studio."),
}).strict();
const roomUpdateSchema = z.object({
  roomId: idSchema,
  name: z.string().trim().min(1).max(120).optional(),
  workDir: z.string().trim().max(4_096).optional(),
  members: membersSchema.optional(),
}).strict();
const roomMemberRemoveSchema = z.object({
  roomId: idSchema,
  memberId: idSchema,
}).strict();
const messageListSchema = z.object({
  roomId: idSchema,
  before: idSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const messageSendSchema = z.object({
  roomId: idSchema,
  content: z.string().trim().min(1).max(100_000),
  targetMemberIds: z.array(idSchema).max(8).superRefine((memberIds, context) => {
    if (new Set(memberIds).size !== memberIds.length) {
      context.addIssue({ code: "custom", message: "Message recipients must be unique." });
    }
  }),
  replyToMessageId: idSchema.optional(),
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
  handle(TEAM_CHAT_CHANNELS.roomsList, async () => {
    await service.connect();
    return service.listRooms();
  });
  handle(TEAM_CHAT_CHANNELS.roomsGet, (value) => service.getRoom(idSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.roomsCreate, (value) => service.createRoom(roomCreateSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.roomsUpdate, (value) => service.updateRoom(roomUpdateSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.roomsRemoveMember, (value) => {
    const request = roomMemberRemoveSchema.parse(value);
    return service.removeRoomMember(request.roomId, request.memberId);
  });
  handle(TEAM_CHAT_CHANNELS.roomsArchive, (value) => service.archiveRoom(idSchema.parse(value)));
  handle(TEAM_CHAT_CHANNELS.roomsDelete, (value) => service.deleteRoom(idSchema.parse(value)));
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
