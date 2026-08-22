import { useState } from "react";
import type { ReactElement } from "react";
import { Copy, FolderOpen, Settings2, Trash2 } from "lucide-react";
import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";
import type { RemoteSkill, RemoteSkillGroup, SkillSyncSnapshot, SkillSyncUploadOutcome } from "../../../../core/skill-sync";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview } from "../../markdown-preview";
import type { UnifiedSkillEntry } from "../../skill-sync-view-model";
import { originLabel } from "./skill-library-list";
import { SkillSyncPanel } from "./skill-sync-panel";
import { SkillTargetDialog } from "./skill-target-dialog";

export function SkillLibraryDetail({
  skill,
  entry,
  remoteOnlyGroups,
  syncSnapshot,
  busy,
  targetBusy,
  language,
  revealLabel,
  onUpdateTargets,
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
  onUpdateTargets: (
    skill: ManagedSkill,
    targets: SkillInstallTarget[],
    forceTargets: SkillInstallTarget[],
  ) => Promise<void>;
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
  const [targetDialogOpen, setTargetDialogOpen] = useState(false);
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

  const installedCount = skill.installations.filter((installation) => installation.state === "installed").length;
  const conflictCount = skill.installations.filter((installation) => installation.state === "conflict").length;

  return (
    <>
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
            <button
              type="button"
              className={`managed-skill-install-action ${conflictCount > 0 ? "warning" : installedCount > 0 ? "installed" : ""}`}
              onClick={() => setTargetDialogOpen(true)}
              disabled={busy || targetBusy}
              title={l("Manage installation", "管理安装")}
            >
              <Settings2 size={14} />
              <span>{l("Install", "安装")}</span>
            </button>
            <button type="button" onClick={() => onCopyPath(skill.path)} title={l("Copy path", "复制路径")} aria-label={l("Copy path", "复制路径")}><Copy size={14} /></button>
            <button type="button" onClick={() => onReveal(skill.directoryPath)} title={l(`Show in ${revealLabel}`, `在 ${revealLabel} 中显示`)} aria-label={l(`Show in ${revealLabel}`, `在 ${revealLabel} 中显示`)}><FolderOpen size={14} /></button>
            {skill.origin.kind !== "builtin" ? (
              <button type="button" className="danger" onClick={() => onRequestDelete(skill)} title={l("Delete from library", "从 Skill 库删除")} aria-label={l("Delete from library", "从 Skill 库删除")}><Trash2 size={14} /></button>
            ) : null}
          </div>
        </header>

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

        <section className="managed-skill-document">
          <div className="managed-skill-document-head">
            <span>SKILL.md</span>
            <small>{l(`Used ${skill.usageCount ?? 0} times`, `使用 ${skill.usageCount ?? 0} 次`)}</small>
          </div>
          <div className="managed-skill-markdown">
            <Markdown text={markdownPreview(skill.markdown, 18_000, l("…(truncated)", "…（已截断）"))} language={language} />
          </div>
        </section>
      </main>
      <SkillTargetDialog
        open={targetDialogOpen}
        skill={skill}
        busy={busy || targetBusy}
        language={language}
        onClose={() => setTargetDialogOpen(false)}
        onSave={(targets, forceTargets) => onUpdateTargets(skill, targets, forceTargets)}
      />
    </>
  );
}
