import type { InstalledSkill, SkillSource } from "../../core/skill-manager";

export type SkillSourceFilter = "all" | "codex" | "claude" | "shared" | "project";
export type SkillSortKey = "usage" | "usage-asc" | "name" | "updated";

export function filterInstalledSkills(skills: InstalledSkill[], query: string, sourceFilter: SkillSourceFilter): InstalledSkill[] {
  const normalizedQuery = query.trim().toLowerCase();
  return skills.filter((skill) => matchesSourceFilter(skill, sourceFilter) && matchesSkillQuery(skill, normalizedQuery));
}

export function sortInstalledSkills(skills: InstalledSkill[], sortKey: SkillSortKey): InstalledSkill[] {
  const sorted = [...skills];
  if (sortKey === "name") {
    sorted.sort((a, b) => byName(a, b));
  } else if (sortKey === "updated") {
    sorted.sort((a, b) => b.mtimeMs - a.mtimeMs || byName(a, b));
  } else if (sortKey === "usage-asc") {
    sorted.sort((a, b) => (a.usageCount ?? 0) - (b.usageCount ?? 0) || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0) || byName(a, b));
  } else {
    // Most-used first; skills never used fall back to alphabetical order.
    sorted.sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || byName(a, b));
  }
  return sorted;
}

function byName(a: InstalledSkill, b: InstalledSkill): number {
  return a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.path.localeCompare(b.path);
}

export function skillSourceLabel(source: SkillSource): string {
  if (source === "codex-user") return "Codex";
  if (source === "codex-system") return "Codex System";
  if (source === "codex-shared") return "Shared";
  if (source === "claude-project") return "Project";
  if (source === "claude-plugin") return "Claude Plugin";
  return "Claude Code";
}

function matchesSourceFilter(skill: InstalledSkill, sourceFilter: SkillSourceFilter): boolean {
  if (sourceFilter === "all") return true;
  if (sourceFilter === "codex") return skill.agent === "codex";
  if (sourceFilter === "claude") return skill.agent === "claude";
  if (sourceFilter === "shared") return skill.source === "codex-shared";
  return skill.source === "claude-project";
}

function matchesSkillQuery(skill: InstalledSkill, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return [skill.name, skill.description, skill.path, skillSourceLabel(skill.source)].join("\n").toLowerCase().includes(normalizedQuery);
}
