import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { ArrowUp, FolderOpen, Sparkles, X } from "lucide-react";
import type { AiChatMessage } from "../../../core/ai-assistant";
import type { SessionSearchResult } from "../../../core/types";
import { SOURCE_LABEL } from "../session-ui";
import { localize, type LanguageMode } from "../language";
import { Markdown } from "../markdown";

// A single chat turn shown in the dialog. Assistant turns may carry the sessions
// the model surfaced, rendered as clickable cards under the reply.
interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  sessions?: SessionSearchResult[];
}

export function AiAssistantDialog({
  language,
  onOpenSession,
  onClose,
}: {
  language: LanguageMode;
  onOpenSession: (session: SessionSearchResult) => void;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  // User turns typed while a reply is in flight wait here, then get dispatched
  // one at a time so the conversation stays strictly user→assistant→user→… and
  // each request carries the full prior history.
  const [queue, setQueue] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastUserMessageRef = useRef<HTMLDivElement>(null);

  // Keep the newest user question pinned to the top of the viewport (rather than
  // scrolling to the bottom), so the user reads from their question down through
  // the matched sessions and reply.
  useEffect(() => {
    lastUserMessageRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [messages, queue, pending]);

  // Auto-grow the textarea so the send button stays bottom-aligned with it.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  // Enqueue the current input, so the user can keep typing and submitting while a
  // reply is in flight. Clears the box; the driver below sends it when ready.
  const enqueue = (): void => {
    const text = input.trim();
    if (!text) return;
    setError(null);
    setQueue((current) => [...current, text]);
    setInput("");
  };

  // Queue driver: whenever no request is in flight and a queued turn exists, move
  // the oldest queued turn into the transcript and send the full history so the
  // model keeps context and answers queued messages in order.
  useEffect(() => {
    if (pending || queue.length === 0) return;
    const [text, ...rest] = queue;
    const nextMessages: DisplayMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setQueue(rest);
    setPending(true);
    const history: AiChatMessage[] = nextMessages.map((message) => ({ role: message.role, content: message.content }));

    void (async () => {
      try {
        const reply = await window.sessionSearch.askAiAssistant(history);
        setMessages((current) => [...current, { role: "assistant", content: reply.reply, sessions: reply.sessions }]);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setPending(false);
        // Return focus to the input so the user can immediately send the next message.
        textareaRef.current?.focus();
      }
    })();
  }, [messages, queue, pending]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // While an IME is composing (e.g. picking a Chinese candidate), Enter confirms
    // the candidate — it must not send. keyCode 229 covers older IME behavior.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      enqueue();
    }
  };

  // The newest user turn — its DOM node is what we pin to the top of the viewport.
  const lastUserMessageIndex = messages.map((m) => m.role).lastIndexOf("user");

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="command-dialog ai-assistant-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span className="ai-assistant-title">
            <Sparkles size={15} />
            {l("AI session finder", "AI 找会话")}
          </span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>

        <div className="ai-assistant-messages">
          {messages.length === 0 ? (
            <div className="ai-assistant-empty">
              <Sparkles size={22} />
              <p>{l("Describe the session you're looking for and I'll search your history.", "描述你想找的会话，我会在历史记录里帮你搜索。")}</p>
              <p className="ai-assistant-hint">
                {l('e.g. "the session where I fixed the SQLite migration bug"', "例如：“我修复 SQLite 迁移 bug 的那次会话”")}
              </p>
            </div>
          ) : null}

          {messages.map((message, index) => {
            const sessions = message.sessions ?? [];
            // For assistant turns, the session cards ARE the answer — hide the
            // model's prose. Keep it only when there are no cards to show (e.g. a
            // clarifying question or "nothing found"), so the turn isn't blank.
            const showBubble = message.role === "user" || sessions.length === 0;
            return (
              <div
                key={index}
                ref={index === lastUserMessageIndex ? lastUserMessageRef : undefined}
                className={`ai-message ai-message-${message.role}`}
              >
                {/* Surface the matched sessions — the top card is the closest
                    match, so it sits right under the user's question. */}
                {sessions.length > 0 ? (
                  <div className="ai-session-cards">
                    {sessions.map((session) => (
                      <div
                        key={session.sessionKey}
                        role="button"
                        tabIndex={0}
                        className="ai-session-card"
                        onClick={() => {
                          // Don't open when the user is selecting text inside the card.
                          if ((window.getSelection()?.toString() ?? "").length > 0) return;
                          onOpenSession(session);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onOpenSession(session);
                          }
                        }}
                      >
                        <div className="ai-session-card-title">{session.displayTitle}</div>
                        <div className="ai-session-card-meta">
                          <span className="ai-session-card-source">{SOURCE_LABEL[session.source] ?? session.source}</span>
                          {session.projectPath ? (
                            <span className="ai-session-card-project">
                              <FolderOpen size={11} />
                              {session.projectPath}
                            </span>
                          ) : null}
                        </div>
                        {session.aiSummary ? (
                          <div className="ai-session-card-summary">
                            <Markdown text={session.aiSummary} language={language} />
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {showBubble ? (
                  <div className="ai-message-bubble">
                    {message.role === "assistant" ? <Markdown text={message.content} language={language} /> : message.content}
                  </div>
                ) : null}
              </div>
            );
          })}

          {pending ? (
            <div className="ai-message ai-message-assistant">
              <div className="ai-message-bubble ai-message-pending">
                <span className="ai-typing">
                  <span></span>
                  <span></span>
                  <span></span>
                </span>
                {l("Searching…", "搜索中…")}
              </div>
            </div>
          ) : null}

          {/* Turns typed while a reply is in flight, waiting their turn to send. */}
          {queue.map((text, index) => (
            <div key={`queued-${index}`} className="ai-message ai-message-user ai-message-queued">
              <div className="ai-message-bubble">{text}</div>
            </div>
          ))}

          {error ? <div className="ai-assistant-error">{error}</div> : null}
        </div>

        <div className="ai-assistant-input">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={l("Ask to find a session…", "描述要查找的会话…")}
            rows={1}
            autoFocus
          />
          <button type="button" className="ai-assistant-send" onClick={enqueue} disabled={!input.trim()} aria-label={l("Send", "发送")}>
            <ArrowUp size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
