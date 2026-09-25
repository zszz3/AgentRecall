import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { assetId, revision, type TeamSkill, type WorkConfig } from "./asset-format.js";
import { WorkspaceError, hasErrorCode } from "./errors.js";
import { inspectProjectSkill, rollbackProjectSkill, uninstallProjectSkill, type ProjectSkillTarget, type SkillInstallResult } from "./project-skills.js";

const targetSchema = z.enum(["codex", "claude"]);
const repositorySchema = z.string().regex(/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  configs: z.array(z.strictObject({
    id: assetId, name: z.string().min(1).max(200), target: targetSchema,
    repository: repositorySchema, revision, skills: z.array(assetId).min(1).max(64),
  })).max(64),
  skills: z.array(z.strictObject({
    id: assetId, target: targetSchema, repository: repositorySchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/), removable: z.boolean(),
  })).max(256),
});
type State = z.infer<typeof stateSchema>;
const maximum = 1024 * 1024;

function invalidState(): WorkspaceError {
  return new WorkspaceError("INVALID_WORK_CONFIG_STATE", "项目的工作配置记录损坏、版本不支持或包含链接，已停止修改。请恢复记录文件的备份后重试。");
}

function validateState(value: unknown): State {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) throw invalidState();
  const state = parsed.data;
  const keys = (items: Array<{ target: string; id: string }>) => new Set(items.map((item) => item.target + ":" + item.id)).size;
  if (keys(state.configs) !== state.configs.length || keys(state.skills) !== state.skills.length) throw invalidState();
  for (const config of state.configs) {
    if (new Set(config.skills).size !== config.skills.length || config.skills.some((id) =>
      !state.skills.some((skill) => skill.target === config.target && skill.id === id && skill.repository === config.repository))) throw invalidState();
  }
  if (state.skills.some((skill) => !state.configs.some((config) => config.target === skill.target && config.skills.includes(skill.id)))) throw invalidState();
  if (Buffer.byteLength(JSON.stringify(state)) > maximum) throw new WorkspaceError("WORK_CONFIG_STATE_TOO_LARGE", "完整工作配置记录超过 1 MiB，请减少配置后重试。");
  return state;
}

function readRecord(file: string): string | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (hasErrorCode(error, "ENOENT")) return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalidState();
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > maximum) throw new WorkspaceError("WORK_CONFIG_STATE_TOO_LARGE", "完整工作配置记录超过 1 MiB，已停止读取和修改。");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { throw invalidState(); }
  } finally { fs.closeSync(descriptor); }
}

// Callers hold the project's Skill lock for this object's entire lifetime.
export class ProjectWorkConfigs {
  readonly state: State;
  private readonly file: string;
  private original: string | null;

  constructor(private readonly root: string) {
    this.file = path.join(root, ".agentrecall-work-configs.json");
    this.original = readRecord(this.file);
    let value: unknown = { schemaVersion: 1, configs: [], skills: [] };
    if (this.original !== null) {
      try { value = JSON.parse(this.original); }
      catch { throw invalidState(); }
    }
    this.state = validateState(value);
  }

