import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { assetId, portableAssetPath, revision, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES, skillFromFiles, type SkillFile, type TeamSkill } from "./asset-format.js";
import { WorkspaceError, hasErrorCode } from "./errors.js";

export type ProjectSkillTarget = "codex" | "claude";
const markerName = ".agentrecall-install.json";
const ownershipSchema = z.strictObject({
  schemaVersion: z.literal(1), repository: z.string().regex(/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
  commit: revision, skillId: assetId, digest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.strictObject({ path: z.string().refine(portableAssetPath), sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean() })).min(1).max(200),
});
type Ownership = z.infer<typeof ownershipSchema>;

function statIfPresent(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function safeDirectory(root: string, segments: string[], create: boolean): string {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat = statIfPresent(current);
    if (!stat && create) { fs.mkdirSync(current); stat = fs.lstatSync(current); }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new WorkspaceError("SKILL_CONFLICT", "Skill 目标目录包含链接或其他文件，请选择普通的项目目录。");
    }
  }
  return current;
}

export function skillDestination(root: string, id: string, target: ProjectSkillTarget, create = false): string {
  if (!assetId.safeParse(id).success || !["codex", "claude"].includes(target)) {
    throw new WorkspaceError("INVALID_ARGUMENTS", "请提供有效 Skill ID，并选择 --target codex 或 claude。");
  }
  return path.join(safeDirectory(root, [target === "codex" ? ".agents" : ".claude", "skills"], create), id);
}

function inspectOwned(directory: string) {
  const stat = statIfPresent(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw conflict();
  const marker = path.join(directory, markerName);
  const markerStat = statIfPresent(marker);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink() || markerStat.size > 128 * 1024) throw conflict();
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(marker, "utf8")); } catch { throw conflict(); }
  const parsed = ownershipSchema.safeParse(raw);
  if (!parsed.success) throw conflict();
  const record = parsed.data;
  const files: string[] = [];
  const walk = (prefix: string) => {
    for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
      if (!prefix && entry.name === markerName) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!portableAssetPath(relative) || entry.isSymbolicLink()) throw conflict();
      if (entry.isDirectory()) walk(relative);
      else if (entry.isFile()) files.push(relative);
      else throw conflict();
      if (files.length > 200) throw conflict();
    }
  };
  walk("");
  if (files.length !== record.files.length || new Set(record.files.map((file) => file.path)).size !== files.length) throw conflict();
  const contents: SkillFile[] = [];
  let bytes = 0;
  for (const file of record.files) {
    if (!files.some((name) => name.normalize("NFC") === file.path.normalize("NFC"))) throw conflict();
    const location = path.join(directory, ...file.path.split("/"));
    const current = fs.lstatSync(location);
    if (!current.isFile() || current.size > MAX_FILE_BYTES || current.isSymbolicLink()) throw conflict();
    bytes += current.size;
    if (bytes > MAX_SNAPSHOT_BYTES) throw conflict();
    const content = fs.readFileSync(location);
    if (createHash("sha256").update(content).digest("hex") !== file.sha256
      || process.platform !== "win32" && Boolean(current.mode & 0o111) !== file.executable) throw conflict();
    contents.push({ path: file.path, content: content.toString("base64"), executable: file.executable });
  }
  const skill = skillFromFiles(record.skillId, contents);
  if (skill.digest !== record.digest) throw conflict();
  return { record, skill };
}

function conflict(): WorkspaceError {
  return new WorkspaceError("SKILL_CONFLICT", "目标 Skill 已存在、未经本工具管理或有本地修改，已保留原内容。请先检查并备份，不会自动覆盖。");
}

