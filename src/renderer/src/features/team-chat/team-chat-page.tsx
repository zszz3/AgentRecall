import {
  Archive,
  Bot,
  ChevronUp,
  CircleStop,
  Database,
  FolderOpen,
  LoaderCircle,
  MessageCircleMore,
  Plus,
  RotateCcw,
  Send,
  UsersRound,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  TeamChatConnectionStatus,
  TeamChatEvent,
  TeamChatMessage,
  TeamChatRoom,
  TeamChatRoomAgent,
  TeamChatRoomSummary,
} from "../../../../shared/team-chat";
import { localize, type LanguageMode } from "../../language";
import { useAutomation } from "../automation/automation-provider";

interface StreamDraft {
  dispatchId: string;
  rootMessageId: string;
  agentId: string;
  agentName: string;
  content: string;
}

const INITIAL_CONNECTION: TeamChatConnectionStatus = { state: "connecting" };

export function TeamChatPage({ language }: { language: LanguageMode }): ReactElement {
  const l = useCallback((en: string, zh: string) => localize(language, en, zh), [language]);
  const api = useMemo(() => window.sessionSearch.teamChat, []);
  const { api: automationApi, snapshot } = useAutomation();
  const [connection, setConnection] = useState<TeamChatConnectionStatus>(INITIAL_CONNECTION);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [rooms, setRooms] = useState<TeamChatRoomSummary[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  const selectedRoomIdRef = useRef<string | undefined>(undefined);
  const [activeRoom, setActiveRoom] = useState<TeamChatRoom>();
  const [messages, setMessages] = useState<TeamChatMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<string>();
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [composer, setComposer] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [activeRootMessageId, setActiveRootMessageId] = useState<string>();
  const [streams, setStreams] = useState<Record<string, StreamDraft>>({});
  const [resettingAgentIds, setResettingAgentIds] = useState<Set<string>>(() => new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const skipNextAutoScrollRef = useRef(false);

  selectedRoomIdRef.current = selectedRoomId;

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
      .filter((member) => member.enabled && available.has(member.agentId))
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

  const loadRooms = useCallback(async (preferredRoomId?: string): Promise<void> => {
    setLoadingRooms(true);
    try {
      const next = await api.listRooms();
      setRooms(next);
      setSelectedRoomId((current) => {
        if (preferredRoomId && next.some((room) => room.id === preferredRoomId)) return preferredRoomId;
        if (current && next.some((room) => room.id === current)) return current;
        return next[0]?.id;
      });
      setFeedback(undefined);
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setLoadingRooms(false);
    }
  }, [api]);

  const connect = useCallback(async (): Promise<void> => {
    setConnectionBusy(true);
    setFeedback(undefined);
    try {
      setConnection(await api.connect());
      await loadRooms();
    } catch (error) {
      setFeedback(errorMessage(error));
      setConnection(await api.getConnectionStatus().catch((): TeamChatConnectionStatus => ({
        state: "error",
        error: errorMessage(error),
      })));
    } finally {
      setConnectionBusy(false);
    }
  }, [api, loadRooms]);

  useEffect(() => {
    let active = true;
    void api.getConnectionStatus().then(async (status) => {
      if (!active) return;
      setConnection(status);
      if (status.state === "ready") {
        await loadRooms();
      } else if (status.state === "unconfigured" && status.databaseLabel) {
        await connect();
      }
    }).catch((error) => {
      if (!active) return;
      setConnection({ state: "error", error: errorMessage(error) });
      setFeedback(errorMessage(error));
    });
    return () => { active = false; };
  }, [api, connect, loadRooms]);

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
          void api.getRoom(roomId).then((room) => {
            if (selectedRoomIdRef.current === roomId) setActiveRoom(room);
          }).catch((error) => setFeedback(errorMessage(error)));
        },
      });
    });
    return () => {
      unsubscribe();
    };
  }, [api, loadRooms]);

  useEffect(() => {
    setActiveRootMessageId(undefined);
    setStreams({});
    setResettingAgentIds(new Set());
    setMentionMenuOpen(false);
    if (!selectedRoomId || connection.state !== "ready") {
      setActiveRoom(undefined);
      setMessages([]);
      setNextBefore(undefined);
      return;
    }
    let active = true;
    setLoadingMessages(true);
    setFeedback(undefined);
    void Promise.all([
      api.getRoom(selectedRoomId),
      api.listMessages({ roomId: selectedRoomId, limit: 100 }),
    ]).then(([room, page]) => {
      if (!active) return;
      setActiveRoom(room);
      setMessages(page.messages);
      setNextBefore(page.nextBefore);
    }).catch((error) => {
      if (active) setFeedback(errorMessage(error));
    }).finally(() => {
      if (active) setLoadingMessages(false);
    });
    return () => { active = false; };
  }, [api, connection.state, selectedRoomId]);

  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streams]);

  const loadEarlierMessages = useCallback(async (): Promise<void> => {
    if (!selectedRoomId || !nextBefore || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await api.listMessages({ roomId: selectedRoomId, before: nextBefore, limit: 100 });
      if (page.messages.length > 0) {
        skipNextAutoScrollRef.current = true;
        setMessages((current) => mergeMessages(page.messages, current));
      }
      setNextBefore(page.nextBefore);
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setLoadingEarlier(false);
    }
  }, [api, loadingEarlier, nextBefore, selectedRoomId]);

  const sendMessage = useCallback(async (): Promise<void> => {
    const content = composer.trim();
    if (!selectedRoomId || !content || sending || activeRootMessageId) return;
    setSending(true);
    setFeedback(undefined);
    try {
      const result = await api.sendMessage({ roomId: selectedRoomId, content });
      setMessages((current) => mergeMessages(current, [result.message]));
      setComposer("");
      setComposerCursor(0);
      setMentionMenuOpen(false);
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }, [activeRootMessageId, api, composer, selectedRoomId, sending]);

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
    setComposer(next);
    setComposerCursor(nextCursor);
    setMentionMenuOpen(false);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
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
    try {
      await api.archiveRoom(activeRoom.id);
      await loadRooms();
    } catch (error) {
      setFeedback(errorMessage(error));
    }
  };

  const resetAgentConversation = async (member: TeamChatRoomAgent): Promise<void> => {
    if (!activeRoom || activeRootMessageId || resettingAgentIds.has(member.agentId)) return;
    setResettingAgentIds((current) => new Set(current).add(member.agentId));
    setFeedback(undefined);
    try {
      const room = await api.resetAgentSession({
        roomId: activeRoom.id,
        agentId: member.agentId,
      });
      if (selectedRoomIdRef.current === room.id) setActiveRoom(room);
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setResettingAgentIds((current) => {
        const next = new Set(current);
        next.delete(member.agentId);
        return next;
      });
    }
  };

  return (
    <div className="team-chat-page">
      <header className="app-page-head team-chat-page-head">
        <div>
          <h2>Chat</h2>
          <p>{l("Persistent rooms for your configured Agents", "让已配置的 Agent 在持久房间中协作")}</p>
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
        <div className="team-chat-layout">
          <aside className="team-chat-room-rail">
            <div className="team-chat-rail-head">
              <span>{l("Rooms", "房间")}</span>
              <button type="button" onClick={() => setCreateOpen(true)} title={l("New room", "新建房间")}>
                <Plus size={15} />
              </button>
            </div>
            <div className="team-chat-room-list">
              {loadingRooms && rooms.length === 0 ? <LoaderCircle className="spin" size={16} /> : null}
              {rooms.map((room) => (
                <button
                  type="button"
                  key={room.id}
                  className={room.id === selectedRoomId ? "active" : ""}
                  onClick={() => setSelectedRoomId(room.id)}
                >
                  <strong>{room.name}</strong>
                  <span>{room.lastMessage || l(`${room.agentCount} Agents`, `${room.agentCount} 个 Agent`)}</span>
                </button>
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
                    <strong>{activeRoom.name}</strong>
                    <span title={activeRoom.workDir}>{activeRoom.workDir || l("No working directory", "未设置工作目录")}</span>
                  </div>
                  <button type="button" onClick={() => void archiveRoom()} title={l("Archive room", "归档房间")}>
                    <Archive size={15} />
                  </button>
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
                      <span>{l("Message everyone, or mention one Agent by name.", "直接发消息给所有成员，或用 @ 指定一个 Agent。")}</span>
                    </div>
                  ) : null}
                  {messages.map((message) => (
                    <TeamChatMessageCard
                      key={message.id}
                      message={message}
                      member={activeRoom.agents.find((member) => member.agentId === message.senderAgentId)}
                      language={language}
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
                  {feedback ? <div className="team-chat-feedback" role="alert">{feedback}</div> : null}
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
                          <span><strong>{member.displayName}</strong><small>{member.runtimeId} · {member.modelId}</small></span>
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
                        setComposer(value);
                        setComposerCursor(cursor);
                        setMentionMenuOpen(Boolean(activeMentionContext(value, cursor)));
                      }}
                      onSelect={(event) => {
                        const cursor = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
                        setComposerCursor(cursor);
                        setMentionMenuOpen(Boolean(activeMentionContext(event.currentTarget.value, cursor)));
                      }}
                      onKeyDown={onComposerKeyDown}
                      placeholder={l("Message the room · @Agent to route", "发送到房间 · 输入 @Agent 指定成员")}
                      rows={2}
                    />
                    {activeRootMessageId ? (
                      <button className="team-chat-stop" type="button" onClick={() => void api.stopTurn(activeRootMessageId)} title={l("Stop this turn", "停止本轮")}>
                        <CircleStop size={17} />
                      </button>
                    ) : (
                      <button className="team-chat-send" type="button" onClick={() => void sendMessage()} disabled={!composer.trim() || sending} title={l("Send", "发送")}>
                        {sending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
                      </button>
                    )}
                  </div>
                  <span className="team-chat-compose-hint">{l("Enter to send · Shift+Enter for a new line", "Enter 发送 · Shift+Enter 换行")}</span>
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
            <div className="team-chat-rail-head"><span>{l("Members", "成员")}</span></div>
            <div className="team-chat-member-list">
              {activeRoom?.agents.map((member) => {
                const available = snapshot.configuredAgents.some((agent) => agent.id === member.agentId);
                const continuity = member.hasActiveConversation
                  ? l("Persistent context", "持续会话")
                  : member.continuationAvailable
                    ? l("Continues after first reply", "首次回复后持续")
                    : l("New context each time", "每次新会话");
                const resetting = resettingAgentIds.has(member.agentId);
                return (
                  <div className="team-chat-member-row" key={member.agentId}>
                    <button className="team-chat-member-main" type="button" disabled={!available || !member.enabled} onClick={() => insertMention(member)} title={available ? l(`Mention ${member.displayName}`, `提及 ${member.displayName}`) : l("Agent configuration is unavailable", "Agent 配置不可用")}>
                      <span className={`team-chat-member-avatar ${available ? "available" : "missing"}`}><Bot size={14} /></span>
                      <span>
                        <strong>{member.displayName}</strong>
                        <small>{available ? `${member.runtimeId} · ${continuity}` : l("Unavailable", "配置不可用")}</small>
                      </span>
                    </button>
                    {available && member.hasActiveConversation ? (
                      <button
                        className="team-chat-member-reset"
                        type="button"
                        disabled={Boolean(activeRootMessageId) || resetting}
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
      )}

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
  agents: Array<{ id: string; name: string; runtimeAgentId: string; description: string }>;
  defaultWorkDir: string;
  onPickDirectory: (defaultPath?: string) => Promise<string | undefined>;
  onCreate: (request: { name: string; workDir: string; agentIds: string[] }) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [name, setName] = useState("");
  const [workDir, setWorkDir] = useState(defaultWorkDir);
  const [agentIds, setAgentIds] = useState<string[]>(agents[0] ? [agents[0].id] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || agentIds.length === 0 || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({ name: name.trim(), workDir: workDir.trim(), agentIds });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };

  return (
    <div className="team-chat-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form className="team-chat-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <div><h3>{l("New Chat room", "新建 Chat 房间")}</h3><p>{l("Choose which configured Agents can participate.", "选择可以参与对话的已配置 Agent。")}</p></div>
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
        <fieldset>
          <legend>{l("Agents", "Agent 成员")}</legend>
          {agents.length === 0 ? <p className="team-chat-no-agents">{l("Configure an Agent in Runtime first.", "请先在 Runtime 中配置 Agent。")}</p> : null}
          <div className="team-chat-agent-options">
            {agents.map((agent) => (
              <label key={agent.id}>
                <input
                  type="checkbox"
                  checked={agentIds.includes(agent.id)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setAgentIds((current) => checked
                      ? [...current, agent.id]
                      : current.filter((id) => id !== agent.id));
                  }}
                />
                <span><strong>{agent.name}</strong><small>{agent.runtimeAgentId}{agent.description ? ` · ${agent.description}` : ""}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
        {error ? <div className="team-chat-dialog-error" role="alert">{error}</div> : null}
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>{l("Cancel", "取消")}</button>
          <button className="primary" type="submit" disabled={busy || !name.trim() || agentIds.length === 0}>
            {busy ? <LoaderCircle className="spin" size={14} /> : null}{l("Create room", "创建房间")}
          </button>
        </footer>
      </form>
    </div>
  );
}

function TeamChatMessageCard({ message, member, language }: { message: TeamChatMessage; member?: TeamChatRoomAgent; language: LanguageMode }): ReactElement {
  return (
    <article className={`team-chat-message is-${message.senderType} ${message.status === "error" ? "is-error" : ""}`}>
      <header><strong>{message.senderName}</strong>{member ? <span className="team-chat-runtime-badge">{member.runtimeId}</span> : null}<time>{formatMessageTime(message.createdAt, language)}</time></header>
      <div className="team-chat-message-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: TeamChatExternalLink }}>{message.content}</ReactMarkdown>
      </div>
    </article>
  );
}

function TeamChatExternalLink({ href, children, ...props }: ComponentPropsWithoutRef<"a">): ReactElement {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) void window.sessionSearch.openExternalLink(href);
      }}
    >
      {children}
    </a>
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
    if (event.roomId !== handlers.selectedRoomId) return;
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
    handlers.setStreams((current) => {
      if (!current[event.dispatchId]) return current;
      const next = { ...current };
      delete next[event.dispatchId];
      return next;
    });
    return;
  }
  if (event.type === "turn-finished") {
    handlers.setActiveRootMessageId((current) => current === event.rootMessageId ? undefined : current);
  }
}

function mergeMessages(...groups: TeamChatMessage[][]): TeamChatMessage[] {
  const byId = new Map<string, TeamChatMessage>();
  for (const message of groups.flat()) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => {
    const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return time || left.id.localeCompare(right.id);
  });
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
