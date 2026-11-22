import type { ReactElement } from "react";
import { ArrowRightLeft, CloudUpload, Copy, Download, FolderOpen, MoreHorizontal, Play, Sparkles, Tag, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import { canDeleteSessionLocally } from "../../../../core/session-environment";
import { isSessionSource, sessionSourceDescriptor, supportsAiSummarySource } from "../../../../core/session-sources";
import type { RuntimeInvocationSummary, SessionSearchResult } from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";
import { isRemoteSession, remoteRevealTitle } from "../../session-ui";
import { MenuButton } from "../../ui/menu";
import { InvocationOwnerActions } from "./invocation-owner";

/**
 * Session action bar: primary actions stay visible and the rest live in the
 * More menu. Capability rules (local-only reveal, AI summary support, remote
 * sync, local deletion) are derived from the session here.
 */
export function DetailActions({
  session,
  language,
  actionRunning,
  revealLabel,
  showItermAction,
  canResume,
  canMigrate,
  migrationTitle,
  summarizing,
  remoteUploadDisabled,
  onResume,
  onResumeIterm,
  onReveal,
  onSummarize,
  onAddTag,
  onMigrate,
  onUploadRemote,
  onCopyResume,
  onCopyMarkdown,
  onExportMarkdown,
  onExportJson,
  onCopyPlain,
  onDelete,
  onOpenInvocationOwner,
}: {
  session: SessionSearchResult;
  language: LanguageMode;
  actionRunning: boolean;
  revealLabel: string;
  showItermAction: boolean;
  canResume: boolean;
  canMigrate: boolean;
  migrationTitle: string;
  summarizing: boolean;
  remoteUploadDisabled: boolean;
  onResume: () => void;
  onResumeIterm: () => void;
  onReveal: () => void;
  onSummarize: () => void;
  onAddTag: () => void;
  onMigrate: () => void;
  onUploadRemote?: () => void;
  onCopyResume: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: (includeToolTrace: boolean) => void;
  onExportJson: () => void;
  onCopyPlain: () => void;
  onDelete: () => void;
  onOpenInvocationOwner?: (invocation: RuntimeInvocationSummary) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const localOnlyDisabled = isRemoteSession(session);
  const canDelete = canDeleteSessionLocally(session);
  const canSyncSession = isSessionSource(session.source)
    && sessionSourceDescriptor(session.source).capabilities.sessionSync;
  const revealTitle = localOnlyDisabled ? remoteRevealTitle(language) : l(`Show in ${revealLabel}`, `在${revealLabel}中显示`);

  return (
    <div className="detail-actions">
      <div className="detail-action-group">
        {canResume ? (
          <button className="primary" onClick={onResume} disabled={actionRunning}>
            <Play size={14} /> {session.source === "codex-app" ? l("Open in Codex", "在 Codex 中打开") : "Resume"}
          </button>
        ) : null}
        {canResume && showItermAction ? (
          <button onClick={onResumeIterm} disabled={actionRunning}>
            <TerminalIcon size={14} /> iTerm
          </button>
        ) : null}
        <button onClick={onReveal} disabled={actionRunning || localOnlyDisabled} title={revealTitle}>
          <FolderOpen size={14} /> {revealLabel}
        </button>
        {supportsAiSummarySource(session.source) ? (
          <button onClick={onSummarize} disabled={actionRunning || summarizing}>
            <Sparkles size={14} />{" "}
            {summarizing
              ? l("Summarizing...", "摘要中...")
              : session.aiSummary
                ? l("Re-summarize", "重新摘要")
                : l("AI Summary", "AI 摘要")}
          </button>
        ) : null}
        <MenuButton
          className="detail-more"
          label={l("More actions", "更多操作")}
          icon={<MoreHorizontal size={15} />}
          disabled={actionRunning}
          items={[
            { key: "tag", label: l("Add Tag", "添加标签"), icon: <Tag size={14} />, onSelect: onAddTag },
            { key: "migrate", label: l("Migrate to…", "迁移到…"), icon: <ArrowRightLeft size={14} />, disabled: !canMigrate, hint: canMigrate ? undefined : migrationTitle || undefined, onSelect: onMigrate },
            ...(onUploadRemote && canSyncSession ? [{
              key: "remote", label: l("Save to Remote", "保存到远程"), icon: <CloudUpload size={14} />,
              disabled: remoteUploadDisabled, onSelect: onUploadRemote,
            }] : []),
            ...(canResume ? [{ key: "copy-command", label: l("Copy Resume Command", "复制恢复命令"), icon: <Copy size={14} />, onSelect: onCopyResume }] : []),
            { key: "copy-markdown", label: l("Copy Markdown", "复制 Markdown"), icon: <Copy size={14} />, onSelect: onCopyMarkdown },
            { key: "export-conversation", label: l("Export Markdown", "导出 Markdown"), hint: l("Conversation only, no Tool Trace", "仅会话内容，不含 Tool Trace"), icon: <Download size={14} />, onSelect: () => onExportMarkdown(false) },
            { key: "export-complete", label: l("Export Markdown", "导出 Markdown"), hint: l("Complete record with Tool Trace", "完整记录，包含 Tool Trace"), icon: <Download size={14} />, onSelect: () => onExportMarkdown(true) },
            { key: "export-json", label: l("Export JSON", "导出 JSON"), icon: <Download size={14} />, onSelect: onExportJson },
            { key: "copy-plain", label: l("Copy Plain Text", "复制纯文本"), icon: <Copy size={14} />, onSelect: onCopyPlain },
            ...(canDelete ? [{
              key: "delete", label: session.sourceAvailable === false ? l("Delete Cache", "删除缓存") : l("Delete", "删除"),
              icon: <Trash2 size={14} />, danger: true, onSelect: onDelete,
            }] : []),
          ]}
        />
      </div>
      {onOpenInvocationOwner ? (
        <InvocationOwnerActions session={session} language={language} onOpen={onOpenInvocationOwner} />
      ) : null}
    </div>
  );
}
