import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Check, Link2, X } from "lucide-react";
import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";
import { localize, type LanguageMode } from "../../language";
import { TARGET_LABELS } from "./skill-target-dialog";

export function SkillBatchTargetDialog({
  open,
  skills,
  busy,
  language,
  onClose,
  onSave,
}: {
  open: boolean;
  skills: ManagedSkill[];
  busy: boolean;
  language: LanguageMode;
  onClose: () => void;
  onSave: (targets: SkillInstallTarget[]) => Promise<void>;
}): ReactElement | null {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [selected, setSelected] = useState<Set<SkillInstallTarget>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSaving(false);
    setError(null);
  }, [open, skills]);

  if (!open || skills.length === 0) return null;

  const installations = skills[0].installations;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(installations
        .filter((installation) => selected.has(installation.target))
        .map((installation) => installation.target));
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-backdrop managed-skill-dialog-backdrop" onMouseDown={onClose}>
      <section
        className="command-dialog managed-skill-target-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-batch-target-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="managed-skill-dialog-head">
          <div>
            <h3 id="skill-batch-target-dialog-title">{l("Install selected Skills", "安装所选 Skill")}</h3>
            <p>{l(
              `Add ${skills.length} selected Skills to one or more agents. Existing installations stay in place; conflicting paths are skipped.`,
              `将选中的 ${skills.length} 个 Skill 安装到一个或多个 Agent。已有安装会保留，路径冲突会跳过。`,
            )}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}><X size={16} /></button>
        </header>

        <div className="managed-skill-target-options">
          {installations.map((installation) => {
            const checked = selected.has(installation.target);
            const states = skills.map((skill) => skill.installations.find((item) => item.target === installation.target)?.state);
            const installedCount = states.filter((state) => state === "installed").length;
            const conflictCount = states.filter((state) => state === "conflict").length;
            const label = TARGET_LABELS[installation.target];
            const status = conflictCount > 0
              ? l(`${installedCount} installed · ${conflictCount} conflicts will be skipped`, `已安装 ${installedCount} 个 · 将跳过 ${conflictCount} 个冲突`)
              : l(`${installedCount} of ${skills.length} already installed`, `${skills.length} 个中已有 ${installedCount} 个安装`);
            return (
              <button
                key={installation.target}
                type="button"
                className={checked ? "selected" : ""}
                role="checkbox"
                aria-checked={checked}
                aria-label={l(`${label}: ${checked ? "Selected" : "Not selected"}`, `${label}：${checked ? "已选择" : "未选择"}`)}
                disabled={busy || saving}
                onClick={() => setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(installation.target)) next.delete(installation.target);
                  else next.add(installation.target);
                  return next;
                })}
              >
                <span className="managed-skill-target-option-icon">{checked ? <Check size={15} /> : <Link2 size={15} />}</span>
                <span className="managed-skill-target-option-copy"><strong>{label}</strong><small>{status}</small></span>
              </button>
            );
          })}
        </div>

        {error ? <div className="managed-skill-dialog-error">{error}</div> : null}
        <footer className="managed-skill-dialog-actions">
          <span>{l(`${selected.size} agents selected`, `已选择 ${selected.size} 个 Agent`)}</span>
          <button type="button" onClick={onClose} disabled={saving}>{l("Cancel", "取消")}</button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy || saving || selected.size === 0}>
            {saving ? l("Installing…", "正在安装…") : l("Install", "安装")}
          </button>
        </footer>
      </section>
    </div>
  );
}
