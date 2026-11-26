import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Check, Plus, X } from "lucide-react";
import type { SkillInstallTarget } from "../../../../core/managed-skill-library";
import { localize, type LanguageMode } from "../../language";
import { Button } from "../../ui/primitives";

const DEFAULT_BODY_ZH = `# 使用时机

描述在什么场景下应该触发这个 Skill。

# 执行步骤

1. 先检查当前上下文与约束。
2. 按约定的检查清单完成操作。
3. 验证输出并总结结果。`;

const DEFAULT_BODY_EN = `# When to use

Describe the scenarios where this Skill should apply.

# Steps

1. Inspect the current context and constraints.
2. Follow the checklist carefully.
3. Verify the outcome before finishing.`;

export function SkillCreateDialog({
  open,
  language,
  availableTargets,
  targetLabels,
  onClose,
  onCreated,
}: {
  open: boolean;
  language: LanguageMode;
  availableTargets: SkillInstallTarget[];
  targetLabels: Record<SkillInstallTarget, string>;
  onClose: () => void;
  onCreated: (managedId: string, installedTargets: SkillInstallTarget[]) => void;
}): ReactElement | null {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(language === "zh" ? DEFAULT_BODY_ZH : DEFAULT_BODY_EN);
  const [targets, setTargets] = useState<SkillInstallTarget[]>(() => availableTargets.slice(0, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setId("");
    setDescription("");
    setBody(language === "zh" ? DEFAULT_BODY_ZH : DEFAULT_BODY_EN);
    setTargets(availableTargets.slice(0, 2));
    setSaving(false);
    setError(null);
  }, [open, language, availableTargets]);

  if (!open) return null;

  const normalizedId = id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const validId = /^[a-z0-9][a-z0-9._-]*$/.test(normalizedId);

  const toggleTarget = (target: SkillInstallTarget) => {
    setTargets((current) =>
      current.includes(target) ? current.filter((item) => item !== target) : [...current, target],
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validId) {
      setError(l("Use lowercase letters, numbers, hyphens, dots or underscores for the Skill ID.", "Skill ID 需使用小写字母、数字、短横线、点或下划线。"));
      return;
    }
    if (!description.trim() || !body.trim()) {
      setError(l("Fill in both description and instructions.", "请填写简介和指令正文。"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await window.sessionSearch.createLibrarySkill({
        id: normalizedId,
        description: description.trim(),
        body: body.trim(),
        originLabel: l("Created locally", "本机创建"),
      });
      if (result.status === "conflict") {
        setError(l(`A different Skill named “${normalizedId}” already exists.`, `已存在同名的其他 Skill「${normalizedId}」，请换一个 ID。`));
        return;
      }
      let installed: SkillInstallTarget[] = [];
      if (targets.length > 0 && window.sessionSearch.updateManagedSkillTargets) {
        try {
          await window.sessionSearch.updateManagedSkillTargets(result.managedId, targets, []);
          installed = targets;
        } catch {
          // Creation succeeded; target conflicts can be resolved inline on the detail page.
        }
      }
      onCreated(result.managedId, installed);
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
        className="command-dialog skill-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-create-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="managed-skill-dialog-head">
          <div>
            <h3 id="skill-create-dialog-title">{l("New Skill", "新建 Skill")}</h3>
            <p>{l("Create a reusable SKILL.md and enable it across your coding agents immediately.", "创建一个可复用的 SKILL.md，并立即分发到你选中的 Coding Agent。")}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={16} />
          </button>
        </header>

        <form className="skill-create-form" onSubmit={(event) => void submit(event)}>
          {error ? <div className="managed-skill-dialog-error">{error}</div> : null}

          <label className="skill-create-field">
            <span>{l("Skill ID", "Skill 标识")}</span>
            <input
              required
              autoFocus
              value={id}
              disabled={saving}
              placeholder="e.g. pr-review-checklist"
              onChange={(event) => setId(event.currentTarget.value)}
            />
            {id.trim() && normalizedId !== id.trim() ? (
              <small>{l(`Saved as: ${normalizedId}`, `将保存为：${normalizedId}`)}</small>
            ) : null}
          </label>

          <label className="skill-create-field">
            <span>{l("Description", "一句话简介")}</span>
            <input
              required
              value={description}
              disabled={saving}
              placeholder={l("When should the agent trigger this Skill?", "简述适用场景，帮助 Agent 判断何时触发")}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>

          <label className="skill-create-field">
            <span>{l("SKILL.md Instructions", "SKILL.md 指令内容")}</span>
            <textarea
              required
              rows={9}
              value={body}
              disabled={saving}
              onChange={(event) => setBody(event.currentTarget.value)}
            />
          </label>

          {availableTargets.length > 0 ? (
            <div className="skill-create-targets">
              <span>{l("Install immediately to", "创建后立即启用到")}</span>
              <div className="skill-discovery-target-chips">
                {availableTargets.map((target) => {
                  const active = targets.includes(target);
                  return (
                    <button
                      key={target}
                      type="button"
                      className={`skill-agent-pill skill-agent-pill-compact${active ? " is-installed" : ""}`}
                      aria-pressed={active}
                      disabled={saving}
                      onClick={() => toggleTarget(target)}
                    >
                      {active ? <Check size={11} /> : <Plus size={11} />}
                      <span>{targetLabels[target]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <footer className="skill-create-footer">
            <Button size="sm" onClick={onClose} disabled={saving}>{l("Cancel", "取消")}</Button>
            <Button size="sm" variant="primary" type="submit" disabled={saving || !validId || !description.trim()}>
              {saving ? l("Creating…", "正在创建…") : l("Create Skill", "创建 Skill")}
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}