  private save(state: State): void {
    const serialized = JSON.stringify(validateState(state));
    if (readRecord(this.file) !== this.original) throw new WorkspaceError("WORK_CONFIG_STATE_CHANGED", "工作配置记录已被其他操作修改，请重新查看状态后重试。");
    const temporary = path.join(this.root, ".agentrecall-work-configs-" + randomUUID() + ".tmp");
    let published = false;
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(descriptor, serialized); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      if (readRecord(this.file) !== this.original) throw new WorkspaceError("WORK_CONFIG_STATE_CHANGED", "工作配置记录已改变，本次修改取消。");
      fs.renameSync(temporary, this.file);
      published = true;
      this.original = serialized;
    } finally { if (!published) fs.rmSync(temporary, { force: true }); }
  }

  assertUnreferenced(id: string, target: ProjectSkillTarget): void {
    const references = this.state.configs.filter((config) => config.target === target && config.skills.includes(id));
    if (references.length) throw new WorkspaceError("SKILL_IN_USE", "该 Skill 正由工作配置引用：" + references.map((config) => config.id).join("、") + "。请先通过 work-config status 查看，并卸载相关配置后再单独修改。");
  }

  prepareInstall(config: WorkConfig, repository: string, commit: string, target: ProjectSkillTarget, skills: TeamSkill[]) {
    const previous = this.state.configs.find((item) => item.id === config.id && item.target === target);
    if (previous && (previous.repository !== repository || previous.revision !== commit || JSON.stringify(previous.skills) !== JSON.stringify(config.skills))) {
      throw new WorkspaceError("WORK_CONFIG_CHANGED", "这个客户端已安装同名工作配置的其他版本或来源。请先查看并卸载原配置，再选择新版本安装。");
    }
    const next = structuredClone(this.state);
    if (!previous) next.configs.push({ id: config.id, name: config.name, repository, revision: commit, target, skills: config.skills });
    const newIds = new Set<string>();
    for (const skill of skills) {
      const existing = next.skills.find((item) => item.id === skill.id && item.target === target);
      if (existing && (existing.repository !== repository || existing.digest !== skill.digest)) throw new WorkspaceError("SKILL_IN_USE", "共享 Skill " + skill.id + " 与其他工作配置要求的内容不同，请先处理原配置。");
      if (!existing) {
        newIds.add(skill.id);
        next.skills.push({ id: skill.id, target, repository, digest: skill.digest, removable: false });
      }
    }
    validateState(next);
    return (results: SkillInstallResult[]) => {
      for (const skill of next.skills) {
        if (skill.target === target && newIds.has(skill.id)) skill.removable = results.some((result) => result.id === skill.id && result.status === "installed");
      }
      this.save(next);
    };
  }

  status(id: string, target: ProjectSkillTarget) {
    const config = this.state.configs.find((item) => item.id === id && item.target === target);
    if (!config) throw new WorkspaceError("WORK_CONFIG_NOT_INSTALLED", "此项目和客户端没有这个工作配置的安装记录，请先运行 work-config installed。");
    return {
      ...config,
      skills: config.skills.map((id) => {
        const expected = this.state.skills.find((skill) => skill.target === target && skill.id === id)!;
        const otherConfigs = this.state.configs.filter((item) => item.target === target && item.id !== config.id && item.skills.includes(id)).map((item) => item.id);
        let state: "ready" | "missing" | "conflict" = "ready";
        try {
          const actual = inspectProjectSkill(this.root, id, target);
          if (!actual) state = "missing";
          else if (actual.repository !== expected.repository || actual.skillId !== id || actual.digest !== expected.digest) state = "conflict";
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error;
          state = "conflict";
        }
        const action = otherConfigs.length ? "keep_shared" as const : !expected.removable ? "keep_independent" as const : state === "missing" ? "missing" as const : "backup" as const;
        return { id, state, action, otherConfigs };
      }),
    };
  }

  async uninstall(id: string, target: ProjectSkillTarget, commit: string, assertOwned: () => void) {
    const plan = this.status(id, target);
    if (plan.revision !== commit) throw new WorkspaceError("INSTALLATION_CHANGED", "工作配置版本与选择不一致，请重新运行 work-config status。");
    if (plan.skills.some((skill) => skill.action === "backup" && skill.state !== "ready")) throw new WorkspaceError("SKILL_CONFLICT", "需要卸载的 Skill 有本地修改或格式损坏，整个配置尚未卸载，请先检查并保存修改。");
    const next = structuredClone(this.state);
    next.configs = next.configs.filter((config) => config.id !== id || config.target !== target);
    next.skills = next.skills.filter((skill) => next.configs.some((config) => config.target === skill.target && config.skills.includes(skill.id)));
    const moved: Array<{ id: string; backupPath: string; state: "backed_up" | "restored" | "recovery_required" }> = [];
    try {
      for (const skill of plan.skills) {
        assertOwned();
        if (skill.action === "backup") {
          // Revalidate immediately before moving; the preflight is only a preview.
          const expected = this.state.skills.find((item) => item.id === skill.id && item.target === target)!;
          const actual = inspectProjectSkill(this.root, skill.id, target);
          if (!actual || actual.skillId !== skill.id || actual.repository !== expected.repository || actual.digest !== expected.digest) throw new WorkspaceError("SKILL_CONFLICT", "Skill 在卸载前发生变化，已停止处理。");
          const removed = uninstallProjectSkill(this.root, skill.id, target);
          moved.push({ id: skill.id, backupPath: removed.backupPath, state: "backed_up" });
        }
        await setImmediate();
      }
      assertOwned();
      this.save(next);
    } catch (error) {
      for (const item of [...moved].reverse()) {
        try {
          rollbackProjectSkill(this.root, item.id, target, path.basename(item.backupPath), null);
          item.state = "restored";
        } catch {
          // Keep backups and original ownership when a directory cannot be restored.
          item.state = "recovery_required";
        }
        await setImmediate();
      }
      if (moved.some((item) => item.state === "recovery_required")) throw new WorkspaceError("WORK_CONFIG_RECOVERY_REQUIRED", "工作配置卸载未完成，部分 Skill 仍在备份目录。请用 work-config status 核对后重试卸载，或重新安装原配置补齐缺失项。", { skills: moved });
      if (!moved.length) throw error;
      throw new WorkspaceError("WORK_CONFIG_UNINSTALL_FAILED", "工作配置卸载失败，已恢复移动的 Skill，安装记录保留。请检查文件权限后重试。", { causeCode: error instanceof WorkspaceError ? error.code : "FILE_OPERATION_FAILED", skills: moved });
    }
    return { id, target, revision: commit, skills: plan.skills, backups: moved };
  }
}
