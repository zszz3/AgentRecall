import type { ManagedSkill, SkillInstallTarget } from "../../../../core/managed-skill-library";

export interface BatchSkillTargetPlan {
  targets: SkillInstallTarget[];
  conflictTargets: SkillInstallTarget[];
  changed: boolean;
}

export function planBatchSkillTargetInstall(
  skill: ManagedSkill,
  requestedTargets: SkillInstallTarget[],
): BatchSkillTargetPlan {
  const requested = new Set(requestedTargets);
  const installed = new Set(skill.installations
    .filter((installation) => installation.state === "installed")
    .map((installation) => installation.target));
  const conflictTargets = skill.installations
    .filter((installation) => requested.has(installation.target) && installation.state === "conflict")
    .map((installation) => installation.target);
  const conflicts = new Set(conflictTargets);
  const targets = skill.installations
    .filter((installation) => installed.has(installation.target)
      || (requested.has(installation.target) && !conflicts.has(installation.target)))
    .map((installation) => installation.target);

  return {
    targets,
    conflictTargets,
    changed: targets.some((target) => !installed.has(target)),
  };
}
