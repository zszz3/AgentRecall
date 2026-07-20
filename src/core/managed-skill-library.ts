import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  listInstalledSkills,
  type DeleteInstalledSkillResult,
  type InstalledSkill,
  type InstalledSkillsSnapshot,
  type SkillManagerOptions,
  type SkillSource,
} from "./skill-manager";

export type SkillInstallTarget = "codex" | "claude" | "trae";
export type ManagedSkillOriginKind = "local" | "skills-sh" | "remote";
export type ManagedSkillTargetState = "installed" | "not-installed" | "conflict";

export interface ManagedSkillOrigin {
  kind: ManagedSkillOriginKind;
  label: string;
  source?: string;
  url?: string;
  sourcePath?: string;
}

export interface ManagedSkillInstallation {
  target: SkillInstallTarget;
  path: string;
  state: ManagedSkillTargetState;
}

export interface ManagedSkill extends InstalledSkill {
  source: "agent-recall";
  managedId: string;
  origin: ManagedSkillOrigin;
  installations: ManagedSkillInstallation[];
}

export interface ManagedSkillsSnapshot extends Omit<InstalledSkillsSnapshot, "skills"> {
  skills: ManagedSkill[];
}

export interface ManagedSkillFile {
  relativePath: string;
  contents: string | Buffer;
  mode?: number;
}

export interface ManagedSkillFileImport {
  suggestedId: string;
  origin: ManagedSkillOrigin;
  files: ManagedSkillFile[];
}

export interface ManagedSkillImportResult {
  status: "imported" | "existing" | "updated";
  managedId: string;
  skill: ManagedSkill;
}

interface ManagedSkillMetadata {
  schemaVersion: 1;
  managedId: string;
  importedAt: string;
  origin: ManagedSkillOrigin;
}

export interface ManagedSkillLibraryOptions {
  libraryRoot: string;
  homeDir: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
}

const INSTALL_TARGETS: SkillInstallTarget[] = ["codex", "claude", "trae"];

export class ManagedSkillLibrary {
  private readonly libraryRoot: string;
  private readonly homeDir: string;
  private readonly codexHome: string;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;

