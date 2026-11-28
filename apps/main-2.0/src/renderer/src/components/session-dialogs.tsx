import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, RotateCcw, X } from "lucide-react";
import type { SessionSearchResult } from "../../../core/types";
import { displayTagName, isBranchTag } from "../session-ui";
import { localize, type LanguageMode } from "../language";
import type { DialogState } from "../app-types";
import {
  SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD,
  type SessionBulkDeletePreview,
} from "../../../core/session-bulk-delete";

export function DeleteTagDialog({
  tagName,
  language,
  onConfirm,
  onCancel,
}: {
  tagName: string;
  language: LanguageMode;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Delete Tag", "删除标签")}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {l("Delete", "从所有会话中删除")} <strong>{isBranchTag(tagName) ? "" : "#"}{displayTagName(tagName)}</strong>
          {l(" from all sessions?", "？")}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {l("Cancel", "取消")}
          </button>
          <button type="button" className="danger-action" onClick={onConfirm}>
            {l("Delete", "删除")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeleteSessionDialog({
  session,
  cascadeCount,
  hasLiveSession,
  liveSessionCheckFailed,
  confirmationVersion,
  isOpen,
  blockedMessage,
  language,
  deleting,
  onConfirm,
  onCancel,
}: {
  session: SessionSearchResult;
  cascadeCount: number | null;
  hasLiveSession: boolean;
  liveSessionCheckFailed?: boolean;
  confirmationVersion?: number;
  isOpen: boolean;
  blockedMessage: string | null;
  language: LanguageMode;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [confirmationText, setConfirmationText] = useState("");
  const requiresConfirmation =
    (cascadeCount ?? 0) > 1 || hasLiveSession || liveSessionCheckFailed || isOpen;
  const canConfirm = !requiresConfirmation || confirmationText === "确认删除";
  useEffect(() => {
    setConfirmationText("");
  }, [confirmationVersion, session.sessionKey]);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog delete-session-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{session.sourceAvailable === false ? l("Delete Cache", "删除缓存") : l("Delete Session", "删除会话")}</span>
          <button type="button" className="icon-button" onClick={onCancel} disabled={deleting} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {session.sourceAvailable === false ? l("Delete cached copy of", "删除缓存") : l("Delete", "删除")} <strong>{session.displayTitle}</strong>
          {l(" permanently?", "？")}
        </p>
        {cascadeCount !== null && cascadeCount > 1 ? (
          <p className="dialog-copy danger-copy">
            <strong>{cascadeCount - 1}</strong>{l(
              " related subagent sessions will also be permanently deleted.",
              " 个关联 Subagent 会话也会被永久删除。",
            )}
          </p>
        ) : null}
        {hasLiveSession ? (
          <p className="dialog-copy danger-copy">
            {l(
              'A session in this tree is still running. Type "确认删除" to force deletion; the running process may fail or recreate session data.',
              "会话树中有会话正在运行。输入“确认删除”后可强制删除；运行中的进程可能报错或重新生成会话数据。",
            )}
          </p>
        ) : null}
        {liveSessionCheckFailed ? (
          <p className="dialog-copy danger-copy">
            {l(
              'AgentRecall could not verify whether this session tree is still running. Type "确认删除" to continue; a running process may fail or recreate session data.',
              "AgentRecall 无法确认该会话树是否仍在运行。输入“确认删除”后继续；运行中的进程可能报错或重新生成会话数据。",
            )}
          </p>
        ) : null}
        {isOpen ? (
          <p className="dialog-copy danger-copy">
            {l(
              "This session is currently open in AgentRecall. Deleting it will close the session detail.",
              "该会话当前正在 AgentRecall 中打开，删除后会关闭会话详情。",
            )}
          </p>
        ) : null}
        {blockedMessage ? <p className="dialog-copy danger-copy">{blockedMessage}</p> : null}
        <p className="dialog-copy danger-copy">
          {session.sourceAvailable === false
            ? l(
                "This only deletes the messages cached by AgentRecall. It does not change Cursor or any cloud copy.",
                "这只会删除 AgentRecall 缓存的消息，不会修改 Cursor 或任何云端副本。",
              )
            : session.source === "zcode-cli"
            ? l(
                "This permanently deletes this ZCode session, its messages, tool calls, and usage records from the local ZCode database. This cannot be undone.",
                "这会从本地 ZCode 数据库永久删除该会话及其消息、工具调用和用量记录，无法撤销。",
              )
            : session.source === "hermes"
            ? l(
                "This permanently deletes this Hermes session and its messages from the local Hermes database. Other Hermes sessions stay intact. This cannot be undone.",
                "这会从本地 Hermes 数据库永久删除该会话及其消息，不影响其他 Hermes 会话，无法撤销。",
              )
            : session.source === "deepseek-cli"
            ? l(
                "This permanently deletes this DeepSeek Harness session and its messages from the local DeepSeek Harness log. Other DeepSeek Harness sessions stay intact. This cannot be undone.",
                "这会从本地 DeepSeek Harness 日志永久删除该会话及其消息，不影响其他 DeepSeek Harness 会话，无法撤销。",
              )
            : session.source === "pi-cli"
            ? l(
                "This permanently deletes this Pi session file and removes it from this app. Other Pi sessions stay intact. This cannot be undone.",
                "这会永久删除该 Pi 会话文件，并从本应用移除，不影响其他 Pi 会话，无法撤销。",
              )
            : session.source === "omp-cli"
            ? l(
                "This permanently deletes this Oh My Pi session file and its artifact folder (tool output spills and subagent transcripts), and removes it from this app. Other Oh My Pi sessions stay intact. This cannot be undone.",
                "这会永久删除该 Oh My Pi 会话文件及其产物目录（工具输出溢出文件和子代理记录），并从本应用移除，不影响其他 Oh My Pi 会话，无法撤销。",
              )
            : l(
                "This deletes the original Codex or Claude Code session file and removes it from this app. This cannot be undone.",
                "这会删除 Codex 或 Claude Code 的原始会话文件，并从本应用移除，无法撤销。",
              )}
        </p>
        {requiresConfirmation ? (
          <label className="delete-confirmation-field">
            <span>{l('Type "确认删除" to continue', '请输入“确认删除”以继续')}</span>
            <input
              type="text"
              value={confirmationText}
              placeholder="确认删除"
              onChange={(event) => setConfirmationText(event.target.value)}
              disabled={deleting}
              autoComplete="off"
            />
          </label>
        ) : null}
        {session.sourceAvailable === false ? null : (
          <div className="delete-session-path" title={session.filePath}>
            {session.filePath}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={deleting}>
            {l("Cancel", "取消")}
          </button>
          <button
            type="button"
            className="danger-action"
            onClick={onConfirm}
            disabled={deleting || !canConfirm || cascadeCount === null || Boolean(blockedMessage)}
          >
            {deleting
              ? l("Deleting...", "正在删除...")
              : hasLiveSession || liveSessionCheckFailed
                ? l("Force Delete", "强制删除")
                : !requiresConfirmation
                  ? l("Confirm", "确认")
                  : session.sourceAvailable === false
                    ? l("Delete Cache", "删除缓存")
                    : l("Delete Permanently", "永久删除")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BulkDeleteDialog({
  mode,
  preview,
  dateValue,
  favoriteCount,
  busy,
  language,
  onDateChange,
  onPreview,
  onConfirm,
  onCancel,
}: {
  mode: "selection" | "cleanup" | "orphans";
  preview: SessionBulkDeletePreview | null;
  dateValue: string;
  favoriteCount: number;
  busy: boolean;
  language: LanguageMode;
  onDateChange: (value: string) => void;
  onPreview: () => void;
  onConfirm: (confirmed: boolean) => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [confirmationText, setConfirmationText] = useState("");
  useEffect(() => {
    setConfirmationText("");
  }, [preview]);
  const hasDeletableSessions = (preview?.deletableCount ?? 0) > 0;
  const requiresTypedConfirmation = Boolean(preview && (
    preview.deletableCount >= SESSION_BULK_DELETE_CONFIRMATION_THRESHOLD
    || preview.hasRelatedSessions
    || preview.includesOpenSession
    || preview.liveSessionCheckFailed
  ));
  const canConfirm = !requiresTypedConfirmation || confirmationText === "确认删除";
  const skippedCounts = preview ? countIssueReasons(preview) : [];
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className={`command-dialog bulk-delete-dialog${mode === "orphans" ? " orphan-delete-dialog" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{mode === "cleanup"
            ? l("Clean Up Sessions", "按日期清理会话")
            : mode === "orphans"
            ? l("Clean Up Leftover Subagent Chats", "清理残留子对话")
            : l("Delete Selected Sessions", "删除所选会话")}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={busy ? l("Continue in background", "转到后台") : l("Close", "关闭")}><X size={16} /></button>
        </div>
        {mode === "cleanup" && !preview ? (
          <div className="bulk-delete-date">
            <span>{l("Delete sessions inactive before", "删除此日期前不活跃的会话")}</span>
            <CleanupDatePicker value={dateValue} language={language} onChange={onDateChange} />
            <small>{l("Favorite and live sessions are protected.", "收藏和正在运行的会话会受到保护。")}</small>
          </div>
        ) : null}
        {mode === "orphans" && !preview ? (
          <p className="dialog-copy">{l("Looking for leftover subagent chats whose parent chat no longer exists...", "正在查找主对话已不存在的残留子对话...")}</p>
        ) : null}
        {preview ? (
          <>
            <p className="dialog-copy">{mode === "orphans" && preview.deletableCount === 0
              ? l("No leftover subagent chats without a parent chat were found.", "未发现主对话已不存在的残留子对话。")
              : <><strong>{preview.deletableCount}</strong>{mode === "orphans"
                ? l(" leftover subagent chats without a parent chat will be permanently deleted.", " 个主对话已不存在的残留子对话将被永久删除。")
                : l(" sessions will be permanently deleted.", " 个会话将被永久删除。")}</>}</p>
            <div className="bulk-delete-summary">
              {preview.sourceCounts.map((item) => <span key={item.source}>{item.source} · {item.count}</span>)}
            </div>
            {preview.skipped.length > 0 ? <p className="dialog-copy">{l("Excluded", "已排除")}：{skippedCounts.map(([reason, count]) => `${issueReasonLabel(reason, l)} · ${count}`).join("，")}</p> : null}
            {mode === "selection" && favoriteCount > 0 ? <p className="dialog-copy danger-copy">{l(`${favoriteCount} favorite sessions are included.`, `其中包含 ${favoriteCount} 个收藏会话。`)}</p> : null}
            {preview.includesOpenSession ? (
              <p className="dialog-copy danger-copy">
                {l("The currently open session is included.", "其中包含当前打开的会话。")}
              </p>
            ) : null}
            {preview.liveSessionCheckFailed ? (
              <p className="dialog-copy danger-copy">
                {l(
                  "AgentRecall could not verify whether these sessions are still running. Continuing may interrupt running processes or recreate session data.",
                  "AgentRecall 无法确认这些会话是否仍在运行。继续删除可能中断运行中的进程，或导致会话数据被重新生成。",
                )}
              </p>
            ) : null}
            {hasDeletableSessions ? (
              <>
                <p className="dialog-copy danger-copy">{l("Original session data may be deleted. This cannot be undone.", "原始会话数据可能被删除，且无法撤销。")}</p>
                {requiresTypedConfirmation ? (
                  <label className="delete-confirmation-field">
                    <span>{l('Type "确认删除" to continue', '请输入“确认删除”以继续')}</span>
                    <input
                      type="text"
                      value={confirmationText}
                      placeholder="确认删除"
                      onChange={(event) => setConfirmationText(event.target.value)}
                      disabled={busy}
                      autoComplete="off"
                    />
                  </label>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>{busy ? l("Continue in background", "转到后台") : preview && !hasDeletableSessions ? l("Close", "关闭") : l("Cancel", "取消")}</button>
          {!preview ? (
            mode === "cleanup"
              ? <button type="button" className="primary-action" onClick={onPreview} disabled={busy || !dateValue}>{busy ? l("Loading...", "正在加载...") : l("Preview", "预览")}</button>
              : <button type="button" className="primary-action" disabled>{l("Scanning...", "正在扫描...")}</button>
          ) : hasDeletableSessions
            ? <button type="button" className="danger-action" onClick={() => onConfirm(requiresTypedConfirmation)} disabled={busy || !canConfirm}>{busy
              ? l("Deleting...", "正在删除...")
              : requiresTypedConfirmation
                ? l("Delete Permanently", "永久删除")
                : l("Confirm", "确认")}</button>
            : null}
        </div>
      </div>
    </div>
  );
}

function countIssueReasons(preview: SessionBulkDeletePreview): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const issue of preview.skipped) counts.set(issue.reason, (counts.get(issue.reason) ?? 0) + 1);
  return [...counts.entries()];
}

function issueReasonLabel(reason: string, l: (en: string, zh: string) => string): string {
  const labels: Record<string, [string, string]> = {
    "not-found": ["Not found", "未找到"], live: ["Live", "正在运行"], favorite: ["Favorite", "收藏"],
    recent: ["Too recent", "日期范围外"], "read-only": ["Read-only", "只读来源"],
    "remote-source": ["Remote source", "远程来源"], "shared-database": ["Shared database", "共享数据库"],
  };
  const label = labels[reason];
  return label ? l(label[0], label[1]) : reason;
}

function localDateInput(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function CleanupDatePicker({
  value,
  language,
  onChange,
}: {
  value: string;
  language: LanguageMode;
  onChange: (value: string) => void;
}): ReactElement {
  const today = new Date();
  const selected = parseLocalDate(value) ?? today;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const [yearMode, setYearMode] = useState(false);
  const l = (en: string, zh: string) => localize(language, en, zh);
  const weekdays = language === "zh" ? ["一", "二", "三", "四", "五", "六", "日"] : ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const firstWeekday = (view.getDay() + 6) % 7;
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const yearPageStart = Math.floor(view.getFullYear() / 12) * 12;

  const chooseDay = (day: number): void => {
    onChange(localDateInput(new Date(view.getFullYear(), view.getMonth(), day)));
    setOpen(false);
  };

  return (
    <div className="cleanup-date-picker">
      <button
        type="button"
        className={`cleanup-date-trigger${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarDays size={15} aria-hidden="true" />
        <span>{value || l("Select a date", "选择日期")}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="cleanup-date-popover" role="dialog" aria-label={l("Choose cleanup date", "选择清理日期")}>
          <div className="cleanup-date-nav">
            <button type="button" aria-label={yearMode ? l("Previous years", "上一组年份") : l("Previous month", "上个月")} onClick={() => {
              setView(new Date(view.getFullYear() - (yearMode ? 12 : 0), view.getMonth() - (yearMode ? 0 : 1), 1));
            }}><ChevronLeft size={15} /></button>
            <button type="button" className="cleanup-date-heading" onClick={() => setYearMode((current) => !current)}>
              {yearMode
                ? `${yearPageStart} – ${yearPageStart + 11}`
                : language === "zh" ? `${view.getFullYear()} 年 ${view.getMonth() + 1} 月` : view.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            <button type="button" aria-label={yearMode ? l("Next years", "下一组年份") : l("Next month", "下个月")} onClick={() => {
              setView(new Date(view.getFullYear() + (yearMode ? 12 : 0), view.getMonth() + (yearMode ? 0 : 1), 1));
            }} disabled={yearMode ? yearPageStart + 12 > today.getFullYear() : view.getFullYear() > today.getFullYear() || (view.getFullYear() === today.getFullYear() && view.getMonth() >= today.getMonth())}><ChevronRight size={15} /></button>
          </div>
          {yearMode ? (
            <div className="cleanup-year-grid">
              {Array.from({ length: 12 }, (_, index) => yearPageStart + index).map((year) => (
                <button
                  key={year}
                  type="button"
                  className={year === view.getFullYear() ? "is-current" : ""}
                  disabled={year > today.getFullYear()}
                  onClick={() => { setView(new Date(year, Math.min(view.getMonth(), year === today.getFullYear() ? today.getMonth() : 11), 1)); setYearMode(false); }}
                >{year}</button>
              ))}
            </div>
          ) : (
            <>
              <div className="cleanup-weekdays">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
              <div className="cleanup-day-grid">
                {Array.from({ length: firstWeekday }, (_, index) => <span key={`blank-${index}`} />)}
                {Array.from({ length: daysInMonth }, (_, index) => index + 1).map((day) => {
                  const date = new Date(view.getFullYear(), view.getMonth(), day);
                  const isSelected = value === localDateInput(date);
                  const isToday = localDateInput(date) === localDateInput(today);
                  return <button key={day} type="button" className={`${isSelected ? "is-selected" : ""}${isToday ? " is-today" : ""}`} disabled={date > today} onClick={() => chooseDay(day)}>{day}</button>;
                })}
              </div>
            </>
          )}
          <div className="cleanup-date-footer">
            <button type="button" onClick={() => { onChange(localDateInput(today)); setOpen(false); }}>{l("Today", "今天")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function CommandDialog({
  dialog,
  tags,
  language,
  onChange,
  onRestoreDefault,
  onSubmit,
  onCancel,
}: {
  dialog: NonNullable<DialogState>;
  tags: string[];
  language: LanguageMode;
  onChange: (value: string) => void;
  onRestoreDefault: () => void;
  onSubmit: (value?: string) => void;
  onCancel: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const l = (en: string, zh: string) => localize(language, en, zh);
  const matchingTags = dialog.kind === "tag" ? tags.filter((tagName) => tagName.includes(dialog.value.trim())).slice(0, 6) : [];
  const showCursorDefaultControl = dialog.kind === "rename"
    && dialog.session.source === "cursor-agent"
    && Boolean(dialog.session.customTitle);

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
          <span>{dialog.kind === "rename" ? l("Rename Session", "重命名会话") : l("Add Tag", "添加标签")}</span>
          <button type="button" className="icon-button" onClick={onCancel} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          value={dialog.value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={dialog.kind === "rename" ? l("Session title", "会话标题") : l("Tag name", "标签名")}
        />
        {showCursorDefaultControl ? (
          <div className="rename-default-control">
            {dialog.kind === "rename" && dialog.useDefaultTitle ? (
              <span>{l("The title will follow future Cursor changes after saving.", "保存后将自动跟随 Cursor 会话名称变化。")}</span>
            ) : (
              <button type="button" className="rename-default-button" onClick={onRestoreDefault}>
                <RotateCcw size={13} />
                {l("Restore default name", "恢复默认名称")}
              </button>
            )}
          </div>
        ) : null}
        {matchingTags.length > 0 ? (
          <div className="tag-suggestions">
            {matchingTags.map((tagName) => (
              <button key={tagName} type="button" onClick={() => onSubmit(tagName)}>
                {isBranchTag(tagName) ? "" : "#"}{displayTagName(tagName)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {l("Cancel", "取消")}
          </button>
          <button type="submit" className="primary-action">
            {l("Save", "保存")}
          </button>
        </div>
      </form>
    </div>
  );
}