export function prepareSkillInstall(root: string, skill: TeamSkill, repository: string, commit: string, target: ProjectSkillTarget, fromRevision?: string) {
  const destination = skillDestination(root, skill.id, target);
  const ownership: Ownership = {
    schemaVersion: 1, repository, commit, skillId: skill.id, digest: skill.digest,
    files: skill.files.map((file) => ({ path: file.path, executable: file.executable, sha256: createHash("sha256").update(Buffer.from(file.content, "base64")).digest("hex") })),
  };
  const verifyExisting = () => {
    skillDestination(root, skill.id, target);
    const { record: existing } = inspectOwned(destination);
    if (existing.repository !== repository || existing.skillId !== skill.id || existing.digest !== skill.digest) throw conflict();
    if (fromRevision !== undefined && existing.commit !== fromRevision) throw changedInstallation();
    return { status: "existing" as const, path: destination, commit: existing.commit, backupPath: null as string | null };
  };
  const verifyUpdate = () => {
    skillDestination(root, skill.id, target);
    const { record: existing } = inspectOwned(destination);
    if (existing.repository !== repository || existing.skillId !== skill.id) throw conflict();
    if (existing.commit !== fromRevision) throw changedInstallation();
  };
  if (fromRevision !== undefined) {
    verifyUpdate();
    if (fromRevision === commit) return { commit: verifyExisting, cleanup: () => {} };
  } else if (statIfPresent(destination)) {
    verifyExisting();
    return { commit: verifyExisting, cleanup: () => {} };
  }
  const staging = fs.mkdtempSync(path.join(root, ".agentrecall-skill-stage-"));
  const cleanup = () => fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const file of skill.files) {
      const location = path.join(staging, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(location), { recursive: true });
      fs.writeFileSync(location, Buffer.from(file.content, "base64"), { flag: "wx", mode: file.executable ? 0o755 : 0o644 });
    }
    fs.writeFileSync(path.join(staging, markerName), JSON.stringify(ownership), { flag: "wx", mode: 0o600 });
  } catch (error) { cleanup(); throw error; }
  return {
    commit: () => {
      // Recheck the physical parents and destination immediately before the rename.
      skillDestination(root, skill.id, target, true);
      if (fromRevision !== undefined) {
        verifyUpdate();
        const backupPath = replaceDirectory(root, skill.id, staging, destination);
        return { status: "updated" as const, path: destination, commit, backupPath };
      }
      if (statIfPresent(destination)) throw conflict();
      fs.renameSync(staging, destination);
      return { status: "installed" as const, path: destination, commit, backupPath: null as string | null };
    }, cleanup,
  };
}

export function uninstallProjectSkill(root: string, id: string, target: ProjectSkillTarget) {
  const destination = skillDestination(root, id, target);
  const { record } = inspectOwned(destination);
  if (record.skillId !== id) throw conflict();
  const backups = safeDirectory(root, [".agentrecall-skill-backups"], true);
  const backup = path.join(backups, `${id}-${randomUUID()}`);
  fs.renameSync(destination, backup);
  return { status: "uninstalled" as const, path: destination, backupPath: backup };
}

export function previewSkillInstall(root: string, skill: TeamSkill, repository: string, target: ProjectSkillTarget) {
  let destination: string | null = null;
  try {
    destination = skillDestination(root, skill.id, target);
    if (!statIfPresent(destination)) return { destination, status: "new" as const, installedRevision: null, reason: null };
    const { record } = inspectOwned(destination);
    if (record.repository !== repository || record.skillId !== skill.id || record.digest !== skill.digest) throw conflict();
    return { destination, status: "existing" as const, installedRevision: record.commit, reason: null };
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { destination, status: "conflict" as const, installedRevision: null, reason: error.message };
  }
}

export function inspectProjectSkill(root: string, id: string, target: ProjectSkillTarget) {
  const destination = skillDestination(root, id, target);
  if (!statIfPresent(destination)) return null;
  return inspectOwned(destination).record;
}

export type SkillInstallResult = { id: string; status: "installed" | "existing" | "reverted" | "recovery_required"; path: string; commit: string; backupPath: string | null };

