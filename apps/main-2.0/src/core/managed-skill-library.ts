import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  listInstalledSkills,
  type DeleteInstalledSkillResult,
  type InstalledSkill,
  type InstalledSkillsSnapshot,
  type SkillSource,
} from "./skill-manager";
import { AGENT_SKILL_REGISTRY, SKILL_INSTALL_TARGETS, agentInstallTargetDir, type SkillInstallTarget } from "./agent-skill-registry";

export type { SkillInstallTarget } from "./agent-skill-registry";
export type ManagedSkillOriginKind = "local" | "skills-sh" | "remote" | "builtin";
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
  source: "agent-recall-v2";
  managedId: string;
  origin: ManagedSkillOrigin;
  installations: ManagedSkillInstallation[];
}

export interface ManagedSkillTargetUpdateResult extends ManagedSkill {
  retainedBackupPaths: string[];
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

export interface AgentRecallBuiltinSkillDefinition {
  /** Directory name under assets/bundled-skills/. */
  id: string;
  /** Managed library directory name after import. */
  installId: string;
  sourceUrl: string;
}

export const AGENT_RECALL_BUILTIN_SKILLS: AgentRecallBuiltinSkillDefinition[] = [
  {
    id: "aihot",
    installId: "aihot",
    sourceUrl: "https://github.com/KKKKhazix/khazix-skills/tree/main/aihot",
  },
  {
    id: "resume-optimization",
    installId: "resume-optimization",
    sourceUrl: "https://github.com/melodic-software/claude-code-plugins/tree/main/plugins/soft-skills/skills/resume-optimization",
  },
  {
    id: "brainstorming",
    installId: "brainstorming",
    sourceUrl: "https://github.com/obra/superpowers/tree/main/skills/brainstorming",
  },
  {
    id: "grill-me",
    installId: "grill-me",
    sourceUrl: "https://github.com/mattpocock/skills/tree/main/skills/grill-me",
  },
  {
    id: "systematic-debugging",
    installId: "systematic-debugging",
    sourceUrl: "https://github.com/obra/superpowers/tree/main/skills/systematic-debugging",
  },
  {
    id: "test-driven-development",
    installId: "test-driven-development",
    sourceUrl: "https://github.com/obra/superpowers/tree/main/skills/test-driven-development",
  },
  {
    id: "verification-before-completion",
    installId: "verification-before-completion",
    sourceUrl: "https://github.com/obra/superpowers/tree/main/skills/verification-before-completion",
  },
];

export interface ManagedSkillLibraryOptions {
  libraryRoot: string;
  homeDir: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
  now?: () => number;
}

const INSTALL_TARGETS: SkillInstallTarget[] = [...SKILL_INSTALL_TARGETS];

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
          source: "agent-recall-v2",
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
      localAgentRootsOnly: true,
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

