import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RemoteSkill } from "./skill-sync";

export type SkillAgent = "codex" | "claude";
export type SkillSource =
  | "codex-user"
  | "codex-system"
  | "codex-shared"
  | "codex-project"
  | "claude-user"
  | "claude-project"
  | "claude-plugin";

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

export interface SkillProjectSource {
  path: string;
  environmentId: string;
}

export interface DeleteInstalledSkillResult {
  deletedPath: string;
  skillName: string;
}

export interface InstallRemoteSkillOptions {
  homeDir?: string;
  codexHome?: string;
}

export interface InstallRemoteSkillResult {
  installedPath: string;
  directoryPath: string;
  overwritten: boolean;
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
      agent: "codex",
      source: "codex-project",
      path: path.join(projectDir, ".codex", "skills"),
    })),
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
    exists: fs.existsSync(pluginsDir),
    skillCount: dedupeSkills(pluginSkills).length,
  });
  skills.push(...pluginSkills);

  return {
    skills: dedupeSkills(skills).sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.path.localeCompare(b.path)),
    roots: rootStatuses,
    scannedAt: Date.now(),
  };
}

export function skillProjectDirsFromIndexedProjects(projects: SkillProjectSource[], fallbackDirs: string[] = [process.cwd()], homeDir = os.homedir()): string[] {
  const localProjectDirs = projects
    .filter((project) => project.environmentId === "local")
    .map((project) => project.path)
    .filter((projectPath) => projectPath.trim() !== "" && isCandidateProjectDir(projectPath, homeDir));
  return dedupePaths([
    ...fallbackDirs,
    ...localProjectDirs,
    ...discoverAncestorSkillProjectDirs(localProjectDirs),
    ...discoverNestedSkillProjectDirs(localProjectDirs),
  ]);
}

function isCandidateProjectDir(projectDir: string, homeDir: string): boolean {
  const normalized = normalizePathKey(projectDir);
  const normalizedHome = normalizePathKey(homeDir);
  if (normalized === normalizedHome) return false;
  return ![".codex", ".claude", ".agents"].some((dirName) => normalized === path.join(normalizedHome, dirName) || normalized.startsWith(`${path.join(normalizedHome, dirName)}${path.sep}`));
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

export function installRemoteSkillLocally(remoteSkill: RemoteSkill, options: InstallRemoteSkillOptions = {}): InstallRemoteSkillResult {
  const homeDir = options.homeDir || os.homedir();
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(homeDir, ".codex");
  const rootPath = remoteSkill.agent === "codex" ? path.join(codexHome, "skills") : path.join(homeDir, ".claude", "skills");
  const directoryName = safeSkillDirectoryName(remoteSkill.name);
  const directoryPath = path.join(rootPath, directoryName);
  const installedPath = path.join(directoryPath, "SKILL.md");
  const rootKey = normalizePathKey(rootPath);
  const directoryKey = normalizePathKey(directoryPath);
  if (!directoryKey.startsWith(`${rootKey}${path.sep}`)) throw new Error("Refusing to install skill outside the managed root.");

  const overwritten = fs.existsSync(installedPath);
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(installedPath, remoteSkill.markdown, "utf8");
  return { installedPath, directoryPath, overwritten };
}

function collectClaudePluginRoots(pluginsDir: string): SkillRootConfig[] {
  const roots: SkillRootConfig[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(pluginsDir, "installed_plugins.json"), "utf8");
  } catch {
    return collectClaudeMarketplacePluginRoots(pluginsDir);
  }

  let parsed: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return collectClaudeMarketplacePluginRoots(pluginsDir);
  }

  const plugins = parsed.plugins;
  if (!plugins || typeof plugins !== "object") return collectClaudeMarketplacePluginRoots(pluginsDir);

  for (const installs of Object.values(plugins)) {
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      const installPath = install?.installPath;
      if (typeof installPath !== "string" || !installPath) continue;
      roots.push({ agent: "claude", source: "claude-plugin", path: path.join(installPath, "skills") });
    }
  }
  roots.push(...collectClaudeMarketplacePluginRoots(pluginsDir));
  return dedupeRootConfigs(roots);
}

function collectClaudeMarketplacePluginRoots(pluginsDir: string): SkillRootConfig[] {
  const marketplacesDir = path.join(pluginsDir, "marketplaces");
  let marketplaces: fs.Dirent[];
  try {
    marketplaces = fs.readdirSync(marketplacesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: SkillRootConfig[] = [];
  for (const marketplace of marketplaces) {
    if (!marketplace.isDirectory()) continue;
    const marketplaceDir = path.join(marketplacesDir, marketplace.name);
    for (const collectionName of ["plugins", "external_plugins"]) {
      roots.push(...collectClaudePluginCollectionRoots(path.join(marketplaceDir, collectionName)));
    }
  }
  return dedupeRootConfigs(roots);
}

function collectClaudePluginCollectionRoots(collectionDir: string): SkillRootConfig[] {
  let pluginEntries: fs.Dirent[];
  try {
    pluginEntries = fs.readdirSync(collectionDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return pluginEntries
    .filter((entry) => entry.isDirectory())
    .map((entry): SkillRootConfig => ({ agent: "claude", source: "claude-plugin", path: path.join(collectionDir, entry.name, "skills") }));
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

function dedupeRootConfigs(roots: SkillRootConfig[]): SkillRootConfig[] {
  const byPath = new Map<string, SkillRootConfig>();
  for (const root of roots) {
    byPath.set(normalizePathKey(root.path), root);
  }
  return [...byPath.values()];
}

function discoverNestedSkillProjectDirs(projectDirs: string[]): string[] {
  const discovered: string[] = [];
  for (const projectDir of projectDirs) {
    discovered.push(...walkForNestedSkillProjectDirs(projectDir, 3));
  }
  return discovered;
}

function discoverAncestorSkillProjectDirs(projectDirs: string[]): string[] {
  const discovered: string[] = [];
  const homeDir = normalizePathKey(os.homedir());
  for (const projectDir of projectDirs) {
    let current = path.dirname(normalizePathKey(projectDir));
    while (current && current !== path.dirname(current)) {
      if (current === homeDir) break;
      if (hasProjectSkillRoot(current)) discovered.push(current);
      current = path.dirname(current);
    }
  }
  return discovered;
}

function walkForNestedSkillProjectDirs(rootDir: string, maxDepth: number): string[] {
  const result: string[] = [];
  const rootKey = normalizePathKey(rootDir);
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (normalizePathKey(dir) !== rootKey && hasProjectSkillRoot(dir)) result.push(dir);

    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipProjectSkillSearchDir(entry.name)) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };

  visit(rootDir, 0);
  return result;
}

function hasProjectSkillRoot(projectDir: string): boolean {
  return [".claude", ".codex"].some((agentDir) => fs.existsSync(path.join(projectDir, agentDir, "skills")));
}

function shouldSkipProjectSkillSearchDir(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === "vendor" || name === "out" || name === "dist" || name === "build";
}

function safeSkillDirectoryName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "skill";
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
