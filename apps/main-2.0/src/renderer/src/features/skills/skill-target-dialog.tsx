import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Check, Link2, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";
import { AGENT_SKILL_REGISTRY } from "../../../../core/agent-skill-registry";
import { localize, type LanguageMode } from "../../language";

export const TARGET_LABELS: Record<SkillInstallTarget, string> = Object.fromEntries([
  ...AGENT_SKILL_REGISTRY
    .filter((entry) => entry.installTarget !== null)
    .map((entry) => [entry.installTarget!, entry.label]),
  ["codex-shared", "Codex shared (~/.agents/skills)"],
]) as Record<SkillInstallTarget, string>;

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
  onSave: (targets: SkillInstallTarget[], forceTargets: SkillInstallTarget[]) => Promise<void>;
}): ReactElement | null {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [selected, setSelected] = useState<Set<SkillInstallTarget>>(() => new Set());
  const [forced, setForced] = useState<Set<SkillInstallTarget>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(skill.installations
      .filter((installation) => installation.state === "installed")
      .map((installation) => installation.target)));
    setForced(new Set());
    setSaving(false);
    setError(null);
  }, [open, skill]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const targets = skill.installations
        .filter((installation) => selected.has(installation.target) || forced.has(installation.target))
        .map((installation) => installation.target);
      const forceTargets = skill.installations
        .filter((installation) => forced.has(installation.target))
        .map((installation) => installation.target);
      await onSave(targets, forceTargets);
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
            <p>{l(
              "Select agents to install to. Conflicting paths require Force install, which replaces their existing contents and cannot be undone.",
              "选择要安装的 Agent。路径冲突需单独选择“强制安装”；现有内容将被替换且无法撤销。",
            )}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}><X size={16} /></button>
        </header>

        <div className="managed-skill-target-options">
          {skill.installations.map((installation) => {
            const checked = selected.has(installation.target);
            const conflict = installation.state === "conflict";
            const forceChecked = forced.has(installation.target);
            const label = TARGET_LABELS[installation.target];
            return (
              <button
                key={installation.target}
                type="button"
                className={conflict
                  ? `conflict${forceChecked ? " force-selected" : ""}`
                  : checked ? "selected" : ""}
                role={conflict ? undefined : "checkbox"}
                aria-checked={conflict ? undefined : checked}
                aria-pressed={conflict ? forceChecked : undefined}
                aria-label={conflict
                  ? forceChecked
                    ? l(`${label}: Force install selected. Activate to cancel it.`, `${label}：已选择强制安装。再次按下可取消。`)
                    : l(`${label}: Path conflict. Force install replaces existing contents and cannot be undone.`, `${label}：路径冲突。强制安装会替换现有内容且无法撤销。`)
                  : l(`${label}: ${checked ? "Selected" : "Not selected"}`, `${label}：${checked ? "已选择" : "未选择"}`)}
                disabled={busy || saving}
                title={conflict
                  ? forceChecked
                    ? l(`Cancel Force install for ${label}; existing contents will remain unchanged.`, `取消对 ${label} 的强制安装；现有内容将保持不变。`)
                    : l(`Force install to ${label}; existing contents will be replaced and cannot be restored.`, `强制安装到 ${label}；现有内容将被替换且无法恢复。`)
                  : installation.path}
                onClick={() => {
                  if (conflict) {
                    setForced((current) => {
                      const next = new Set(current);
                      if (next.has(installation.target)) next.delete(installation.target);
                      else next.add(installation.target);
                      return next;
                    });
                    return;
                  }
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(installation.target)) next.delete(installation.target);
                    else next.add(installation.target);
                    return next;
                  });
                }}
              >
                <span className="managed-skill-target-option-icon">
                  {conflict
                    ? forceChecked ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />
                    : checked ? <Check size={15} /> : <Link2 size={15} />}
                </span>
                <span className="managed-skill-target-option-copy">
                  <strong>{label}</strong>
                  <small>{conflict
                    ? forceChecked
                      ? l("Existing contents will be replaced", "将替换现有内容")
                      : l("Path conflict", "路径冲突")
                    : checked ? l("Selected", "已选择") : l("Not selected", "未选择")}</small>
                </span>
                {conflict ? (
                  <span className="managed-skill-target-force-action" aria-hidden="true">
                    {forceChecked ? l("Cancel force", "取消强制") : l("Force install", "强制安装")}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {error ? <div className="managed-skill-dialog-error">{error}</div> : null}
        <footer className="managed-skill-dialog-actions">
          <span>{forced.size > 0
            ? l(
              `${selected.size} regular · ${forced.size} force ${forced.size === 1 ? "install" : "installs"}`,
              `普通安装 ${selected.size} 个 · 强制安装 ${forced.size} 个`,
            )
            : l(`${selected.size} agents selected`, `已选择 ${selected.size} 个 Agent`)}</span>
          <button type="button" onClick={onClose} disabled={saving}>{l("Cancel", "取消")}</button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy || saving}>
            {saving ? l("Saving…", "正在保存…") : l("Save", "保存")}
          </button>
        </footer>
      </section>
    </div>
  );
}
