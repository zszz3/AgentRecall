import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Check, Link2, ShieldAlert, X } from "lucide-react";
import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";
import { AGENT_SKILL_REGISTRY } from "../../../../core/agent-skill-registry";
import { localize, type LanguageMode } from "../../language";

const TARGET_LABELS: Record<SkillInstallTarget, string> = Object.fromEntries(
  AGENT_SKILL_REGISTRY
    .filter((entry) => entry.installTarget !== null)
    .map((entry) => [entry.installTarget!, entry.label]),
) as Record<SkillInstallTarget, string>;

export function SkillTargetDialog({
  open,
  skill,
  busy,
  language,
  onClose,
  onSave,
}: {
  open: boolean;
  skill: ManagedSkill;
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
    setSelected(new Set(skill.installations
      .filter((installation) => installation.state === "installed")
      .map((installation) => installation.target)));
    setSaving(false);
    setError(null);
  }, [open, skill]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave([...selected]);
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
        aria-labelledby="skill-target-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="managed-skill-dialog-head">
          <div>
            <h3 id="skill-target-dialog-title">{l("Install Skill", "安装 Skill")}</h3>
            <p>{l("Select agents to install to. A path already occupied by another Skill will be overwritten when selected.", "选择要安装的 Agent。若该位置已存在同名 Skill，勾选后将被覆盖。")}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}><X size={16} /></button>
        </header>

        <div className="managed-skill-target-options">
          {skill.installations.map((installation) => {
            const checked = selected.has(installation.target);
            const conflict = installation.state === "conflict";
            const label = TARGET_LABELS[installation.target];
            return (
              <button
                key={installation.target}
                type="button"
                className={`${checked ? "selected" : ""} ${conflict ? "conflict" : ""}`}
                role="checkbox"
                aria-checked={checked}
                disabled={busy || saving}
                title={conflict
                  ? l(`Overwrite the existing ${label} Skill at this path.`, `覆盖 ${label} 中已有的同名 Skill。`)
                  : installation.path}
                onClick={() => setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(installation.target)) next.delete(installation.target);
                  else next.add(installation.target);
                  return next;
                })}
              >
                <span className="managed-skill-target-option-icon">
                  {checked ? <Check size={15} /> : conflict ? <ShieldAlert size={15} /> : <Link2 size={15} />}
                </span>
                <span>
                  <strong>{label}</strong>
                  <small>{checked ? l("Selected", "已选择") : conflict ? l("Path conflict", "路径冲突") : l("Not selected", "未选择")}</small>
                </span>
              </button>
            );
          })}
        </div>

        {error ? <div className="managed-skill-dialog-error">{error}</div> : null}
        <footer className="managed-skill-dialog-actions">
          <span>{l(`${selected.size} agents selected`, `已选择 ${selected.size} 个 Agent`)}</span>
          <button type="button" onClick={onClose} disabled={saving}>{l("Cancel", "取消")}</button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy || saving}>
            {saving ? l("Saving…", "正在保存…") : l("Save", "保存")}
          </button>
        </footer>
      </section>
    </div>
  );
}
