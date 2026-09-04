// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateTeamChatRoomRequest,
  ListTeamChatMessagesRequest,
  SendTeamChatMessageRequest,
  SendTeamChatMessageResult,
  TeamChatEvent,
  TeamChatMessage,
  TeamChatMessagePage,
  TeamChatRoom,
  TeamChatRoomSummary,
} from "../../../../shared/team-chat";

const automationFixture = vi.hoisted(() => ({
  api: {
    pickDirectory: vi.fn(async () => undefined),
  },
  snapshot: {
    workDir: "/workspace/project",
    configuredAgents: [{
      id: "builder-profile",
      name: "Builder",
      description: "Builds the project",
      runtimeAgentId: "codex",
      channelId: "codex",
      modelId: "gpt-5",
      tags: [],
      createdAt: 0,
      updatedAt: 0,
    }],
  },
}));

vi.mock("../automation/automation-provider", () => ({
  useAutomationDetails: () => automationFixture,
}));

import { TeamChatPage } from "./team-chat-page";

describe("TeamChatPage rooms", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fixture: ReturnType<typeof createTeamChatFixture>;
  let teamChat: ReturnType<typeof createTeamChatFixture>;
  let resolveRuntimeInvocationSession = vi.fn();

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fixture = createTeamChatFixture();
    teamChat = fixture;
    resolveRuntimeInvocationSession = vi.fn(async () => ({ status: "not_recorded" as const }));
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: { teamChat, resolveRuntimeInvocationSession },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("lets a newly created room be permanently deleted from the room list", async () => {
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(teamChat.listRooms).toHaveBeenCalled());

    const openCreate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create room");
    expect(openCreate).toBeDefined();
    await act(async () => openCreate?.click());

    const roomName = container.querySelector<HTMLInputElement>('input[placeholder="Release review"]');
    expect(roomName).not.toBeNull();
    await typeInto(roomName!, "Launch room");

    const create = [...container.querySelectorAll<HTMLButtonElement>(".team-chat-dialog footer button")]
      .find((button) => button.textContent?.includes("Create room"));
    expect(create?.disabled).toBe(false);
    await act(async () => create?.click());

    await vi.waitFor(() => {
      expect(teamChat.createRoom).toHaveBeenCalledWith({
        name: "Launch room",
        workDir: "/workspace/project",
        members: [{ configuredAgentId: "builder-profile", displayName: "Builder" }],
      });
      expect(container.querySelector(".team-chat-room-item.active")).not.toBeNull();
    });

    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete room “Launch room”"]',
    );
    expect(deleteButton).not.toBeNull();
    await act(async () => deleteButton?.click());

    await vi.waitFor(() => {
      expect(window.confirm).toHaveBeenCalledWith(
        "Permanently delete “Launch room” and all of its messages? This cannot be undone.",
      );
      expect(teamChat.deleteRoom).toHaveBeenCalledWith("room-new");
      expect(container.querySelector(".team-chat-room-item")).toBeNull();
    });
  });

  it("keeps the active room open when a different room is deleted", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
    ]);
    fixture.setRoomMessages("room-alpha", [
      messageFixture("alpha-message", "room-alpha", 1, "Alpha stays visible"),
    ]);
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    await vi.waitFor(() => expect(container.textContent).toContain("Alpha stays visible"));
    await typeInto(composer(container), "Keep this draft");

    const deleteBeta = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete room “Beta”"]',
    );
    expect(deleteBeta).not.toBeNull();
    await act(async () => deleteBeta?.click());

    await vi.waitFor(() => {
      expect(teamChat.deleteRoom).toHaveBeenCalledWith("room-beta");
      expect(container.querySelector('button[aria-label="Delete room “Beta”"]')).toBeNull();
      expect(container.querySelector(".team-chat-room-title strong")?.textContent).toBe("Alpha");
      expect(container.textContent).toContain("Alpha stays visible");
      expect(composer(container).value).toBe("Keep this draft");
    });
  });

  it("opens the latest Session recorded for the active room", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    resolveRuntimeInvocationSession.mockResolvedValue({
      status: "found",
      session: { sessionKey: "session-1" },
    });
    const onOpenSession = vi.fn();

    await act(async () => root.render(
      <TeamChatPage language="en" onOpenSession={onOpenSession} />,
    ));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    const sessionButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open latest Session"]',
    );
    if (!sessionButton) throw new Error("Open latest Session button was not rendered");

    await act(async () => {
      sessionButton.click();
      await Promise.resolve();
    });

    expect(resolveRuntimeInvocationSession).toHaveBeenCalledWith({
      surface: "team_chat",
      role: "member",
      ownerReference: { roomId: "room-alpha" },
    });
    expect(onOpenSession).toHaveBeenCalledWith("session-1");
  });

  it("opens the Session recorded for an individual agent message", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    fixture.setRoomMessages("room-alpha", [{
      ...messageFixture("agent-message", "room-alpha", 2, "Done"),
      senderType: "agent",
      senderAgentId: "member-1",
      senderName: "Builder",
      sourceMessageId: "human-message",
    }]);
    resolveRuntimeInvocationSession.mockResolvedValue({
      status: "found",
      session: { sessionKey: "session-message" },
    });
    const onOpenSession = vi.fn();

    await act(async () => root.render(
      <TeamChatPage language="en" onOpenSession={onOpenSession} />,
    ));
    await vi.waitFor(() => expect(container.textContent).toContain("Done"));
    const sessionButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Session for Builder"]',
    );
    if (!sessionButton) throw new Error("Message Session button was not rendered");

    await act(async () => {
      sessionButton.click();
      await Promise.resolve();
    });

    expect(resolveRuntimeInvocationSession).toHaveBeenCalledWith({
      surface: "team_chat",
      role: "member",
      ownerReference: {
        roomId: "room-alpha",
        messageId: "human-message",
        agentId: "member-1",
      },
    });
    expect(onOpenSession).toHaveBeenCalledWith("session-message");
  });

  it("clears deleted room details after switching rooms during a pending delete", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
    ]);
    const deletion = deferred<void>();
    teamChat.deleteRoom.mockImplementationOnce(async (roomId: string) => {
      await deletion.promise;
      fixture.removeRoom(roomId);
    });
    teamChat.getRoom.mockImplementation(async (roomId: string) => {
      if (roomId === "room-beta") throw new Error("Beta failed to load.");
      return fixture.findRoom(roomId);
    });

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    const deleteAlpha = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete room “Alpha”"]',
    );
    expect(deleteAlpha).not.toBeNull();
    await act(async () => deleteAlpha?.click());
    await vi.waitFor(() => {
      expect(teamChat.deleteRoom).toHaveBeenCalledTimes(1);
      expect(deleteAlpha?.disabled).toBe(false);
      expect(deleteAlpha?.getAttribute("aria-disabled")).toBe("true");
      expect(deleteAlpha?.getAttribute("aria-busy")).toBe("true");
    });

    await act(async () => deleteAlpha?.click());
    expect(teamChat.deleteRoom).toHaveBeenCalledTimes(1);

    const selectBeta = [...container.querySelectorAll<HTMLButtonElement>(".team-chat-room-select")]
      .find((button) => button.querySelector("strong")?.textContent === "Beta");
    expect(selectBeta).toBeDefined();
    await act(async () => selectBeta?.click());
    await vi.waitFor(() => expect(teamChat.getRoom).toHaveBeenCalledWith("room-beta"));

    await act(async () => {
      deletion.resolve();
      await deletion.promise;
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".team-chat-room-title")).toBeNull();
      expect(container.querySelector(".team-chat-room-item.active strong")?.textContent).toBe("Beta");
    });
  });

  it("keeps a newly loaded room when its load and the previous room deletion finish together", async () => {
    const alpha = roomFixture("room-alpha", "Alpha");
    const beta = roomFixture("room-beta", "Beta");
    fixture.setRooms([alpha, beta]);
    const deletion = deferred<void>();
    const betaLoad = deferred<TeamChatRoom | undefined>();
    teamChat.deleteRoom.mockImplementationOnce(async (roomId: string) => {
      await deletion.promise;
      fixture.removeRoom(roomId);
    });
    teamChat.getRoom.mockImplementation(async (roomId: string) => {
      if (roomId === beta.id) return betaLoad.promise;
      return fixture.findRoom(roomId);
    });
    teamChat.listMessages.mockImplementation(async (request: ListTeamChatMessagesRequest) => ({
      messages: request.roomId === beta.id
        ? [messageFixture("beta-message", beta.id, 1, "Beta message")]
        : [],
    }));

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    const deleteAlpha = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete room “Alpha”"]',
    );
    await act(async () => deleteAlpha?.click());
    await vi.waitFor(() => expect(teamChat.deleteRoom).toHaveBeenCalledWith(alpha.id));

    const selectBeta = [...container.querySelectorAll<HTMLButtonElement>(".team-chat-room-select")]
      .find((button) => button.querySelector("strong")?.textContent === "Beta");
    await act(async () => selectBeta?.click());
    await vi.waitFor(() => expect(teamChat.getRoom).toHaveBeenCalledWith(beta.id));

    await act(async () => {
      betaLoad.resolve(beta);
      deletion.resolve();
      await Promise.all([betaLoad.promise, deletion.promise]);
    });
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));
    expect(container.textContent).toContain("Beta message");
  });

  it("does not revive a deleted room when an older room refresh resolves last", async () => {
    const alpha = roomFixture("room-alpha", "Alpha");
    const beta = roomFixture("room-beta", "Beta");
    fixture.setRooms([alpha, beta]);
    const staleRefresh = deferred<TeamChatRoomSummary[]>();
    const staleSnapshot = [roomSummary(alpha), roomSummary(beta)];
    let listCall = 0;
    teamChat.listRooms.mockImplementation(async () => {
      listCall += 1;
      if (listCall === 2) return staleRefresh.promise;
      return fixture.roomSummaries();
    });

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(deleteButton(container, "Beta")).not.toBeNull());

    await act(async () => fixture.emit({ type: "rooms-changed" }));
    await vi.waitFor(() => expect(teamChat.listRooms).toHaveBeenCalledTimes(2));

    await act(async () => deleteButton(container, "Beta")?.click());
    await vi.waitFor(() => {
      expect(teamChat.deleteRoom).toHaveBeenCalledWith(beta.id);
      expect(teamChat.listRooms).toHaveBeenCalledTimes(3);
      expect(deleteButton(container, "Beta")).toBeNull();
    });

    await act(async () => {
      staleRefresh.resolve(staleSnapshot);
      await staleRefresh.promise;
    });
    expect(deleteButton(container, "Beta")).toBeNull();
    expect(roomSelectButton(container, "Alpha")).not.toBeNull();
  });

  it("clears a room-list refresh error after the next refresh succeeds", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    let listCall = 0;
    teamChat.listRooms.mockImplementation(async () => {
      listCall += 1;
      if (listCall === 2) throw new Error("Transient room refresh failure.");
      return fixture.roomSummaries();
    });
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    await act(async () => fixture.emit({ type: "rooms-changed" }));
    await vi.waitFor(() => expect(
      container.querySelector('[role="alert"]')?.textContent,
    ).toBe("Transient room refresh failure."));
    await act(async () => fixture.emit({ type: "rooms-changed" }));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull());
  });

  it("does not clear a delete error when a pending room refresh later succeeds", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    const refresh = deferred<TeamChatRoomSummary[]>();
    let listCall = 0;
    teamChat.listRooms.mockImplementation(async () => {
      listCall += 1;
      if (listCall === 2) return refresh.promise;
      return fixture.roomSummaries();
    });
    teamChat.deleteRoom.mockRejectedValueOnce(new Error("Delete still failed."));
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(deleteButton(container, "Alpha")).not.toBeNull());

    await act(async () => fixture.emit({ type: "rooms-changed" }));
    await vi.waitFor(() => expect(teamChat.listRooms).toHaveBeenCalledTimes(2));
    await act(async () => deleteButton(container, "Alpha")?.click());
    await vi.waitFor(() => expect(
      container.querySelector('[role="alert"]')?.textContent,
    ).toBe("Delete still failed."));
    await act(async () => {
      refresh.resolve(fixture.roomSummaries());
      await refresh.promise;
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Delete still failed.");
  });

  it("loads earlier messages in the current room and advances the cursor", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    teamChat.listMessages.mockImplementation(async (request: ListTeamChatMessagesRequest) => {
      if (request.before === "alpha-before") {
        return {
          messages: [messageFixture("alpha-earlier", "room-alpha", 1, "Alpha earlier")],
        };
      }
      return {
        messages: [messageFixture("alpha-recent", "room-alpha", 2, "Alpha recent")],
        nextBefore: "alpha-before",
      };
    });

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(container.textContent).toContain("Alpha recent"));
    await act(async () => earlierMessagesButton(container)?.click());

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Alpha earlier");
      expect(container.textContent).toContain("Alpha recent");
      expect(earlierMessagesButton(container)).toBeUndefined();
    });
  });

  it("loads older pages until the preferred source message can be focused", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    const onPreferredConsumed = vi.fn();
    teamChat.listMessages.mockImplementation(async (request: ListTeamChatMessagesRequest) => {
      if (request.before === "alpha-before") {
        return {
          messages: [messageFixture("target-message", "room-alpha", 1, "Original request")],
        };
      }
      return {
        messages: [messageFixture("recent-message", "room-alpha", 2, "Recent reply")],
        nextBefore: "alpha-before",
      };
    });

    await act(async () => root.render(
      <TeamChatPage
        language="en"
        preferredRoomId="room-alpha"
        preferredMessageId="target-message"
        onPreferredConsumed={onPreferredConsumed}
      />,
    ));

    await vi.waitFor(() => expect(teamChat.listMessages).toHaveBeenCalledWith({
      roomId: "room-alpha",
      before: "alpha-before",
      limit: 100,
    }));
    await vi.waitFor(() => {
      const target = container.querySelector<HTMLElement>('[data-message-id="target-message"]');
      expect(target).not.toBeNull();
      expect(document.activeElement).toBe(target);
      expect(onPreferredConsumed).toHaveBeenCalledOnce();
    });
  });

  it("ignores an earlier-message response after switching rooms", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
    ]);
    const alphaEarlier = deferred<TeamChatMessagePage>();
    teamChat.listMessages.mockImplementation(async (request: ListTeamChatMessagesRequest) => {
      if (request.roomId === "room-alpha" && request.before) return alphaEarlier.promise;
      if (request.roomId === "room-alpha") {
        return {
          messages: [messageFixture("alpha-recent", "room-alpha", 2, "Alpha recent")],
          nextBefore: "alpha-before",
        };
      }
      if (request.before) return { messages: [], nextBefore: undefined };
      return {
        messages: [messageFixture("beta-only", "room-beta", 1, "Beta only")],
        nextBefore: "beta-before",
      };
    });

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(container.textContent).toContain("Alpha recent"));

    const alphaEarlierButton = earlierMessagesButton(container);
    await act(async () => alphaEarlierButton?.click());
    await vi.waitFor(() => expect(teamChat.listMessages).toHaveBeenCalledWith({
      roomId: "room-alpha",
      before: "alpha-before",
      limit: 100,
    }));

    await act(async () => roomSelectButton(container, "Beta")?.click());
    await vi.waitFor(() => {
      expect(container.querySelector(".team-chat-room-title strong")?.textContent).toBe("Beta");
      expect(container.textContent).toContain("Beta only");
    });

    await act(async () => {
      alphaEarlier.resolve({
        messages: [messageFixture("alpha-secret", "room-alpha", 1, "Alpha secret")],
        nextBefore: "alpha-older",
      });
      await alphaEarlier.promise;
    });

    expect(container.textContent).not.toContain("Alpha secret");
    expect(container.textContent).toContain("Beta only");
    const betaEarlierButton = earlierMessagesButton(container);
    expect(betaEarlierButton?.disabled).toBe(false);
    await act(async () => betaEarlierButton?.click());
    await vi.waitFor(() => expect(teamChat.listMessages).toHaveBeenCalledWith({
      roomId: "room-beta",
      before: "beta-before",
      limit: 100,
    }));
  });

  it("deduplicates a same-room send event, clears the sent draft, and restores composer focus", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    teamChat.sendMessage.mockImplementationOnce(async (request: SendTeamChatMessageRequest) => {
      const message = messageFixture("alpha-sent", request.roomId, 1, request.content);
      fixture.emit({
        type: "message-created",
        roomId: request.roomId,
        rootMessageId: message.rootMessageId,
        message,
      });
      return {
        message,
        rootMessageId: message.rootMessageId,
        rejectedTargetMemberIds: [],
      };
    });

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    const activeComposer = composer(container);
    await typeInto(activeComposer, "Send once");
    activeComposer.focus();
    await act(async () => sendButton(container)?.click());

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".team-chat-message")).toHaveLength(1);
      expect(container.textContent).toContain("Send once");
      expect(composer(container).value).toBe("");
      expect(document.activeElement).toBe(activeComposer);
    });
  });

  it("keeps the draft and shows feedback when a same-room send fails", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    teamChat.sendMessage.mockRejectedValueOnce(new Error("Send failed."));

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    const activeComposer = composer(container);
    await typeInto(activeComposer, "Keep after failure");
    await act(async () => sendButton(container)?.click());

    await vi.waitFor(() => {
      expect(composer(container).value).toBe("Keep after failure");
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Send failed.");
      expect(document.activeElement).toBe(activeComposer);
    });
  });

  it("shows a completed same-room send without clearing a newer draft or stealing focus", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    const send = deferred<SendTeamChatMessageResult>();
    teamChat.sendMessage.mockImplementationOnce(() => send.promise);

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    await typeInto(composer(container), "First draft");
    await act(async () => sendButton(container)?.click());
    await vi.waitFor(() => expect(teamChat.sendMessage).toHaveBeenCalledTimes(1));

    await typeInto(composer(container), "New draft");
    const newRoom = container.querySelector<HTMLButtonElement>('button[aria-label="New room"]');
    newRoom?.focus();
    await act(async () => {
      send.resolve({
        message: messageFixture("alpha-sent", "room-alpha", 1, "First draft"),
        rootMessageId: "alpha-sent",
        rejectedTargetMemberIds: [],
      });
      await send.promise;
    });

    await vi.waitFor(() => expect(container.textContent).toContain("First draft"));
    expect(composer(container).value).toBe("New draft");
    expect(document.activeElement).toBe(newRoom);
  });

  it("does not let a completed send overwrite the next room draft or focus", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
    ]);
    const send = deferred<SendTeamChatMessageResult>();
    teamChat.sendMessage.mockImplementationOnce(() => send.promise);

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    await typeInto(composer(container), "Alpha draft");
    await act(async () => sendButton(container)?.click());
    await vi.waitFor(() => expect(teamChat.sendMessage).toHaveBeenCalledWith({
      roomId: "room-alpha",
      content: "Alpha draft",
      targetMemberIds: [],
    }));

    await act(async () => roomSelectButton(container, "Beta")?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));
    const betaComposer = composer(container);
    await typeInto(betaComposer, "Beta draft");
    const newRoom = container.querySelector<HTMLButtonElement>('button[aria-label="New room"]');
    newRoom?.focus();

    await act(async () => {
      send.resolve({
        message: messageFixture("alpha-sent", "room-alpha", 1, "Alpha sent"),
        rootMessageId: "alpha-sent",
        rejectedTargetMemberIds: ["member-1"],
      });
      await send.promise;
    });

    expect(composer(container).value).toBe("Beta draft");
    expect(container.textContent).not.toContain("Alpha sent");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(newRoom);
  });

  it("does not surface an old send failure in the newly selected room", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
    ]);
    const send = deferred<SendTeamChatMessageResult>();
    teamChat.sendMessage.mockImplementationOnce(() => send.promise);

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    await typeInto(composer(container), "Alpha draft");
    await act(async () => sendButton(container)?.click());
    await vi.waitFor(() => expect(teamChat.sendMessage).toHaveBeenCalledTimes(1));

    await act(async () => roomSelectButton(container, "Beta")?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));
    await typeInto(composer(container), "Beta draft");
    const newRoom = container.querySelector<HTMLButtonElement>('button[aria-label="New room"]');
    newRoom?.focus();

    await act(async () => {
      send.reject(new Error("Alpha send failed."));
      await send.promise.catch(() => undefined);
    });

    expect(composer(container).value).toBe("Beta draft");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(document.activeElement).toBe(newRoom);
  });

  it("shows a delete failure even while the selected room details are still loading", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    const roomLoad = deferred<TeamChatRoom | undefined>();
    teamChat.getRoom.mockImplementationOnce(() => roomLoad.promise);
    teamChat.deleteRoom.mockRejectedValueOnce(new Error("Delete failed."));

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(deleteButton(container, "Alpha")).not.toBeNull());
    expect(container.querySelector(".team-chat-room-title")).toBeNull();

    await act(async () => deleteButton(container, "Alpha")?.click());
    await vi.waitFor(() => {
      const alerts = container.querySelectorAll('[role="alert"]');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.textContent).toBe("Delete failed.");
      expect(deleteButton(container, "Alpha")).not.toBeNull();
      expect(deleteButton(container, "Alpha")?.getAttribute("aria-disabled")).toBeNull();
    });
  });

  it("does nothing when permanent deletion is not confirmed", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    vi.mocked(window.confirm).mockReturnValueOnce(false);

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    const trigger = deleteButton(container, "Alpha");
    trigger?.focus();
    await act(async () => trigger?.click());

    expect(teamChat.deleteRoom).not.toHaveBeenCalled();
    expect(teamChat.listRooms).toHaveBeenCalledTimes(1);
    expect(trigger?.getAttribute("aria-disabled")).toBeNull();
    expect(trigger?.getAttribute("aria-busy")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector(".team-chat-room-title strong")?.textContent).toBe("Alpha");
  });

  it("keeps a pending delete focusable, prevents duplicates, and restores focus on failure", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    const deletion = deferred<void>();
    teamChat.deleteRoom.mockImplementationOnce(() => deletion.promise);

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    const trigger = deleteButton(container, "Alpha");
    trigger?.focus();
    await act(async () => {
      trigger?.click();
      trigger?.click();
    });
    await vi.waitFor(() => expect(teamChat.deleteRoom).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(trigger?.disabled).toBe(false);
    expect(trigger?.getAttribute("aria-disabled")).toBe("true");
    expect(trigger?.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      deletion.reject(new Error("Still in use."));
      await deletion.promise.catch(() => undefined);
    });
    await vi.waitFor(() => {
      expect(trigger?.getAttribute("aria-disabled")).toBeNull();
      expect(trigger?.getAttribute("aria-busy")).toBeNull();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Still in use.");
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("keeps the Room actions delete item focusable and restores it after failure", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    const deletion = deferred<void>();
    teamChat.deleteRoom.mockImplementationOnce(() => deletion.promise);

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    await act(async () => roomActionsButton(container)?.click());
    const trigger = menuItem(container, "Delete permanently");
    trigger?.focus();
    await act(async () => {
      trigger?.click();
      trigger?.click();
    });

    await vi.waitFor(() => expect(teamChat.deleteRoom).toHaveBeenCalledTimes(1));
    expect(trigger?.disabled).toBe(false);
    expect(trigger?.getAttribute("aria-disabled")).toBe("true");
    expect(trigger?.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      deletion.reject(new Error("Menu delete failed."));
      await deletion.promise.catch(() => undefined);
    });
    await vi.waitFor(() => {
      expect(trigger?.isConnected).toBe(true);
      expect(trigger?.getAttribute("aria-disabled")).toBeNull();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Menu delete failed.");
      expect(document.activeElement).toBe(trigger);
    });
  });

  it.each([
    {
      label: "the next room",
      rooms: [
        roomFixture("room-alpha", "Alpha"),
        roomFixture("room-beta", "Beta"),
        roomFixture("room-gamma", "Gamma"),
      ],
      deleted: "Beta",
      expected: "Gamma",
    },
    {
      label: "the previous room",
      rooms: [
        roomFixture("room-alpha", "Alpha"),
        roomFixture("room-beta", "Beta"),
        roomFixture("room-gamma", "Gamma"),
      ],
      deleted: "Gamma",
      expected: "Beta",
    },
  ])("focuses $label after deletion succeeds", async ({ rooms, deleted, expected }) => {
    fixture.setRooms(rooms);
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(deleteButton(container, deleted)).not.toBeNull());

    const trigger = deleteButton(container, deleted);
    trigger?.focus();
    await act(async () => trigger?.click());
    await vi.waitFor(() => {
      expect(deleteButton(container, deleted)).toBeNull();
      expect(document.activeElement).toBe(roomSelectButton(container, expected));
    });
  });

  it("selects the next room when the service refresh arrives before a selected-room delete resolves", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
      roomFixture("room-gamma", "Gamma"),
    ]);
    teamChat.deleteRoom.mockImplementationOnce(async (roomId: string) => {
      fixture.removeRoom(roomId);
      fixture.emit({ type: "rooms-changed" });
      await Promise.resolve();
    });
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    await act(async () => roomSelectButton(container, "Beta")?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));

    const trigger = deleteButton(container, "Beta");
    trigger?.focus();
    await act(async () => trigger?.click());
    await vi.waitFor(() => {
      expect(container.querySelector(".team-chat-room-item.active strong")?.textContent).toBe("Gamma");
      expect(document.activeElement).toBe(roomSelectButton(container, "Gamma"));
    });
  });

  it("does not replace the user's room selection or focus while a delete is pending", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
      roomFixture("room-gamma", "Gamma"),
    ]);
    const deletion = deferred<void>();
    teamChat.deleteRoom.mockImplementationOnce(async (roomId: string) => {
      await deletion.promise;
      fixture.removeRoom(roomId);
      fixture.emit({ type: "rooms-changed" });
      await Promise.resolve();
    });
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    const deleteAlpha = deleteButton(container, "Alpha");
    deleteAlpha?.focus();
    await act(async () => deleteAlpha?.click());
    await vi.waitFor(() => expect(teamChat.deleteRoom).toHaveBeenCalledWith("room-alpha"));

    const gamma = roomSelectButton(container, "Gamma");
    gamma?.focus();
    await act(async () => gamma?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Gamma"));

    await act(async () => {
      deletion.resolve();
      await deletion.promise;
    });
    await vi.waitFor(() => {
      expect(deleteButton(container, "Alpha")).toBeNull();
      expect(container.querySelector(".team-chat-room-item.active strong")?.textContent).toBe("Gamma");
      expect(document.activeElement).toBe(gamma);
    });
  });

  it("does not apply a delete fallback after the user selects another room during refresh", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
      roomFixture("room-gamma", "Gamma"),
    ]);
    const postDeleteRooms = deferred<TeamChatRoomSummary[]>();
    let listCall = 0;
    teamChat.listRooms.mockImplementation(async () => {
      listCall += 1;
      if (listCall === 2) return postDeleteRooms.promise;
      return fixture.roomSummaries();
    });
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    await act(async () => roomSelectButton(container, "Beta")?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));

    const deleteBeta = deleteButton(container, "Beta");
    deleteBeta?.focus();
    await act(async () => deleteBeta?.click());
    await vi.waitFor(() => {
      expect(teamChat.listRooms).toHaveBeenCalledTimes(2);
      expect(container.querySelector(".team-chat-room-item.active strong")?.textContent).toBe("Gamma");
    });

    const alpha = roomSelectButton(container, "Alpha");
    alpha?.focus();
    await act(async () => alpha?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    await act(async () => {
      postDeleteRooms.resolve(fixture.roomSummaries());
      await postDeleteRooms.promise;
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".team-chat-room-item.active strong")?.textContent).toBe("Alpha");
      expect(document.activeElement).toBe(alpha);
    });
  });

  it("uses the delete fallback when a pending non-current room becomes selected", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
      roomFixture("room-gamma", "Gamma"),
    ]);
    const commitDelete = deferred<void>();
    const allowDeleteResponse = deferred<void>();
    teamChat.deleteRoom.mockImplementationOnce(async (roomId: string) => {
      await commitDelete.promise;
      fixture.removeRoom(roomId);
      fixture.emit({ type: "rooms-changed" });
      await allowDeleteResponse.promise;
    });
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    await act(async () => deleteButton(container, "Beta")?.click());
    await vi.waitFor(() => expect(teamChat.deleteRoom).toHaveBeenCalledWith("room-beta"));

    const beta = roomSelectButton(container, "Beta");
    beta?.focus();
    await act(async () => beta?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));

    await act(async () => {
      commitDelete.resolve();
      await commitDelete.promise;
    });
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-item.active strong")?.textContent,
    ).toBe("Gamma"));
    await act(async () => {
      allowDeleteResponse.resolve();
      await allowDeleteResponse.promise;
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(roomSelectButton(container, "Gamma")));
  });

  it("keeps the user's new focus when deletion later fails", async () => {
    fixture.setRooms([
      roomFixture("room-alpha", "Alpha"),
      roomFixture("room-beta", "Beta"),
    ]);
    const deletion = deferred<void>();
    teamChat.deleteRoom.mockImplementationOnce(() => deletion.promise);
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    const alphaDelete = deleteButton(container, "Alpha");
    alphaDelete?.focus();
    await act(async () => alphaDelete?.click());
    const beta = roomSelectButton(container, "Beta");
    beta?.focus();
    await act(async () => beta?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));

    await act(async () => {
      deletion.reject(new Error("Delete failed."));
      await deletion.promise.catch(() => undefined);
    });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(beta);
      expect(container.querySelector(".team-chat-room-title strong")?.textContent).toBe("Beta");
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Delete failed.");
    });
  });

  it("focuses a surviving room when the preferred neighbor also disappears on refresh", async () => {
    const alpha = roomFixture("room-alpha", "Alpha");
    fixture.setRooms([
      alpha,
      roomFixture("room-beta", "Beta"),
      roomFixture("room-gamma", "Gamma"),
    ]);
    const finalRooms = deferred<TeamChatRoomSummary[]>();
    let listCall = 0;
    teamChat.listRooms.mockImplementation(async () => {
      listCall += 1;
      if (listCall === 2) return finalRooms.promise;
      return fixture.roomSummaries();
    });
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(deleteButton(container, "Beta")).not.toBeNull());

    const deleteBeta = deleteButton(container, "Beta");
    deleteBeta?.focus();
    await act(async () => deleteBeta?.click());
    await vi.waitFor(() => expect(teamChat.listRooms).toHaveBeenCalledTimes(2));
    expect(document.activeElement).toBe(roomSelectButton(container, "Gamma"));
    await act(async () => {
      finalRooms.resolve([roomSummary(alpha)]);
      await finalRooms.promise;
    });
    await vi.waitFor(() => {
      expect(roomSelectButton(container, "Gamma")).toBeUndefined();
      expect(document.activeElement).toBe(roomSelectButton(container, "Alpha"));
    });
  });

  it("clears an archived room after leaving and returning before the request completes", async () => {
    const alpha = roomFixture("room-alpha", "Alpha");
    const beta = roomFixture("room-beta", "Beta");
    fixture.setRooms([alpha, beta]);
    const archive = deferred<void>();
    const refreshedRooms = deferred<TeamChatRoomSummary[]>();
    let listCall = 0;
    teamChat.listRooms.mockImplementation(async () => {
      listCall += 1;
      if (listCall > 1) return refreshedRooms.promise;
      return fixture.roomSummaries();
    });
    teamChat.archiveRoom.mockImplementationOnce(async (roomId: string) => {
      await archive.promise;
      fixture.removeRoom(roomId);
      fixture.emit({ type: "rooms-changed" });
    });

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));
    await act(async () => roomActionsButton(container)?.click());
    await act(async () => menuItem(container, "Archive studio")?.click());
    await vi.waitFor(() => expect(teamChat.archiveRoom).toHaveBeenCalledWith(alpha.id));
    await act(async () => roomSelectButton(container, "Beta")?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));
    await act(async () => roomSelectButton(container, "Alpha")?.click());
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Alpha"));

    await act(async () => {
      archive.resolve();
      await archive.promise;
    });
    await vi.waitFor(() => {
      expect(deleteButton(container, "Alpha")).toBeNull();
      expect(container.querySelector(".team-chat-room-title")).toBeNull();
    });
    await act(async () => {
      refreshedRooms.resolve([roomSummary(beta)]);
      await refreshedRooms.promise;
    });
    await vi.waitFor(() => expect(
      container.querySelector(".team-chat-room-title strong")?.textContent,
    ).toBe("Beta"));
  });

  it("does not let an older room detail overwrite a newer session refresh", async () => {
    const initialRoom = roomFixture("room-alpha", "Alpha");
    const refreshedRoom: TeamChatRoom = {
      ...initialRoom,
      agents: initialRoom.agents.map((agent) => ({
        ...agent,
        hasActiveConversation: true,
      })),
    };
    fixture.setRooms([initialRoom]);
    const oldDetail = deferred<TeamChatRoom | undefined>();
    let getRoomCall = 0;
    teamChat.getRoom.mockImplementation(async () => {
      getRoomCall += 1;
      if (getRoomCall === 1) return oldDetail.promise;
      return refreshedRoom;
    });

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(teamChat.getRoom).toHaveBeenCalledTimes(1));
    await act(async () => fixture.emit({
      type: "agent-session-changed",
      roomId: initialRoom.id,
      agentId: initialRoom.agents[0]!.agentId,
    }));
    await vi.waitFor(() => expect(
      container.querySelector('[aria-label="Start a new conversation for Builder"]'),
    ).not.toBeNull());

    await act(async () => {
      oldDetail.resolve(initialRoom);
      await oldDetail.promise;
    });
    expect(
      container.querySelector('[aria-label="Start a new conversation for Builder"]'),
    ).not.toBeNull();
  });

  it("focuses New room after deleting the only room", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(deleteButton(container, "Alpha")).not.toBeNull());

    const trigger = deleteButton(container, "Alpha");
    trigger?.focus();
    await act(async () => trigger?.click());
    const newRoom = container.querySelector<HTMLButtonElement>('button[aria-label="New room"]');
    await vi.waitFor(() => {
      expect(deleteButton(container, "Alpha")).toBeNull();
      expect(document.activeElement).toBe(newRoom);
    });
  });

  it("merges a live message that arrives before the initial room snapshot", async () => {
    fixture.setRooms([roomFixture("room-alpha", "Alpha")]);
    const initialPage = deferred<TeamChatMessagePage>();
    teamChat.listMessages.mockImplementationOnce(() => initialPage.promise);

    await act(async () => root.render(<TeamChatPage language="en" />));
    await vi.waitFor(() => expect(teamChat.listMessages).toHaveBeenCalledWith({
      roomId: "room-alpha",
      limit: 100,
    }));

    const liveMessage = messageFixture("live", "room-alpha", 2, "Live message");
    await act(async () => fixture.emit({
      type: "message-created",
      roomId: "room-alpha",
      rootMessageId: liveMessage.rootMessageId,
      message: liveMessage,
    }));
    await act(async () => {
      initialPage.resolve({
        messages: [
          messageFixture("snapshot", "room-alpha", 1, "Snapshot message"),
          liveMessage,
        ],
      });
      await initialPage.promise;
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Snapshot message");
      expect(container.textContent).toContain("Live message");
      expect(container.querySelectorAll(".team-chat-message")).toHaveLength(2);
      expect([...container.querySelectorAll(".team-chat-message-content")]
        .filter((element) => element.textContent === "Live message")).toHaveLength(1);
    });
  });
});