  constructor(options: ManagedSkillLibraryOptions) {
    this.libraryRoot = path.resolve(options.libraryRoot);
    this.homeDir = path.resolve(options.homeDir);
    this.codexHome = path.resolve(options.codexHome || path.join(this.homeDir, ".codex"));
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  list(): ManagedSkillsSnapshot {
    const scanned = listInstalledSkills({
      homeDir: this.homeDir,
      codexHome: this.codexHome,
      managedRoot: this.libraryRoot,
      managedOnly: true,
    });
    const skills = scanned.skills
      .filter((skill) => path.dirname(skill.directoryPath) === this.libraryRoot)
      .map((skill): ManagedSkill => {
        const managedId = path.basename(skill.directoryPath);
        const metadata = this.readMetadata(managedId);
        return {
          ...skill,
          source: "agent-recall",
          managedId,
          origin: metadata?.origin ?? { kind: "local", label: "AgentRecall" },
          installations: INSTALL_TARGETS.map((target) => this.inspectInstallation(managedId, target)),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.managedId.localeCompare(right.managedId));
    return {
      ...scanned,
      skills,
      roots: scanned.roots.map((root) => ({ ...root, skillCount: skills.length })),
    };
  }

  listImportCandidates(projectDirs: string[]): InstalledSkillsSnapshot {
    const snapshot = listInstalledSkills({
      homeDir: this.homeDir,
      codexHome: this.codexHome,
      projectDirs,
    });
    return {
      ...snapshot,
      skills: snapshot.skills.filter((skill) => !this.pointsIntoManagedLibrary(skill.directoryPath)),
    };
  }

  importLocalSkill(skillPath: string, projectDirs: string[] = []): ManagedSkillImportResult {
    const normalizedSkillPath = path.resolve(skillPath);
    const sourceSkill = this.listImportCandidates(projectDirs).skills.find(
      (candidate) => path.resolve(candidate.path) === normalizedSkillPath,
    );
    if (!sourceSkill) throw new Error("The selected path is not an available local Skill.");
    const managedId = safeManagedSkillId(path.basename(sourceSkill.directoryPath));
    return this.importDirectory(managedId, sourceSkill.directoryPath, {
      kind: "local",
      label: localSkillSourceLabel(sourceSkill.source),
      sourcePath: sourceSkill.directoryPath,
    });
  }

  importFiles(input: ManagedSkillFileImport): ManagedSkillImportResult {
    const managedId = safeManagedSkillId(input.suggestedId);
    const validated = input.files.map((file) => ({ ...file, relativePath: safeRelativeSkillPath(file.relativePath) }));
    if (!validated.some((file) => file.relativePath.toLowerCase() === "skill.md")) {
      throw new Error("Downloaded Skill does not include SKILL.md.");
    }
    return this.importIntoStaging(managedId, input.origin, (stagingPath) => {
      for (const file of validated) {
        const targetPath = path.join(stagingPath, ...file.relativePath.split("/"));
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, file.contents);
        if (file.mode !== undefined && this.platform !== "win32") fs.chmodSync(targetPath, file.mode & 0o777);
      }
    });
  }

  replaceFiles(input: ManagedSkillFileImport): ManagedSkillImportResult {
    const managedId = safeManagedSkillId(input.suggestedId);
    const validated = input.files.map((file) => ({ ...file, relativePath: safeRelativeSkillPath(file.relativePath) }));
    if (!validated.some((file) => file.relativePath.toLowerCase() === "skill.md")) {
      throw new Error("Downloaded Skill does not include SKILL.md.");
    }
    return this.importIntoStaging(managedId, input.origin, (stagingPath) => {
      for (const file of validated) {
        const targetPath = path.join(stagingPath, ...file.relativePath.split("/"));
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, file.contents);
        if (file.mode !== undefined && this.platform !== "win32") fs.chmodSync(targetPath, file.mode & 0o777);
      }
    }, true);
  }

  updateTargets(managedId: string, targets: SkillInstallTarget[]): ManagedSkill {
    const skill = this.requireManagedSkill(managedId);
    const requestedTargets = new Set(targets);
    if ([...requestedTargets].some((target) => !INSTALL_TARGETS.includes(target))) {
      throw new Error("Unknown Skill installation target.");
    }
    const current = new Map(skill.installations.map((installation) => [installation.target, installation]));
    for (const target of requestedTargets) {
      if (current.get(target)?.state === "conflict") {
        throw new Error(`Refusing to overwrite the existing ${target} Skill directory.`);
      }
    }

    // Preflight every requested target before removing any existing owned link.
    for (const target of INSTALL_TARGETS) {
      const installation = current.get(target)!;
      if (!requestedTargets.has(target) && installation.state === "installed") {
        const verified = this.inspectInstallation(managedId, target);
        if (verified.state !== "installed") {
          throw new Error(`Refusing to remove a ${target} Skill link that is no longer owned by AgentRecall.`);
        }
      }
    }

    for (const target of INSTALL_TARGETS) {
      const installation = current.get(target)!;
      const requested = requestedTargets.has(target);
      if (!requested && installation.state === "installed") {
        fs.unlinkSync(installation.path);
      } else if (requested && installation.state === "not-installed") {
        fs.mkdirSync(path.dirname(installation.path), { recursive: true });
        fs.symlinkSync(skill.directoryPath, installation.path, managedSkillLinkType(this.platform));
      }
    }
    return this.requireManagedSkill(managedId);
  }

  delete(managedId: string): DeleteInstalledSkillResult {
    const normalizedId = safeManagedSkillId(managedId);
    if (normalizedId !== managedId) throw new Error("Unsafe managed Skill id.");
    const skill = this.requireManagedSkill(normalizedId);
    for (const installation of skill.installations) {
      if (installation.state !== "installed") continue;
      const verified = this.inspectInstallation(normalizedId, installation.target);
      if (verified.state !== "installed") {
        throw new Error(`Refusing to remove a ${installation.target} Skill link that is no longer owned by AgentRecall.`);
      }
    }
    for (const installation of skill.installations) {
      if (installation.state === "installed") fs.unlinkSync(installation.path);
    }
    fs.rmSync(skill.directoryPath, { recursive: true, force: false });
    fs.rmSync(this.metadataPath(normalizedId), { force: true });
    return { deletedPath: skill.directoryPath, skillName: skill.name };
  }

  private importDirectory(managedId: string, sourceDirectory: string, origin: ManagedSkillOrigin): ManagedSkillImportResult {
    return this.importIntoStaging(managedId, origin, (stagingPath) => {
      fs.cpSync(sourceDirectory, stagingPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
    });
  }

  private importIntoStaging(
    managedId: string,
    origin: ManagedSkillOrigin,
    populate: (stagingPath: string) => void,
    replaceExisting = false,
  ): ManagedSkillImportResult {
    fs.mkdirSync(this.libraryRoot, { recursive: true });
    const targetPath = this.managedSkillDirectory(managedId);
    const stagingPath = path.join(this.libraryRoot, `.staging-${managedId}-${randomUUID()}`);
    fs.rmSync(stagingPath, { recursive: true, force: true });
    try {
      populate(stagingPath);
      if (!fs.existsSync(path.join(stagingPath, "SKILL.md"))) {
        throw new Error("Imported Skill does not include SKILL.md.");
      }
      if (fs.existsSync(targetPath)) {
        if (directoryContentHash(targetPath) === directoryContentHash(stagingPath)) {
          fs.rmSync(stagingPath, { recursive: true, force: true });
          this.writeMetadata(managedId, origin);
          return { status: "existing", managedId, skill: this.requireManagedSkill(managedId) };
        }
        if (!replaceExisting) {
          throw new Error(`Managed Skill ${managedId} already exists with different content.`);
        }
        const backupPath = path.join(this.libraryRoot, `.backup-${managedId}-${randomUUID()}`);
        fs.renameSync(targetPath, backupPath);
        try {
          fs.renameSync(stagingPath, targetPath);
          this.writeMetadata(managedId, origin);
          fs.rmSync(backupPath, { recursive: true, force: true });
          return { status: "updated", managedId, skill: this.requireManagedSkill(managedId) };
        } catch (error) {
          fs.rmSync(targetPath, { recursive: true, force: true });
          if (fs.existsSync(backupPath)) fs.renameSync(backupPath, targetPath);
          throw error;
        }
      }
      fs.renameSync(stagingPath, targetPath);
      this.writeMetadata(managedId, origin);
      return { status: "imported", managedId, skill: this.requireManagedSkill(managedId) };
    } catch (error) {
      fs.rmSync(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  private requireManagedSkill(managedId: string): ManagedSkill {
    const skill = this.list().skills.find((candidate) => candidate.managedId === managedId);
    if (!skill) throw new Error(`Managed Skill ${managedId} could not be read after import.`);
    return skill;
  }

  private managedSkillDirectory(managedId: string): string {
    const target = path.resolve(this.libraryRoot, managedId);
    if (path.dirname(target) !== this.libraryRoot) throw new Error("Unsafe managed Skill id.");
    return target;
  }

  private metadataPath(managedId: string): string {
    return path.join(this.libraryRoot, ".metadata", `${managedId}.json`);
  }

  private readMetadata(managedId: string): ManagedSkillMetadata | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.metadataPath(managedId), "utf8")) as Partial<ManagedSkillMetadata>;
      if (value.schemaVersion !== 1 || value.managedId !== managedId || !isManagedSkillOrigin(value.origin)) return null;
      return value as ManagedSkillMetadata;
    } catch {
      return null;
    }
  }

  private writeMetadata(managedId: string, origin: ManagedSkillOrigin): void {
    const metadataPath = this.metadataPath(managedId);
    const temporaryPath = `${metadataPath}.${randomUUID()}.tmp`;
    const metadata: ManagedSkillMetadata = {
      schemaVersion: 1,
      managedId,
      importedAt: new Date(this.now()).toISOString(),
      origin,
    };
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, metadataPath);
  }

