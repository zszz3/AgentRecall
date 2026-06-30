import type { ReactElement } from "react";
import { Copy, X } from "lucide-react";
import type { MigrationAgent, SessionMigrationResult, SessionSearchResult } from "../../../core/types";
import { localize, type LanguageMode } from "../language";
import { isRemoteSession, migrationAgentLabel, migrationTargetsForSource } from "../session-ui";

export function SessionMigrationDialog({
  session,
  language,
  busy,
  onSelect,
  onClose,
}: {
  session: SessionSearchResult;
  language: LanguageMode;
  busy: boolean;
  onSelect: (target: MigrationAgent) => void;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const targets = migrationTargetsForSource(session.source);
  const remote = isRemoteSession(session);

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="command-dialog migration-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Migrate session to…", "迁移会话到…")}</span>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {l("Create a new local target-agent session from", "从当前会话创建新的本地目标 Agent 会话：")} <strong>{session.displayTitle}</strong>
        </p>
        {remote ? <p className="dialog-copy danger-copy">{l("Remote session migration is not supported yet.", "首版仅支持本地会话迁移。")}</p> : null}
        <div className="migration-targets">
          {(["claude", "codex", "codebuddy"] as const).map((target) => {
            const disabled = busy || remote || !targets.includes(target);
            return (
              <button key={target} type="button" onClick={() => onSelect(target)} disabled={disabled}>
                {migrationAgentLabel(target)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function SessionMigrationLaunchFailedDialog({
  session,
  result,
  language,
  onClose,
}: {
  session: SessionSearchResult;
  result: SessionMigrationResult;
  language: LanguageMode;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="command-dialog migration-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Migration created", "迁移会话已创建")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {l("The target session was created, but it could not be opened automatically.", "目标会话已创建，但无法自动打开。")}
        </p>
        <p className="dialog-copy">
          {migrationAgentLabel(result.target)} · <strong>{result.targetSessionId}</strong>
        </p>
        <div className="migration-resume-command" title={result.resumeCommand}>
          {result.resumeCommand}
        </div>
        {result.warning ? <p className="dialog-copy danger-copy">{result.warning}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={() => void navigator.clipboard.writeText(result.resumeCommand)}>
            <Copy size={14} /> {l("Copy command", "复制命令")}
          </button>
          <button type="button" className="primary-action" onClick={onClose}>
            {l("Done", "完成")}
          </button>
        </div>
        <p className="dialog-copy">
          {l("Source:", "源会话：")} {session.displayTitle}
        </p>
      </div>
    </div>
  );
}
