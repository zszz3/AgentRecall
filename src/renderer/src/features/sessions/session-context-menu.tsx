import type { ReactElement } from "react";
import {
  AppWindow,
  Archive,
  ArrowRightLeft,
  Clipboard,
  Copy,
  Download,
  Eye,
  FolderOpen,
  Pin,
  PinOff,
  Play,
  Star,
  Tag,
  Terminal,
  Trash2,
} from "lucide-react";
import type { ContextMenuState } from "../../app-types";
import { useClampedContextMenuStyle } from "../../context-menu-position";
import { localize, type LanguageMode } from "../../language";
import {
  isRemoteSession,
  remoteMigrationTitle,
  remoteOpenAppTitle,
  remoteRevealTitle,
  unsupportedMigrationTitle,
} from "../../session-ui";

export function SessionContextMenu({
  state,
  language,
  revealLabel,
  showMacActions,
  canResume,
  canMigrate,
  onRename,
  onAddTag,
  onFavorite,
  onPin,
  onHide,
  onResume,
  onResumeIterm,
  onOpenApp,
  onMigrate,
  onCopyResume,
  onCopyMarkdown,
  onExportMarkdown,
  onExportJson,
  onDelete,
  onReveal,
}: {
  state: ContextMenuState;
  language: LanguageMode;
  revealLabel: string;
  showMacActions: boolean;
  canResume: boolean;
  canMigrate: boolean;
  onRename(): void;
  onAddTag(): void;
  onFavorite(): void;
  onPin(): void;
  onHide(): void;
  onResume(): void;
  onResumeIterm(): void;
  onOpenApp(): void;
  onMigrate(): void;
  onCopyResume(): void;
  onCopyMarkdown(): void;
  onExportMarkdown(): void;
  onExportJson(): void;
  onDelete(): void;
  onReveal(): void;
}): ReactElement {
  const l = (en: string, zh: string): string => localize(language, en, zh);
  const menu = useClampedContextMenuStyle(state);
  const localOnlyDisabled = isRemoteSession(state.session);
  const revealTitle = localOnlyDisabled
    ? remoteRevealTitle(language)
    : l(`Show in ${revealLabel}`, `在${revealLabel}中显示`);
  const openAppTitle = localOnlyDisabled
    ? remoteOpenAppTitle(language)
    : l("Open native app", "打开原生应用");
  const migrateTitle = localOnlyDisabled
    ? remoteMigrationTitle(language)
    : canMigrate
      ? l("Migrate session to…", "迁移会话到…")
      : unsupportedMigrationTitle(language);
  return (
    <div
      ref={menu.ref}
      className="context-menu"
      style={menu.style}
      onClick={(event) => event.stopPropagation()}
    >
      <button onClick={onRename}>
        <Clipboard size={14} /> {l("Rename", "重命名")}
      </button>
      <button onClick={onAddTag}>
        <Tag size={14} /> {l("Add Tag", "添加标签")}
      </button>
      <button onClick={onFavorite}>
        <Star size={14} fill={state.session.favorited ? "currentColor" : "none"} />{" "}
        {state.session.favorited ? l("Unfavorite", "取消收藏") : l("Favorite", "收藏")}
      </button>
      <button onClick={onPin}>
        {state.session.pinned ? <PinOff size={14} /> : <Pin size={14} />}{" "}
        {state.session.pinned ? l("Unpin", "取消置顶") : l("Pin", "置顶")}
      </button>
      <button onClick={onHide}>
        {state.session.hidden ? <Eye size={14} /> : <Archive size={14} />}{" "}
        {state.session.hidden ? l("Unhide", "取消隐藏") : l("Hide", "隐藏")}
      </button>
      <hr />
      {canResume ? (
        <button onClick={onResume}>
          <Play size={14} />{" "}
          {state.session.source === "codex-app"
            ? l("Open in Codex", "在 Codex 中打开")
            : l("Resume in Terminal", "在终端恢复")}
        </button>
      ) : null}
      {canResume && showMacActions && state.session.source !== "codex-app" ? (
        <button onClick={onResumeIterm}>
          <Terminal size={14} /> Resume in iTerm
        </button>
      ) : null}
      {canResume && showMacActions ? (
        <button onClick={onOpenApp} disabled={localOnlyDisabled} title={openAppTitle}>
          <AppWindow size={14} /> Open App
        </button>
      ) : null}
      <button
        onClick={onMigrate}
        disabled={!canMigrate || localOnlyDisabled}
        title={migrateTitle}
      >
        <ArrowRightLeft size={14} /> {l("Migrate to…", "迁移到…")}
      </button>
      {canResume ? (
        <button onClick={onCopyResume}>
          <Copy size={14} /> {l("Copy Resume Cmd", "复制 Resume 命令")}
        </button>
      ) : null}
      <button onClick={onCopyMarkdown}>{l("Copy Markdown", "复制 Markdown")}</button>
      <button onClick={onExportMarkdown}>
        <Download size={14} /> {l("Export Markdown", "导出 Markdown")}
      </button>
      <button onClick={onExportJson}>
        <Download size={14} /> {l("Export JSON", "导出 JSON")}
      </button>
      <button onClick={onReveal} disabled={localOnlyDisabled} title={revealTitle}>
        <FolderOpen size={14} /> Show in {revealLabel}
      </button>
      <hr />
      <button className="danger" onClick={onDelete}>
        <Trash2 size={14} /> {l("Delete Session", "删除会话")}
      </button>
    </div>
  );
}