// Ownership is recorded before releasing the publication lock. After that commit,
// cleanup/lock-release failures must not compensate the durable installation.
export async function installProjectSkills(root: string, skills: TeamSkill[], repository: string, commit: string, target: ProjectSkillTarget, publish: (operation: (assertOwned: () => void) => Promise<void>) => Promise<void>, recordInstallation: (results: SkillInstallResult[]) => void) {
  const prepared: Array<{ skill: TeamSkill; operation: ReturnType<typeof prepareSkillInstall> }> = [];
  const results: SkillInstallResult[] = [];
  let recorded = false;
  const cleanupFailed: string[] = [];
  let failed = false;
  let failure: unknown;
  let failedSkillId: string | null = null;
  try {
    for (const skill of skills) {
      failedSkillId = skill.id;
      prepared.push({ skill, operation: prepareSkillInstall(root, skill, repository, commit, target) });
      // Let the project lock heartbeat run between potentially large Skill copies.
      await setImmediate();
    }
    // Prepare every directory before publishing the first one.
    await publish(async (assertOwned) => {
      for (const { skill, operation } of prepared) {
        assertOwned();
        failedSkillId = skill.id;
        const result = operation.commit();
        results.push({ id: skill.id, status: result.status === "existing" ? "existing" : "installed", path: result.path, commit: result.commit, backupPath: null });
        await setImmediate();
      }
      assertOwned();
      recordInstallation(results);
      recorded = true;
    });
    failedSkillId = null;
  } catch (error) {
    failed = true;
    failure = error;
    for (const result of recorded ? [] : [...results].reverse()) {
      if (result.status === "existing") continue;
      try {
        const { record } = inspectOwned(skillDestination(root, result.id, target));
        const expected = skills.find((skill) => skill.id === result.id)!;
        if (record.commit !== commit || record.repository !== repository || record.skillId !== result.id || record.digest !== expected.digest) throw conflict();
        result.backupPath = uninstallProjectSkill(root, result.id, target).backupPath;
        result.status = "reverted";
      } catch {
        // Preserve changed or inaccessible copies; report each unresolved target.
        result.status = "recovery_required";
      }
      await setImmediate();
    }
  } finally {
    for (const { skill, operation } of prepared) {
      try { operation.cleanup(); }
      catch { cleanupFailed.push(skill.id); }
      await setImmediate();
    }
  }
  const details = { recorded, failedSkillId, causeCode: failure instanceof WorkspaceError ? failure.code : failed ? "FILE_OPERATION_FAILED" : null, skills: results, cleanupFailed };
  if (recorded && failed) throw new WorkspaceError("WORK_CONFIG_RECOVERY_REQUIRED", "工作配置已记录，但操作收尾失败。请先运行 work-config status 核对实际状态。", details);
  if (cleanupFailed.length || results.some((result) => result.status === "recovery_required")) {
    throw new WorkspaceError("WORK_CONFIG_RECOVERY_REQUIRED", "工作配置操作未完全结束。请检查以下 Skill 和暂存目录，保留的内容不会被强制删除："
      + [...results.filter((result) => result.status === "recovery_required").map((result) => result.id), ...cleanupFailed].join("、"), details);
  }
  if (failed) {
    if (!results.length) throw failure;
    throw new WorkspaceError("WORK_CONFIG_INSTALL_FAILED", "工作配置安装失败（" + failedSkillId + "）；本次新安装已移至备份，已有 Skill 保留。请用 skill backups 查看后重试。", details);
  }
  return results;
}

function changedInstallation(): WorkspaceError {
  return new WorkspaceError("INSTALLATION_CHANGED", "当前安装与已选择的版本不一致，请重新查看差异或备份后再操作。");
}

// A directory replacement needs two renames on Windows as well as POSIX. Keep
// the old directory intact and restore it if publishing the replacement fails.
function replaceDirectory(root: string, id: string, source: string, destination: string): string {
  const backups = safeDirectory(root, [".agentrecall-skill-backups"], true);
  const backup = path.join(backups, `${id}-${randomUUID()}`);
  fs.renameSync(destination, backup);
  try { fs.renameSync(source, destination); }
  catch {
    try {
      if (statIfPresent(destination)) throw conflict();
      fs.renameSync(backup, destination);
    } catch {
      throw new WorkspaceError("SKILL_RECOVERY_REQUIRED", `替换失败，原版本仍保存在 ${backup}。请用 skill backups 查看，并在确认目标状态后运行 skill rollback。`);
    }
    throw new WorkspaceError("SKILL_REPLACE_FAILED", "替换未能完成，原安装已恢复。请检查目录权限或占用情况后重试。");
  }
  return backup;
}

