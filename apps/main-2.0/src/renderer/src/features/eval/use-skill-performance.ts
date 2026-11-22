import { useCallback, useEffect, useState } from "react";

import type { SkillTriggerLink } from "../../../../core/session-store";
import type { SkillFinding } from "../../../../core/skill-eval-findings";
import type { SkillEvalDetail, SkillEvalOverview, SkillEvalOverviewItem } from "../../../../main/services/skill-service";

export interface SkillPerformance {
  overview: SkillEvalOverview | null;
  skills: SkillEvalOverviewItem[];
  /** The chosen skill, or the first one until a choice matches a listed skill. */
  selected: SkillEvalOverviewItem | null;
  detail: SkillEvalDetail | null;
  triggers: SkillTriggerLink[] | null;
  findings: SkillFinding[] | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  selectSkill(skill: string): void;
}

/**
 * The Skill performance report of the Eval page.
 *
 * The page owns it rather than the Skill tab: the tab unmounts when another tab
 * opens, and returning to it keeps the selected skill without re-running the
 * usage refresh.
 */
export function useSkillPerformance({
  enabled,
  preselectedSkill,
  onPreselectedConsumed,
}: {
  enabled: boolean;
  preselectedSkill?: string | null;
  onPreselectedConsumed?: () => void;
}): SkillPerformance {
  const [overview, setOverview] = useState<SkillEvalOverview | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillEvalDetail | null>(null);
  const [triggers, setTriggers] = useState<SkillTriggerLink[] | null>(null);
  const [findings, setFindings] = useState<SkillFinding[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await window.sessionSearch.refreshSkillUsage();
      setOverview(await window.sessionSearch.getSkillEvalOverview());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setOverview(null);
      setDetail(null);
      setTriggers(null);
      setFindings(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const skills = overview?.skills ?? [];
  const selected = skills.find((item) => skillKey(item.skill) === selectedSkill) ?? skills[0] ?? null;

  useEffect(() => {
    if (!enabled || !selected) {
      setDetail(null);
      setTriggers(null);
      setFindings(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setTriggers(null);
    setFindings(null);
    void (async () => {
      try {
        const [nextDetail, nextTriggers, nextFindings] = await Promise.all([
          window.sessionSearch.getSkillEvalDetail(selected.skill),
          window.sessionSearch.listSkillTriggers({ skill: selected.skill, limit: 50 }),
          window.sessionSearch.getSkillEvalFindings(selected.skill),
        ]);
        if (cancelled) return;
        setDetail(nextDetail);
        setTriggers(nextTriggers);
        setFindings(nextFindings);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
    // selected object identity changes on every refresh; key on the name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, selected?.skill]);

  // Consume preselected skill from Skills page badge click.
  useEffect(() => {
    if (preselectedSkill) {
      setSelectedSkill(skillKey(preselectedSkill));
      onPreselectedConsumed?.();
    }
  }, [preselectedSkill, onPreselectedConsumed]);

  return {
    overview,
    skills,
    selected,
    detail,
    triggers,
    findings,
    loading,
    error,
    refresh,
    selectSkill: (skill) => setSelectedSkill(skillKey(skill)),
  };
}

export function skillKey(skill: string): string {
  return skill.trim().toLowerCase();
}
