import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillMarkdown } from "../../shared/online-skills";
import { SKILL_TEMPLATES } from "../../shared/skill-templates";
import type {
  ImportedSkillResult,
  ImportOnlineSkillRequest,
  InstalledSkillResult,
  InstallSkillRequest,
  SkillTemplate,
  UninstalledSkillResult,
  UninstallSkillRequest,
} from "../../shared/types";

const TARGET_DIRS: Record<InstallSkillRequest["target"], string[]> = {
  codex: [".codex", "skills"],
  claude: [".claude", "skills"],
  trae: [".trae", "skills"],
};

function assertSafeTemplateId(templateId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(templateId)) {
    throw new Error(`Invalid skill template id: ${templateId}`);
  }
}

function safeTemplateId(input: string): string {
  const id = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) throw new Error("Online skill name is required.");
  assertSafeTemplateId(id);
  return id;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function defaultBundledSkillRoot(homeDir: string): string {
  return path.join(homeDir, ".agent-recall", "automation-skills");
}

function targetSkillDir(request: InstallSkillRequest | UninstallSkillRequest, homeDir: string): string {
  const targetParts = TARGET_DIRS[request.target];
  if (!targetParts) throw new Error(`Unknown skill target: ${request.target}`);
  return path.join(homeDir, ...targetParts, request.templateId);
}

function managedSkillDir(templateId: string, bundledRoot: string): string {
  return path.join(bundledRoot, templateId);
}

interface ImportedSkillMetadata {
  managedBy?: string;
  tags?: string[];
  sourceLabel?: string;
  sourcePath?: string;
  sourceUrl?: string;
  importedFromId?: string;
}

function bundledSkillSourceDir(template: SkillTemplate): string | undefined {
  if (!template.sourcePath?.startsWith("src/shared/bundled-skills/")) return undefined;
  const relativeDir = path.dirname(template.sourcePath);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), relativeDir),
    path.resolve(moduleDir, "..", "..", relativeDir),
    path.resolve(moduleDir, "..", "shared", "bundled-skills", template.id),
  ];
  return candidates.find((candidate) => pathExistsSync(candidate));
}

function pathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

async function assertOwnedSymlink(linkPath: string, sourceDir: string): Promise<void> {
  const stats = await lstat(linkPath);
  if (!stats.isSymbolicLink()) {
    throw new Error(`${linkPath} already exists and is not a symlink. Refusing to overwrite user content.`);
  }
  const linkTarget = await readlink(linkPath);
  const resolvedTarget = path.resolve(path.dirname(linkPath), linkTarget);
  if (resolvedTarget !== sourceDir) {
    throw new Error(`${linkPath} points to ${resolvedTarget}, not this app's bundled skill. Refusing to modify it.`);
  }
}

async function importedSkillTemplateFromDir(skillDir: string): Promise<SkillTemplate | undefined> {
  const metadataPath = path.join(skillDir, "metadata.json");
  const skillPath = path.join(skillDir, "SKILL.md");
  if (!(await pathExists(metadataPath)) || !(await pathExists(skillPath))) return undefined;
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as ImportedSkillMetadata;
  if (metadata.managedBy !== "online-import") return undefined;
  const prompt = await readFile(skillPath, "utf8");
  const parsed = parseSkillMarkdown(prompt, skillPath);
  const template: SkillTemplate = {
    id: path.basename(skillDir),
    sourceType: "user",
    name: parsed.name,
    description: parsed.description,
    prompt,
    tags: Array.isArray(metadata.tags) && metadata.tags.length > 0 ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : parsed.tags,
    sourceLabel: typeof metadata.sourceLabel === "string" ? metadata.sourceLabel : "Imported skill",
    sourcePath: skillPath,
  };
  if (typeof metadata.sourceUrl === "string") template.sourceUrl = metadata.sourceUrl;
  return template;
}

export async function listImportedSkillTemplates(bundledRoot: string): Promise<SkillTemplate[]> {
  if (!(await pathExists(bundledRoot))) return [];
  const entries = await readdir(bundledRoot, { withFileTypes: true });
  const templates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => importedSkillTemplateFromDir(path.join(bundledRoot, entry.name))),
  );
  return templates.filter((template): template is SkillTemplate => Boolean(template)).sort((left, right) => left.name.localeCompare(right.name));
}

