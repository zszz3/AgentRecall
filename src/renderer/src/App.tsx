import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEventHandler, ReactElement } from "react";
import {
  AppWindow,
  Archive,
  Clipboard,
  Code2,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Search,
  Tag,
  Terminal,
  X,
} from "lucide-react";
import type { IndexStatus } from "../../core/indexer";
import { formatMessageTime, formatRelativeTime } from "../../core/format-session";
import type { SearchOptions, SessionMessage, SessionSearchResult, SessionSource } from "../../core/types";

const SOURCE_LABEL: Record<SessionSource, string> = {
  "claude-cli": "Claude Code",
  "claude-app": "Claude App",
  "codex-cli": "Codex CLI",
  "codex-app": "Codex App",
};

const SOURCE_FILTERS: Array<{ label: string; value: SearchOptions["source"] }> = [
  { label: "All", value: "all" },
  { label: "Claude", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "Claude Code", value: "claude-cli" },
  { label: "Claude App", value: "claude-app" },
  { label: "Codex CLI", value: "codex-cli" },
  { label: "Codex App", value: "codex-app" },
];

type ViewMode = "default" | "pinned" | "hidden";
const INITIAL_MESSAGE_LIMIT = 20;
const MESSAGE_PAGE_SIZE = 80;

interface ContextMenuState {
  x: number;
  y: number;
  session: SessionSearchResult;
}

type DialogState =
  | {
      kind: "rename" | "tag";
      session: SessionSearchResult;
      value: string;
    }
  | null;

