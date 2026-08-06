import type { TeamChatMessage } from "../../../../shared/team-chat";

export interface TeamChatStreamDraft {
  dispatchId: string;
  rootMessageId: string;
  agentId: string;
  agentName: string;
  content: string;
}

export type TeamChatTranscriptItem =
  | { kind: "message"; message: TeamChatMessage }
  | { kind: "stream"; stream: TeamChatStreamDraft };

export function orderTeamChatTranscript(
  messages: TeamChatMessage[],
  streams: TeamChatStreamDraft[],
): TeamChatTranscriptItem[] {
  const rootSequences = new Map(messages.map((message) => [message.id, message.sequence]));
  const items: TeamChatTranscriptItem[] = [
    ...messages.map((message): TeamChatTranscriptItem => ({ kind: "message", message })),
    ...streams.map((stream): TeamChatTranscriptItem => ({ kind: "stream", stream })),
  ];

  return items.sort((left, right) => {
    const leftRootSequence = transcriptRootSequence(left, rootSequences);
    const rightRootSequence = transcriptRootSequence(right, rootSequences);
    if (leftRootSequence !== rightRootSequence) return leftRootSequence - rightRootSequence;

    if (left.kind === "message" && right.kind === "message") {
      return left.message.sequence - right.message.sequence || left.message.id.localeCompare(right.message.id);
    }
    if (left.kind === "message") return -1;
    if (right.kind === "message") return 1;
    return left.stream.dispatchId.localeCompare(right.stream.dispatchId);
  });
}

function transcriptRootSequence(
  item: TeamChatTranscriptItem,
  rootSequences: Map<string, number>,
): number {
  if (item.kind === "stream") {
    return rootSequences.get(item.stream.rootMessageId) ?? Number.MAX_SAFE_INTEGER;
  }
  return rootSequences.get(item.message.rootMessageId)
    ?? item.message.basedOnSequence
    ?? item.message.sequence;
}