export async function importOnlineSkillToLibrary(request: ImportOnlineSkillRequest, bundledRoot: string): Promise<ImportedSkillResult> {
  const templateId = safeTemplateId(request.name);
  const sourceDir = managedSkillDir(templateId, bundledRoot);
  const skillPath = path.join(sourceDir, "SKILL.md");
  const metadataPath = path.join(sourceDir, "metadata.json");
  const existed = await pathExists(sourceDir);
  await mkdir(sourceDir, { recursive: true });
  await writeFile(skillPath, `${request.prompt.trim()}\n`, "utf8");
  const metadata: ImportedSkillMetadata = {
    managedBy: "online-import",
    importedFromId: request.id,
    tags: request.tags,
    sourceLabel: request.sourceLabel ?? "Online skill",
  };
  if (request.sourcePath) metadata.sourcePath = request.sourcePath;
  if (request.sourceUrl) metadata.sourceUrl = request.sourceUrl;
  await writeFile(
    metadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  const template = await importedSkillTemplateFromDir(sourceDir);
  if (!template) throw new Error(`Failed to import online skill: ${request.name}`);
  return { template, path: skillPath, existed };
}

async function managedSkillTemplate(request: InstallSkillRequest, bundledRoot: string): Promise<{ template: SkillTemplate; imported: boolean }> {
  const bundledTemplate = SKILL_TEMPLATES.find((item) => item.id === request.templateId);
  if (request.sourceType !== "user" && bundledTemplate) return { template: bundledTemplate, imported: false };
  const importedTemplate = await importedSkillTemplateFromDir(managedSkillDir(request.templateId, bundledRoot));
  if (importedTemplate) return { template: importedTemplate, imported: true };
  throw new Error(`Unknown ${request.sourceType ?? "managed"} skill: ${request.templateId}`);
}

export async function deleteImportedSkillFromLibrary(templateId: string, bundledRoot: string): Promise<void> {
  assertSafeTemplateId(templateId);
  await rm(managedSkillDir(templateId, bundledRoot), { recursive: true, force: true });
}

export async function installBundledSkill(request: InstallSkillRequest, homeDir: string, bundledRoot = defaultBundledSkillRoot(homeDir)): Promise<InstalledSkillResult> {
  assertSafeTemplateId(request.templateId);
  const { template, imported } = await managedSkillTemplate(request, bundledRoot);

  const sourceDir = managedSkillDir(template.id, bundledRoot);
  const sourcePath = path.join(sourceDir, "SKILL.md");
  const linkPath = targetSkillDir(request, homeDir);
  const skillPath = path.join(linkPath, "SKILL.md");
  const existed = await pathExists(linkPath);
  if (!imported) {
    await rm(sourceDir, { recursive: true, force: true });
    const bundledSourceDir = bundledSkillSourceDir(template);
    if (bundledSourceDir) {
      await cp(bundledSourceDir, sourceDir, { recursive: true });
    } else {
      await mkdir(sourceDir, { recursive: true });
      await writeFile(sourcePath, `${template.prompt.trim()}\n`, "utf8");
    }
  }
  await mkdir(path.dirname(linkPath), { recursive: true });
  if (existed) {
    await assertOwnedSymlink(linkPath, sourceDir);
    await unlink(linkPath);
  }
  await symlink(sourceDir, linkPath, process.platform === "win32" ? "junction" : "dir");

  return {
    templateId: template.id,
    target: request.target,
    path: skillPath,
    sourcePath,
    existed,
  };
}

export async function uninstallBundledSkill(
  request: UninstallSkillRequest,
  homeDir: string,
  bundledRoot = defaultBundledSkillRoot(homeDir),
): Promise<UninstalledSkillResult> {
  assertSafeTemplateId(request.templateId);
  const sourceDir = managedSkillDir(request.templateId, bundledRoot);
  const linkPath = targetSkillDir(request, homeDir);
  if (!(await pathExists(linkPath))) {
    return {
      templateId: request.templateId,
      target: request.target,
      path: linkPath,
      removed: false,
    };
  }
  await assertOwnedSymlink(linkPath, sourceDir);
  await unlink(linkPath);
  return {
    templateId: request.templateId,
    target: request.target,
    path: linkPath,
    removed: true,
  };
}
