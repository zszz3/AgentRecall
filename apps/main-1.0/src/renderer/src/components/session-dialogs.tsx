import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { X } from "lucide-react";
import type { SessionSearchResult } from "../../../core/types";
import { displayTagName, isBranchTag } from "../session-ui";
import { localize, type LanguageMode } from "../language";
import type { DialogState } from "../app-types";
import type { SessionBulkDeletePreview } from "../../../core/session-bulk-delete";

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
  blockedMessage,
  language,
  deleting,
  onConfirm,
  onCancel,
}: {
  session: SessionSearchResult;
  cascadeCount: number | null;
  blockedMessage: string | null;
  language: LanguageMode;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [confirmationText, setConfirmationText] = useState("");
  const canConfirm = confirmationText === "确认删除";
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
            : l(
                "This deletes the original Codex or Claude Code session file and removes it from this app. This cannot be undone.",
                "这会删除 Codex 或 Claude Code 的原始会话文件，并从本应用移除，无法撤销。",
              )}
        </p>
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
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [confirmationText, setConfirmationText] = useState("");
  const canConfirm = confirmationText === "确认删除";
  useEffect(() => {
    if (!preview) setConfirmationText("");
  }, [preview]);
  const skippedCounts = preview ? countIssueReasons(preview) : [];
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog bulk-delete-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{mode === "cleanup"
            ? l("Clean Up Sessions", "按日期清理会话")
            : mode === "orphans"
            ? l("Clean Up Orphaned Subagents", "清理孤儿 Subagent")
            : l("Delete Selected Sessions", "删除所选会话")}</span>
          <button type="button" className="icon-button" onClick={onCancel} disabled={busy} aria-label={l("Close", "关闭")}><X size={16} /></button>
        </div>
        {mode === "cleanup" && !preview ? (
          <label className="bulk-delete-date">
            <span>{l("Delete sessions inactive before", "删除此日期前不活跃的会话")}</span>
            <input type="date" value={dateValue} max={localDateInput(new Date())} onChange={(event) => onDateChange(event.target.value)} />
            <small>{l("Favorite and live sessions are protected.", "收藏和正在运行的会话会受到保护。")}</small>
          </label>
        ) : null}
        {mode === "orphans" && !preview ? (
          <p className="dialog-copy">{l("Scanning for orphaned subagent sessions...", "正在扫描孤儿 Subagent 会话...")}</p>
        ) : null}
        {preview ? (
          <>
            <p className="dialog-copy">{mode === "orphans" && preview.deletableCount === 0
              ? l("No deletable orphaned subagent sessions were found.", "未发现可清理的孤儿 Subagent 会话。")
              : <><strong>{preview.deletableCount}</strong>{l(" sessions will be permanently deleted.", " 个会话将被永久删除。")}</>}</p>
            <div className="bulk-delete-summary">
              {preview.sourceCounts.map((item) => <span key={item.source}>{item.source} · {item.count}</span>)}
            </div>
            {preview.skipped.length > 0 ? <p className="dialog-copy">{l("Excluded", "已排除")}：{skippedCounts.map(([reason, count]) => `${issueReasonLabel(reason, l)} · ${count}`).join("，")}</p> : null}
            {mode === "selection" && favoriteCount > 0 ? <p className="dialog-copy danger-copy">{l(`${favoriteCount} favorite sessions are included.`, `其中包含 ${favoriteCount} 个收藏会话。`)}</p> : null}
            <p className="dialog-copy danger-copy">{l("Original session data may be deleted. This cannot be undone.", "原始会话数据可能被删除，且无法撤销。")}</p>
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
          </>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>{l("Cancel", "取消")}</button>
          {!preview ? (
            mode === "cleanup"
              ? <button type="button" className="primary-action" onClick={onPreview} disabled={busy || !dateValue}>{busy ? l("Loading...", "正在加载...") : l("Preview", "预览")}</button>
              : <button type="button" className="primary-action" disabled>{l("Scanning...", "正在扫描...")}</button>
          ) : (
            <button type="button" className="danger-action" onClick={onConfirm} disabled={busy || preview.deletableCount === 0 || !canConfirm}>{busy ? l("Deleting...", "正在删除...") : l("Delete Permanently", "永久删除")}</button>
          )}
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

export function CommandDialog({
  dialog,
  tags,
  language,
  onChange,
  onSubmit,
  onCancel,
}: {
  dialog: NonNullable<DialogState>;
  tags: string[];
  language: LanguageMode;
  onChange: (value: string) => void;
  onSubmit: (value?: string) => void;
  onCancel: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const l = (en: string, zh: string) => localize(language, en, zh);
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