function createTeamChatFixture() {
  let rooms: TeamChatRoom[] = [];
  const messages = new Map<string, TeamChatMessage[]>();
  let eventListener: ((event: TeamChatEvent) => void) | undefined;
  const fixture = {
    getConnectionStatus: vi.fn(async () => ({
      state: "ready" as const,
      mode: "local" as const,
      databaseLabel: "Local data",
    })),
    connect: vi.fn(),
    listRooms: vi.fn(async () => rooms.map(roomSummary)),
    getRoom: vi.fn(async (roomId: string) => rooms.find((room) => room.id === roomId)),
    createRoom: vi.fn(async (request: CreateTeamChatRoomRequest) => {
      const created = roomFixture("room-new", request.name, request);
      rooms = [...rooms, created];
      return created;
    }),
    deleteRoom: vi.fn(async (roomId: string) => {
      rooms = rooms.filter((room) => room.id !== roomId);
      messages.delete(roomId);
    }),
    listMessages: vi.fn(async (
      request: ListTeamChatMessagesRequest,
    ): Promise<TeamChatMessagePage> => ({
      messages: [...(messages.get(request.roomId) ?? [])],
    })),
    sendMessage: vi.fn(async (
      request: SendTeamChatMessageRequest,
    ): Promise<SendTeamChatMessageResult> => {
      const message = messageFixture(
        `message-${(messages.get(request.roomId)?.length ?? 0) + 1}`,
        request.roomId,
        (messages.get(request.roomId)?.length ?? 0) + 1,
        request.content,
      );
      messages.set(request.roomId, [...(messages.get(request.roomId) ?? []), message]);
      return {
        message,
        rootMessageId: message.rootMessageId,
        rejectedTargetMemberIds: [],
      };
    }),
    updateRoom: vi.fn(),
    removeRoomMember: vi.fn(),
    archiveRoom: vi.fn(),
    stopTurn: vi.fn(),
    resetAgentSession: vi.fn(),
    onEvent: vi.fn((listener: (event: TeamChatEvent) => void) => {
      eventListener = listener;
      return () => {
        if (eventListener === listener) eventListener = undefined;
      };
    }),
    setRooms(nextRooms: TeamChatRoom[]) {
      rooms = [...nextRooms];
    },
    setRoomMessages(roomId: string, nextMessages: TeamChatMessage[]) {
      messages.set(roomId, [...nextMessages]);
    },
    removeRoom(roomId: string) {
      rooms = rooms.filter((room) => room.id !== roomId);
    },
    findRoom(roomId: string) {
      return rooms.find((room) => room.id === roomId);
    },
    roomSummaries() {
      return rooms.map(roomSummary);
    },
    emit(event: TeamChatEvent) {
      eventListener?.(event);
    },
  };
  return fixture;
}

