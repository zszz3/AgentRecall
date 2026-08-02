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
  configuredAgentId: string;
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
  sequence: number;
  senderType: TeamChatSenderType;
  senderAgentId?: string;
  recipientMemberId?: string;
  senderName: string;
  content: string;
  deliveryType: "message" | "reply" | "post";
  rootMessageId: string;
  sourceMessageId?: string;
  hop: number;
  status: TeamChatMessageStatus;
  basedOnSequence?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamChatDispatch {
  id: string;
  roomId: string;
  mentionId?: string;
  taskId?: string;
  rootMessageId: string;
  sourceMessageId: string;
  targetAgentId: string;
  roomSnapshotSequence?: number;
  hop: number;
  status: TeamChatDispatchStatus;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamChatRoomMemberInput {
  memberId?: string;
  configuredAgentId: string;
  displayName: string;
}

export interface RemoveTeamChatRoomMemberRequest {
  roomId: string;
  memberId: string;
}

export interface TeamChatMention {
  memberId: string;
  start: number;
  end: number;
}

const MENTION_LEADING_BOUNDARY = /[\s,，。.!！?？:：;；([<{"'`]/u;

/**
 * Scans message text for `@displayName` mentions and resolves them to member ids.
 *
 * Display names may contain spaces and regex metacharacters, so candidates are
 * compared as plain strings (longest name first) instead of being interpolated
 * into a pattern. Longest-first matching keeps `@Codex2` from resolving to a
 * member named `Codex`.
 */
export function parseTeamChatMentions(
  content: string,
  members: readonly Pick<TeamChatRoomAgent, "agentId" | "displayName">[],
): TeamChatMention[] {
  const candidates = members
    .map((member) => ({ memberId: member.agentId, name: member.displayName.trim() }))
    .filter((candidate) => candidate.name.length > 0)
    .sort((left, right) => right.name.length - left.name.length);
  if (candidates.length === 0) return [];

  const lowered = content.toLocaleLowerCase();
  const mentions: TeamChatMention[] = [];
  const claimed = new Set<string>();
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "@") continue;
    const previous = content[index - 1];
    if (previous && !MENTION_LEADING_BOUNDARY.test(previous)) continue;
    const nameStart = index + 1;
    const match = candidates.find((candidate) =>
      lowered.startsWith(candidate.name.toLocaleLowerCase(), nameStart));
    if (!match) continue;
    const end = nameStart + match.name.length;
    // Reject a partial hit such as `@Codex` inside `@Codexington`.
    const following = content[end];
    if (following && !MENTION_LEADING_BOUNDARY.test(following) && following !== ")"
      && following !== "]" && following !== "}" && following !== ">") continue;
    if (!claimed.has(match.memberId)) {
      claimed.add(match.memberId);
      mentions.push({ memberId: match.memberId, start: index, end });
    }
    index = end - 1;
  }
  return mentions;
}

export function resolveMentionedMemberIds(
  content: string,
  members: readonly Pick<TeamChatRoomAgent, "agentId" | "displayName">[],
): string[] {
  return parseTeamChatMentions(content, members).map((mention) => mention.memberId);
}

/**
 * Cuts a mention out of a draft and closes the gap it leaves behind.
 *
 * Only the whitespace directly around the removed span is touched: collapsing
 * every run of whitespace would flatten blank lines and indentation elsewhere in
 * the draft.
 */
export function removeMentionFromText(
  content: string,
  mention: Pick<TeamChatMention, "start" | "end">,
): { text: string; cursor: number } {
  const before = content.slice(0, mention.start);
  const after = content.slice(mention.end);
  const joinsWords = /[^\S\n]$/u.test(before) && /^[^\S\n]/u.test(after);
  const text = joinsWords ? `${before}${after.replace(/^[^\S\n]+/u, "")}` : `${before}${after}`;
  return { text, cursor: Math.min(before.length, text.length) };
}

export interface TeamChatWorkspaceReservation {
  roomId: string;
  memberId: string;
  relativePath: string;
  reason?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTeamChatRoomRequest {
  name: string;
  workDir: string;
  members: TeamChatRoomMemberInput[];
}

export interface UpdateTeamChatRoomRequest {
  roomId: string;
  name?: string;
  workDir?: string;
  members?: TeamChatRoomMemberInput[];
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
  targetMemberIds: string[];
  replyToMessageId?: string;
}

export interface ResetTeamChatAgentSessionRequest {
  roomId: string;
  agentId: string;
}

export interface SendTeamChatMessageResult {
  message: TeamChatMessage;
  rootMessageId: string;
  rejectedTargetMemberIds: string[];
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