  private pointsIntoManagedLibrary(directoryPath: string): boolean {
    try {
      const realDirectory = fs.realpathSync(directoryPath);
      const relative = path.relative(this.libraryRoot, realDirectory);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  }

  private inspectInstallation(managedId: string, target: SkillInstallTarget): ManagedSkillInstallation {
    const targetPath = this.installTargetPath(managedId, target);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(targetPath);
    } catch {
      return { target, path: targetPath, state: "not-installed" };
    }
    if (!stat.isSymbolicLink()) return { target, path: targetPath, state: "conflict" };
    try {
      const actual = path.resolve(fs.realpathSync(targetPath));
      const expected = path.resolve(fs.realpathSync(this.managedSkillDirectory(managedId)));
      return { target, path: targetPath, state: actual === expected ? "installed" : "conflict" };
    } catch {
      return { target, path: targetPath, state: "conflict" };
    }
  }

  private installTargetPath(managedId: string, target: SkillInstallTarget): string {
    if (target === "codex") return path.join(this.codexHome, "skills", managedId);
    return path.join(this.homeDir, target === "claude" ? ".claude" : ".trae", "skills", managedId);
  }
}

export function managedSkillLinkType(platform: NodeJS.Platform): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir";
}

function localSkillSourceLabel(source: SkillSource): string {
  if (source.startsWith("claude")) return "Claude Code";
  if (source === "codex-shared") return "Shared";
  return "Codex";
}

function safeManagedSkillId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!normalized || normalized === "." || normalized === "..") throw new Error("Skill name cannot produce a safe managed id.");
  return normalized;
}

function safeRelativeSkillPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("Unsafe Skill file path.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Unsafe Skill file path.");
  }
  return segments.join("/");
}

function directoryContentHash(directoryPath: string): string {
  const root = path.resolve(directoryPath);
  const hash = createHash("sha256");
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(current, entry.name);
      const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
      hash.update(relativePath);
      hash.update("\0");
      if (entry.isDirectory()) {
        hash.update("directory\0");
        visit(entryPath);
      } else if (entry.isFile()) {
        hash.update("file\0");
        hash.update(fs.readFileSync(entryPath));
      } else if (entry.isSymbolicLink()) {
        hash.update("link\0");
        hash.update(fs.readlinkSync(entryPath));
      }
      hash.update("\0");
    }
  };
  visit(root);
  return hash.digest("hex");
}

function isManagedSkillOrigin(value: unknown): value is ManagedSkillOrigin {
  if (!value || typeof value !== "object") return false;
  const origin = value as Partial<ManagedSkillOrigin>;
  return (origin.kind === "local" || origin.kind === "skills-sh" || origin.kind === "remote")
    && typeof origin.label === "string";
}

export function managedSkillManagerOptions(
  libraryRoot: string,
  options: Pick<ManagedSkillLibraryOptions, "homeDir" | "codexHome">,
): SkillManagerOptions {
  return {
    homeDir: options.homeDir,
    codexHome: options.codexHome,
    managedRoot: libraryRoot,
    managedOnly: true,
  };
}