export function diffProjectSkill(root: string, skill: TeamSkill, repository: string, commit: string, target: ProjectSkillTarget, file?: string) {
  const destination = skillDestination(root, skill.id, target);
  const { record, skill: installed } = inspectOwned(destination);
  if (record.repository !== repository || record.skillId !== skill.id) throw conflict();
  const before = new Map(installed.files.map((item) => [item.path, item]));
  const after = new Map(skill.files.map((item) => [item.path, item]));
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((name) => {
    const old = before.get(name);
    const next = after.get(name);
    if (old?.content === next?.content && old?.executable === next?.executable) return [];
    return [{ path: name, status: !old ? "added" : !next ? "removed" : "modified", beforeExecutable: old?.executable ?? null, afterExecutable: next?.executable ?? null }];
  });
  const display = (item: SkillFile | undefined) => {
    if (!item) return null;
    try { return { encoding: "utf8", content: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(item.content, "base64")) }; }
    catch { return { encoding: "base64", content: item.content }; }
  };
  if (file !== undefined && !before.has(file) && !after.has(file)) throw new WorkspaceError("SKILL_FILE_NOT_FOUND", "该文件不在新旧版本中，请从差异清单选择。");
  const result = {
    id: skill.id, path: destination, repository, fromRevision: record.commit, revision: commit, changes,
    ...(file !== undefined ? { file, before: display(before.get(file)), after: display(after.get(file)) } : {}),
  };
  // Include JSON escaping, wrappers and metadata in the emitted-value limit.
  if (Buffer.byteLength(JSON.stringify({ ok: true, data: result })) > MAX_SNAPSHOT_BYTES) throw new WorkspaceError("ASSETS_TOO_LARGE", "完整差异超过 16 MiB，请选择较小的文件。");
  return result;
}

const backupSuffix = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function listSkillBackups(root: string, id: string) {
  if (!assetId.safeParse(id).success) throw new WorkspaceError("INVALID_ARGUMENTS", "Skill ID 无效。");
  const installations = (["codex", "claude"] as const).map((target) => {
    try {
      const destination = skillDestination(root, id, target);
      if (!statIfPresent(destination)) return { target, status: "absent", revision: null };
      const { record } = inspectOwned(destination);
      if (record.skillId !== id) throw conflict();
      return { target, status: "installed", revision: record.commit };
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      return { target, status: "conflict", revision: null };
    }
  });
  const directory = safeDirectory(root, [".agentrecall-skill-backups"], false);
  const backups = [];
  for (const name of statIfPresent(directory) ? fs.readdirSync(directory).sort() : []) {
    if (!name.startsWith(`${id}-`) || !backupSuffix.test(name.slice(id.length + 1))) continue;
    if (backups.length >= 200) throw new WorkspaceError("ASSETS_TOO_LARGE", "此 Skill 的备份超过 200 个，请先在项目备份目录中整理旧备份。");
    try {
      const { record } = inspectOwned(path.join(directory, name));
      if (record.skillId !== id) throw conflict();
      backups.push({ backup: name, revision: record.commit, repository: record.repository, valid: true });
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      backups.push({ backup: name, revision: null, repository: null, valid: false });
    }
  }
  return { installations, backups };
}

export function rollbackProjectSkill(root: string, id: string, target: ProjectSkillTarget, backup: string, fromRevision: string | null) {
  const destination = skillDestination(root, id, target);
  if (!backup.startsWith(`${id}-`) || !backupSuffix.test(backup.slice(id.length + 1))) throw new WorkspaceError("INVALID_ARGUMENTS", "请使用 skill backups 返回的备份名称。");
  const directory = safeDirectory(root, [".agentrecall-skill-backups"], false);
  const source = path.join(directory, backup);
  const { record } = inspectOwned(source);
  if (record.skillId !== id) throw conflict();
  let backupPath: string | null = null;
  if (fromRevision === null) {
    if (statIfPresent(destination)) throw changedInstallation();
    skillDestination(root, id, target, true);
    fs.renameSync(source, destination);
  } else {
    const { record: current } = inspectOwned(destination);
    if (current.repository !== record.repository || current.skillId !== id) throw conflict();
    if (current.commit !== fromRevision) throw changedInstallation();
    backupPath = replaceDirectory(root, id, source, destination);
  }
  return { status: "restored" as const, path: destination, commit: record.commit, backupPath };
}
