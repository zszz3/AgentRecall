// Central registry of coding agents that AgentRecall manages Skills for.
//
// Adding a new agent that supports Skills is a single entry here: every
// install target, scan root, label, and sync scope derives from this table.
// Keep this as the single source of truth — do not hardcode agent names in
// mapping functions elsewhere.

import * as path from "node:path";

/** Stable identifier of an agent AgentRecall can manage Skills for. */
export type SkillAgent = "codex" | "claude" | "codebuddy" | "qoder" | "trae" | "pi";

/** An agent directory a managed Skill can be installed into. */
export type SkillInstallTarget = "codex" | "claude" | "codebuddy" | "qoder" | "trae" | "pi";

/** Portability scope used by cross-device Skill sync. */
export type SkillPortableScope = "agent-recall-v2" | "codex-user" | "claude-user" | "qoder-user" | "shared";

export type SkillSource =
  | "agent-recall-v2"
  | "codex-user"
  | "codex-system"
  | "codex-shared"
  | "codex-project"
  | "claude-user"
  | "claude-project"
  | "claude-plugin"
  | "codebuddy-user"
  | "codebuddy-project"
  | "qoder-user"
  | "qoder-project"
  | "trae-user"
  | "trae-project"
  | "pi-user"
  | "pi-project";

export interface AgentSkillRegistryEntry {
  id: SkillAgent;
  /** Install-target key; null when this agent is not an install target. */
  installTarget: SkillInstallTarget | null;
  /** User-visible agent name. */
  label: string;
  /** Skills directory relative to the user home. */
  skillDir: string | null;
  /** Portable sync scope; null when Skills are not syncable. */
  portableScope: SkillPortableScope | null;
  /** Whether skill usage tracking supports this agent. */
  hasSkillUsage: boolean;
  /** Whether this agent has a user-level scan source (e.g. codex-user). */
  hasUserSource: boolean;
  /** Whether this agent has a project-level scan source (e.g. codex-project). */
  hasProjectSource: boolean;
}

export const AGENT_SKILL_REGISTRY: readonly AgentSkillRegistryEntry[] = [
  {
    id: "codex",
    installTarget: "codex",
    label: "Codex",
    skillDir: ".codex/skills",
    portableScope: "codex-user",
    hasSkillUsage: true,
    hasUserSource: true,
    hasProjectSource: true,
  },
  {
    id: "claude",
    installTarget: "claude",
    label: "Claude Code",
    skillDir: ".claude/skills",
    portableScope: "claude-user",
    hasSkillUsage: true,
    hasUserSource: true,
    hasProjectSource: true,
  },
  {
    id: "codebuddy",
    installTarget: "codebuddy",
    label: "CodeBuddy",
    skillDir: ".codebuddy/skills",
    portableScope: null,
    hasSkillUsage: false,
    hasUserSource: true,
    hasProjectSource: true,
  },
  {
    id: "qoder",
    installTarget: "qoder",
    label: "Qoder",
    skillDir: ".qoder/skills",
    portableScope: "qoder-user",
    hasSkillUsage: true,
    hasUserSource: true,
    hasProjectSource: true,
  },
  {
    id: "trae",
    installTarget: "trae",
    label: "Trae",
    skillDir: ".trae/skills",
    portableScope: null,
    hasSkillUsage: false,
    hasUserSource: true,
    hasProjectSource: true,
  },
  {
    id: "pi",
    installTarget: "pi",
    label: "Pi",
    skillDir: ".pi/agent/skills",
    portableScope: null,
    hasSkillUsage: false,
    hasUserSource: true,
    hasProjectSource: false,
  },
];

export const SKILL_AGENTS: readonly SkillAgent[] = AGENT_SKILL_REGISTRY.map((entry) => entry.id);

export const SKILL_INSTALL_TARGETS: readonly SkillInstallTarget[] = AGENT_SKILL_REGISTRY
  .map((entry) => entry.installTarget)
  .filter((target): target is SkillInstallTarget => target !== null);

export function agentEntry(id: SkillAgent): AgentSkillRegistryEntry {
  const entry = AGENT_SKILL_REGISTRY.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown Skill agent: ${id}`);
  return entry;
}

export function agentLabel(id: SkillAgent): string {
  return agentEntry(id).label;
}

/** Absolute path to an agent's Skills directory; null when not supported. */
export function agentSkillDir(id: SkillAgent, homeDir: string): string | null {
  const dir = agentEntry(id).skillDir;
  return dir ? path.join(homeDir, dir) : null;
}

export function agentInstallTargetDir(target: SkillInstallTarget, homeDir: string, codexHome?: string): string {
  if (target === "codex") return path.join(codexHome ?? path.join(homeDir, ".codex"), "skills");
  const entry = AGENT_SKILL_REGISTRY.find((candidate) => candidate.installTarget === target);
  if (!entry?.skillDir) throw new Error(`Unknown install target: ${target}`);
  return path.join(homeDir, entry.skillDir);
}
