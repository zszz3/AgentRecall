import {
  Archive,
  Bot,
  ChevronUp,
  CircleStop,
  Database,
  FolderOpen,
  LoaderCircle,
  MessageCircleMore,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import type {
  CreateTeamChatRoomRequest,
  TeamChatConnectionStatus,
  TeamChatEvent,
  TeamChatMessage,
  TeamChatRoom,
  TeamChatRoomAgent,
  TeamChatRoomSummary,
} from "../../../../shared/team-chat";
import { parseTeamChatMentions, removeMentionFromText, resolveMentionedMemberIds } from "../../../../shared/team-chat";
import { modelDisplayLabel } from "../../../../automation/engine/shared/models";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { useAutomationDetails } from "../automation/automation-provider";
import { runtimeSessionUnavailableMessage } from "../sessions/runtime-session-resolution";

interface StreamDraft {
  dispatchId: string;
  rootMessageId: string;
  agentId: string;
  agentName: string;
  content: string;
}

interface DraftStudioEmployee {
  localId: string;
  configuredAgentId: string;
  displayName: string;
}

interface StudioAgentOption {
  id: string;
  name: string;
  runtimeAgentId: string;
  modelId: string;
  description: string;
}

interface MemberContextMenu {
  member: TeamChatRoomAgent;
  x: number;
  y: number;
}

type PendingDeleteFocus =
  | { kind: "trigger"; element: HTMLButtonElement }
  | { kind: "room"; preferredRoomId?: string; origin: HTMLButtonElement };

const INITIAL_CONNECTION: TeamChatConnectionStatus = { state: "connecting" };

export function TeamChatRoomTitle({
  room,
  language,
  onRename,
  onError,
}: {
  room: TeamChatRoom;
  language: LanguageMode;
  onRename(name: string): Promise<void>;
  onError(error: unknown): void;
}): ReactElement {
  const l = (en: string, zh: string): string => localize(language, en, zh);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.name);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(room.name);
  }, [editing, room.name]);

  const save = async (): Promise<void> => {
    if (saving) return;
    const name = draft.trim();
    if (!name || name === room.name) {
      setDraft(room.name);
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      await onRename(name);
      setEditing(false);
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        className="team-chat-room-title-input"
        value={draft}
        maxLength={120}
        disabled={saving}
        autoFocus
        aria-label={l("Room title", "房间标题")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(room.name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <div className="team-chat-room-title">
      <strong title={room.name}>{room.name}</strong>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={l("Rename room", "修改房间标题")}
        aria-label={l("Rename room", "修改房间标题")}
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

export function TeamChatPage({
  language,
  preferredRoomId,
  preferredMessageId,
  onPreferredConsumed,
  onOpenSession,
}: {
  language: LanguageMode;
  preferredRoomId?: string;
  preferredMessageId?: string;
  onPreferredConsumed?: () => void;
  onOpenSession?: (sessionKey: string) => void;
}): ReactElement {
  const l = useCallback((en: string, zh: string) => localize(language, en, zh), [language]);
  const api = useMemo(() => window.sessionSearch.teamChat, []);
  const { api: automationApi, snapshot } = useAutomationDetails();
  const [connection, setConnection] = useState<TeamChatConnectionStatus>(INITIAL_CONNECTION);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [rooms, setRooms] = useState<TeamChatRoomSummary[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  const selectedRoomIdRef = useRef<string | undefined>(undefined);
  const roomEpochRef = useRef(0);
  const roomDetailRequestIdRef = useRef(0);
  const roomsGenerationRef = useRef(0);
  const [activeRoom, setActiveRoom] = useState<TeamChatRoom>();
  const [messages, setMessages] = useState<TeamChatMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<string>();
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);
  const earlierRequestIdRef = useRef(0);
  const [feedback, setFeedback] = useState<string>();
  const roomListFeedbackRef = useRef(false);
  const [composer, setComposer] = useState("");
  const composerRevisionRef = useRef(0);
  const [composerCursor, setComposerCursor] = useState(0);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const sendingRequestIdRef = useRef<number | undefined>(undefined);
  const nextSendingRequestIdRef = useRef(0);
  const [activeRootMessageId, setActiveRootMessageId] = useState<string>();
  const [streams, setStreams] = useState<Record<string, StreamDraft>>({});
  const [resettingAgentIds, setResettingAgentIds] = useState<Set<string>>(() => new Set());
  const resettingAgentRequestIdsRef = useRef(new Map<string, number>());
  const [removingAgentIds, setRemovingAgentIds] = useState<Set<string>>(() => new Set());
  const removingAgentRequestIdsRef = useRef(new Map<string, number>());
  const nextRoomOperationIdRef = useRef(0);
  const [memberContextMenu, setMemberContextMenu] = useState<MemberContextMenu>();
  const [createOpen, setCreateOpen] = useState(false);
  const [addEmployeeOpen, setAddEmployeeOpen] = useState(false);
  const [roomActionsOpen, setRoomActionsOpen] = useState(false);
  const [deletingRoomId, setDeletingRoomId] = useState<string>();
  const deletingRoomIdRef = useRef<string | undefined>(undefined);
  const deletingRoomSelectionRef = useRef<{
    roomId: string;
    preferredRoomId?: string;
  } | undefined>(undefined);
  const [pendingDeleteFocus, setPendingDeleteFocus] = useState<PendingDeleteFocus>();
  const newRoomButtonRef = useRef<HTMLButtonElement>(null);
  const roomSelectButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const focusedMessageIdRef = useRef<string | undefined>(undefined);
  const skipNextAutoScrollRef = useRef(false);

  useEffect(() => {
    focusedMessageIdRef.current = undefined;
  }, [preferredMessageId, preferredRoomId]);

  useEffect(() => {
    if (
      !preferredRoomId
      || preferredMessageId
      || selectedRoomId !== preferredRoomId
      || activeRoom?.id !== preferredRoomId
      || loadingMessages
    ) return;
    onPreferredConsumed?.();
  }, [
    activeRoom?.id,
    loadingMessages,
    onPreferredConsumed,
    preferredMessageId,
    preferredRoomId,
    selectedRoomId,
  ]);

  const openLatestRoomSession = async (): Promise<void> => {
    if (!activeRoom) return;
    try {
      const resolution = await window.sessionSearch.resolveRuntimeInvocationSession({
        roomId: activeRoom.id,
      });
      if (resolution.status !== "found") {
        setContextFeedback(runtimeSessionUnavailableMessage(
          resolution,
          { en: "this room's latest reply", zh: "该工作室最近一次回复" },
          language,
        ));
        return;
      }
      onOpenSession?.(resolution.session.sessionKey);
    } catch (error) {
      setContextFeedback(errorMessage(error));
    }
  };

  const openMessageSession = async (message: TeamChatMessage): Promise<void> => {
    const messageId = message.sourceMessageId ?? message.id;
    try {
      const resolution = await window.sessionSearch.resolveRuntimeInvocationSession({
        roomId: message.roomId,
        messageId,
        ...(message.senderAgentId ? { agentId: message.senderAgentId } : {}),
      });
      if (resolution.status !== "found") {
        setContextFeedback(runtimeSessionUnavailableMessage(
          resolution,
          { en: "this message", zh: "该消息" },
          language,
        ));
        return;
      }
      onOpenSession?.(resolution.session.sessionKey);
    } catch (error) {
      setContextFeedback(errorMessage(error));
    }
  };

  const isCurrentRoomScope = useCallback((roomId: string, epoch: number): boolean =>
    selectedRoomIdRef.current === roomId && roomEpochRef.current === epoch, []);

  const setContextFeedback = useCallback((value?: string): void => {
    roomListFeedbackRef.current = false;
    setFeedback(value);
  }, []);

  const commitAuthoritativeRoom = useCallback((room: TeamChatRoom): void => {
    roomDetailRequestIdRef.current += 1;
    setActiveRoom(room);
  }, []);

  const selectRoom = useCallback((nextRoomId?: string): void => {
    if (selectedRoomIdRef.current === nextRoomId) return;
    selectedRoomIdRef.current = nextRoomId;
    roomEpochRef.current += 1;
    roomDetailRequestIdRef.current += 1;
    earlierRequestIdRef.current += 1;
    loadingEarlierRef.current = false;
    nextSendingRequestIdRef.current += 1;
    sendingRequestIdRef.current = undefined;
    setSelectedRoomId(nextRoomId);
    setActiveRoom(undefined);
    setMessages([]);
    setNextBefore(undefined);
    setLoadingMessages(false);
    setLoadingEarlier(false);
    setSending(false);
    setActiveRootMessageId(undefined);
    setStreams({});
    setResettingAgentIds(new Set());
    setRemovingAgentIds(new Set());
    setMemberContextMenu(undefined);
    setRoomActionsOpen(false);
    setAddEmployeeOpen(false);
    setMentionMenuOpen(false);
    setContextFeedback(undefined);
  }, [setContextFeedback]);

  const updateComposer = useCallback((value: string): void => {
    composerRevisionRef.current += 1;
    setComposer(value);
  }, []);

  useLayoutEffect(() => {
    if (!pendingDeleteFocus) return;
    const origin = pendingDeleteFocus.kind === "trigger"
      ? pendingDeleteFocus.element
      : pendingDeleteFocus.origin;
    const requested = pendingDeleteFocus.kind === "trigger"
      ? pendingDeleteFocus.element
      : pendingDeleteFocus.preferredRoomId
        ? roomSelectButtonRefs.current.get(pendingDeleteFocus.preferredRoomId)
        : undefined;
    const fallback = selectedRoomIdRef.current
      ? roomSelectButtonRefs.current.get(selectedRoomIdRef.current)
      : undefined;
    const target = requested?.isConnected
      ? requested
      : fallback?.isConnected
        ? fallback
        : [...roomSelectButtonRefs.current.values()].find((button) => button.isConnected)
          ?? newRoomButtonRef.current;
    const activeElement = document.activeElement;
    if (
      activeElement !== document.body
      && activeElement !== origin
      && activeElement !== target
      && activeElement?.isConnected
    ) {
      setPendingDeleteFocus(undefined);
      return;
    }
    target?.focus();
    if (pendingDeleteFocus.kind === "room" && loadingRooms) return;
    setPendingDeleteFocus(undefined);
  }, [loadingRooms, pendingDeleteFocus, rooms]);

  const mentionContext = useMemo(
    () => activeMentionContext(composer, composerCursor),
    [composer, composerCursor],
  );
  const mentionCandidates = useMemo(() => {
    if (!mentionMenuOpen || !mentionContext || !activeRoom) return [];
    const available = new Set(snapshot.configuredAgents.map((agent) => agent.id));
    const query = mentionContext.query.trim().toLocaleLowerCase();
    if (mentionContext.query.endsWith(" ") && activeRoom.agents.some(
      (member) => member.displayName.toLocaleLowerCase() === query,
    )) return [];
    return activeRoom.agents
      .filter((member) => member.enabled && available.has(member.configuredAgentId))
      .filter((member) => !query || member.displayName.toLocaleLowerCase().includes(query))
      .sort((left, right) => {
        const leftStarts = left.displayName.toLocaleLowerCase().startsWith(query) ? 0 : 1;
        const rightStarts = right.displayName.toLocaleLowerCase().startsWith(query) ? 0 : 1;
        return leftStarts - rightStarts || left.position - right.position;
      })
      .slice(0, 6);
  }, [activeRoom, mentionContext, mentionMenuOpen, snapshot.configuredAgents]);

  useEffect(() => {
    setMentionIndex(0);
  }, [activeRoom?.id, mentionContext?.query]);

  // Recipients are derived from the text being composed rather than tracked
  // separately, so deleting an "@name" also withdraws that recipient.
  const targetMemberIds = useMemo(() => {
    if (!activeRoom) return [];
    const availableConfiguredAgents = new Set(snapshot.configuredAgents.map((agent) => agent.id));
    const routable = activeRoom.agents.filter((member) =>
      member.enabled && availableConfiguredAgents.has(member.configuredAgentId));
    return resolveMentionedMemberIds(composer, routable);
  }, [activeRoom, composer, snapshot.configuredAgents]);

  const loadRooms = useCallback(async (
    preferredRoomId?: string,
  ): Promise<TeamChatRoomSummary[] | undefined> => {
    const generation = roomsGenerationRef.current + 1;
    const selectionEpoch = roomEpochRef.current;
    roomsGenerationRef.current = generation;
    setLoadingRooms(true);
    try {
      const next = await api.listRooms();
      if (roomsGenerationRef.current !== generation) return undefined;
      setRooms(next);
      const currentRoomId = selectedRoomIdRef.current;
      const deletionSelection = deletingRoomSelectionRef.current;
      const deletionPreferredRoomId = deletionSelection
        && deletionSelection.roomId === currentRoomId
        ? deletionSelection.preferredRoomId
        : undefined;
      let nextRoomId: string | undefined;
      if (
        roomEpochRef.current === selectionEpoch
        && preferredRoomId
        && next.some((room) => room.id === preferredRoomId)
      ) {
        nextRoomId = preferredRoomId;
      } else if (currentRoomId && next.some((room) => room.id === currentRoomId)) {
        nextRoomId = currentRoomId;
      } else if (
        deletionPreferredRoomId
        && next.some((room) => room.id === deletionPreferredRoomId)
      ) {
        nextRoomId = deletionPreferredRoomId;
      } else {
        nextRoomId = next[0]?.id;
      }
      selectRoom(nextRoomId);
      if (roomListFeedbackRef.current) {
        roomListFeedbackRef.current = false;
        setFeedback(undefined);
      }
      return next;
    } catch (error) {
      if (roomsGenerationRef.current !== generation) return undefined;
      roomListFeedbackRef.current = true;
      setFeedback(errorMessage(error));
      return undefined;
    } finally {
      if (roomsGenerationRef.current === generation) setLoadingRooms(false);
    }
  }, [api, selectRoom]);

  const connect = useCallback(async (): Promise<void> => {
    setConnectionBusy(true);
    setContextFeedback(undefined);
    try {
      setConnection(await api.connect());
      await loadRooms(preferredRoomId);
    } catch (error) {
      setContextFeedback(errorMessage(error));
      setConnection(await api.getConnectionStatus().catch((): TeamChatConnectionStatus => ({
        state: "error",
        error: errorMessage(error),
      })));
    } finally {
      setConnectionBusy(false);
    }
  }, [api, loadRooms, preferredRoomId, setContextFeedback]);

  useEffect(() => {
    let active = true;
    void api.getConnectionStatus().then(async (status) => {
      if (!active) return;
      setConnection(status);
      if (status.state === "ready") {
        await loadRooms(preferredRoomId);
      } else if (status.state === "unconfigured" && status.databaseLabel) {
        await connect();
      }
    }).catch((error) => {
      if (!active) return;
      setConnection({ state: "error", error: errorMessage(error) });
      setContextFeedback(errorMessage(error));
    });
    return () => { active = false; };
  }, [api, connect, loadRooms, preferredRoomId, setContextFeedback]);

  useEffect(() => {
    const unsubscribe = api.onEvent((event) => {
      handleTeamChatEvent(event, {
        selectedRoomId: selectedRoomIdRef.current,
        setConnection,
        setMessages,
        setStreams,
        setActiveRootMessageId,
        refreshRooms: () => void loadRooms(),
        refreshActiveRoom: (roomId) => {
          const epoch = roomEpochRef.current;
          const requestId = roomDetailRequestIdRef.current + 1;
          roomDetailRequestIdRef.current = requestId;
          void api.getRoom(roomId).then((room) => {
            if (
              isCurrentRoomScope(roomId, epoch)
              && roomDetailRequestIdRef.current === requestId
            ) setActiveRoom(room);
          }).catch((error) => {
            if (
              isCurrentRoomScope(roomId, epoch)
              && roomDetailRequestIdRef.current === requestId
            ) setContextFeedback(errorMessage(error));
          });
        },
      });
    });
    return () => {
      unsubscribe();
    };
  }, [api, isCurrentRoomScope, loadRooms, setContextFeedback]);

  useEffect(() => {
    setActiveRootMessageId(undefined);
    setStreams({});
    setResettingAgentIds(new Set());
    setRoomActionsOpen(false);
    setAddEmployeeOpen(false);
    setMentionMenuOpen(false);
    if (!selectedRoomId || connection.state !== "ready") {
      setActiveRoom(undefined);
      setMessages([]);
      setNextBefore(undefined);
      return;
    }
    const roomId = selectedRoomId;
    const epoch = roomEpochRef.current;
    const roomDetailRequestId = roomDetailRequestIdRef.current + 1;
    roomDetailRequestIdRef.current = roomDetailRequestId;
    let active = true;
    setLoadingMessages(true);
    setContextFeedback(undefined);
    void api.getRoom(roomId).then((room) => {
      if (!active || !isCurrentRoomScope(roomId, epoch)) return;
      if (roomDetailRequestIdRef.current === roomDetailRequestId) {
        setActiveRoom(room?.id === roomId ? room : undefined);
      }
    }).catch((error) => {
      if (
        active
        && isCurrentRoomScope(roomId, epoch)
        && roomDetailRequestIdRef.current === roomDetailRequestId
      ) setContextFeedback(errorMessage(error));
    });
    void api.listMessages({ roomId, limit: 100 }).then((page) => {
      if (!active || !isCurrentRoomScope(roomId, epoch)) return;
      setMessages((current) => mergeMessages(
        page.messages.filter((message) => message.roomId === roomId),
        current.filter((message) => message.roomId === roomId),
      ));
      setNextBefore(page.nextBefore);
    }).catch((error) => {
      if (active && isCurrentRoomScope(roomId, epoch)) setContextFeedback(errorMessage(error));
    }).finally(() => {
      if (active && isCurrentRoomScope(roomId, epoch)) setLoadingMessages(false);
    });
    return () => { active = false; };
  }, [api, connection.state, isCurrentRoomScope, selectedRoomId, setContextFeedback]);

  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streams]);

  const loadEarlierMessages = useCallback(async (): Promise<void> => {
    const roomId = selectedRoomIdRef.current;
    if (!roomId || activeRoom?.id !== roomId || !nextBefore || loadingEarlierRef.current) return;
    const epoch = roomEpochRef.current;
    const requestId = earlierRequestIdRef.current + 1;
    earlierRequestIdRef.current = requestId;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const page = await api.listMessages({ roomId, before: nextBefore, limit: 100 });
      if (
        !isCurrentRoomScope(roomId, epoch)
        || earlierRequestIdRef.current !== requestId
      ) return;
      if (page.messages.length > 0) {
        skipNextAutoScrollRef.current = true;
        setMessages((current) => mergeMessages(
          page.messages.filter((message) => message.roomId === roomId),
          current.filter((message) => message.roomId === roomId),
        ));
      }
      setNextBefore(page.nextBefore);
    } catch (error) {
      if (
        isCurrentRoomScope(roomId, epoch)
        && earlierRequestIdRef.current === requestId
      ) setContextFeedback(errorMessage(error));
    } finally {
      if (
        isCurrentRoomScope(roomId, epoch)
        && earlierRequestIdRef.current === requestId
      ) {
        loadingEarlierRef.current = false;
        setLoadingEarlier(false);
      }
    }
  }, [activeRoom?.id, api, isCurrentRoomScope, nextBefore, setContextFeedback]);

  useEffect(() => {
    if (!preferredMessageId || focusedMessageIdRef.current === preferredMessageId) return;
    const target = [...document.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((element) => element.dataset.messageId === preferredMessageId);
    if (target) {
      focusedMessageIdRef.current = preferredMessageId;
      target.scrollIntoView?.({ block: "center" });
      target.focus?.();
      onPreferredConsumed?.();
      return;
    }
    if (
      selectedRoomId === preferredRoomId
      && nextBefore
      && !loadingMessages
      && !loadingEarlier
    ) {
      void loadEarlierMessages();
      return;
    }
    if (
      selectedRoomId === preferredRoomId
      && activeRoom?.id === preferredRoomId
      && !loadingMessages
      && !loadingEarlier
      && !nextBefore
    ) {
      focusedMessageIdRef.current = preferredMessageId;
      onPreferredConsumed?.();
    }
  }, [
    activeRoom?.id,
    loadEarlierMessages,
    loadingEarlier,
    loadingMessages,
    messages,
    nextBefore,
    onPreferredConsumed,
    preferredMessageId,
    preferredRoomId,
    selectedRoomId,
  ]);

  const sendMessage = useCallback(async (): Promise<void> => {
    const content = composer.trim();
    const roomId = selectedRoomIdRef.current;
    if (
      !roomId
      || activeRoom?.id !== roomId
      || !content
      || sendingRequestIdRef.current !== undefined
    ) return;
    const epoch = roomEpochRef.current;
    const requestId = nextSendingRequestIdRef.current + 1;
    const composerRevision = composerRevisionRef.current;
    const roomAgents = activeRoom.agents;
    nextSendingRequestIdRef.current = requestId;
    sendingRequestIdRef.current = requestId;
    setSending(true);
    setContextFeedback(undefined);
    let restoreComposerFocus = false;
    try {
      const result = await api.sendMessage({
        roomId,
        content,
        targetMemberIds,
      });
      if (
        !isCurrentRoomScope(roomId, epoch)
        || sendingRequestIdRef.current !== requestId
      ) return;
      if (result.message.roomId === roomId) {
        setMessages((current) => mergeMessages(
          current.filter((message) => message.roomId === roomId),
          [result.message],
        ));
      }
      restoreComposerFocus = composerRevisionRef.current === composerRevision;
      if (restoreComposerFocus) {
        updateComposer("");
        setComposerCursor(0);
        setMentionMenuOpen(false);
      }
      if (result.rejectedTargetMemberIds.length > 0) {
        const rejectedNames = result.rejectedTargetMemberIds
          .map((memberId) => roomAgents
            .find((member) => member.agentId === memberId)?.displayName ?? memberId)
          .join("、");
        setContextFeedback(l(
          `The room message was saved, but these Runtimes were not started: ${rejectedNames}.`,
          `房间消息已保存，但以下 Runtime 未被唤醒：${rejectedNames}。`,
        ));
      }
    } catch (error) {
      if (
        isCurrentRoomScope(roomId, epoch)
        && sendingRequestIdRef.current === requestId
      ) {
        restoreComposerFocus = composerRevisionRef.current === composerRevision;
        setContextFeedback(errorMessage(error));
      }
    } finally {
      if (
        isCurrentRoomScope(roomId, epoch)
        && sendingRequestIdRef.current === requestId
      ) {
        sendingRequestIdRef.current = undefined;
        setSending(false);
        if (restoreComposerFocus) composerRef.current?.focus();
      }
    }
  }, [
    activeRoom,
    api,
    composer,
    isCurrentRoomScope,
    l,
    setContextFeedback,
    targetMemberIds,
    updateComposer,
  ]);

  const insertMention = (member: TeamChatRoomAgent, replaceActiveQuery = false): void => {
    const cursor = Math.min(composerCursor, composer.length);
    const context = replaceActiveQuery ? activeMentionContext(composer, cursor) : undefined;
    const mention = `@${member.displayName}`;
    let next: string;
    let nextCursor: number;
    if (context) {
      next = `${composer.slice(0, context.start)}${mention} ${composer.slice(context.end)}`;
      nextCursor = context.start + mention.length + 1;
    } else {
      const leading = cursor > 0 && !/\s/u.test(composer[cursor - 1] ?? "") ? " " : "";
      const trailing = cursor < composer.length && /\s/u.test(composer[cursor] ?? "") ? "" : " ";
      const inserted = `${leading}${mention}${trailing}`;
      next = `${composer.slice(0, cursor)}${inserted}${composer.slice(cursor)}`;
      nextCursor = cursor + inserted.length;
    }
    updateComposer(next);
    setComposerCursor(nextCursor);
    setMentionMenuOpen(false);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  // The picker edits the composer text because the text decides who is activated.
  // Selecting appends a mention; deselecting removes the mention it added.
  const toggleTargetMember = (memberId: string): void => {
    const member = activeRoom?.agents.find((entry) => entry.agentId === memberId);
    if (!member) return;
    const existing = parseTeamChatMentions(composer, [member])
      .find((mention) => mention.memberId === memberId);
    if (!existing) {
      insertMention(member);
      return;
    }
    // Close the gap the mention left behind without reflowing the rest of the draft.
    const { text, cursor } = removeMentionFromText(composer, existing);
    updateComposer(text);
    setComposerCursor(cursor);
  };

  const onMentionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (mentionCandidates.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setMentionIndex((current) => (current + direction + mentionCandidates.length) % mentionCandidates.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(mentionCandidates[mentionIndex] ?? mentionCandidates[0]!, true);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMentionMenuOpen(false);
      return true;
    }
    return false;
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (onMentionKeyDown(event)) return;
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void sendMessage();
  };

  const archiveRoom = async (): Promise<void> => {
    if (!activeRoom) return;
    if (!window.confirm(l(`Archive “${activeRoom.name}”?`, `归档“${activeRoom.name}”？`))) return;
    const roomId = activeRoom.id;
    const epoch = roomEpochRef.current;
    try {
      setRoomActionsOpen(false);
      await api.archiveRoom(roomId);
      roomsGenerationRef.current += 1;
      setRooms((current) => current.filter((room) => room.id !== roomId));
      if (selectedRoomIdRef.current === roomId) selectRoom(undefined);
      await loadRooms();
    } catch (error) {
      if (isCurrentRoomScope(roomId, epoch)) setContextFeedback(errorMessage(error));
    }
  };

  const deleteRoom = async (
    room: Pick<TeamChatRoomSummary, "id" | "name">,
    trigger: HTMLButtonElement,
  ): Promise<void> => {
    if (deletingRoomIdRef.current) return;
    const confirmed = window.confirm(l(
      `Permanently delete “${room.name}” and all of its messages? This cannot be undone.`,
      `永久删除“${room.name}”及其中的全部消息？此操作无法撤销。`,
    ));
    if (!confirmed) return;
    const roomIndex = rooms.findIndex((candidate) => candidate.id === room.id);
    const preferredFocusRoomId = roomIndex >= 0
      ? rooms[roomIndex + 1]?.id ?? rooms[roomIndex - 1]?.id
      : undefined;
    deletingRoomSelectionRef.current = {
      roomId: room.id,
      preferredRoomId: preferredFocusRoomId,
    };
    deletingRoomIdRef.current = room.id;
    setDeletingRoomId(room.id);
    setContextFeedback(undefined);
    try {
      await api.deleteRoom(room.id);
      const shouldMoveFocus = document.activeElement === trigger
        || document.activeElement === document.body;
      roomsGenerationRef.current += 1;
      setRooms((current) => current.filter((candidate) => candidate.id !== room.id));
      setMessages((current) => current.filter((message) => message.roomId !== room.id));
      const deletedSelectedRoom = selectedRoomIdRef.current === room.id;
      if (deletedSelectedRoom) selectRoom(preferredFocusRoomId);
      setRoomActionsOpen(false);
      if (shouldMoveFocus) {
        setPendingDeleteFocus({
          kind: "room",
          preferredRoomId: preferredFocusRoomId,
          origin: trigger,
        });
      }
      await loadRooms(deletedSelectedRoom ? preferredFocusRoomId : undefined);
    } catch (error) {
      setContextFeedback(errorMessage(error));
      if (
        document.activeElement === trigger
        || document.activeElement === document.body
      ) setPendingDeleteFocus({ kind: "trigger", element: trigger });
    } finally {
      deletingRoomSelectionRef.current = undefined;
      deletingRoomIdRef.current = undefined;
      setDeletingRoomId(undefined);
    }
  };

  const renameRoom = async (name: string): Promise<void> => {
    if (!activeRoom) return;
    const roomId = activeRoom.id;
    const epoch = roomEpochRef.current;
    let updated: TeamChatRoom;
    try {
      updated = await api.updateRoom({ roomId, name });
    } catch (error) {
      if (isCurrentRoomScope(roomId, epoch)) throw error;
      return;
    }
    if (
      isCurrentRoomScope(roomId, epoch)
      && updated.id === roomId
    ) commitAuthoritativeRoom(updated);
    setRooms((current) => current.map((room) =>
      room.id === updated.id
        ? { ...room, name: updated.name, updatedAt: updated.updatedAt }
        : room));
    if (isCurrentRoomScope(roomId, epoch)) setContextFeedback(undefined);
  };

  const addRoomEmployee = async (member: {
    configuredAgentId: string;
    displayName: string;
  }): Promise<void> => {
    if (!activeRoom) return;
    const room = activeRoom;
    const epoch = roomEpochRef.current;
    const updated = await api.updateRoom({
      roomId: room.id,
      members: [
        ...room.agents.map((existing) => ({
          memberId: existing.agentId,
          configuredAgentId: existing.configuredAgentId,
          displayName: existing.displayName,
        })),
        member,
      ],
    });
    if (
      isCurrentRoomScope(room.id, epoch)
      && updated.id === room.id
    ) commitAuthoritativeRoom(updated);
    setRooms((current) => current.map((room) =>
      room.id === updated.id
        ? { ...room, agentCount: updated.agents.length, updatedAt: updated.updatedAt }
        : room));
    if (isCurrentRoomScope(room.id, epoch)) {
      setAddEmployeeOpen(false);
      setContextFeedback(undefined);
    }
  };

  const removeRoomEmployee = async (member: TeamChatRoomAgent): Promise<void> => {
    if (!activeRoom || removingAgentIds.has(member.agentId)) return;
    if (!window.confirm(l(
      `Remove employee “${member.displayName}” from this room?`,
      `从当前房间移除员工“${member.displayName}”？`,
    ))) return;
    const roomId = activeRoom.id;
    const epoch = roomEpochRef.current;
    const requestId = nextRoomOperationIdRef.current + 1;
    nextRoomOperationIdRef.current = requestId;
    removingAgentRequestIdsRef.current.set(member.agentId, requestId);
    setRemovingAgentIds((current) => new Set(current).add(member.agentId));
    setMemberContextMenu(undefined);
    setContextFeedback(undefined);
    try {
      const updated = await api.removeRoomMember({
        roomId,
        memberId: member.agentId,
      });
      if (
        isCurrentRoomScope(roomId, epoch)
        && updated.id === roomId
      ) commitAuthoritativeRoom(updated);
      setRooms((current) => current.map((room) =>
        room.id === updated.id
          ? { ...room, agentCount: updated.agents.length, updatedAt: updated.updatedAt }
          : room));
    } catch (error) {
      if (isCurrentRoomScope(roomId, epoch)) setContextFeedback(errorMessage(error));
    } finally {
      if (removingAgentRequestIdsRef.current.get(member.agentId) === requestId) {
        removingAgentRequestIdsRef.current.delete(member.agentId);
        setRemovingAgentIds((current) => {
          const next = new Set(current);
          next.delete(member.agentId);
          return next;
        });
      }
    }
  };

  useEffect(() => {
    if (!memberContextMenu) return undefined;
    const close = (): void => setMemberContextMenu(undefined);
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [memberContextMenu]);

  const resetAgentConversation = async (member: TeamChatRoomAgent): Promise<void> => {
    if (
      !activeRoom ||
      Object.values(streams).some((stream) => stream.agentId === member.agentId) ||
      resettingAgentIds.has(member.agentId)
    ) return;
    const roomId = activeRoom.id;
    const epoch = roomEpochRef.current;
    const requestId = nextRoomOperationIdRef.current + 1;
    nextRoomOperationIdRef.current = requestId;
    resettingAgentRequestIdsRef.current.set(member.agentId, requestId);
    setResettingAgentIds((current) => new Set(current).add(member.agentId));
    setContextFeedback(undefined);
    try {
      const room = await api.resetAgentSession({
        roomId,
        agentId: member.agentId,
      });
      if (
        isCurrentRoomScope(roomId, epoch)
        && room.id === roomId
      ) commitAuthoritativeRoom(room);
    } catch (error) {
      if (isCurrentRoomScope(roomId, epoch)) setContextFeedback(errorMessage(error));
    } finally {
      if (resettingAgentRequestIdsRef.current.get(member.agentId) === requestId) {
        resettingAgentRequestIdsRef.current.delete(member.agentId);
        setResettingAgentIds((current) => {
          const next = new Set(current);
          next.delete(member.agentId);
          return next;
        });
      }
    }
  };

  return (
    <div className="team-chat-page">
      <header className="app-page-head team-chat-page-head">
        <div>
          <h2>Chat</h2>
          <p>{l("Independent Runtime employees sharing one project workspace", "多个独立 Runtime 员工共享同一个项目工作区")}</p>
        </div>
        {connection.state === "ready" ? (
          <div className="team-chat-database-controls">
            <div className="team-chat-connection-chip" title={connection.databaseLabel}>
              <Database size={13} />
              <span>{l("Local data", "本地数据")}</span>
            </div>
          </div>
        ) : null}
      </header>

      {connection.state !== "ready" ? (
        <ConnectionSetup
          language={language}
          status={connection}
          busy={connectionBusy}
          feedback={feedback}
          onRetry={() => void connect()}
        />
      ) : (
        <div className="team-chat-ready">
          {feedback ? (
            <div className="team-chat-feedback" role="alert" aria-atomic="true">{feedback}</div>
          ) : null}
          <div className="team-chat-layout">
          <aside className="team-chat-room-rail">
            <div className="team-chat-rail-head">
              <span>{l("Rooms", "房间")}</span>
              <button
                ref={newRoomButtonRef}
                type="button"
                onClick={() => setCreateOpen(true)}
                title={l("New room", "新建房间")}
                aria-label={l("New room", "新建房间")}
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="team-chat-room-list">
              {loadingRooms && rooms.length === 0 ? <LoaderCircle className="spin" size={16} /> : null}
              {rooms.map((room) => (
                <div
                  key={room.id}
                  className={`team-chat-room-item${room.id === selectedRoomId ? " active" : ""}`}
                >
                  <button
                    className="team-chat-room-select"
                    type="button"
                    ref={(element) => {
                      if (element) roomSelectButtonRefs.current.set(room.id, element);
                      else roomSelectButtonRefs.current.delete(room.id);
                    }}
                    onClick={() => selectRoom(room.id)}
                  >
                    <strong>{room.name}</strong>
                    <span>{room.lastMessage || l(`${room.agentCount} employees`, `${room.agentCount} 名员工`)}</span>
                  </button>
                  <button
                    className="team-chat-room-delete"
                    type="button"
                    aria-disabled={deletingRoomId !== undefined || undefined}
                    aria-busy={deletingRoomId === room.id || undefined}
                    onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                      void deleteRoom(room, event.currentTarget);
                    }}
                    title={l(`Delete room “${room.name}”`, `删除房间“${room.name}”`)}
                    aria-label={l(`Delete room “${room.name}”`, `删除房间“${room.name}”`)}
                  >
                    {deletingRoomId === room.id
                      ? <LoaderCircle className="spin" size={13} />
                      : <Trash2 size={13} />}
                  </button>
                </div>
              ))}
              {!loadingRooms && rooms.length === 0 ? (
                <div className="team-chat-room-empty">
                  <MessageCircleMore size={20} />
                  <span>{l("No rooms yet", "还没有房间")}</span>
                  <button type="button" onClick={() => setCreateOpen(true)}>{l("Create room", "创建房间")}</button>
                </div>
              ) : null}
            </div>
          </aside>

          <section className="team-chat-conversation">
            {activeRoom ? (
              <>
                <header className="team-chat-room-head">
                  <div>
                    <TeamChatRoomTitle
                      room={activeRoom}
                      language={language}
                      onRename={renameRoom}
                      onError={(error) => setContextFeedback(errorMessage(error))}
                    />
                    <span title={activeRoom.workDir}>{activeRoom.workDir || l("No working directory", "未设置工作目录")}</span>
                  </div>
                  <div className="team-chat-room-actions">
                    <button
                      type="button"
                      onClick={() => void openLatestRoomSession()}
                      title={l("Open latest Session", "打开最近 Session")}
                      aria-label={l("Open latest Session", "打开最近 Session")}
                    >
                      <MessageCircleMore size={16} />
                    </button>
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={roomActionsOpen}
                      onClick={() => setRoomActionsOpen((current) => !current)}
                      title={l("Room actions", "房间操作")}
                      aria-label={l("Room actions", "房间操作")}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    {roomActionsOpen ? (
                      <div className="team-chat-room-menu" role="menu">
                        <button type="button" role="menuitem" onClick={() => void archiveRoom()}>
                          <Archive size={14} />
                          {l("Archive studio", "归档工作室")}
                        </button>
                        <button
                          className="danger"
                          type="button"
                          role="menuitem"
                          aria-disabled={deletingRoomId !== undefined || undefined}
                          aria-busy={deletingRoomId === activeRoom.id || undefined}
                          onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                            void deleteRoom(activeRoom, event.currentTarget);
                          }}
                        >
                          {deletingRoomId === activeRoom.id
                            ? <LoaderCircle className="spin" size={14} />
                            : <Trash2 size={14} />}
                          {l("Delete permanently", "永久删除")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </header>
                <div className="team-chat-transcript">
                  {nextBefore ? (
                    <button className="team-chat-load-earlier" type="button" onClick={() => void loadEarlierMessages()} disabled={loadingEarlier}>
                      {loadingEarlier ? <LoaderCircle className="spin" size={13} /> : <ChevronUp size={13} />}
                      {l("Earlier messages", "更早消息")}
                    </button>
                  ) : null}
                  {loadingMessages ? <div className="team-chat-loading"><LoaderCircle className="spin" size={18} /></div> : null}
                  {!loadingMessages && messages.length === 0 && Object.keys(streams).length === 0 ? (
                    <div className="team-chat-transcript-empty">
                      <UsersRound size={26} />
                      <strong>{l("Start the room", "开始房间对话")}</strong>
                      <span>{l("Send a room message, or mention a Runtime when it should act.", "发送房间消息；需要 Runtime 行动时再 @它。")}</span>
                    </div>
                  ) : null}
                  {messages.map((message) => (
                    <TeamChatMessageCard
                      key={message.id}
                      message={message}
                      member={activeRoom.agents.find((member) => member.agentId === message.senderAgentId)}
                      recipient={activeRoom.agents.find((member) => member.agentId === message.recipientMemberId)}
                      language={language}
                      onOpenSession={message.senderType === "agent" ? () => void openMessageSession(message) : undefined}
                    />
                  ))}
                  {Object.values(streams).map((stream) => (
                    <StreamMessageCard
                      key={stream.dispatchId}
                      stream={stream}
                      member={activeRoom.agents.find((member) => member.agentId === stream.agentId)}
                      language={language}
                    />
                  ))}
                  <div ref={transcriptEndRef} />
                </div>
                <footer className="team-chat-composer">
                  <div className="team-chat-recipient-picker" aria-label={l("Message recipients", "消息收件员工")}>
                    <span>{l("To", "发送给")}</span>
                    {activeRoom.agents.map((member) => {
                      const available = snapshot.configuredAgents
                        .some((agent) => agent.id === member.configuredAgentId);
                      const selected = targetMemberIds.includes(member.agentId);
                      return (
                        <button
                          type="button"
                          key={member.agentId}
                          className={selected ? "selected" : ""}
                          disabled={!available || !member.enabled}
                          aria-pressed={selected}
                          onClick={() => toggleTargetMember(member.agentId)}
                        >
                          {member.displayName}
                        </button>
                      );
                    })}
                  </div>
                  {mentionCandidates.length > 0 ? (
                    <div className="team-chat-mention-menu" id="team-chat-mentions" role="listbox" aria-label={l("Mention an Agent", "提及 Agent")}>
                      {mentionCandidates.map((member, index) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={index === mentionIndex}
                          className={index === mentionIndex ? "active" : ""}
                          key={member.agentId}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => insertMention(member, true)}
                        >
                          <span className="team-chat-member-avatar available"><Bot size={14} /></span>
                          <span><strong>{member.displayName}</strong><small>{member.runtimeId} · {modelDisplayLabel(member.modelId)}</small></span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="team-chat-compose-row">
                    <textarea
                      ref={composerRef}
                      value={composer}
                      aria-autocomplete="list"
                      aria-controls="team-chat-mentions"
                      aria-expanded={mentionCandidates.length > 0}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        const cursor = event.currentTarget.selectionStart ?? value.length;
                        updateComposer(value);
                        setComposerCursor(cursor);
                        setMentionMenuOpen(Boolean(activeMentionContext(value, cursor)));
                      }}
                      onSelect={(event) => {
                        const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
                        setComposerCursor(cursor);
                        setMentionMenuOpen(Boolean(activeMentionContext(event.currentTarget.value, cursor)));
                      }}
                      onKeyDown={onComposerKeyDown}
                      placeholder={l("Room message · @name wakes that Runtime", "房间消息 · 输入 @名称才会唤醒对应 Runtime")}
                      rows={2}
                    />
                    {activeRootMessageId ? (
                      <button className="team-chat-stop" type="button" onClick={() => void api.stopTurn(activeRootMessageId)} title={l("Stop this turn", "停止本轮")}>
                        <CircleStop size={17} />
                      </button>
                    ) : null}
                    <button className="team-chat-send" type="button" onClick={() => void sendMessage()} disabled={!composer.trim() || sending} title={l("Send", "发送")}>
                      {sending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
                    </button>
                  </div>
                  <span className="team-chat-compose-hint">{l("No mention: room message only · Enter to send", "未 @：只发房间消息 · Enter 发送")}</span>
                </footer>
              </>
            ) : (
              <div className="team-chat-no-selection">
                <MessageCircleMore size={28} />
                <strong>{l("Choose or create a room", "选择或创建一个房间")}</strong>
              </div>
            )}
          </section>

          <aside className="team-chat-members">
            <div className="team-chat-rail-head">
              <span>{l("Employees", "员工")}</span>
              {activeRoom ? (
                <button
                  type="button"
                  onClick={() => setAddEmployeeOpen(true)}
                  disabled={snapshot.configuredAgents.length === 0 || activeRoom.agents.length >= 24}
                  title={l("Add employee", "添加员工")}
                  aria-label={l("Add employee", "添加员工")}
                >
                  <Plus size={15} />
                </button>
              ) : null}
            </div>
            <div className="team-chat-member-list">
              {activeRoom?.agents.map((member) => {
                const available = snapshot.configuredAgents.some(
                  (agent) => agent.id === member.configuredAgentId,
                );
                const continuity = member.hasActiveConversation
                  ? l("Persistent context", "持续会话")
                  : member.continuationAvailable
                    ? l("Continues after first reply", "首次回复后持续")
                    : l("New context each time", "每次新会话");
                const resetting = resettingAgentIds.has(member.agentId);
                const running = Object.values(streams)
                  .some((stream) => stream.agentId === member.agentId);
                const selected = targetMemberIds.includes(member.agentId);
                return (
                  <div
                    className={`team-chat-member-row ${selected ? "selected" : ""}`}
                    key={member.agentId}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMemberContextMenu({
                        member,
                        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 164)),
                        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 48)),
                      });
                    }}
                  >
                    <button className="team-chat-member-main" type="button" disabled={!available || !member.enabled} onClick={() => toggleTargetMember(member.agentId)} title={available ? l(`Select ${member.displayName}`, `选择 ${member.displayName}`) : l("Agent configuration is unavailable", "Agent 配置不可用")}>
                      <span className={`team-chat-member-avatar ${available ? "available" : "missing"} ${running ? "running" : ""}`}><Bot size={14} /></span>
                      <span>
                        <strong>{member.displayName}</strong>
                        <small>{available ? `${member.runtimeId} · ${running ? l("Running", "运行中") : continuity}` : l("Unavailable", "配置不可用")}</small>
                      </span>
                    </button>
                    {available && member.hasActiveConversation ? (
                      <button
                        className="team-chat-member-reset"
                        type="button"
                        disabled={running || resetting}
                        onClick={() => void resetAgentConversation(member)}
                        title={l("Start new conversation", "开始新会话")}
                        aria-label={l(`Start a new conversation for ${member.displayName}`, `为 ${member.displayName} 开始新会话`)}
                      >
                        {resetting ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </aside>
          </div>
        </div>
      )}

      {memberContextMenu ? (
        <div
          className="team-chat-member-context-menu"
          style={{ left: memberContextMenu.x, top: memberContextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="team-chat-member-context-action"
            disabled={removingAgentIds.has(memberContextMenu.member.agentId)}
            onClick={() => void removeRoomEmployee(memberContextMenu.member)}
          >
            {removingAgentIds.has(memberContextMenu.member.agentId) ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
            <span>{l("Remove employee", "删除员工")}</span>
          </button>
        </div>
      ) : null}

      {createOpen ? (
        <CreateRoomDialog
          language={language}
          agents={snapshot.configuredAgents}
          defaultWorkDir={snapshot.workDir}
          onPickDirectory={(defaultPath) => automationApi.pickDirectory(defaultPath)}
          onCreate={async (request) => {
            const room = await api.createRoom(request);
            setCreateOpen(false);
            await loadRooms(room.id);
          }}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}

      {addEmployeeOpen && activeRoom ? (
        <AddRoomEmployeeDialog
          language={language}
          agents={snapshot.configuredAgents}
          existingNames={activeRoom.agents.map((member) => member.displayName)}
          onAdd={addRoomEmployee}
          onClose={() => setAddEmployeeOpen(false)}
        />
      ) : null}

    </div>
  );
}

function ConnectionSetup({
  language,
  status,
  busy,
  feedback,
  onRetry,
}: {
  language: LanguageMode;
  status: TeamChatConnectionStatus;
  busy: boolean;
  feedback?: string;
  onRetry: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="team-chat-setup">
      <div className="team-chat-setup-card">
        <span className="team-chat-setup-icon"><Database size={22} /></span>
        <h3>{status.state === "connecting" ? l("Starting Chat database", "正在启动 Chat 数据库") : l("Chat database unavailable", "Chat 数据库不可用")}</h3>
        <p>{l(
          "AgentRecall manages Chat data automatically. No database setup is required.",
          "AgentRecall 会自动管理 Chat 数据，无需单独安装或配置数据库。",
        )}</p>
        {feedback || status.error ? <div className="team-chat-setup-error" role="alert">{feedback || status.error}</div> : null}
        <div className="team-chat-setup-actions">
          <button className="primary" type="button" onClick={onRetry} disabled={busy || status.state === "connecting"}>
            {busy ? <LoaderCircle className="spin" size={14} /> : null}
            {l("Retry", "重试")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateRoomDialog({
  language,
  agents,
  defaultWorkDir,
  onPickDirectory,
  onCreate,
  onClose,
}: {
  language: LanguageMode;
  agents: StudioAgentOption[];
  defaultWorkDir: string;
  onPickDirectory: (defaultPath?: string) => Promise<string | undefined>;
  onCreate: (request: CreateTeamChatRoomRequest) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [name, setName] = useState("");
  const [workDir, setWorkDir] = useState(defaultWorkDir);
  const employeeSequence = useRef(1);
  const [employees, setEmployees] = useState<DraftStudioEmployee[]>(() => agents[0]
    ? [{
        localId: "employee-1",
        configuredAgentId: agents[0].id,
        displayName: agents[0].name,
      }]
    : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || employees.length === 0 || employees.some((employee) => !employee.displayName.trim()) || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({
        name: name.trim(),
        workDir: workDir.trim(),
        members: employees.map((employee) => ({
          configuredAgentId: employee.configuredAgentId,
          displayName: employee.displayName.trim(),
        })),
      });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  const addEmployee = (): void => {
    const agent = agents[0];
    if (!agent) return;
    employeeSequence.current += 1;
    setEmployees((current) => [...current, {
      localId: `employee-${employeeSequence.current}`,
      configuredAgentId: agent.id,
      displayName: nextStudioEmployeeName(agent.name, current.map((employee) => employee.displayName)),
    }]);
  };

  return (
    <div className="team-chat-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form className="team-chat-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <div><h3>{l("Create a studio", "创建工作室")}</h3><p>{l("Give independent employees one shared project workspace.", "让多个独立员工在同一个项目目录中协作。")}</p></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={l("Close", "关闭")}><X size={16} /></button>
        </header>
        <label className="team-chat-field">
          <span>{l("Room name", "房间名称")}</span>
          <input autoFocus value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={120} placeholder={l("Release review", "版本评审")} />
        </label>
        <label className="team-chat-field">
          <span>{l("Working directory", "工作目录")}</span>
          <div className="team-chat-directory-field">
            <input value={workDir} onChange={(event) => setWorkDir(event.currentTarget.value)} maxLength={4096} placeholder={l("Optional project directory", "可选项目目录")} />
            <button type="button" onClick={() => void onPickDirectory(workDir).then((selected) => { if (selected) setWorkDir(selected); })} title={l("Choose directory", "选择目录")}>
              <FolderOpen size={15} />
            </button>
          </div>
        </label>
        <section className="team-chat-employees">
          <div className="team-chat-employee-heading">
            <div>
              <h4>{l("Employees", "员工")}</h4>
              <p>{l("Each employee keeps a separate conversation.", "每名员工都会保留自己的独立会话。")}</p>
            </div>
            <span>{employees.length}/24</span>
          </div>
          {agents.length === 0 ? <p className="team-chat-no-agents">{l("Configure an Agent in Runtime first.", "请先在 Runtime 中配置 Agent。")}</p> : null}
          <div className="team-chat-employee-roster">
            {employees.map((employee) => {
              const selectedAgent = agents.find((agent) => agent.id === employee.configuredAgentId);
              return (
                <article className="team-chat-employee-card" key={employee.localId}>
                  <span className="team-chat-employee-portrait" aria-hidden="true">
                    <Bot size={16} />
                    <i />
                  </span>
                  <div className="team-chat-employee-identity">
                    <input
                      className="team-chat-employee-name"
                      value={employee.displayName}
                      disabled={busy}
                      maxLength={120}
                      aria-label={l("Employee name", "员工名称")}
                      placeholder={l("Employee name", "员工名称")}
                      onChange={(event) => {
                        const displayName = event.currentTarget.value;
                        setEmployees((current) => current.map((item) =>
                          item.localId === employee.localId ? { ...item, displayName } : item));
                      }}
                    />
                    <label className="team-chat-employee-runtime">
                      <span>Runtime</span>
                      <select
                        value={employee.configuredAgentId}
                        disabled={busy}
                        aria-label={l("Runtime configuration", "Runtime 配置")}
                        onChange={(event) => {
                          const configuredAgentId = event.currentTarget.value;
                          setEmployees((current) => current.map((item) => {
                            if (item.localId !== employee.localId) return item;
                            const agent = agents.find((candidate) => candidate.id === configuredAgentId);
                            return {
                              ...item,
                              configuredAgentId,
                              displayName: agent
                                ? nextStudioEmployeeName(
                                    agent.name,
                                    current
                                      .filter((candidate) => candidate.localId !== item.localId)
                                      .map((candidate) => candidate.displayName),
                                  )
                                : item.displayName,
                            };
                          }));
                        }}
                      >
                        {agents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="team-chat-employee-meta">
                      <span>{selectedAgent?.runtimeAgentId}</span>
                      <span>{modelDisplayLabel(selectedAgent?.modelId)}</span>
                      {selectedAgent?.description ? <small>{selectedAgent.description}</small> : null}
                    </div>
                  </div>
                  {employees.length > 1 ? (
                    <button
                      className="team-chat-employee-remove"
                      type="button"
                      disabled={busy}
                      onClick={() => setEmployees((current) =>
                        current.filter((item) => item.localId !== employee.localId))}
                      title={l("Remove employee", "移除员工")}
                      aria-label={l("Remove employee", "移除员工")}
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                </article>
              );
            })}
            {agents.length > 0 ? (
              <button
                className="team-chat-add-employee"
                type="button"
                onClick={addEmployee}
                disabled={busy || employees.length >= 24}
              >
                <span><Plus size={14} /></span>
                <strong>{l("Add another employee", "再添加一名员工")}</strong>
                <small>{l("The same Runtime can be used more than once.", "可以重复使用同一个 Runtime。")}</small>
              </button>
            ) : null}
          </div>
        </section>
        {error ? <div className="team-chat-dialog-error" role="alert">{error}</div> : null}
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>{l("Cancel", "取消")}</button>
          <button className="primary" type="submit" disabled={busy || !name.trim() || employees.length === 0 || employees.some((employee) => !employee.displayName.trim())}>
            {busy ? <LoaderCircle className="spin" size={14} /> : null}{l("Create room", "创建房间")}
          </button>
        </footer>
      </form>
    </div>
  );
}

function AddRoomEmployeeDialog({
  language,
  agents,
  existingNames,
  onAdd,
  onClose,
}: {
  language: LanguageMode;
  agents: StudioAgentOption[];
  existingNames: string[];
  onAdd: (member: { configuredAgentId: string; displayName: string }) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [configuredAgentId, setConfiguredAgentId] = useState(agents[0]?.id ?? "");
  const [displayName, setDisplayName] = useState(() =>
    nextStudioEmployeeName(agents[0]?.name ?? "Employee", existingNames));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selectedAgent = agents.find((agent) => agent.id === configuredAgentId);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const name = displayName.trim();
    if (!configuredAgentId || !name || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdd({ configuredAgentId, displayName: name });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <div
      className="team-chat-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={l("Add employee", "添加员工")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form className="team-chat-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <div>
            <h3>{l("Add employee", "添加员工")}</h3>
            <p>{l(
              "Add another independent Runtime conversation to this room.",
              "向这个房间添加一个拥有独立会话的 Runtime 员工。",
            )}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </header>
        <label className="team-chat-field">
          <span>{l("Employee name", "员工名称")}</span>
          <input
            autoFocus
            value={displayName}
            disabled={busy}
            maxLength={120}
            aria-label={l("Employee name", "员工名称")}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
          />
        </label>
        <label className="team-chat-field">
          <span>Runtime</span>
          <select
            value={configuredAgentId}
            disabled={busy}
            aria-label={l("Runtime configuration", "Runtime 配置")}
            onChange={(event) => {
              const nextId = event.currentTarget.value;
              const nextAgent = agents.find((agent) => agent.id === nextId);
              setConfiguredAgentId(nextId);
              if (nextAgent) setDisplayName(nextStudioEmployeeName(nextAgent.name, existingNames));
            }}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
        </label>
        {selectedAgent ? (
          <div className="team-chat-employee-meta">
            <span>{selectedAgent.runtimeAgentId}</span>
            <span>{modelDisplayLabel(selectedAgent.modelId)}</span>
            {selectedAgent.description ? <small>{selectedAgent.description}</small> : null}
          </div>
        ) : null}
        {error ? <div className="team-chat-dialog-error" role="alert">{error}</div> : null}
        <footer>
          <button className="team-chat-dialog-cancel" type="button" onClick={onClose} disabled={busy}>
            {l("Cancel", "取消")}
          </button>
          <button className="primary team-chat-dialog-confirm" type="submit" disabled={busy || !displayName.trim() || !configuredAgentId}>
            {busy ? <LoaderCircle className="spin" size={14} /> : null}
            {!busy ? <Plus size={14} /> : null}
            {l("Add employee", "添加员工")}
          </button>
        </footer>
      </form>
    </div>
  );
}

function TeamChatMessageCard({
  message,
  member,
  recipient,
  language,
  onOpenSession,
}: {
  message: TeamChatMessage;
  member?: TeamChatRoomAgent;
  recipient?: TeamChatRoomAgent;
  language: LanguageMode;
  onOpenSession?: () => void;
}): ReactElement {
  return (
    <article tabIndex={-1} data-message-id={message.sourceMessageId ?? message.id} className={`team-chat-message is-${message.senderType} ${message.status === "error" ? "is-error" : ""}`}>
      <header>
        <strong>{message.senderName}</strong>
        {recipient ? <span className="team-chat-message-recipient">→ {recipient.displayName}</span> : null}
        {message.deliveryType === "post" ? <span>{localize(language, "post", "公告")}</span> : null}
        {member ? <span className="team-chat-runtime-badge">{member.runtimeId}</span> : null}
        {onOpenSession ? (
          <button
            type="button"
            onClick={onOpenSession}
            title={localize(language, "Open Session", "打开 Session")}
            aria-label={localize(language, `Open Session for ${message.senderName}`, `打开 ${message.senderName} 的 Session`)}
          >
            <MessageCircleMore size={13} />
          </button>
        ) : null}
        <time>{formatMessageTime(message.createdAt, language)}</time>
      </header>
      <div className="team-chat-message-content">
        <Markdown text={message.content} language={language} />
      </div>
    </article>
  );
}

function StreamMessageCard({ stream, member, language }: { stream: StreamDraft; member?: TeamChatRoomAgent; language: LanguageMode }): ReactElement {
  return (
    <article className="team-chat-message is-agent is-streaming">
      <header><strong>{stream.agentName}</strong>{member ? <span className="team-chat-runtime-badge">{member.runtimeId}</span> : null}<span>{localize(language, "Running…", "正在执行…")}</span></header>
      <div className="team-chat-message-content">{stream.content || <span className="team-chat-typing"><i /><i /><i /></span>}</div>
    </article>
  );
}

function handleTeamChatEvent(event: TeamChatEvent, handlers: {
  selectedRoomId?: string;
  setConnection: (status: TeamChatConnectionStatus) => void;
  setMessages: React.Dispatch<React.SetStateAction<TeamChatMessage[]>>;
  setStreams: React.Dispatch<React.SetStateAction<Record<string, StreamDraft>>>;
  setActiveRootMessageId: React.Dispatch<React.SetStateAction<string | undefined>>;
  refreshRooms: () => void;
  refreshActiveRoom: (roomId: string) => void;
}): void {
  if (event.type === "connection-changed") {
    handlers.setConnection(event.status);
    return;
  }
  if (event.type === "rooms-changed") {
    handlers.refreshRooms();
    return;
  }
  if (event.type === "agent-session-changed") {
    if (event.roomId === handlers.selectedRoomId) handlers.refreshActiveRoom(event.roomId);
    return;
  }
  if (event.type === "message-created") {
    if (
      event.roomId !== handlers.selectedRoomId
      || event.message.roomId !== event.roomId
    ) return;
    handlers.setMessages((current) => mergeMessages(current, [event.message]));
    if (event.message.senderAgentId) {
      handlers.setStreams((current) => Object.fromEntries(Object.entries(current).filter(([, stream]) =>
        stream.rootMessageId !== event.rootMessageId || stream.agentId !== event.message.senderAgentId)));
    }
    return;
  }
  if (event.type === "dispatch-started") {
    if (event.roomId !== handlers.selectedRoomId) return;
    handlers.setActiveRootMessageId(event.rootMessageId);
    handlers.setStreams((current) => ({
      ...current,
      [event.dispatchId]: {
        dispatchId: event.dispatchId,
        rootMessageId: event.rootMessageId,
        agentId: event.agentId,
        agentName: event.agentName,
        content: "",
      },
    }));
    return;
  }
  if (event.type === "dispatch-delta") {
    if (event.roomId !== handlers.selectedRoomId) return;
    handlers.setStreams((current) => {
      const stream = current[event.dispatchId];
      if (!stream) return current;
      return { ...current, [event.dispatchId]: { ...stream, content: stream.content + event.content } };
    });
    return;
  }
  if (event.type === "dispatch-finished") {
    if (event.roomId !== handlers.selectedRoomId) return;
    handlers.setStreams((current) => {
      if (!current[event.dispatchId]) return current;
      const next = { ...current };
      delete next[event.dispatchId];
      return next;
    });
    return;
  }
  if (event.type === "turn-finished") {
    if (event.roomId !== handlers.selectedRoomId) return;
    handlers.setActiveRootMessageId((current) => current === event.rootMessageId ? undefined : current);
  }
}

function mergeMessages(...groups: TeamChatMessage[][]): TeamChatMessage[] {
  const byId = new Map<string, TeamChatMessage>();
  for (const message of groups.flat()) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => {
    return left.sequence - right.sequence || left.id.localeCompare(right.id);
  });
}

export function nextStudioEmployeeName(baseName: string, existingNames: string[]): string {
  const base = baseName.trim() || "Employee";
  const used = new Set(existingNames.map((name) => name.trim().toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  let suffix = 2;
  while (used.has(`${base}${suffix}`.toLocaleLowerCase())) suffix += 1;
  return `${base}${suffix}`;
}

function formatMessageTime(value: string, language: LanguageMode): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeMentionContext(value: string, cursor: number): { start: number; end: number; query: string } | undefined {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  if (safeCursor === 0) return undefined;
  const start = value.lastIndexOf("@", Math.max(0, safeCursor - 1));
  if (start < 0) return undefined;
  const previous = value[start - 1];
  if (previous && !/[\s,，。.!！?？:：;；(\[<{]/u.test(previous)) return undefined;
  const query = value.slice(start + 1, safeCursor);
  if (query.length > 80 || /[\n,，。.!！?？:：;；)\]}>]/u.test(query)) return undefined;
  let end = safeCursor;
  while (end < value.length && !/[\n,，。.!！?？:：;；)\]}>]/u.test(value[end]!)) end += 1;
  return { start, end, query };
}
