import { useState, type ReactElement } from "react";
import { Copy, X } from "lucide-react";
import type {
  MigrationTarget,
  SessionMigrationProgress,
  SessionMigrationResult,
  SessionEnvironment,
  SessionSearchResult,
} from "../../../core/types";
import { isLocalSessionEnvironment } from "../../../core/session-environment";
import { localize, type LanguageMode } from "../language";
import { migrationAgentLabel } from "../session-ui";
import { environmentTarget } from "../features/environments/environment-display";

export function SessionMigrationDialog({
  session,
  language,
  busy,
  progress,
  targets,
  environments,
  onSelect,
  onClose,
}: {
  session: SessionSearchResult;
  language: LanguageMode;
  busy: boolean;
  progress?: SessionMigrationProgress | null;
  targets: readonly MigrationTarget[];
  environments: readonly SessionEnvironment[];
  onSelect: (target: MigrationTarget, withoutProjectPath: boolean, targetEnvironmentId: string, targetProjectPath?: string) => void;
  onClose: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const ssh = session.environmentKind === "ssh";
  const [targetEnvironmentId, setTargetEnvironmentId] = useState(() => session.environmentId);
  const [withoutProjectPath, setWithoutProjectPath] = useState(() => !session.projectPath.trim());
  const [targetProjectPath, setTargetProjectPath] = useState(() => session.projectPath.trim());
  const targetEnvironment = environments.find((environment) => environment.id === targetEnvironmentId)
    ?? environments.find((environment) => environment.id === session.environmentId);
  const destinationIsLocal = targetEnvironment?.kind === "local";
  const crossEnvironment = targetEnvironmentId !== session.environmentId;
  const visibleTargets = targetEnvironment?.kind === "wsl"
    ? targets.filter((target) => target === "claude" || target === "codex" || target === "codebuddy" || target === "cursor")
    : targets;

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="command-dialog migration-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{l("Migrate session to…", "迁移会话到…")}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={busy ? l("Continue in background", "转到后台") : l("Close", "关闭")}>
            <X size={16} />
          </button>
        </div>
        <p className="dialog-copy">
          {ssh
            ? l("Create a new target-Agent session on the same SSH host from", "在同一台 SSH 主机上从当前会话创建新的目标 Agent 会话：")
            : session.environmentKind === "wsl"
            ? l("Create a new WSL target-agent session from", "从当前会话创建新的 WSL 目标 Agent 会话：")
            : l("Create a new local target-agent session from", "从当前会话创建新的本地目标 Agent 会话：")} <strong>{session.displayTitle}</strong>
        </p>
        <label className="migration-project-option">
          <span className="migration-project-copy">
            <strong>{l("Destination environment", "目标环境")}</strong>
            <small>{targetEnvironment ? environmentTarget(targetEnvironment, language) : l("This computer", "这台电脑")}</small>
          </span>
          <select
            value={targetEnvironmentId}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value;
              setTargetEnvironmentId(next);
              if (next !== session.environmentId) {
                setWithoutProjectPath(true);
                setTargetProjectPath("");
              } else {
                setWithoutProjectPath(!session.projectPath.trim());
                setTargetProjectPath(session.projectPath.trim());
              }
            }}
            aria-label={l("Destination environment", "目标环境")}
          >
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id} disabled={environment.kind !== "local" && !environment.enabled}>
                {environment.label} · {environmentTarget(environment, language)}
              </option>
            ))}
          </select>
        </label>
        {targetEnvironment?.kind === "wsl" && !withoutProjectPath ? (
          <label className="migration-project-option">
            <span className="migration-project-copy">
              <strong>{l("WSL project directory", "WSL 项目目录")}</strong>
              <small>{l("Enter an absolute Linux path in the selected distribution.", "请输入所选发行版中的 Linux 绝对路径。")}</small>
            </span>
            <input
              value={targetProjectPath}
              disabled={busy}
              onChange={(event) => setTargetProjectPath(event.currentTarget.value)}
              placeholder="/home/user/project"
              aria-label={l("WSL project directory", "WSL 项目目录")}
            />
          </label>
        ) : null}
        {(isLocalSessionEnvironment(session) || destinationIsLocal || targetEnvironment?.kind === "wsl") ? (
          <button
            type="button"
            className="migration-project-option"
            role="switch"
            aria-checked={withoutProjectPath}
            disabled={busy}
            onClick={() => setWithoutProjectPath((selected) => !selected)}
          >
            <span className="migration-project-copy">
              <strong>{l("Create without a project path", "创建为无项目路径会话")}</strong>
              <small>
                {crossEnvironment
                  ? l("The source project path is not portable; start without one or choose a local directory.", "源环境的项目路径无法直接复用；可无项目路径启动，或选择本地目录。")
                  : session.projectPath.trim()
                  ? l(
                      "The new session will not be associated with the current project directory.",
                      "新会话不会关联当前项目目录。",
                    )
                  : l(
                      "Keep this selected to preserve the missing project path, or clear it to choose a directory.",
                      "保持选中可继续使用无项目路径；取消选中后可选择项目目录。",
                    )}
              </small>
            </span>
            <span className="migration-project-switch" aria-hidden="true"><span /></span>
          </button>
        ) : null}
        {busy ? <MigrationProgressPanel progress={progress ?? null} language={language} /> : null}
        <div className="migration-targets">
          {visibleTargets.length === 0 ? (
            <p className="dialog-copy">{l("No migration targets are available for this session.", "当前会话没有可用的迁移目标。")}</p>
          ) : visibleTargets.map((target) => {
            const disabled = busy;
            return (
            <button
              key={target}
              type="button"
              onClick={() => onSelect(target, withoutProjectPath, targetEnvironmentId, targetProjectPath.trim() || undefined)}
              disabled={disabled}
            >
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

function migrationStageStatus(
  progress: SessionMigrationProgress | null,
  language: LanguageMode,
): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (!progress) return l("Preparing migration...", "正在准备迁移...");
  const target = migrationAgentLabel(progress.target);
  if (progress.stage === "reading") return l(`Reading session for ${target}...`, `正在读取会话，准备迁移到 ${target}...`);
  if (progress.stage === "compressing") return l(`Compressing long session for ${target}...`, `正在压缩长会话，准备迁移到 ${target}...`);
  if (progress.stage === "writing") return l(`Writing ${target} session...`, `正在写入 ${target} 会话...`);
  if (progress.stage === "indexing") return l("Refreshing index...", "正在刷新索引...");
  return l(`Opening ${target}...`, `正在打开 ${target}...`);
}

function compressionDetailText(
  progress: SessionMigrationProgress,
  language: LanguageMode,
): string | null {
  const compression = progress.compression;
  if (!compression) return null;
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (compression.phase === "chunk") {
    return l(
      `Summarized ${compression.completed}/${compression.totalChunks} chunks`,
      `已完成 ${compression.completed}/${compression.totalChunks} 个分片`,
    );
  }
  return l("Generating handoff summary...", "生成交接摘要...");
}

function MigrationProgressPanel({
  progress,
  language,
}: {
  progress: SessionMigrationProgress | null;
  language: LanguageMode;
}): ReactElement {
  const compressing = progress?.stage === "compressing";
  const percent = compressing ? Math.max(0, Math.min(100, progress?.percent ?? 0)) : 0;
  const detail = compressing && progress ? compressionDetailText(progress, language) : null;
  return (
    <div className="migration-progress" aria-live="polite">
      <div className="migration-progress-status">{migrationStageStatus(progress, language)}</div>
      {compressing ? (
        <>
          <div
            className="migration-progress-bar"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="migration-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="migration-progress-meta">
            <span className="migration-progress-percent">{percent}%</span>
            {detail ? <span className="migration-progress-detail">{detail}</span> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
