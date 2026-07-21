import type { ReactElement } from "react";
import { Check, FileDiff, X } from "lucide-react";
import type { AgentMemorySyncPreview, AgentMemoryTarget } from "../../../../core/agent-memory-sync";
import { localize, type LanguageMode } from "../../language";

interface AgentMemorySyncDialogProps {
  language: LanguageMode;
  sourcePath: string;
  targets: AgentMemoryTarget[];
  preview: AgentMemorySyncPreview | null;
  busy: "preview" | "apply" | null;
  error: string | null;
  onToggleTarget(target: AgentMemoryTarget): void;
  onPreview(): void;
  onApply(): void;
  onClose(): void;
  onBack?(): void;
}

export function AgentMemorySyncDialog({
  language,
  sourcePath,
  targets,
  preview,
  busy,
  error,
  onToggleTarget,
  onPreview,
  onApply,
  onClose,
  onBack,
}: AgentMemorySyncDialogProps): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const hasChanges = preview?.items.some((item) => item.action !== "unchanged") ?? false;
  return (
    <div className="agent-memory-dialog-backdrop" role="presentation" onMouseDown={() => busy === null && onClose()}>
      <section
        className="agent-memory-dialog agent-memory-sync-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-memory-sync-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h3 id="agent-memory-sync-title">{preview ? l("Review sync changes", "确认同步差异") : l("Sync to Agents", "同步到 Agent")}</h3>
            <p>{sourcePath}</p>
          </div>
          <button type="button" aria-label={l("Close", "关闭")} onClick={onClose} disabled={busy !== null}><X size={15} /></button>
        </header>

        {preview ? (
          <div className="agent-memory-sync-preview">
            {preview.items.map((item) => (
              <section key={item.target} className="agent-memory-sync-file">
                <header>
                  <div><strong>{targetLabel(item.target)}</strong><code>{item.relativePath}</code></div>
                  <span data-action={item.action}>{actionLabel(item.action, language)}</span>
                </header>
                <div className="agent-memory-diff" aria-label={l(`Diff for ${item.relativePath}`, `${item.relativePath} 的差异`)}>
                  {item.diff.length > 0 ? item.diff.map((line, index) => (
                    <div className={`agent-memory-diff-line ${line.kind}`} key={`${line.kind}-${index}`}>
                      <span>{line.oldLine ?? ""}</span><span>{line.newLine ?? ""}</span>
                      <em>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</em>
                      <code>{line.text || " "}</code>
                    </div>
                  )) : <div className="agent-memory-diff-empty"><Check size={14} />{l("Already in sync", "内容已经一致")}</div>}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="agent-memory-sync-targets">
            <p>{l(
              "Copy this saved memory into the selected directory. Existing files are changed only after you review the diff.",
              "把这份已保存的记忆同步到当前目录；已有文件只有在你查看差异并确认后才会修改。",
            )}</p>
            <div role="group" aria-label={l("Sync targets", "同步目标")}>
              {(["codex", "claude", "cursor"] as AgentMemoryTarget[]).map((target) => {
                const selected = targets.includes(target);
                return (
                  <button type="button" key={target} className={selected ? "active" : ""} aria-pressed={selected} onClick={() => onToggleTarget(target)}>
                    <span>{selected ? <Check size={12} /> : null}</span>
                    <strong>{targetLabel(target)}</strong>
                    <small>{targetPathLabel(target)}</small>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {error ? <div className="agent-memory-dialog-error">{error}</div> : null}
        <footer>
          {preview ? <button type="button" onClick={onBack} disabled={busy !== null || !onBack}>{l("Back", "返回")}</button> : null}
          <button type="button" onClick={onClose} disabled={busy !== null}>{l("Cancel", "取消")}</button>
          {preview ? (
            <button type="button" className="primary" onClick={onApply} disabled={busy !== null || !hasChanges}>
              {busy === "apply" ? l("Syncing…", "同步中…") : l("Apply sync", "应用同步")}
            </button>
          ) : (
            <button type="button" className="primary" onClick={onPreview} disabled={busy !== null || targets.length === 0}>
              <FileDiff size={13} />{busy === "preview" ? l("Building diff…", "正在生成差异…") : l("Preview changes", "预览差异")}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function targetLabel(target: AgentMemoryTarget): string {
  if (target === "codex") return "Codex";
  if (target === "claude") return "Claude Code";
  return "Cursor";
}

function targetPathLabel(target: AgentMemoryTarget): string {
  if (target === "codex") return "AGENTS.md";
  if (target === "claude") return "CLAUDE.md";
  return ".cursor/rules/agent-recall.mdc";
}

function actionLabel(action: "create" | "update" | "unchanged", language: LanguageMode): string {
  if (action === "create") return localize(language, "Create", "新建");
  if (action === "update") return localize(language, "Update", "更新");
  return localize(language, "Unchanged", "无变化");
}