export function App(): ReactElement {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SearchOptions["source"]>("all");
  const [tag, setTag] = useState<string | undefined>();
  const [visibility, setVisibility] = useState<ViewMode>("default");
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionSearchResult | null>(null);
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const options: SearchOptions = {
      query,
      source,
      tag,
      visibility,
      limit: 300,
    };
    const [nextResults, nextTags, nextStatus] = await Promise.all([
      window.sessionSearch.searchSessions(options),
      window.sessionSearch.listTags(),
      window.sessionSearch.getIndexStatus(),
    ]);
    setResults(nextResults);
    setTags(nextTags);
    setStatus(nextStatus);
    if (!selectedKey && nextResults[0]) setSelectedKey(nextResults[0].sessionKey);
  }, [query, source, tag, visibility, selectedKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 120);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const offIndex = window.sessionSearch.onIndexStatus((nextStatus) => {
      setStatus(nextStatus);
      void load();
    });
    const offFocus = window.sessionSearch.onFocusSearch(() => searchRef.current?.focus());
    return () => {
      offIndex();
      offFocus();
    };
  }, [load]);

  const selected = useMemo(
    () => results.find((session) => session.sessionKey === selectedKey) || results[0] || null,
    [results, selectedKey],
  );

  async function openDetail(session: SessionSearchResult): Promise<void> {
    setContextMenu(null);
    setDetail(session);
    setMessages([]);
    setMessagesLoading(true);

    const sessionKey = session.sessionKey;
    const [fresh, loadedMessages] = await Promise.all([
      window.sessionSearch.getSession(sessionKey),
      window.sessionSearch.getMessages(sessionKey, 0, INITIAL_MESSAGE_LIMIT),
    ]);
    if (!fresh) {
      setMessagesLoading(false);
      return;
    }
    setDetail(fresh);
    setMessages(loadedMessages);
    setMessagesLoading(false);
  }

  async function loadMoreMessages(): Promise<void> {
    if (!detail || messagesLoading) return;
    setMessagesLoading(true);
    const nextMessages = await window.sessionSearch.getMessages(detail.sessionKey, messages.length, MESSAGE_PAGE_SIZE);
    setMessages((current) => [...current, ...nextMessages]);
    setMessagesLoading(false);
  }

  async function refreshAfterAction(): Promise<void> {
    await load();
    if (detail) {
      const fresh = await window.sessionSearch.getSession(detail.sessionKey);
      if (fresh) setDetail(fresh);
    }
  }

  function beginRename(session: SessionSearchResult): void {
    setContextMenu(null);
    setDialog({ kind: "rename", session, value: session.customTitle || session.displayTitle });
  }

  function beginAddTag(session: SessionSearchResult): void {
    setContextMenu(null);
    setDialog({ kind: "tag", session, value: "" });
  }

  async function submitDialog(valueOverride?: string): Promise<void> {
    if (!dialog) return;
    const value = (valueOverride ?? dialog.value).trim();
    if (dialog.kind === "rename") {
      await window.sessionSearch.setCustomTitle(dialog.session.sessionKey, value || null);
    } else if (value) {
      await window.sessionSearch.addTag(dialog.session.sessionKey, value);
    }
    setDialog(null);
    await refreshAfterAction();
  }

  async function removeTag(session: SessionSearchResult, tagName: string): Promise<void> {
    await window.sessionSearch.removeTag(session.sessionKey, tagName);
    await refreshAfterAction();
  }

  async function runAction(action: () => Promise<void>): Promise<void> {
    setContextMenu(null);
    await action();
    await refreshAfterAction();
  }

  return (
    <main className="app" onClick={() => setContextMenu(null)}>
      <section className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Search size={17} />
          </div>
          <div>
            <h1>Agent-Session-Search</h1>
            <p>AI agent session console</p>
          </div>
        </div>

        <button className="primary" onClick={() => void window.sessionSearch.refreshIndex()}>
          <RefreshCw size={16} />
          Refresh Index
        </button>

        <div className="status">
          <strong>{status?.running ? "Indexing" : "Index"}</strong>
          <span>
            {status?.lastIndexedAt
              ? `${status.indexed}/${status.total} sessions · ${formatRelativeTime(status.lastIndexedAt)}`
              : "Waiting for first scan"}
          </span>
          {status?.error ? <em>{status.error}</em> : null}
        </div>

        <nav className="nav-group">
          <button className={visibility === "default" ? "active" : ""} onClick={() => setVisibility("default")}>
            All
          </button>
          <button className={visibility === "pinned" ? "active" : ""} onClick={() => setVisibility("pinned")}>
            Pinned
          </button>
          <button className={visibility === "hidden" ? "active" : ""} onClick={() => setVisibility("hidden")}>
            Hidden
          </button>
        </nav>

        <div className="filter-title">Sources</div>
        <nav className="nav-group">
          {SOURCE_FILTERS.map((item) => (
            <button key={item.label} className={source === item.value ? "active" : ""} onClick={() => setSource(item.value)}>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="filter-title">Tags</div>
        <nav className="tag-list">
          <button className={!tag ? "active" : ""} onClick={() => setTag(undefined)}>
            All Tags
          </button>
          {tags.map((tagName) => (
            <button key={tagName} className={tag === tagName ? "active" : ""} onClick={() => setTag(tagName)}>
              <Tag size={13} />
              {tagName}
            </button>
          ))}
        </nav>
      </section>

      <section className="content">
        <header className="toolbar">
          <div className="searchbox">
            <Search size={18} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && selected) void openDetail(selected);
              }}
              placeholder={tag ? `Search within #${tag}` : "Search titles, first questions, full text, paths, or ids"}
              autoFocus
            />
          </div>
          {tag ? (
            <button className="chip clear" onClick={() => setTag(undefined)}>
              #{tag} ×
            </button>
          ) : null}
        </header>

        <div className="result-count">
          <span>{results.length} sessions</span>
          {selected ? <span className="selected-path">{selected.projectPath || selected.rawId}</span> : null}
        </div>

        <div className="results">
          {results.map((session) => (
            <SessionRow
              key={session.sessionKey}
              session={session}
              selected={selected?.sessionKey === session.sessionKey}
              onSelect={() => setSelectedKey(session.sessionKey)}
              onOpen={() => void openDetail(session)}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedKey(session.sessionKey);
                setContextMenu({ x: event.clientX, y: event.clientY, session });
              }}
            />
          ))}
          {results.length === 0 ? <div className="empty">No sessions found.</div> : null}
        </div>
      </section>

      {detail ? (
        <DetailPanel
          session={detail}
          messages={messages}
          loading={messagesLoading}
          query={query}
          onClose={() => setDetail(null)}
          onShowMore={() => void loadMoreMessages()}
          onRename={() => beginRename(detail)}
          onAddTag={() => beginAddTag(detail)}
          onRemoveTag={(tagName) => void removeTag(detail, tagName)}
          onResume={() => void runAction(() => window.sessionSearch.resumeSession(detail.sessionKey))}
          onOpenApp={() => void runAction(() => window.sessionSearch.openNativeApp(detail.sessionKey))}
          onCopyResume={() => void runAction(() => window.sessionSearch.copyResumeCommand(detail.sessionKey))}
          onCopyMarkdown={() => void runAction(() => window.sessionSearch.copyMarkdown(detail.sessionKey))}
          onCopyPlain={() => void runAction(() => window.sessionSearch.copyPlainText(detail.sessionKey))}
          onReveal={() => void runAction(() => window.sessionSearch.revealSession(detail.sessionKey))}
        />
      ) : null}

      {contextMenu ? (
        <ContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onRename={() => beginRename(contextMenu.session)}
          onAddTag={() => beginAddTag(contextMenu.session)}
          onPin={() => void runAction(() => window.sessionSearch.setPinned(contextMenu.session.sessionKey, !contextMenu.session.pinned))}
          onHide={() => void runAction(() => window.sessionSearch.setHidden(contextMenu.session.sessionKey, !contextMenu.session.hidden))}
          onResume={() => void runAction(() => window.sessionSearch.resumeSession(contextMenu.session.sessionKey))}
          onOpenApp={() => void runAction(() => window.sessionSearch.openNativeApp(contextMenu.session.sessionKey))}
          onCopyResume={() => void runAction(() => window.sessionSearch.copyResumeCommand(contextMenu.session.sessionKey))}
          onCopyMarkdown={() => void runAction(() => window.sessionSearch.copyMarkdown(contextMenu.session.sessionKey))}
          onCopyPlain={() => void runAction(() => window.sessionSearch.copyPlainText(contextMenu.session.sessionKey))}
          onReveal={() => void runAction(() => window.sessionSearch.revealSession(contextMenu.session.sessionKey))}
        />
      ) : null}

      {dialog ? (
        <CommandDialog
          dialog={dialog}
          tags={tags}
          onChange={(value) => setDialog({ ...dialog, value })}
          onSubmit={(value) => void submitDialog(value)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </main>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  session: SessionSearchResult;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: MouseEventHandler;
}): ReactElement {
  return (
    <article
      className={`session-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
    >
      <div className="session-main">
        <div className="session-title">
          <span className={`source-dot ${session.source.startsWith("claude") ? "claude" : "codex"}`} />
          {session.pinned ? <Pin size={14} /> : null}
          {session.hidden ? <EyeOff size={14} /> : null}
          <span>{session.displayTitle}</span>
        </div>
        <div className="session-meta">
          <span className={`source-badge ${session.source.startsWith("claude") ? "claude" : "codex"}`}>
            {session.source.startsWith("claude") ? <Code2 size={13} /> : <Terminal size={13} />}
            {SOURCE_LABEL[session.source]}
          </span>
          <span>{session.projectPath || "No project path"}</span>
          <span>{formatRelativeTime(session.timestamp)}</span>
          <span>{session.messageCount} messages</span>
        </div>
        {session.matchSnippet ? <div className="snippet">{session.matchSnippet}</div> : null}
      </div>
      <div className="row-tags">
        {session.tags.slice(0, 3).map((tagName) => (
          <span key={tagName}>#{tagName}</span>
        ))}
      </div>
    </article>
  );
}

function DetailPanel({
  session,
  messages,
  loading,
  query,
  onClose,
  onShowMore,
  onRename,
  onAddTag,
  onRemoveTag,
  onResume,
  onOpenApp,
  onCopyResume,
  onCopyMarkdown,
  onCopyPlain,
  onReveal,
}: {
  session: SessionSearchResult;
  messages: SessionMessage[];
  loading: boolean;
  query: string;
  onClose: () => void;
  onShowMore: () => void;
  onRename: () => void;
  onAddTag: () => void;
  onRemoveTag: (tagName: string) => void;
  onResume: () => void;
  onOpenApp: () => void;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onCopyPlain: () => void;
  onReveal: () => void;
}): ReactElement {
  const matchIndex = query
    ? messages.findIndex((message) => message.content.toLowerCase().includes(query.toLowerCase()))
    : -1;
  const context = matchIndex >= 0 ? messages.slice(Math.max(0, matchIndex - 1), Math.min(messages.length, matchIndex + 2)) : [];

  return (
    <div className="detail-backdrop" onClick={onClose}>
    <aside className="detail" onClick={(event) => event.stopPropagation()}>
      <div className="detail-header">
        <div>
          <div className={`source-badge ${session.source.startsWith("claude") ? "claude" : "codex"}`}>
            {SOURCE_LABEL[session.source]}
          </div>
          <h2>{session.displayTitle}</h2>
          <p>
            {session.projectPath || "No project"} · {new Date(session.timestamp).toLocaleString()} · {messages.length} messages
          </p>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          <X size={17} />
        </button>
      </div>
      <div className="detail-actions">
        <button onClick={onResume}>
          <Play size={15} /> Resume
        </button>
        <button onClick={onOpenApp}>
          <AppWindow size={15} /> Open App
        </button>
        <button onClick={onRename}>
          <Clipboard size={15} /> Rename
        </button>
        <button onClick={onAddTag}>
          <Tag size={15} /> Add Tag
        </button>
        <button onClick={onCopyResume}>
          <Copy size={15} /> Copy Cmd
        </button>
        <button onClick={onCopyMarkdown}>Markdown</button>
        <button onClick={onCopyPlain}>Plain Text</button>
        <button onClick={onReveal}>
          <FolderOpen size={15} /> Finder
        </button>
      </div>
      <div className="detail-tags">
        {session.tags.map((tagName) => (
          <button key={tagName} className="chip" onClick={() => onRemoveTag(tagName)}>
            #{tagName} ×
          </button>
        ))}
      </div>
      {context.length > 0 ? (
        <section className="matched">
          <h3>Matched Context</h3>
          {context.map((message) => (
            <MessageBlock key={message.index} message={message} query={query} />
          ))}
        </section>
      ) : null}
      <section className="conversation">
        <h3>Full Conversation</h3>
        {loading ? <div className="loading-state">Loading conversation...</div> : null}
        {!loading && messages.length === 0 ? <div className="loading-state">No visible messages indexed for this session.</div> : null}
        {messages.map((message) => (
          <MessageBlock key={message.index} message={message} query={query} />
        ))}
        {!loading && messages.length < session.messageCount ? (
          <button className="show-more" onClick={onShowMore}>
            Show {Math.min(MESSAGE_PAGE_SIZE, session.messageCount - messages.length)} more messages
          </button>
        ) : null}
      </section>
    </aside>
    </div>
  );
}

function MessageBlock({ message, query }: { message: SessionMessage; query: string }): ReactElement {
  const content = useMemo(() => {
    const text = message.content.length > 3000 ? `${message.content.slice(0, 3000)}\n\n...(truncated)` : message.content;
    if (!query) return text;
    return text;
  }, [message.content, query]);

  return (
    <div className={`message ${message.role}`}>
      <div className="message-head">
        <strong>{message.role === "user" ? "User" : "Assistant"}</strong>
        <span>{formatMessageTime(message.timestamp)}</span>
      </div>
      <pre>{content}</pre>
    </div>
  );
}

function ContextMenu({
  state,
  onClose,
  onRename,
  onAddTag,
  onPin,
  onHide,
  onResume,
  onOpenApp,
  onCopyResume,
  onCopyMarkdown,
  onCopyPlain,
  onReveal,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onRename: () => void;
  onAddTag: () => void;
  onPin: () => void;
  onHide: () => void;
  onResume: () => void;
  onOpenApp: () => void;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onCopyPlain: () => void;
  onReveal: () => void;
}): ReactElement {
  return (
    <div className="context-menu" style={{ left: state.x, top: state.y }} onClick={(event) => event.stopPropagation()}>
      <button onClick={onRename}>
        <Clipboard size={14} /> Rename
      </button>
      <button onClick={onAddTag}>
        <Tag size={14} /> Add Tag
      </button>
      <button onClick={onPin}>{state.session.pinned ? <PinOff size={14} /> : <Pin size={14} />} {state.session.pinned ? "Unpin" : "Pin"}</button>
      <button onClick={onHide}>
        {state.session.hidden ? <Eye size={14} /> : <Archive size={14} />} {state.session.hidden ? "Unhide" : "Hide"}
      </button>
      <hr />
      <button onClick={onResume}>
        <Play size={14} /> Resume in Terminal
      </button>
      <button onClick={onOpenApp}>
        <AppWindow size={14} /> Open App
      </button>
      <button onClick={onCopyResume}>
        <Copy size={14} /> Copy Resume Cmd
      </button>
      <button onClick={onCopyMarkdown}>Copy Markdown</button>
      <button onClick={onCopyPlain}>Copy Plain Text</button>
      <button onClick={onReveal}>
        <FolderOpen size={14} /> Show in Finder
      </button>
      <hr />
      <button onClick={onClose}>Close Menu</button>
    </div>
  );
}

function CommandDialog({
  dialog,
  tags,
  onChange,
  onSubmit,
  onCancel,
}: {
  dialog: NonNullable<DialogState>;
  tags: string[];
  onChange: (value: string) => void;
  onSubmit: (value?: string) => void;
  onCancel: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const matchingTags = dialog.kind === "tag" ? tags.filter((tagName) => tagName.includes(dialog.value.trim())).slice(0, 6) : [];

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <form
        className="command-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="dialog-title">
          <span>{dialog.kind === "rename" ? "Rename Session" : "Add Tag"}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          value={dialog.value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={dialog.kind === "rename" ? "Session title" : "Tag name"}
        />
        {matchingTags.length > 0 ? (
          <div className="tag-suggestions">
            {matchingTags.map((tagName) => (
              <button key={tagName} type="button" onClick={() => onSubmit(tagName)}>
                #{tagName}
              </button>
            ))}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-action">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
