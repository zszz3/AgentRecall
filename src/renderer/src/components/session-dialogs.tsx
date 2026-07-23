import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { X } from "lucide-react";
import type { SessionSearchResult } from "../../../core/types";
import { displayTagName, isBranchTag } from "../session-ui";
import { localize, type LanguageMode } from "../language";
import type { DialogState } from "../app-types";

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
  language,
  deleting,
  onConfirm,
  onCancel,
}: {
  session: SessionSearchResult;
  language: LanguageMode;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div className="command-dialog delete-session-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Delete Session", "删除会话")}</span>
          <button type="button" className="icon-button" onClick={onCancel} disabled={deleting} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {l("Delete", "删除")} <strong>{session.displayTitle}</strong>
          {l(" permanently?", "？")}
        </p>
        <p className="dialog-copy danger-copy">
          {session.source === "zcode-cli"
            ? l(
                "This permanently deletes this ZCode session, its messages, tool calls, and usage records from the local ZCode database. This cannot be undone.",
                "这会从本地 ZCode 数据库永久删除该会话及其消息、工具调用和用量记录，无法撤销。",
              )
            : l(
                "This deletes the original Codex or Claude Code session file and removes it from this app. This cannot be undone.",
                "这会删除 Codex 或 Claude Code 的原始会话文件，并从本应用移除，无法撤销。",
              )}
        </p>
        <div className="delete-session-path" title={session.filePath}>
          {session.filePath}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={deleting}>
            {l("Cancel", "取消")}
          </button>
          <button type="button" className="danger-action" onClick={onConfirm} disabled={deleting}>
            {deleting ? l("Deleting...", "正在删除...") : l("Delete Permanently", "永久删除")}
          </button>
        </div>
      </div>
    </div>
  );
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
