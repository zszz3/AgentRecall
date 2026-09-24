import fs from "node:fs/promises";
import { renameSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceError, hasErrorCode } from "./errors.js";
import { GitAssetSource, type AssetTransport } from "./git-assets.js";
import { MAX_SNAPSHOT_BYTES, validateSnapshot, type AssetSnapshot } from "./asset-format.js";
import { readBoundedJson, withAssetLock } from "./asset-storage.js";
import { inspectCheckout } from "./git.js";
import { prepareSkillInstall, skillDestination, uninstallProjectSkill, type ProjectSkillTarget } from "./project-skills.js";

type Context = Awaited<ReturnType<WorkspaceService["currentTeam"]>>;

export class TeamAssetService {
  private readonly cacheDirectory: string;
  constructor(private readonly workspace: WorkspaceService, private readonly source = new GitAssetSource()) {
    this.cacheDirectory = path.join(path.dirname(workspace.store.filePath), "assets");
  }

  private async commitForTeam<T>(directory: string, expected: Context, action: () => T): Promise<T> {
    // Use the config writer's lock only for the final check and commit, so disabling
    // a team can proceed while a network operation is still in flight.
    return withAssetLock(path.dirname(this.workspace.store.filePath), ".config.lock", async (assertOwned) => {
      const current = await this.workspace.currentTeam(directory, expected.project.id);
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new WorkspaceError("TEAM_CHANGED", "项目或团队配置已改变，本次操作取消，请重新选择。");
      assertOwned();
      return action();
    });
  }

  async sync(directory: string, projectId?: string, transport: AssetTransport = "https", signal?: AbortSignal) {
    const context = await this.workspace.currentTeam(directory, projectId);
    if (!["https", "ssh"].includes(transport)) throw new WorkspaceError("INVALID_ARGUMENTS", "传输方式只能是 https 或 ssh。");
    return withAssetLock(this.cacheDirectory, `.${context.team.id}.lock`, async (assertOwned) => {
      const scratch = await fs.mkdtemp(path.join(this.cacheDirectory, ".download-"));
      const temporary = path.join(this.cacheDirectory, `.snapshot-${randomUUID()}.tmp`);
      try {
        const snapshot = await this.source.load(context.team.repository, scratch, transport, signal);
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(snapshot)); await handle.sync(); } finally { await handle.close(); }
        return await this.commitForTeam(directory, context, () => {
          if (signal?.aborted) throw new WorkspaceError("CANCELLED", "同步已取消，已有缓存保留。");
          assertOwned();
          renameSync(temporary, path.join(this.cacheDirectory, `${context.team.id}.json`));
          return { teamId: context.team.id, repository: snapshot.repository, commit: snapshot.commit, skills: snapshot.skills.length };
        });
      } finally {
        try { await fs.rm(temporary, { force: true }); }
        finally { await fs.rm(scratch, { recursive: true, force: true }); }
      }
    });
  }

  private async snapshot(context: Context): Promise<AssetSnapshot> {
    let value: unknown;
    try { value = await readBoundedJson(path.join(this.cacheDirectory, `${context.team.id}.json`), MAX_SNAPSHOT_BYTES); }
    catch (error) {
      if (hasErrorCode(error, "ENOENT")) throw new WorkspaceError("ASSETS_NOT_SYNCED", "此团队还没有资产缓存，请先运行 agentrecall team sync。");
      throw error;
    }
    return validateSnapshot(value, context.team.repository);
  }

  async list(directory: string, projectId?: string) {
    const context = await this.workspace.currentTeam(directory, projectId);
    const snapshot = await this.snapshot(context);
    return this.commitForTeam(directory, context, () => ({
      teamId: context.team.id, repository: snapshot.repository, commit: snapshot.commit,
      skills: snapshot.skills.map((skill) => ({ id: skill.id, description: skill.description, files: skill.files.length, digest: skill.digest })),
    }));
  }

  async preview(directory: string, id: string, projectId?: string, target?: ProjectSkillTarget, file = "SKILL.md") {
    const context = await this.workspace.currentTeam(directory, projectId);
    const snapshot = await this.snapshot(context);
    const skill = snapshot.skills.find((item) => item.id === id);
    if (!skill) throw new WorkspaceError("SKILL_NOT_FOUND", "当前团队中找不到这个 Skill，请先运行 skill list。");
    const selected = skill.files.find((item) => item.path === file);
    if (!selected) throw new WorkspaceError("SKILL_FILE_NOT_FOUND", "Skill 中没有该文件，请从预览的文件清单中选择。");
    let content: string;
    let encoding: "utf8" | "base64" = "utf8";
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(selected.content, "base64")); }
    catch { content = selected.content; encoding = "base64"; }
    const root = target ? await this.projectRoot(directory, context.project.id) : undefined;
    return this.commitForTeam(directory, context, () => ({
      teamId: context.team.id, repository: snapshot.repository, commit: snapshot.commit, id: skill.id, description: skill.description,
      file, content, encoding,
      files: skill.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.content, "base64").length, executable: file.executable })),
      ...(root && target ? { destination: skillDestination(root, id, target) } : {}),
    }));
  }

  private async projectRoot(directory: string, projectId?: string): Promise<string> {
    const status = await this.workspace.status(directory, projectId);
    if (!status.project) throw new WorkspaceError("NO_PROJECT", "请进入已登记的项目或使用 --project。");
    const checkout = await inspectCheckout(directory) ?? await inspectCheckout(status.project.root);
    if (!checkout) throw new WorkspaceError("NO_PROJECT", "本地项目路径已不存在，请重新登记项目。");
    await this.workspace.status(checkout.root, status.project.id);
    return checkout.root;
  }

  async install(directory: string, id: string, target: ProjectSkillTarget, commit: string, projectId?: string) {
    const context = await this.workspace.currentTeam(directory, projectId);
    const root = await this.projectRoot(directory, context.project.id);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      const snapshot = await this.snapshot(context);
      if (snapshot.commit !== commit) throw new WorkspaceError("SNAPSHOT_CHANGED", "资产版本与预览不一致，请重新预览并使用返回的 --revision。");
      const skill = snapshot.skills.find((item) => item.id === id);
      if (!skill) throw new WorkspaceError("SKILL_NOT_FOUND", "当前团队中找不到这个 Skill。");
      const prepared = prepareSkillInstall(root, skill, snapshot.repository, snapshot.commit, target);
      try {
        return await this.commitForTeam(root, context, () => { assertOwned(); return prepared.commit(); });
      } finally { prepared.cleanup(); }
    });
  }

  async uninstall(directory: string, id: string, target: ProjectSkillTarget, projectId?: string) {
    // Explicit cleanup remains available when team access is disabled or removed.
    const root = await this.projectRoot(directory, projectId);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      assertOwned();
      return uninstallProjectSkill(root, id, target);
    });
  }
}
