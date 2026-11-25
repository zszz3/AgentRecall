// Central registry of coding agents that AgentRecall manages Skills for.
//
// Adding a new agent that supports Skills is a single entry here: every
// install target, scan root, label, and sync scope derives from this table.
// Keep this as the single source of truth — do not hardcode agent names in
// mapping functions elsewhere.

/** Stable identifier of an agent AgentRecall can manage Skills for. */
export type SkillAgent = "codex" | "claude" | "antigravity" | "cursor" | "codebuddy" | "qoder" | "trae" | "pi";

/** An agent directory a managed Skill can be installed into. */
export type SkillInstallTarget =
  | "codex"
  | "codex-shared"
  | "claude"
  | "antigravity"
  | "cursor"
  | "codebuddy"
  | "qoder"
  | "trae"
  | "pi";

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
  | "antigravity-user"
  | "cursor-user"
  | "cursor-project"
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
  /** Agent home directory relative to user home used to detect whether the agent is installed. */
  detectDir: string | null;
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
    detectDir: ".codex",
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
    detectDir: ".claude",
    portableScope: "claude-user",
    hasSkillUsage: true,
    hasUserSource: true,
    hasProjectSource: true,
  },
  {
    id: "antigravity",
    installTarget: "antigravity",
    label: "Antigravity (agy)",
    skillDir: ".gemini/antigravity/skills",
    detectDir: ".gemini/antigravity",
    portableScope: null,
    hasSkillUsage: false,
    hasUserSource: true,
    hasProjectSource: false,
  },
  {
    id: "cursor",
    installTarget: "cursor",
    label: "Cursor",
    skillDir: ".cursor/skills",
    detectDir: ".cursor",
    portableScope: null,
    hasSkillUsage: false,
    hasUserSource: true,
    hasProjectSource: true,
  },
  {
    id: "codebuddy",
    installTarget: "codebuddy",
    label: "CodeBuddy",
    skillDir: ".codebuddy/skills",
    detectDir: ".codebuddy",
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
    detectDir: ".qoder",
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
    detectDir: ".trae",
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
    detectDir: ".pi",
    portableScope: null,
    hasSkillUsage: false,
    hasUserSource: true,
    hasProjectSource: false,
  },
];

export const SKILL_AGENTS: readonly SkillAgent[] = AGENT_SKILL_REGISTRY.map((entry) => entry.id);

export const SKILL_INSTALL_TARGETS: readonly SkillInstallTarget[] = AGENT_SKILL_REGISTRY
  .map((entry) => entry.installTarget)
  .filter((target): target is SkillInstallTarget => target !== null)
  .flatMap((target) => (target === "codex" ? [target, "codex-shared"] : [target]));

export function agentEntry(id: SkillAgent): AgentSkillRegistryEntry {
  const entry = AGENT_SKILL_REGISTRY.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown Skill agent: ${id}`);
  return entry;
}

export function agentLabel(id: SkillAgent): string {
  return agentEntry(id).label;
}

/** Maps a user-level Skill source to its corresponding managed installation target, or null for project/system/plugin copies. */
export function installTargetForSkillSource(source: SkillSource): SkillInstallTarget | null {
  if (source === "codex-shared") return "codex-shared";
  for (const entry of AGENT_SKILL_REGISTRY) {
    if (entry.installTarget && source === `${entry.id}-user`) return entry.installTarget;
  }
  return null;
}
