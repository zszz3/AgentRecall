import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type SkillAgent = "codex" | "claude";
export type SkillSource = "codex-user" | "codex-system" | "codex-shared" | "claude-user" | "claude-project" | "claude-plugin";

export interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  agent: SkillAgent;
  source: SkillSource;
  path: string;
  directoryPath: string;
  rootPath: string;
  markdown: string;
  mtimeMs: number;
  // Populated from the skill-usage hook log; absent until usage is merged in.
  usageCount?: number;
  lastUsedAt?: number | null;
}

export interface SkillUsageSummary {
  // Whether the Claude Code PostToolUse hook is installed in ~/.claude/settings.json.
  hookInstalled: boolean;
  // Whether any usage source has produced records yet.
  logExists: boolean;
  totalEvents: number;
}

export interface SkillRootStatus {
  agent: SkillAgent;
  source: SkillSource;
  path: string;
  exists: boolean;
  skillCount: number;
}

export interface InstalledSkillsSnapshot {
  skills: InstalledSkill[];
  roots: SkillRootStatus[];
  scannedAt: number;
  usage?: SkillUsageSummary;
}

export interface SkillManagerOptions {
  homeDir?: string;
  codexHome?: string;
  projectDirs?: string[];
  claudePluginsDir?: string;
}

export interface DeleteInstalledSkillResult {
  deletedPath: string;
  skillName: string;
}

interface SkillRootConfig {
  agent: SkillAgent;
  source: SkillSource;
  path: string;
}

export function listInstalledSkills(options: SkillManagerOptions = {}): InstalledSkillsSnapshot {
  const homeDir = options.homeDir || os.homedir();
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(homeDir, ".codex");
  const projectDirs = dedupePaths(options.projectDirs ?? [process.cwd()]);
  const roots: SkillRootConfig[] = [
    { agent: "codex", source: "codex-user", path: path.join(codexHome, "skills") },
    { agent: "codex", source: "codex-system", path: path.join(codexHome, "skills", ".system") },
    { agent: "codex", source: "codex-shared", path: path.join(homeDir, ".agents", "skills") },
    { agent: "claude", source: "claude-user", path: path.join(homeDir, ".claude", "skills") },
    ...projectDirs.map((projectDir): SkillRootConfig => ({
      agent: "claude",
      source: "claude-project",
      path: path.join(projectDir, ".claude", "skills"),
    })),
  ];

  const skills: InstalledSkill[] = [];
  const rootStatuses: SkillRootStatus[] = [];
  for (const root of roots) {
    const rootSkills = readSkillsFromRoot(root);
    rootStatuses.push({
      agent: root.agent,
      source: root.source,
      path: root.path,
      exists: fs.existsSync(root.path),
      skillCount: rootSkills.length,
    });
    skills.push(...rootSkills);
  }

  const pluginsDir = options.claudePluginsDir || path.join(homeDir, ".claude", "plugins");
  const pluginRoots = collectClaudePluginRoots(pluginsDir);
  const pluginSkills: InstalledSkill[] = [];
  for (const root of pluginRoots) {
    pluginSkills.push(...readSkillsFromRoot(root));
  }
  rootStatuses.push({
    agent: "claude",
    source: "claude-plugin",
    path: pluginsDir,
    exists: fs.existsSync(path.join(pluginsDir, "installed_plugins.json")),
    skillCount: dedupeSkills(pluginSkills).length,
  });
  skills.push(...pluginSkills);

  return {
    skills: dedupeSkills(skills).sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.path.localeCompare(b.path)),
    roots: rootStatuses,
    scannedAt: Date.now(),
  };
}

export function deleteInstalledSkill(skillPath: string, options: SkillManagerOptions = {}): DeleteInstalledSkillResult {
  const normalizedSkillPath = normalizePathKey(skillPath);
  const skill = listInstalledSkills(options).skills.find((item) => normalizePathKey(item.path) === normalizedSkillPath);
  if (!skill) throw new Error("Skill is no longer installed or is outside managed roots.");
  if (skill.source === "codex-system") throw new Error("Codex system skills cannot be deleted from this app.");

  const directoryPath = normalizePathKey(skill.directoryPath);
  const rootPath = normalizePathKey(skill.rootPath);
  const relativeToRoot = path.relative(rootPath, directoryPath);
  if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error("Refusing to delete an unsafe skill directory.");
  }

  fs.rmSync(directoryPath, { recursive: true, force: false });
  return { deletedPath: directoryPath, skillName: skill.name };
}

function collectClaudePluginRoots(pluginsDir: string): SkillRootConfig[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(pluginsDir, "installed_plugins.json"), "utf8");
  } catch {
    return [];
  }

  let parsed: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const plugins = parsed.plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const roots: SkillRootConfig[] = [];
  for (const installs of Object.values(plugins)) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      const installPath = install?.installPath;
      if (typeof installPath !== "string" || !installPath) continue;
      roots.push({ agent: "claude", source: "claude-plugin", path: path.join(installPath, "skills") });
    }
  }
  return roots;
}

function readSkillsFromRoot(root: SkillRootConfig): InstalledSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root.path, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: InstalledSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".system") continue;
    const skillPath = path.join(root.path, entry.name, "SKILL.md");
    const skill = readSkillFile(skillPath, entry.name, root);
    if (skill) skills.push(skill);
  }
  return skills;
}

function readSkillFile(skillPath: string, fallbackName: string, root: SkillRootConfig): InstalledSkill | null {
  let markdown: string;
  let stat: fs.Stats;
  try {
    markdown = fs.readFileSync(skillPath, "utf8");
    stat = fs.statSync(skillPath);
  } catch {
    return null;
  }

  const metadata = parseFrontmatter(markdown);
  return {
    id: `${root.source}:${normalizePathKey(skillPath)}`,
    name: metadata.name || fallbackName,
    description: metadata.description,
    agent: root.agent,
    source: root.source,
    path: skillPath,
    directoryPath: path.dirname(skillPath),
    rootPath: root.path,
    markdown,
    mtimeMs: stat.mtimeMs,
  };
}

function parseFrontmatter(markdown: string): { name: string; description: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { name: "", description: "" };

  let name = "";
  let description = "";
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = stripYamlScalar(line.slice(separator + 1).trim());
    if (key === "name") name = value;
    else if (key === "description") description = value;
  }

  return { name, description };
}

function stripYamlScalar(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function dedupeSkills(skills: InstalledSkill[]): InstalledSkill[] {
  const byPath = new Map<string, InstalledSkill>();
  for (const skill of skills) {
    byPath.set(normalizePathKey(skill.path), skill);
  }
  return [...byPath.values()];
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const normalized = normalizePathKey(item);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item);
  }
  return result;
}

function normalizePathKey(filePath: string): string {
  return path.resolve(filePath);
}
