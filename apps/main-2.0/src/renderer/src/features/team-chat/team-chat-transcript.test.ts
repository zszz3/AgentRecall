import { describe, expect, it } from "vitest";
import type { TeamChatMessage } from "../../../../shared/team-chat";
import { orderTeamChatTranscript, type TeamChatStreamDraft } from "./team-chat-transcript";

function message(input: {
  id: string;
  sequence: number;
  rootMessageId?: string;
  senderType?: TeamChatMessage["senderType"];
  basedOnSequence?: number;
}): TeamChatMessage {
  return {
    id: input.id,
    roomId: "room-1",
    sequence: input.sequence,
    senderType: input.senderType ?? "human",
    senderName: input.senderType === "agent" ? "Agent" : "You",
    content: input.id,
    deliveryType: input.senderType === "agent" ? "reply" : "message",
    rootMessageId: input.rootMessageId ?? input.id,
    hop: input.senderType === "agent" ? 1 : 0,
    status: "final",
    ...(input.basedOnSequence !== undefined ? { basedOnSequence: input.basedOnSequence } : {}),
    createdAt: "2026-08-06T03:00:00.000Z",
    updatedAt: "2026-08-06T03:00:00.000Z",
  };
}

function itemId(item: ReturnType<typeof orderTeamChatTranscript>[number]): string {
  return item.kind === "message" ? item.message.id : item.stream.dispatchId;
}

describe("orderTeamChatTranscript", () => {
  it("keeps each answer below its question when answers finish in reverse order", () => {
    const messages = [
      message({ id: "question-1", sequence: 1 }),
      message({ id: "question-2", sequence: 2 }),
      message({ id: "question-3", sequence: 3 }),
      message({ id: "answer-3", sequence: 4, rootMessageId: "question-3", senderType: "agent" }),
      message({ id: "answer-2", sequence: 5, rootMessageId: "question-2", senderType: "agent" }),
      message({ id: "answer-1", sequence: 6, rootMessageId: "question-1", senderType: "agent" }),
    ];

    expect(orderTeamChatTranscript(messages, []).map(itemId)).toEqual([
      "question-1",
      "answer-1",
      "question-2",
      "answer-2",
      "question-3",
      "answer-3",
    ]);
  });

  it("places running responses below the question that started them", () => {
    const messages = [
      message({ id: "question-1", sequence: 1 }),
      message({ id: "question-2", sequence: 2 }),
    ];
    const streams: TeamChatStreamDraft[] = [
      { dispatchId: "stream-2", rootMessageId: "question-2", agentId: "agent-2", agentName: "Agent 2", content: "" },
      { dispatchId: "stream-1", rootMessageId: "question-1", agentId: "agent-1", agentName: "Agent 1", content: "" },
    ];

    expect(orderTeamChatTranscript(messages, streams).map(itemId)).toEqual([
      "question-1",
      "stream-1",
      "question-2",
      "stream-2",
    ]);
  });
});
