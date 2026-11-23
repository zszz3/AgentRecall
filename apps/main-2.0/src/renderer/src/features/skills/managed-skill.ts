import type { InstalledSkill } from "../../../../core/skill-manager";
import type { ManagedSkill } from "../../../../core/managed-skill-library";
import { isSkillCategoryId } from "../../../../core/skill-categories";

/** Whether a listed Skill lives in AgentRecall's own Skill library rather than only in an agent folder. */
export function isManagedSkill(skill: InstalledSkill): skill is ManagedSkill {
  if (skill.source !== "agent-recall-v2") return false;
  const candidate = skill as Partial<ManagedSkill>;
  return typeof candidate.managedId === "string"
    && Boolean(candidate.origin)
    && (candidate.categoryId === null || isSkillCategoryId(candidate.categoryId))
    && Array.isArray(candidate.installations);
}
