import { describe, expect, it } from "vitest";
import type { TeamChatMessage, TeamChatRoom, TeamChatRoomAgent } from "../../shared/team-chat";
import { buildTeamChatPrompt, resolveTeamChatTargets } from "./team-chat-routing";

const joinedAt = "2026-07-23T08:00:00.000Z";

function member(agentId: string, displayName: string, position: number): TeamChatRoomAgent {
  return {
    roomId: "room-1",
    agentId,
    displayName,
    runtimeId: "codex",
    channelId: "codex-main",
    modelId: "gpt-5",
    enabled: true,
    position,
    joinedAt,
  };
}

const members = [member("builder", "Builder", 0), member("reviewer", "Reviewer", 1)];

describe("resolveTeamChatTargets", () => {
  it("routes a human message with an explicit mention only to that Agent", () => {
    expect(resolveTeamChatTargets("请 @Reviewer 检查", members, "human")).toEqual(["reviewer"]);
  });

  it("routes an unmentioned human message to all enabled room Agents", () => {
    expect(resolveTeamChatTargets("一起看看", members, "human")).toEqual(["builder", "reviewer"]);
  });

  it("does not continue an Agent reply unless it mentions another Agent", () => {
    expect(resolveTeamChatTargets("完成了", members, "agent")).toEqual([]);
    expect(resolveTeamChatTargets("交给 @Builder", members, "agent")).toEqual(["builder"]);
  });

  it("matches overlapping names literally and returns members in room order", () => {
    const overlapping = [member("ann", "Ann", 0), member("anna", "Anna", 1), member("regex", "QA+", 2)];

    expect(resolveTeamChatTargets("@Anna 继续，@Ann 请看，最后 @QA+", overlapping, "human"))
      .toEqual(["ann", "anna", "regex"]);
  });

  it("does not broadcast when an explicit mention targets an unavailable or unknown member", () => {
    const disabled = { ...members[1]!, enabled: false };
    expect(resolveTeamChatTargets("@Reviewer 检查", [members[0]!, disabled], "human")).toEqual([]);
    expect(resolveTeamChatTargets("@Unknown 检查", members, "human")).toEqual([]);
  });
});

describe("buildTeamChatPrompt", () => {
  it("keeps chronological recent context and exposes deterministic turn state", () => {
    const room: TeamChatRoom = {
      id: "room-1",
      name: "Release room",
      workDir: "/synthetic/repo",
      archived: false,
      agents: members,
      createdAt: joinedAt,
      updatedAt: joinedAt,
    };
    const messages: TeamChatMessage[] = Array.from({ length: 50 }, (_, index) => ({
      id: `message-${index}`,
      roomId: room.id,
      senderType: index % 2 === 0 ? "human" : "agent",
      senderAgentId: index % 2 === 0 ? undefined : "builder",
      senderName: index % 2 === 0 ? "You" : "Builder",
      content: `message-${index} ${"x".repeat(2_000)}`,
      rootMessageId: "message-0",
      sourceMessageId: index === 0 ? undefined : `message-${index - 1}`,
      hop: Math.floor(index / 2),
      status: "final",
      createdAt: new Date(Date.parse(joinedAt) + index * 1_000).toISOString(),
      updatedAt: new Date(Date.parse(joinedAt) + index * 1_000).toISOString(),
    }));

    const prompt = buildTeamChatPrompt({
      room,
      target: members[1]!,
      messages,
      triggerMessage: messages.at(-1)!,
      executedAgentIds: ["builder"],
      remainingExecutions: 7,
    });

    expect(prompt).toContain("Release room");
    expect(prompt).toContain("You are Reviewer");
    expect(prompt).toContain("Already executed: Builder");
    expect(prompt).toContain("Remaining Agent executions: 7");
    expect(prompt).not.toContain("message-0 ");
    expect(prompt.indexOf("message-30 ")).toBeLessThan(prompt.indexOf("message-49 "));
    expect(prompt.length).toBeLessThanOrEqual(50_500);
  });
});
