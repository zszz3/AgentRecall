import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Bookmark, Link, ShieldCheck, X } from "lucide-react";
import type { MessageBookmark } from "../../../../core/message-tools";
import { localize, type LanguageMode } from "../../language";
import { ExportReviewDialog } from "./export-review-dialog";
import "./message-tools.css";

interface MessageToolsContextValue {
  bookmarks: MessageBookmark[];
  busy: boolean;
  act(operation: () => Promise<unknown>, success?: string): Promise<void>;
  sessionKey: string;
  language: LanguageMode;
}
const MessageToolsContext = createContext<MessageToolsContextValue | null>(null);

export function MessageToolsProvider({ sessionKey, language, enabled, children, revision = 0 }: {
  sessionKey: string; language: LanguageMode; enabled: boolean; children: ReactNode; revision?: number;
}) {
  const [bookmarks, setBookmarks] = useState<MessageBookmark[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const api = window.sessionSearch?.messageTools;
  const load = useCallback(async () => {
    if (!enabled || !api) return;
    const request = generation.current;
    const items = await api.list(sessionKey);
    if (request === generation.current) setBookmarks(items);
  }, [api, enabled, sessionKey, revision]);
  useEffect(() => {
    generation.current++;
    setBookmarks([]);
    setFeedback(null);
    const request = generation.current;
    void load().catch((error: unknown) => {
      if (request === generation.current) setFeedback({ error: true, text: String(error) });
    });
    return () => { generation.current++; };
  }, [load]);
  const act = async (operation: () => Promise<unknown>, success?: string): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFeedback(null);
    const request = generation.current;
    try {
      await operation();
      if (request !== generation.current) return;
      await load();
      if (request === generation.current && success) setFeedback({ error: false, text: success });
    } catch (error) {
      if (request === generation.current) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return <MessageToolsContext.Provider value={enabled && api ? { bookmarks, busy, act, sessionKey, language } : null}>
    {children}
    {feedback ? <div className="message-tools-feedback" role={feedback.error ? "alert" : "status"}>
      {feedback.text}<button onClick={() => setFeedback(null)} aria-label={localize(language, "Dismiss", "关闭提示")}><X size={14} /></button>
    </div> : null}
  </MessageToolsContext.Provider>;
}

export function MessageActions({ index }: { index: number | null }) {
  const context = useContext(MessageToolsContext);
  if (!context || index === null) return null;
  const { bookmarks, busy, act, sessionKey, language } = context;
  const l = (en: string, zh: string) => localize(language, en, zh);
  const bookmark = bookmarks.find((item) => item.resolvedMessageIndex === index);
  return <div className="message-actions">
    <button type="button" disabled={busy} aria-pressed={Boolean(bookmark)}
      aria-label={bookmark ? l("Remove message bookmark", "取消消息收藏") : l("Bookmark message", "收藏消息")}
      onClick={() => void act(() => bookmark ? window.sessionSearch.messageTools.remove(bookmark)
        : window.sessionSearch.messageTools.set(sessionKey, index, true))}>
      <Bookmark size={14} fill={bookmark ? "currentColor" : "none"} />
      {bookmark ? l("Bookmarked", "已收藏") : l("Bookmark", "收藏")}
    </button>
    <button type="button" disabled={busy} onClick={() => void act(
      () => window.sessionSearch.messageTools.copyLink(sessionKey, index), l("Message link copied", "消息链接已复制"))}>
      <Link size={14} />{l("Copy message link", "复制消息链接")}
    </button>
  </div>;
}

export function MessageToolsToolbar() {
  const context = useContext(MessageToolsContext);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  if (!context) return null;
  const { bookmarks, busy, act, sessionKey, language } = context;
  const l = (en: string, zh: string) => localize(language, en, zh);
  return <div className="message-tools-toolbar">
    <button type="button" aria-expanded={bookmarksOpen} onClick={() => setBookmarksOpen(!bookmarksOpen)}>
      <Bookmark size={14} />{l("Important messages", "重要消息")} ({bookmarks.length})
    </button>
    <button type="button" onClick={() => setReviewOpen(true)}><ShieldCheck size={14} />{l("Review & redact export", "导出脱敏预览")}</button>
    {bookmarksOpen ? <div className="message-bookmark-list">
      {bookmarks.length === 0 ? <p>{l("Bookmark a message to find it here later.", "收藏消息后，可在这里快速定位。")}</p> : null}
      {bookmarks.map((bookmark) => <div key={`${bookmark.messageIndex}:${bookmark.fingerprint}`}>
        <button disabled={busy} onClick={() => void act(() => window.sessionSearch.messageTools.open(bookmark))}>
          <span>{bookmark.resolvedMessageIndex === null ? l("Unavailable", "不可定位") : `#${(bookmark.resolvedMessageIndex ?? bookmark.messageIndex) + 1}`}</span> {bookmark.excerpt || l("Empty message", "空消息")}
        </button>
        <button disabled={busy} aria-label={l("Remove bookmark", "删除收藏")}
          onClick={() => void act(() => window.sessionSearch.messageTools.remove(bookmark))}><X size={14} /></button>
      </div>)}
    </div> : null}
    {reviewOpen ? <ExportReviewDialog sessionKey={sessionKey} language={language} onClose={() => setReviewOpen(false)} /> : null}
  </div>;
}
