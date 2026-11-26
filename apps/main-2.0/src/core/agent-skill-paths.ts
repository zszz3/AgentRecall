import * as fs from "node:fs";
import * as path from "node:path";

import {
  AGENT_SKILL_REGISTRY,
  agentEntry,
  type SkillAgent,
  type SkillInstallTarget,
} from "./agent-skill-registry";

/** Node-only path helpers for the browser-safe Skill registry. */
export function agentSkillDir(id: SkillAgent, homeDir: string): string | null {
  const dir = agentEntry(id).skillDir;
  return dir ? path.join(homeDir, dir) : null;
}

export function agentInstallTargetDir(target: SkillInstallTarget, homeDir: string, codexHome?: string): string {
  if (target === "codex") return path.join(codexHome ?? path.join(homeDir, ".codex"), "skills");
  if (target === "codex-shared") return path.join(homeDir, ".agents", "skills");
  const entry = AGENT_SKILL_REGISTRY.find((candidate) => candidate.installTarget === target);
  if (!entry?.skillDir) throw new Error(`Unknown install target: ${target}`);
  return path.join(homeDir, entry.skillDir);
}

/** Whether the coding agent owning `target` appears to be present on this machine. */
export function isAgentTargetDetected(target: SkillInstallTarget, homeDir: string, codexHome?: string): boolean {
  if (target === "codex") return fs.existsSync(codexHome ?? path.join(homeDir, ".codex"));
  if (target === "codex-shared") {
    return fs.existsSync(path.join(homeDir, ".agents"))
      || fs.existsSync(codexHome ?? path.join(homeDir, ".codex"))
      || fs.existsSync(path.join(homeDir, ".gemini", "antigravity"));
  }
  const entry = AGENT_SKILL_REGISTRY.find((candidate) => candidate.installTarget === target);
  if (!entry?.detectDir) return false;
  return fs.existsSync(path.join(homeDir, entry.detectDir));
}
