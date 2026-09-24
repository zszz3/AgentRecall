import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assetId, portableAssetPath, revision, MAX_FILE_BYTES, type TeamSkill } from "./asset-format.js";
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

function inspectOwned(directory: string): Ownership {
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
  for (const file of record.files) {
    if (!files.some((name) => name.normalize("NFC") === file.path.normalize("NFC"))) throw conflict();
    const location = path.join(directory, ...file.path.split("/"));
    const current = fs.lstatSync(location);
    if (!current.isFile() || current.size > MAX_FILE_BYTES || current.isSymbolicLink()) throw conflict();
    if (createHash("sha256").update(fs.readFileSync(location)).digest("hex") !== file.sha256
      || process.platform !== "win32" && Boolean(current.mode & 0o111) !== file.executable) throw conflict();
  }
  return record;
}

function conflict(): WorkspaceError {
  return new WorkspaceError("SKILL_CONFLICT", "目标 Skill 已存在、未经本工具管理或有本地修改，已保留原内容。请先检查并备份，不会自动覆盖。");
}

export function prepareSkillInstall(root: string, skill: TeamSkill, repository: string, commit: string, target: ProjectSkillTarget) {
  const destination = skillDestination(root, skill.id, target);
  const ownership: Ownership = {
    schemaVersion: 1, repository, commit, skillId: skill.id, digest: skill.digest,
    files: skill.files.map((file) => ({ path: file.path, executable: file.executable, sha256: createHash("sha256").update(Buffer.from(file.content, "base64")).digest("hex") })),
  };
  const verifyExisting = () => {
    const existing = inspectOwned(destination);
    if (existing.repository !== repository || existing.skillId !== skill.id || existing.digest !== skill.digest) throw conflict();
    return { status: "existing" as const, path: destination, commit: existing.commit };
  };
  if (statIfPresent(destination)) {
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
      if (statIfPresent(destination)) throw conflict();
      fs.renameSync(staging, destination);
      return { status: "installed" as const, path: destination, commit };
    }, cleanup,
  };
}

export function uninstallProjectSkill(root: string, id: string, target: ProjectSkillTarget) {
  const destination = skillDestination(root, id, target);
  const record = inspectOwned(destination);
  if (record.skillId !== id) throw conflict();
  const backups = safeDirectory(root, [".agentrecall-skill-backups"], true);
  const backup = path.join(backups, `${id}-${randomUUID()}`);
  fs.renameSync(destination, backup);
  return { status: "uninstalled" as const, path: destination, backupPath: backup };
}
