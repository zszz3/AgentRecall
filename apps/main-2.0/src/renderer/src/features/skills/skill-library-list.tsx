import { useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { ManagedSkill, ManagedSkillOriginKind, ManagedSkillTargetState } from "../../../../core/managed-skill-library";
import type { RemoteSkillGroup } from "../../../../core/skill-sync";
import { formatCompactNumber } from "../../format-count";
import { localize, type LanguageMode } from "../../language";
import { TARGET_LABELS } from "./skill-target-dialog";

export type ManagedSkillOriginFilter = "all" | ManagedSkillOriginKind;
export type ManagedSkillSort = "usage" | "name" | "updated";

export function filterManagedSkills(
  skills: ManagedSkill[],
  query: string,
  originFilter: ManagedSkillOriginFilter,
  sort: ManagedSkillSort,
): ManagedSkill[] {
  const normalizedQuery = query.trim().toLowerCase();
  return skills
    .filter((skill) => {
      if (originFilter !== "all" && skill.origin.kind !== originFilter) return false;
      if (!normalizedQuery) return true;
      return [skill.name, skill.description, skill.origin.label, skill.origin.source ?? ""]
        .join("\n")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name) || left.managedId.localeCompare(right.managedId);
      if (sort === "updated") return right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name);
      return (right.usageCount ?? 0) - (left.usageCount ?? 0)
        || (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0)
        || left.name.localeCompare(right.name);
    });
}

