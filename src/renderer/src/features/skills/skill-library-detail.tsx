import type { ReactElement } from "react";
import { Copy, FolderOpen, Link2, Link2Off, Trash2 } from "lucide-react";
import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";
import type { RemoteSkill, RemoteSkillGroup, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../../../../core/skill-sync";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import type { UnifiedSkillEntry } from "../../skill-sync-view-model";
import { originLabel } from "./skill-library-list";
import { SkillSyncPanel } from "./skill-sync-panel";

const TARGET_LABELS: Record<SkillInstallTarget, string> = {
  codex: "Codex",
  claude: "Claude Code",
  trae: "Trae",
};

export function SkillLibraryDetail({
  skill,
  entry,
  remoteOnlyGroups,
  syncSnapshot,
  busy,
  targetBusy,
  language,
  revealLabel,
  onToggleTarget,
  onUpload,
  onInstallRemote,
  onFetchVersion,
  onRefreshRemote,
  onCopySetupSql,
  onOpenSqlEditor,
  onCopyPath,
  onReveal,
  onRequestDelete,
}: {
  skill: ManagedSkill | null;
  entry: UnifiedSkillEntry | null;
  remoteOnlyGroups: RemoteSkillGroup[];
  syncSnapshot: SkillSyncSnapshot;
  busy: boolean;
  targetBusy: boolean;
  language: LanguageMode;
  revealLabel: string;
  onToggleTarget: (skill: ManagedSkill, target: SkillInstallTarget) => void;
  onUpload: (skill: ManagedSkill, force?: boolean) => Promise<SkillSyncUploadOutcome | null>;
  onInstallRemote: (remoteSkillId: string) => Promise<void>;
  onFetchVersion: (remoteSkillId: string) => Promise<RemoteSkill>;
  onRefreshRemote: () => void;
  onCopySetupSql: () => void;
  onOpenSqlEditor: () => void | Promise<void>;
  onCopyPath: (skillPath: string) => void;
  onReveal: (skillPath: string) => void;
  onRequestDelete: (skill: ManagedSkill) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (!skill) {
    return (
      <main className="skill-library-detail empty">
        <div className="skill-library-detail-empty">
          <strong>{l("Choose a Skill", "选择一个 Skill")}</strong>
          <span>{l("Its documentation, install targets, and versions will appear here.", "这里会显示说明、安装目标和云端版本。")}</span>
        </div>
      </main>
    );
  }

  return (
    <main className="skill-library-detail">
      <header className="managed-skill-head">
        <div className="managed-skill-title">
          <div>
            <h3>{skill.name}</h3>
            <span>{originLabel(skill, language)}</span>
          </div>
          <p>{skill.description || l("No description", "暂无说明")}</p>
        </div>
        <div className="managed-skill-actions">
          <button type="button" onClick={() => onCopyPath(skill.path)} title={l("Copy path", "复制路径")} aria-label={l("Copy path", "复制路径")}><Copy size={14} /></button>
          <button type="button" onClick={() => onReveal(skill.directoryPath)} title={l(`Show in ${revealLabel}`, `在 ${revealLabel} 中显示`)} aria-label={l(`Show in ${revealLabel}`, `在 ${revealLabel} 中显示`)}><FolderOpen size={14} /></button>
          <button type="button" className="danger" onClick={() => onRequestDelete(skill)} title={l("Delete from library", "从 Skill 库删除")} aria-label={l("Delete from library", "从 Skill 库删除")}><Trash2 size={14} /></button>
        </div>
      </header>

      <section className="managed-skill-target-section">
        <div className="managed-skill-section-label">
          <span>{l("Available in", "安装到")}</span>
          <small>{l("AgentRecall keeps one copy and links it to selected agents.", "AgentRecall 只保留一份内容，并链接到选中的 Agent。")}</small>
        </div>
        <div className="managed-skill-targets" role="group" aria-label={l("Skill installation targets", "Skill 安装目标")}>
          {skill.installations.map((installation) => {
            const installed = installation.state === "installed";
            const conflict = installation.state === "conflict";
            return (
              <button
                key={installation.target}
                type="button"
                className={`${installation.state}`}
                disabled={busy || targetBusy || conflict}
                aria-pressed={installed}
                title={conflict
                  ? l(`An existing ${TARGET_LABELS[installation.target]} Skill occupies this path. AgentRecall will not overwrite it.`, `${TARGET_LABELS[installation.target]} 中已有同名 Skill，AgentRecall 不会覆盖。`)
                  : installation.path}
                onClick={() => onToggleTarget(skill, installation.target)}
              >
                <span className="managed-skill-target-icon">{installed ? <Link2 size={15} /> : <Link2Off size={15} />}</span>
                <span><strong>{TARGET_LABELS[installation.target]}</strong><small>{conflict ? l("Conflict", "路径冲突") : installed ? l("Installed", "已安装") : l("Not installed", "未安装")}</small></span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="managed-skill-document">
        <div className="managed-skill-document-head">
          <span>SKILL.md</span>
          <small>{l(`Used ${skill.usageCount ?? 0} times`, `使用 ${skill.usageCount ?? 0} 次`)}</small>
        </div>
        <div className="managed-skill-markdown">
          <Markdown text={markdownPreview(skill.markdown, 18_000, l("…(truncated)", "…（已截断）"))} language={language} />
        </div>
      </section>

      <SkillSyncPanel
        skill={skill}
        entry={entry}
        remoteOnlyGroups={remoteOnlyGroups}
        snapshot={syncSnapshot}
        busy={busy}
        language={language}
        onUpload={onUpload}
        onInstallRemote={onInstallRemote}
        onFetchVersion={onFetchVersion}
        onRefresh={onRefreshRemote}
        onCopySetupSql={onCopySetupSql}
        onOpenSqlEditor={onOpenSqlEditor}
      />
    </main>
  );
}
