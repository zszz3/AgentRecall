import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Beaker, Link2Off, Lock, RefreshCw, Settings2 } from "lucide-react";

import type { SkillTriggerLink } from "../../../../core/session-store";
import { formatRelativeTime } from "../../../../core/format-session";
import { localize, type LanguageMode } from "../../language";
import { EvaluationFeaturePage } from "../automation/evaluation-feature-page";

type EvalTab = "skills" | "experiments";

interface SkillTriggerGroup {
  key: string;
  skill: string;
  count: number;
  lastTriggeredAt: number;
  triggers: SkillTriggerLink[];
}

export function EvalPage({
  language,
  enabled,
  onOpenSettings,
  onOpenSession,
  onNavigationGuardChange,
}: {
  language: LanguageMode;
  enabled: boolean;
  onOpenSettings: () => void;
  onOpenSession: (sessionKey: string) => void;
  onNavigationGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [tab, setTab] = useState<EvalTab>("skills");
  const [triggers, setTriggers] = useState<SkillTriggerLink[] | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await window.sessionSearch.refreshSkillUsage();
      setTriggers(await window.sessionSearch.listSkillTriggers({ limit: 500 }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setTriggers(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const groups = useMemo(() => groupTriggers(triggers ?? []), [triggers]);
  const selected = groups.find((group) => group.key === selectedSkill) ?? groups[0] ?? null;

  return (
    <div className="eval-page">
      <header className="app-page-head">
        <div>
          <h2>Eval</h2>
          <p>{l(
            "Review how the assets you can change actually perform.",
            "回看你能改动的资产在真实使用中的表现。",
          )}</p>
        </div>
      </header>

      <nav className="eval-tabs" aria-label={l("Eval objects", "评测对象")}>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>
          {l("Skills", "Skills")}
        </button>
        <button className={tab === "experiments" ? "active" : ""} onClick={() => setTab("experiments")}>
          {l("Experiments", "实验")}
        </button>
        <button disabled title={l("Coming later", "后续开放")}>
          <Lock size={12} /> Workflows
        </button>
        <button disabled title={l("Coming later", "后续开放")}>
          <Lock size={12} /> Rules
        </button>
      </nav>

      {tab === "experiments" ? (
        <EvaluationFeaturePage language={language} onNavigationGuardChange={onNavigationGuardChange} />
      ) : !enabled ? (
        <section className="eval-disabled-state">
          <span><Beaker size={24} /></span>
          <h3>{l("Eval is off by default", "Eval 默认关闭")}</h3>
          <p>{l(
            "Enable it in Settings and install the usage hook, then new skill triggers link to their sessions.",
            "请先在设置中开启并安装使用统计 Hook，此后新的 Skill 触发会关联到对应会话。",
          )}</p>
          <button type="button" onClick={onOpenSettings}>
            <Settings2 size={15} />{l("Open Settings", "前往设置")}
          </button>
        </section>
      ) : (
        <div className="eval-skills-layout">
          <aside className="eval-skill-list">
            <header>
              <span>{l("Triggered skills", "有触发记录的 Skill")}</span>
              <button
                type="button"
                disabled={loading}
                onClick={() => void refresh()}
                aria-label={l("Refresh", "刷新")}
              >
                <RefreshCw size={14} className={loading ? "spinning" : undefined} />
              </button>
            </header>
            {triggers === null ? (
              <p className="eval-muted">{l("Loading...", "加载中...")}</p>
            ) : groups.length === 0 ? (
              <p className="eval-muted">{l(
                "No skill triggers recorded yet.",
                "还没有任何 Skill 触发记录。",
              )}</p>
            ) : (
              groups.map((group) => (
                <button
                  key={group.key}
                  className={`eval-skill-item ${selected?.key === group.key ? "active" : ""}`}
                  onClick={() => setSelectedSkill(group.key)}
                >
                  <span className="eval-skill-name">{group.skill}</span>
                  <span className="eval-skill-meta">
                    {l(`${group.count} triggers`, `${group.count} 次触发`)}
                    {" · "}
                    {formatRelativeTime(group.lastTriggeredAt)}
                  </span>
                </button>
              ))
            )}
          </aside>
          <section className="eval-trigger-panel">
            {error ? <p className="eval-error" role="alert">{error}</p> : null}
            {selected ? (
              <>
                <header>
                  <h3>{selected.skill}</h3>
                  <span className="eval-muted">{l("Recent triggers", "最近触发")}</span>
                </header>
                <ul className="eval-trigger-list">
                  {selected.triggers.slice(0, 50).map((trigger, index) => (
                    <li key={`${trigger.occurredAt}-${index}`}>
                      <span className="eval-trigger-time">{formatRelativeTime(trigger.occurredAt)}</span>
                      <span className="eval-trigger-agent">{trigger.agent}</span>
                      {trigger.sessionKey ? (
                        <button
                          type="button"
                          className="eval-trigger-session"
                          onClick={() => onOpenSession(trigger.sessionKey!)}
                        >
                          {trigger.sessionTitle || trigger.sessionKey}
                        </button>
                      ) : (
                        <span className="eval-trigger-unlinked">
                          <Link2Off size={12} />{l("Not linked", "未关联")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="eval-muted">{l(
                "Select a skill to review its triggers.",
                "选择一个 Skill 查看它的触发记录。",
              )}</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function groupTriggers(triggers: SkillTriggerLink[]): SkillTriggerGroup[] {
  const groups = new Map<string, SkillTriggerGroup>();
  for (const trigger of triggers) {
    const key = trigger.skill.trim().toLowerCase();
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.triggers.push(trigger);
      if (trigger.occurredAt > group.lastTriggeredAt) group.lastTriggeredAt = trigger.occurredAt;
    } else {
      groups.set(key, {
        key,
        skill: trigger.skill,
        count: 1,
        lastTriggeredAt: trigger.occurredAt,
        triggers: [trigger],
      });
    }
  }
  return [...groups.values()].sort((a, b) =>
    b.count - a.count || b.lastTriggeredAt - a.lastTriggeredAt || a.skill.localeCompare(b.skill));
}