export function SkillLibraryList({
  skills,
  selectedId,
  selectedIds,
  query,
  originFilter,
  sort,
  loading,
  language,
  onQueryChange,
  onOriginFilterChange,
  onSortChange,
  onSelect,
  onToggleChecked,
  remoteOnlyGroups,
  selectedRemoteFingerprint,
  onSelectRemote,
  evalBadgeCounts,
  onNavigateToEval,
}: {
  skills: ManagedSkill[];
  selectedId: string | null;
  selectedIds: Set<string>;
  query: string;
  originFilter: ManagedSkillOriginFilter;
  sort: ManagedSkillSort;
  loading: boolean;
  language: LanguageMode;
  onQueryChange: (query: string) => void;
  onOriginFilterChange: (filter: ManagedSkillOriginFilter) => void;
  onSortChange: (sort: ManagedSkillSort) => void;
  onSelect: (managedId: string) => void;
  onToggleChecked: (managedId: string) => void;
  remoteOnlyGroups: RemoteSkillGroup[];
  selectedRemoteFingerprint: string | null;
  onSelectRemote: (fingerprint: string) => void;
  evalBadgeCounts?: Map<string, { low: number; medium: number }>;
  onNavigateToEval?: (skillName: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<ManagedSkillOriginKind>>(() => new Set());
  const toggleGroup = (kind: ManagedSkillOriginKind) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };
  const groups = useMemo(() => {
    const byKind = new Map<ManagedSkillOriginKind, ManagedSkill[]>();
    for (const skill of skills) {
      const group = byKind.get(skill.origin.kind) ?? [];
      group.push(skill);
      byKind.set(skill.origin.kind, group);
    }
    return [...byKind.entries()]
      .sort((left, right) => originGroupOrder(left[0]) - originGroupOrder(right[0]))
      .map(([kind, groupSkills]) => ({ kind, skills: groupSkills }));
  }, [skills]);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (skills.length === 0) return;
    const current = Math.max(0, skills.findIndex((skill) => skill.managedId === selectedId));
    let next: number;
    if (event.key === "ArrowDown") next = Math.min(skills.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = skills.length - 1;
    else return;
    event.preventDefault();
    onSelect(skills[next].managedId);
  };

  return (
    <aside className="skill-library-list" onKeyDown={handleKeyDown}>
      <div className="skill-library-list-tools">
        <label className="skill-library-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={l("Search managed Skills", "搜索 Skill 库")}
            aria-label={l("Search managed Skills", "搜索 Skill 库")}
          />
        </label>
        <div className="skill-library-filter-row">
          <select
            value={originFilter}
            onChange={(event) => onOriginFilterChange(event.currentTarget.value as ManagedSkillOriginFilter)}
            aria-label={l("Filter by origin", "按来源筛选")}
          >
            <option value="all">{l("All origins", "全部来源")}</option>
            <option value="builtin">{l("Built-in", "内置")}</option>
            <option value="local">{l("Local import", "本机导入")}</option>
            <option value="skills-sh">skills.sh</option>
            <option value="remote">{l("Cloud sync", "云端同步")}</option>
          </select>
          <select
            value={sort}
            onChange={(event) => onSortChange(event.currentTarget.value as ManagedSkillSort)}
            aria-label={l("Sort Skills", "排序 Skill")}
          >
            <option value="usage">{l("Most used", "最常使用")}</option>
            <option value="updated">{l("Recently updated", "最近更新")}</option>
            <option value="name">{l("Name", "名称")}</option>
          </select>
        </div>
      </div>

      <div className="skill-library-scroll" role="listbox" aria-label={l("Managed Skill library", "托管 Skill 库")}>
        {loading && skills.length === 0 ? (
          <div className="skill-library-skeletons" role="presentation" aria-busy="true" aria-label={l("Loading Skills…", "正在加载 Skill…")}>
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="skill-row-skeleton"><span /><span /></div>
            ))}
          </div>
        ) : null}
        {!loading && skills.length === 0 && remoteOnlyGroups.length === 0 ? (
          <div className="skill-library-empty">
            <strong>{l("No managed Skills", "Skill 库还是空的")}</strong>
            <span>{l("Import an existing Skill or discover one from skills.sh.", "可以导入本机已有 Skill，或从 skills.sh 发现新 Skill。")}</span>
          </div>
        ) : null}
        {groups.map((group) => {
          const collapsed = collapsedGroups.has(group.kind);
          return (
            <section key={group.kind} className="skill-library-group">
              <button
                type="button"
                className="skill-library-group-header"
                aria-expanded={!collapsed}
                onClick={() => toggleGroup(group.kind)}
              >
                {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span>{groupLabel(group.kind, language)}</span>
                <small>{formatCompactNumber(group.skills.length)}</small>
              </button>
              {!collapsed ? group.skills.map((skill) => {
                const active = skill.managedId === selectedId;
                const checked = selectedIds.has(skill.managedId);
                return (
                  <div
                    key={skill.managedId}
                    className={`skill-library-row ${active ? "active" : ""}`}
                    role="option"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => onSelect(skill.managedId)}
                  >
                    <button
                      type="button"
                      className={`skill-library-check ${checked ? "checked" : ""}`}
                      aria-label={l(`Select ${skill.name}`, `选择 ${skill.name}`)}
                      aria-pressed={checked}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleChecked(skill.managedId);
                      }}
                    >
                      {checked ? <Check size={11} /> : null}
                    </button>
                    <div className="skill-library-row-copy">
                      <div className="skill-library-row-title">
                        <strong title={skill.name}>{skill.name}</strong>
                        <span>{originLabel(skill, language)}</span>
                      </div>
                      <div className="skill-library-row-meta">
                        <span>{l(`Used ${formatCompactNumber(skill.usageCount ?? 0)} times`, `使用 ${formatCompactNumber(skill.usageCount ?? 0)} 次`)}</span>
                        {evalBadgeCounts && onNavigateToEval ? (() => {
                          const badge = evalBadgeCounts.get(skill.name.trim().toLowerCase());
                          if (!badge) return null;
                          const total = badge.low + badge.medium;
                          if (total === 0) return null;
                          return (
                            <button
                              type="button"
                              className="skill-eval-badge-link"
                              aria-label={l(`View ${total} findings in Eval`, `在 Eval 中查看 ${total} 条诊断`)}
                              onClick={(event) => {
                                event.stopPropagation();
                                onNavigateToEval(skill.name);
                              }}
                            >
                              {badge.medium > 0 ? `⚠ ${badge.medium}` : `· ${badge.low}`}
                            </button>
                          );
                        })() : null}
                        <span className="skill-target-dots" aria-label={l("Installation targets", "安装目标")}>
                          {skill.installations.map((installation) => (
                            <i key={installation.target} className={installation.state} title={`${TARGET_LABELS[installation.target] ?? installation.target}: ${installStateLabel(installation.state, language)}`} />
                          ))}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              }) : null}
            </section>
          );
        })}
        {remoteOnlyGroups.length > 0 ? (
          <section className="skill-library-group cloud-only-skill-group">
            <div className="skill-library-group-header cloud-only-skill-group-header">
              <span aria-hidden="true" />
              <span>{l("Cloud only", "仅云端")}</span>
              <small>{formatCompactNumber(remoteOnlyGroups.length)}</small>
            </div>
            {remoteOnlyGroups.map((group) => {
              const active = group.fingerprint === selectedRemoteFingerprint;
              return (
                <div
                  key={group.fingerprint}
                  className={`skill-library-row cloud-only-skill-row ${active ? "active" : ""}`}
                  role="option"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onSelectRemote(group.fingerprint)}
                >
                  <span className="cloud-only-skill-icon" aria-hidden="true">☁</span>
                  <div className="skill-library-row-copy">
                    <div className="skill-library-row-title">
                      <strong title={group.name}>{group.name}</strong>
                      <span>v{group.latest.version}</span>
                    </div>
                    <div className="skill-library-row-meta">
                      <span>{l("Cloud version available", "云端已有版本")}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

export function originLabel(skill: ManagedSkill, language: LanguageMode): string {
  if (skill.origin.kind === "builtin") return localize(language, "Built-in", "内置");
  if (skill.origin.kind === "skills-sh") return "skills.sh";
  if (skill.origin.kind === "remote") return localize(language, "Cloud", "云端");
  return skill.origin.label || localize(language, "Local", "本机");
}

export function groupLabel(kind: ManagedSkillOriginKind, language: LanguageMode): string {
  if (kind === "builtin") return localize(language, "Built-in", "内置");
  if (kind === "skills-sh") return "skills.sh";
  if (kind === "remote") return localize(language, "Cloud", "云端");
  return localize(language, "Local", "本机");
}

export function originGroupOrder(kind: ManagedSkillOriginKind): number {
  if (kind === "builtin") return 0;
  if (kind === "skills-sh") return 1;
  if (kind === "remote") return 2;
  return 3;
}

function installStateLabel(state: ManagedSkillTargetState, language: LanguageMode): string {
  if (state === "installed") return localize(language, "Installed", "已安装");
  if (state === "conflict") return localize(language, "Conflict", "冲突");
  return localize(language, "Not installed", "未安装");
}
