import type { TeamChatMessage, TeamChatRoom, TeamChatRoomAgent } from "../../shared/team-chat";

const MAX_CONTEXT_MESSAGES = 40;
const MAX_CONTEXT_CHARACTERS = 48_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(content: string, displayName: string): boolean {
  const name = displayName.trim();
  if (!name) return false;
  return new RegExp(`(?:^|[\\s,，。.!！?？:：;；(\\[<{])@${escapeRegExp(name)}(?=$|[\\s,，。.!！?？:：;；)\\]}>])`, "iu").test(content);
}

function mentionTokens(content: string): string[] {
  const tokens: string[] = [];
  const pattern = /(?:^|[\s,，。.!！?？:：;；(\[<{])@([^\s,，。.!！?？:：;；)\]}>]+)/gu;
  for (const match of content.matchAll(pattern)) {
    const token = match[1]?.trim();
    if (token && !tokens.some((item) => item.toLocaleLowerCase() === token.toLocaleLowerCase())) tokens.push(token);
  }
  return tokens;
}

export interface TeamChatRoute {
  targetAgentIds: string[];
  explicitMention: boolean;
  mentionedNames: string[];
}

export function resolveTeamChatRoute(
  content: string,
  members: TeamChatRoomAgent[],
  senderType: "human" | "agent",
): TeamChatRoute {
  const ordered = [...members].sort((left, right) => left.position - right.position);
  const matched = [...ordered]
    .sort((left, right) => right.displayName.length - left.displayName.length)
    .filter((member) => mentions(content, member.displayName));
  const matchedIds = new Set(matched.map((member) => member.agentId));
  const tokens = mentionTokens(content);
  const explicitMention = matchedIds.size > 0 || tokens.length > 0;
  const enabled = ordered.filter((member) => member.enabled);
  const targetAgentIds = explicitMention
    ? enabled.filter((member) => matchedIds.has(member.agentId)).map((member) => member.agentId)
    : senderType === "human" ? enabled.map((member) => member.agentId) : [];
  return {
    targetAgentIds,
    explicitMention,
    mentionedNames: matched.length > 0 ? matched.map((member) => member.displayName) : tokens,
  };
}

export function resolveTeamChatTargets(
  content: string,
  members: TeamChatRoomAgent[],
  senderType: "human" | "agent",
): string[] {
  return resolveTeamChatRoute(content, members, senderType).targetAgentIds;
}

function transcriptWithinBudget(messages: TeamChatMessage[]): TeamChatMessage[] {
  const recent = messages.slice(-MAX_CONTEXT_MESSAGES);
  const selected: TeamChatMessage[] = [];
  let characters = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const formattedLength = message.content.length + message.senderName.length + message.createdAt.length + 8;
    if (selected.length > 0 && characters + formattedLength > MAX_CONTEXT_CHARACTERS) break;
    selected.push(message);
    characters += formattedLength;
  }
  return selected.reverse();
}

export function buildTeamChatPrompt(input: {
  room: TeamChatRoom;
  target: TeamChatRoomAgent;
  messages: TeamChatMessage[];
  triggerMessage: TeamChatMessage;
  executedAgentIds: string[];
  remainingExecutions: number;
}): string {
  const byId = new Map(input.room.agents.map((agent) => [agent.agentId, agent.displayName]));
  const executed = input.executedAgentIds.map((id) => byId.get(id) ?? id);
  const transcript = transcriptWithinBudget(input.messages)
    .map((message) => `[${message.createdAt}] ${message.senderName}: ${message.content}`)
    .join("\n");
  const memberNames = input.room.agents
    .filter((agent) => agent.enabled)
    .sort((left, right) => left.position - right.position)
    .map((agent) => `@${agent.displayName}`)
    .join(", ");

  return [
    "You are participating in a persistent multi-Agent room.",
    `Room: ${input.room.name}`,
    `You are ${input.target.displayName}.`,
    `Room members: ${memberNames || "none"}`,
    `Already executed: ${executed.length > 0 ? executed.join(", ") : "none"}`,
    `Remaining Agent executions: ${input.remainingExecutions}`,
    "Reply directly to the room. Do not invent messages from other members.",
    "If another room member must continue the work, mention that member by exact @name.",
    "",
    "Recent room transcript:",
    transcript || "(empty)",
    "",
    `Current triggering message from ${input.triggerMessage.senderName}:`,
    input.triggerMessage.content,
  ].join("\n");
}