function roomSummary(room: TeamChatRoom): TeamChatRoomSummary {
  return {
    id: room.id,
    name: room.name,
    workDir: room.workDir,
    archived: room.archived,
    agentCount: room.agents.length,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function roomFixture(
  id: string,
  name: string,
  request?: CreateTeamChatRoomRequest,
): TeamChatRoom {
  const members = request?.members ?? [{ configuredAgentId: "builder-profile", displayName: "Builder" }];
  return {
    id,
    name,
    workDir: request?.workDir ?? "/workspace/project",
    archived: false,
    agents: members.map((member, position) => ({
      roomId: id,
      agentId: `member-${position + 1}`,
      configuredAgentId: member.configuredAgentId,
      displayName: member.displayName,
      runtimeId: "codex",
      channelId: "codex",
      modelId: "gpt-5",
      enabled: true,
      position,
      joinedAt: "2026-08-18T00:00:00.000Z",
      continuationAvailable: false,
      hasActiveConversation: false,
    })),
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function messageFixture(
  id: string,
  roomId: string,
  sequence: number,
  content: string,
): TeamChatMessage {
  return {
    id,
    roomId,
    sequence,
    senderType: "human",
    senderName: "You",
    content,
    deliveryType: "message",
    rootMessageId: id,
    hop: 0,
    status: "final",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deleteButton(container: HTMLElement, roomName: string): HTMLButtonElement | null {
  return container.querySelector(`button[aria-label="Delete room “${roomName}”"]`);
}

function roomSelectButton(container: HTMLElement, roomName: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>(".team-chat-room-select")]
    .find((button) => button.querySelector("strong")?.textContent === roomName);
}

function earlierMessagesButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes("Earlier messages"));
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>(".team-chat-composer textarea");
  if (!element) throw new Error("Expected the Team Chat composer to be visible.");
  return element;
}

function sendButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector(".team-chat-send");
}

function roomActionsButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector('button[aria-label="Room actions"]');
}

function menuItem(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.includes(label));
}

async function typeInto(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
}
