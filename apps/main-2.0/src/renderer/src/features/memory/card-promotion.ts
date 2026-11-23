import type { MemoryCard } from "../../../../shared/ipc/experience-cards";
import type { LibrarySkillDraft } from "../../../../shared/ipc/skills";

type Localize = (en: string, zh: string) => string;

/**
 * A Skill draft the member reviews before it is written into the Skill library. The project path is left out
 * because a Skill can be shared with a team, where a local path means nothing and reveals the member's folders.
 */
export function cardSkill(card: MemoryCard, l: Localize): LibrarySkillDraft {
  const failed = card.failedAttempts.length > 0
    ? `\n\n## ${l("Did not work", "试过无效")}\n\n${card.failedAttempts.map((attempt) => `- ${attempt}`).join("\n")}`
    : "";
  return { id: skillId(card), description: card.problem.replace(/\s+/g, " ").trim().slice(0, 200), body: `# ${card.problem}\n\n${card.solution}${failed}` };
}

function skillId(card: MemoryCard): string {
  for (const text of [card.keywords.slice(0, 3).join(" "), card.problem]) {
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
    if (slug) return slug;
  }
  return `experience-${card.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "card"}`;
}