  ensureBuiltinSkills(bundledSkillsPath: string): void {
    for (const definition of AGENT_RECALL_BUILTIN_SKILLS) {
      const sourceDir = path.join(bundledSkillsPath, definition.id);
      if (!fs.existsSync(path.join(sourceDir, "SKILL.md"))) continue;
      const managedId = safeManagedSkillId(definition.installId);
      const targetPath = this.managedSkillDirectory(managedId);
      // Idempotent: skip when the built-in skill is already present.
      if (fs.existsSync(targetPath)) continue;
      try {
        this.importDirectory(managedId, sourceDir, {
          kind: "builtin",
          label: "AgentRecall",
          url: definition.sourceUrl,
        });
      } catch {
        // A failed built-in import must not block startup; retried next launch.
      }
    }
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

  updateTargets(
    managedId: string,
    targets: SkillInstallTarget[],
    forceTargets: SkillInstallTarget[] = [],
  ): ManagedSkillTargetUpdateResult {
    const skill = this.requireManagedSkill(managedId);
    const requestedTargets = new Set(targets);
    const requestedForceTargets = new Set(forceTargets);
    if (
      [...requestedTargets].some((target) => !INSTALL_TARGETS.includes(target))
      || [...requestedForceTargets].some((target) => !INSTALL_TARGETS.includes(target))
    ) {
      throw new Error("Unknown Skill installation target.");
    }
    if ([...requestedForceTargets].some((target) => !requestedTargets.has(target))) {
      throw new Error("A forced Skill installation target must also be selected.");
    }
    const installations = INSTALL_TARGETS.map((target) => this.inspectInstallation(managedId, target));
    const managedSkillRealPath = fs.realpathSync(skill.directoryPath);
    const physicalGroups = new Map<string, {
      key: string;
      path: string;
      installations: ManagedSkillInstallation[];
    }>();
    for (const installation of installations) {
      let physicalTargetPath: string;
      try {
        physicalTargetPath = physicalEntryPath(installation.path);
      } catch (error) {
        if (requestedTargets.has(installation.target) || installation.state === "installed") throw error;
        continue;
      }
      const physicalTargetKey = comparablePath(physicalTargetPath, this.platform);
      const group = physicalGroups.get(physicalTargetKey) ?? {
        key: physicalTargetKey,
        path: physicalTargetPath,
        installations: [],
      };
      group.installations.push(installation);
      physicalGroups.set(physicalTargetKey, group);
    }
    const targetPlans = [...physicalGroups.values()].map((group) => {
      const states = new Set(group.installations.map((installation) => installation.state));
      if (states.size !== 1) {
        throw new Error(
          `Refusing to update Skill targets ${group.installations.map((installation) => installation.target).join(", ")} because their shared physical path has inconsistent state.`,
        );
      }
      const requestedIntents = new Set(
        group.installations.map((installation) => requestedTargets.has(installation.target)),
      );
      if (requestedIntents.size !== 1) {
        throw new Error(
          `Refusing to update Skill targets ${group.installations.map((installation) => installation.target).join(", ")} because they resolve to the same path with different requested installation intent.`,
        );
      }
      const state = group.installations[0].state;
      const requested = requestedTargets.has(group.installations[0].target);
      if (
        state === "conflict"
        && requested
        && group.installations.some((installation) => !requestedForceTargets.has(installation.target))
      ) {
        throw new Error(
          `The ${group.installations.find((installation) => !requestedForceTargets.has(installation.target))!.target} Skill target conflicts with an existing path and requires explicit force installation.`,
        );
      }
      return {
        ...group,
        state,
        requested,
        representative: group.installations[0],
      };
    });
    const pathsToStage = targetPlans.filter((plan) =>
      (!plan.requested && plan.state === "installed")
      || (plan.requested && plan.state === "conflict"));
    const linksToCreate = targetPlans.filter((plan) =>
      plan.requested && (plan.state === "not-installed" || plan.state === "conflict"));
    for (const plan of [...pathsToStage, ...linksToCreate]) {
      if (pathsOverlap(plan.path, managedSkillRealPath, this.platform)) {
        throw new Error(`Refusing to update an overlapping managed Skill target at ${plan.representative.path}.`);
      }
    }

    const stagedPaths: Array<{ originalPath: string; backupPath: string }> = [];
    const createdLinks: typeof linksToCreate = [];
    try {
      for (const plan of pathsToStage) {
        const installation = plan.representative;
        if (
          comparablePath(physicalEntryPath(installation.path), this.platform)
          !== plan.key
        ) {
          throw new Error(`Refusing to update a ${installation.target} Skill target whose parent path changed.`);
        }
        const removingOwnedLink = !plan.requested;
        if (removingOwnedLink) {
          for (const alias of plan.installations) {
            if (this.inspectInstallation(managedId, alias.target).state !== "installed") {
              throw new Error(`Refusing to remove a ${alias.target} Skill link that is no longer owned by AgentRecall.`);
            }
          }
        }
        const backupPath = path.join(
          path.dirname(installation.path),
          `.${path.basename(installation.path)}.agent-recall-backup-${randomUUID()}`,
        );
        fs.renameSync(installation.path, backupPath);
        stagedPaths.push({ originalPath: installation.path, backupPath });
        if (removingOwnedLink && !symlinkPointsToDirectory(backupPath, skill.directoryPath)) {
          throw new Error(`Refusing to remove a ${installation.target} Skill path that changed during the update.`);
        }
      }
      for (const plan of linksToCreate) {
        const installation = plan.representative;
        fs.mkdirSync(path.dirname(installation.path), { recursive: true });
        if (
          comparablePath(physicalEntryPath(installation.path), this.platform)
          !== plan.key
        ) {
          throw new Error(`Refusing to install a ${installation.target} Skill target whose parent path changed.`);
        }
        fs.symlinkSync(skill.directoryPath, installation.path, managedSkillLinkType(this.platform));
        createdLinks.push(plan);
        for (const alias of plan.installations) {
          if (this.inspectInstallation(managedId, alias.target).state !== "installed") {
            throw new Error(`Managed Skill link verification failed for ${alias.target}.`);
          }
        }
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const plan of [...createdLinks].reverse()) {
        const installation = plan.representative;
        try {
          const states = new Set(
            plan.installations.map((alias) => this.inspectInstallation(managedId, alias.target).state),
          );
          if (states.size === 1 && states.has("installed")) {
            fs.unlinkSync(installation.path);
          } else if (!(states.size === 1 && states.has("not-installed"))) {
            throw new Error(`Refusing to remove an unowned path while rolling back ${installation.target}.`);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const staged of [...stagedPaths].reverse()) {
        try {
          if (lstatIfPresent(staged.originalPath)) {
            throw new Error(`Refusing to overwrite a path that appeared while restoring ${staged.originalPath}.`);
          }
          fs.renameSync(staged.backupPath, staged.originalPath);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Failed to update managed Skill targets and fully restore their previous state.",
        );
      }
      throw error;
    }

    const retainedBackupPaths: string[] = [];
    for (const staged of stagedPaths) {
      try {
        const stat = fs.lstatSync(staged.backupPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          fs.rmSync(staged.backupPath, { recursive: true, force: false });
        } else {
          fs.unlinkSync(staged.backupPath);
        }
      } catch {
        // The target update has committed. A cleanup failure must not roll
        // back after the requested visible state was reached. Report a backup
        // that still exists so the renderer can tell the user where it remains.
        try {
          fs.lstatSync(staged.backupPath);
          retainedBackupPaths.push(staged.backupPath);
        } catch (error) {
          if (!isMissingPathError(error)) retainedBackupPaths.push(staged.backupPath);
        }
      }
    }
    return {
      ...this.requireManagedSkill(managedId),
      retainedBackupPaths,
    };
  }

  delete(managedId: string): DeleteInstalledSkillResult {
    const normalizedId = safeManagedSkillId(managedId);
    if (normalizedId !== managedId) throw new Error("Unsafe managed Skill id.");
    const skill = this.requireManagedSkill(normalizedId);
    const managedSkillRealPath = path.resolve(fs.realpathSync(skill.directoryPath));
    const managedSkillStat = fs.lstatSync(skill.directoryPath);
    if (!managedSkillStat.isDirectory() || managedSkillStat.isSymbolicLink()) {
      throw new Error(`Refusing to delete managed Skill ${normalizedId} because its source is not a directory.`);
    }
    const realLibraryRoot = path.resolve(fs.realpathSync(this.libraryRoot));
    const metadataPath = this.metadataPath(normalizedId);
    const metadataStat = lstatIfPresent(metadataPath);
    if (metadataStat && !metadataStat.isFile()) {
      throw new Error(`Refusing to delete managed Skill ${normalizedId} because its metadata is not a regular file.`);
    }
    fs.accessSync(this.libraryRoot, fs.constants.W_OK);
    fs.accessSync(path.dirname(realLibraryRoot), fs.constants.W_OK);
    if (metadataStat) fs.accessSync(path.dirname(metadataPath), fs.constants.W_OK);

    const ownedInstallations = new Map<string, {
      installation: ManagedSkillInstallation;
      stat: fs.Stats;
    }>();
    for (const target of INSTALL_TARGETS) {
      const previous = skill.installations.find((candidate) => candidate.target === target)!;
      const verified = this.inspectInstallation(normalizedId, target, true);
      if (previous.state === "installed" && verified.state !== "installed") {
        throw new Error(`Refusing to remove a ${target} Skill link that changed during deletion.`);
      }
      if (verified.state !== "installed") continue;
      const physicalPath = physicalEntryPath(verified.path);
      const physicalKey = comparablePath(physicalPath, this.platform);
      const stat = fs.lstatSync(verified.path);
      if (
        !stat.isSymbolicLink()
        || path.resolve(fs.realpathSync(verified.path)) !== managedSkillRealPath
      ) {
        throw new Error(`Refusing to remove a ${target} Skill link that changed during deletion.`);
      }
      fs.accessSync(path.dirname(verified.path), fs.constants.W_OK);
      const existing = ownedInstallations.get(physicalKey);
      if (existing) {
        if (!sameFileIdentity(existing.stat, stat)) {
          throw new Error(`Refusing to remove aliased Skill links whose shared path changed during deletion.`);
        }
        continue;
      }
      ownedInstallations.set(physicalKey, {
        installation: verified,
        stat,
      });
    }

    type DeleteStage = {
      originalPath: string;
      backupPath: string;
      movedStat: fs.Stats | null;
    };
    const stagedLinks: DeleteStage[] = [];
    let stagedSource: DeleteStage | null = null;
    let stagedMetadata: DeleteStage | null = null;
    const deleteToken = randomUUID();
    const libraryParent = path.dirname(realLibraryRoot);
    const backupStem = `.${path.basename(realLibraryRoot)}.agent-recall-delete-${deleteToken}`;
    const sourceBackupPath = path.join(libraryParent, backupStem);
    const metadataBackupPath = path.join(libraryParent, `${backupStem}.metadata`);

    try {
      for (const [physicalKey, owned] of ownedInstallations) {
        const { installation } = owned;
        if (
          comparablePath(physicalEntryPath(installation.path), this.platform) !== physicalKey
        ) {
          throw new Error(`Refusing to remove a ${installation.target} Skill link whose parent path changed.`);
        }
        const currentStat = fs.lstatSync(installation.path);
        if (
          !sameFileIdentity(currentStat, owned.stat)
          || !currentStat.isSymbolicLink()
          || path.resolve(fs.realpathSync(installation.path)) !== managedSkillRealPath
        ) {
          throw new Error(`Refusing to remove a ${installation.target} Skill link that changed during deletion.`);
        }
        const backupPath = path.join(
          path.dirname(installation.path),
          `.${path.basename(installation.path)}.agent-recall-backup-${randomUUID()}`,
        );
        if (lstatIfPresent(backupPath)) {
          throw new Error(`Refusing to overwrite an existing Skill deletion backup at ${backupPath}.`);
        }
        const stage: DeleteStage = {
          originalPath: installation.path,
          backupPath,
          movedStat: null,
        };
        stagedLinks.push(stage);
        fs.renameSync(stage.originalPath, stage.backupPath);
        stage.movedStat = fs.lstatSync(stage.backupPath);
        if (
          !sameFileIdentity(stage.movedStat, owned.stat)
          || !stage.movedStat.isSymbolicLink()
          || !symlinkPointsToDirectory(stage.backupPath, skill.directoryPath)
        ) {
          throw new Error(`Refusing to remove a ${installation.target} Skill path that changed during deletion.`);
        }
      }

      if (lstatIfPresent(sourceBackupPath)) {
        throw new Error(`Refusing to overwrite an existing Skill deletion backup at ${sourceBackupPath}.`);
      }
      stagedSource = {
        originalPath: skill.directoryPath,
        backupPath: sourceBackupPath,
        movedStat: null,
      };
      fs.renameSync(stagedSource.originalPath, stagedSource.backupPath);
      stagedSource.movedStat = fs.lstatSync(stagedSource.backupPath);
      if (
        !sameFileIdentity(stagedSource.movedStat, managedSkillStat)
        || !stagedSource.movedStat.isDirectory()
        || stagedSource.movedStat.isSymbolicLink()
      ) {
        throw new Error(`Refusing to delete managed Skill ${normalizedId} because its source changed during deletion.`);
      }

      if (metadataStat) {
        if (lstatIfPresent(metadataBackupPath)) {
          throw new Error(`Refusing to overwrite an existing Skill deletion backup at ${metadataBackupPath}.`);
        }
        stagedMetadata = {
          originalPath: metadataPath,
          backupPath: metadataBackupPath,
          movedStat: null,
        };
        fs.renameSync(stagedMetadata.originalPath, stagedMetadata.backupPath);
        stagedMetadata.movedStat = fs.lstatSync(stagedMetadata.backupPath);
        if (
          !sameFileIdentity(stagedMetadata.movedStat, metadataStat)
          || !stagedMetadata.movedStat.isFile()
        ) {
          throw new Error(`Refusing to delete managed Skill ${normalizedId} because its metadata changed during deletion.`);
        }
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      const restore = (stage: DeleteStage | null): boolean => {
        if (!stage) return true;
        try {
          const backupStat = lstatIfPresent(stage.backupPath);
          if (!backupStat) {
            if (!stage.movedStat && lstatIfPresent(stage.originalPath)) return true;
            throw new Error(`Cannot restore missing Skill deletion backup ${stage.backupPath}.`);
          }
          if (stage.movedStat && !sameFileIdentity(backupStat, stage.movedStat)) {
            throw new Error(`Refusing to restore a Skill deletion backup that changed at ${stage.backupPath}.`);
          }
          if (lstatIfPresent(stage.originalPath)) {
            throw new Error(`Refusing to overwrite a path that appeared while restoring ${stage.originalPath}.`);
          }
          fs.renameSync(stage.backupPath, stage.originalPath);
          if (
            stage.movedStat
            && !sameFileIdentity(fs.lstatSync(stage.originalPath), stage.movedStat)
          ) {
            throw new Error(`Skill deletion rollback verification failed for ${stage.originalPath}.`);
          }
          return true;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
          return false;
        }
      };
      const sourceRestored = restore(stagedSource) && (() => {
        try {
          const restoredSourceStat = fs.lstatSync(skill.directoryPath);
          if (
            !sameFileIdentity(restoredSourceStat, managedSkillStat)
            || !restoredSourceStat.isDirectory()
            || restoredSourceStat.isSymbolicLink()
          ) {
            throw new Error(`Managed Skill source rollback verification failed for ${skill.directoryPath}.`);
          }
          return true;
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
          return false;
        }
      })();
      restore(stagedMetadata);
      if (sourceRestored) {
        for (const staged of [...stagedLinks].reverse()) restore(staged);
      } else if (stagedLinks.length > 0) {
        rollbackErrors.push(new Error(
          "Skipped restoring installed Skill links because the managed Skill source was not safely restored.",
        ));
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Failed to delete the managed Skill and fully restore its previous state.",
        );
      }
      throw error;
    }

    const retainedBackupPaths: string[] = [];
    const cleanup = (stage: DeleteStage | null, recursive = false): void => {
      if (!stage?.movedStat) return;
      try {
        const backupStat = lstatIfPresent(stage.backupPath);
        if (!backupStat) return;
        if (!sameFileIdentity(backupStat, stage.movedStat)) {
          retainedBackupPaths.push(stage.backupPath);
          return;
        }
        if (recursive) {
          fs.rmSync(stage.backupPath, { recursive: true, force: false });
        } else {
          fs.unlinkSync(stage.backupPath);
        }
      } catch {
        // Deletion has committed. Hidden backups are deliberately retained
        // when cleanup cannot complete so the deleted state stays consistent.
        // Report any path that may remain so the renderer can tell the user.
        try {
          if (lstatIfPresent(stage.backupPath)) retainedBackupPaths.push(stage.backupPath);
        } catch {
          retainedBackupPaths.push(stage.backupPath);
        }
      }
    };
    for (const staged of stagedLinks) cleanup(staged);
    cleanup(stagedMetadata);
    cleanup(stagedSource, true);
    return {
      deletedPath: skill.directoryPath,
      skillName: skill.name,
      retainedBackupPaths,
    };
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

  private inspectInstallation(
    managedId: string,
    target: SkillInstallTarget,
    strict = false,
  ): ManagedSkillInstallation {
    const targetPath = this.installTargetPath(managedId, target);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(targetPath);
    } catch (error) {
      if (strict && !isMissingPathError(error)) throw error;
      return {
        target,
        path: targetPath,
        state: isMissingPathError(error) ? "not-installed" : "conflict",
      };
    }
    if (!stat.isSymbolicLink()) return { target, path: targetPath, state: "conflict" };
    try {
      const actual = path.resolve(fs.realpathSync(targetPath));
      const expected = path.resolve(fs.realpathSync(this.managedSkillDirectory(managedId)));
      return { target, path: targetPath, state: actual === expected ? "installed" : "conflict" };
    } catch (error) {
      if (strict && !isMissingPathError(error)) throw error;
      return { target, path: targetPath, state: "conflict" };
    }
  }

  private installTargetPath(managedId: string, target: SkillInstallTarget): string {
    return path.join(agentInstallTargetDir(target, this.homeDir, this.codexHome), managedId);
  }
}

function managedSkillLinkType(platform: NodeJS.Platform): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir";
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function lstatIfPresent(targetPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function symlinkPointsToDirectory(linkPath: string, expectedDirectory: string): boolean {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return false;
    return path.resolve(fs.realpathSync(linkPath)) === path.resolve(fs.realpathSync(expectedDirectory));
  } catch {
    return false;
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function physicalEntryPath(entryPath: string): string {
  const absoluteEntryPath = path.resolve(entryPath);
  let existingAncestor = path.dirname(absoluteEntryPath);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(
        fs.realpathSync(existingAncestor),
        ...missingSegments,
        path.basename(absoluteEntryPath),
      );
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      if (lstatIfPresent(existingAncestor)) {
        throw new Error(`Cannot resolve the physical parent of Skill target ${entryPath}.`, { cause: error });
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function comparablePath(targetPath: string, platform: NodeJS.Platform): string {
  const normalized = path.resolve(targetPath);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = comparablePath(left, platform);
  const normalizedRight = comparablePath(right, platform);
  const leftToRight = path.relative(normalizedLeft, normalizedRight);
  const rightToLeft = path.relative(normalizedRight, normalizedLeft);
  return leftToRight === ""
    || (leftToRight !== ".." && !leftToRight.startsWith(`..${path.sep}`) && !path.isAbsolute(leftToRight))
    || (rightToLeft !== ".." && !rightToLeft.startsWith(`..${path.sep}`) && !path.isAbsolute(rightToLeft));
}

function localSkillSourceLabel(source: SkillSource): string {
  if (source === "codex-shared" || source === "codex-system") return source === "codex-shared" ? "Shared" : "Codex System";
  if (source.startsWith("codex")) return "Codex";
  const agentName = source.split("-")[0];
  const entry = AGENT_SKILL_REGISTRY.find((candidate) => candidate.id === agentName);
  if (entry) return entry.label;
  return agentName;
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
  return (origin.kind === "local" || origin.kind === "skills-sh" || origin.kind === "remote" || origin.kind === "builtin")
    && typeof origin.label === "string";
}
