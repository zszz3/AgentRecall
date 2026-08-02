// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TeamChatEvent,
  TeamChatMessage,
  TeamChatRoom,
  TeamChatRoomSummary,
} from "../../shared/team-chat";

const configuredAgents = [
  {
    id: "codex-profile",
    name: "Codex",
    runtimeAgentId: "codex",
    channelId: "openai",
    modelId: "gpt-5",
    description: "Builder",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "claude-profile",
    name: "Claude",
    runtimeAgentId: "claude-code",
    channelId: "anthropic",
    modelId: "sonnet",
    description: "Reviewer",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  },
];

vi.mock("./features/automation/automation-provider", () => ({
  useAutomation: () => ({
    api: { pickDirectory: vi.fn(async () => undefined) },
    snapshot: {
      workDir: "/repo",
      configuredAgents,
    },
  }),
}));

import { TeamChatPage } from "./features/team-chat/team-chat-page";

const ROOM: TeamChatRoom = {
  id: "room-1",
  name: "Release room",
  workDir: "/repo",
  archived: false,
  agents: [{
    roomId: "room-1",
    agentId: "member-codex",
    configuredAgentId: "codex-profile",
    displayName: "Codex",
    runtimeId: "codex",
    channelId: "openai",
    modelId: "gpt-5",
    enabled: true,
    position: 0,
    joinedAt: "2026-07-24T00:00:00.000Z",
    continuationAvailable: true,
    hasActiveConversation: false,
  }],
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
};

const SUMMARY: TeamChatRoomSummary = {
  id: ROOM.id,
  name: ROOM.name,
  workDir: ROOM.workDir,
  archived: false,
  agentCount: 1,
  createdAt: ROOM.createdAt,
  updatedAt: ROOM.updatedAt,
};

describe("existing Studio employees", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onTeamChatEvent: (event: TeamChatEvent) => void;
  const updateRoom = vi.fn();
  const removeRoomMember = vi.fn();

  beforeEach(async () => {
    updateRoom.mockReset();
    removeRoomMember.mockReset();
    updateRoom.mockImplementation(async (request: {
      members: Array<{ memberId?: string; configuredAgentId: string; displayName: string }>;
    }) => ({
      ...ROOM,
      agents: request.members.map((member, position) => ({
        ...ROOM.agents[0]!,
        agentId: member.memberId ?? "member-claude",
        configuredAgentId: member.configuredAgentId,
        displayName: member.displayName,
        position,
      })),
    }));
    removeRoomMember.mockResolvedValue({ ...ROOM, agents: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    Reflect.set(Element.prototype, "scrollIntoView", vi.fn());
    Reflect.set(window, "sessionSearch", {
      teamChat: {
        getConnectionStatus: vi.fn(async () => ({
          state: "ready",
          mode: "local",
          databaseLabel: "AgentRecall database",
        })),
        connect: vi.fn(),
        listRooms: vi.fn(async () => [SUMMARY]),
        getRoom: vi.fn(async () => ROOM),
        listMessages: vi.fn(async () => ({ messages: [] })),
        updateRoom,
        removeRoomMember,
        onEvent: vi.fn((listener: (event: TeamChatEvent) => void) => {
          onTeamChatEvent = listener;
          return () => undefined;
        }),
      },
    });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(TeamChatPage, { language: "zh" }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("adds an employee while preserving the existing room member identity", async () => {
    const addButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="添加员工"]',
    );
    expect(addButton).not.toBeNull();

    await act(async () => addButton!.click());

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const nameInput = dialog!.querySelector<HTMLInputElement>(
      'input[aria-label="员工名称"]',
    );
    const runtimeSelect = dialog!.querySelector<HTMLSelectElement>(
      'select[aria-label="Runtime 配置"]',
    );
    expect(nameInput).not.toBeNull();
    expect(runtimeSelect).not.toBeNull();

    await act(async () => {
      runtimeSelect!.value = "claude-profile";
      runtimeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      nameInput!.value = "Claude";
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      dialog!.querySelector<HTMLFormElement>("form")!.requestSubmit();
      await Promise.resolve();
    });

    expect(updateRoom).toHaveBeenCalledWith({
      roomId: "room-1",
      members: [
        {
          memberId: "member-codex",
          configuredAgentId: "codex-profile",
          displayName: "Codex",
        },
        {
          configuredAgentId: "claude-profile",
          displayName: "Claude",
        },
      ],
    });
  });

  it("renders a room message table with readable cells and horizontal overflow", async () => {
    const message: TeamChatMessage = {
      id: "message-table",
      roomId: ROOM.id,
      sequence: 1,
      senderType: "agent",
      senderAgentId: "member-codex",
      senderName: "Codex",
      content: [
        "| 功能区 | 当前能力 |",
        "| --- | --- |",
        "| Chat | 多 Agent 工作室 |",
      ].join("\n"),
      deliveryType: "message",
      rootMessageId: "message-table",
      hop: 0,
      status: "final",
      createdAt: "2026-07-24T00:01:00.000Z",
      updatedAt: "2026-07-24T00:01:00.000Z",
    };

    await act(async () => {
      onTeamChatEvent({
        type: "message-created",
        roomId: ROOM.id,
        rootMessageId: message.rootMessageId,
        message,
      });
    });

    const content = container.querySelector(".team-chat-message-content");
    expect(content?.querySelector("table")?.textContent).toContain("多 Agent 工作室");
    expect(content?.querySelector(".md-table-wrap > table.md-table")).not.toBeNull();
  });

  it("offers employee deletion only from the member context menu", async () => {
    const memberRow = container.querySelector<HTMLElement>(".team-chat-member-row");
    expect(memberRow).not.toBeNull();
    expect(container.querySelector(".team-chat-member-context-menu")).toBeNull();

    await act(async () => {
      memberRow!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 40,
        clientY: 60,
      }));
    });

    const removeAction = container.querySelector<HTMLButtonElement>(
      ".team-chat-member-context-action",
    );
    expect(removeAction?.textContent).toContain("删除员工");
    await act(async () => {
      removeAction!.click();
      await Promise.resolve();
    });

    expect(removeRoomMember).toHaveBeenCalledWith({
      roomId: "room-1",
      memberId: "member-codex",
    });
    expect(updateRoom).not.toHaveBeenCalled();
  });
});
