import fs from "node:fs/promises";
import { renameSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceService } from "./workspace.js";
import { WorkspaceError, hasErrorCode } from "./errors.js";
import { GitAssetSource, type AssetTransport } from "./git-assets.js";
import { MAX_SNAPSHOT_BYTES, validateSnapshot, type AssetSnapshot, type WorkConfig } from "./asset-format.js";
import { readBoundedJson, withAssetLock } from "./asset-storage.js";
import { canonicalGitHubRepository, inspectCheckout } from "./git.js";
import { ProjectWorkConfigs } from "./project-work-configs.js";
import { diffProjectSkill, listSkillBackups, installProjectSkills, prepareSkillInstall, previewSkillInstall, rollbackProjectSkill, skillDestination, uninstallProjectSkill, type ProjectSkillTarget } from "./project-skills.js";

type Context = Awaited<ReturnType<WorkspaceService["currentTeam"]>>;
type AssetSelection = { projectId: string; root: string; repository?: string };

export class TeamAssetService {
  private readonly cacheDirectory: string;
  constructor(private readonly workspace: WorkspaceService, private readonly source = new GitAssetSource(), private readonly selection?: AssetSelection) {
    this.cacheDirectory = path.join(path.dirname(workspace.store.filePath), "assets");
  }

  async initialize(repository: string, name?: string, transport: AssetTransport = "https", signal?: AbortSignal) {
    const canonical = canonicalGitHubRepository(repository);
    if (!["https", "ssh"].includes(transport) || name !== undefined && (!name.trim() || name.trim().length > 200)) {
      throw new WorkspaceError("INVALID_ARGUMENTS", "请使用 https 或 ssh，名称需为 1—200 个字符。");
    }
    if (signal?.aborted) throw new WorkspaceError("CANCELLED", "初始化已取消。");
    const before = await this.workspace.store.initialize();
    if (before.teams.filter((team) => team.repository === canonical).length > 1) {
      throw new WorkspaceError("AMBIGUOUS_TEAM", "这个仓库已登记为多个团队，请先整理重复的团队配置后再初始化。");
    }
    const directory = path.dirname(this.workspace.store.filePath);
    const staging = path.join(directory, "initialization");
    // Separate lock target: config writes acquire their own lock while init is in flight.
    return withAssetLock(staging, ".init.lock", async (assertOwned) => {
      const scratch = await fs.mkdtemp(path.join(staging, ".init-"));
      let remoteReady = false;
      let localReady = false;
      try {
        const result = await this.source.initialize(canonical, scratch, transport, assertOwned, signal);
        remoteReady = true;
        let config;
        try {
          config = await this.workspace.store.update((current) => {
            assertOwned();
            if (signal?.aborted) throw new WorkspaceError("CANCELLED", "初始化已取消。");
            const matches = current.teams.filter((team) => team.repository === canonical);
            if (matches.length > 1) throw new WorkspaceError("AMBIGUOUS_TEAM", "这个仓库对应多个团队，请先整理重复配置。");
            if (matches.length) return current;
            return { ...current, teams: [...current.teams, { id: `team-${randomUUID()}`, name: name?.trim() ?? canonical.slice("https://github.com/".length), repository: canonical }] };
          });
          localReady = true;
        } catch {
          throw new WorkspaceError("INIT_LOCAL_CONFIG_FAILED", "远端资产仓库已就绪，但本地团队配置未保存。请检查配置文件、权限或锁后重新执行 init；不会覆盖远端已有内容。", { repository: canonical, commit: result.snapshot.commit, remoteCreated: result.created });
        }
        return {
          team: config.teams.find((team) => team.repository === canonical)!,
          created: result.created, commit: result.snapshot.commit, teamEnabled: config.teamEnabled,
          skills: result.snapshot.skills.length,
          workConfigs: "workConfigs" in result.snapshot ? result.snapshot.workConfigs.length : 0,
        };
      } finally {
        try { await fs.rm(scratch, { recursive: true, force: true }); }
        catch { throw new WorkspaceError("INIT_CLEANUP_FAILED", "初始化临时目录未能清理，请检查目录权限并重试。", { directory: scratch, remoteReady, localReady }); }
      }
    });
  }

  private async currentTeam(directory: string, projectId?: string): Promise<Context> {
    const context = await this.workspace.currentTeam(directory, projectId);
    if (this.selection && (context.project.id !== this.selection.projectId || context.project.root !== this.selection.root
      || this.selection.repository !== undefined && context.team.repository !== this.selection.repository)) {
      throw new WorkspaceError("TEAM_CHANGED", "选中的项目或资产来源已改变，请刷新后重新选择。");
    }
    return context;
  }

  private async commitForTeam<T>(directory: string, expected: Context, action: (assertOwned: () => void) => T | Promise<T>): Promise<T> {
    // Use the config writer's lock only for the final check and commit, so disabling
    // a team can proceed while a network operation is still in flight.
    return withAssetLock(path.dirname(this.workspace.store.filePath), ".config.lock", async (assertOwned) => {
      const current = await this.currentTeam(directory, expected.project.id);
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new WorkspaceError("TEAM_CHANGED", "项目或团队配置已改变，本次操作取消，请重新选择。");
      assertOwned();
      return action(assertOwned);
    });
  }

  async sync(directory: string, projectId?: string, transport: AssetTransport = "https", signal?: AbortSignal) {
    const context = await this.currentTeam(directory, projectId);
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
    const context = await this.currentTeam(directory, projectId);
    const snapshot = await this.snapshot(context);
    return this.commitForTeam(directory, context, () => ({
      teamId: context.team.id, repository: snapshot.repository, commit: snapshot.commit,
      skills: snapshot.skills.map((skill) => ({ id: skill.id, description: skill.description, files: skill.files.length, digest: skill.digest })),
      workConfigs: "workConfigs" in snapshot ? snapshot.workConfigs : [],
      documents: snapshot.schemaVersion === 3 ? snapshot.documents.map(({ content: _content, ...document }) => document) : [],
    }));
  }

  async previewDocument(directory: string, id: string, projectId?: string) {
    const context = await this.currentTeam(directory, projectId);
    const snapshot = await this.snapshot(context);
    const document = snapshot.schemaVersion === 3 ? snapshot.documents.find((item) => item.id === id) : undefined;
    if (!document) throw new WorkspaceError("DOCUMENT_NOT_FOUND", "当前团队没有这份文档，请同步后重试。");
    const root = await this.projectRoot(directory, context.project.id);
    const destination = path.join(root, ...document.target.split("/"));
    const local = await this.localDocument(root, document.target);
    return this.commitForTeam(directory, context, () => ({ ...document, repository: snapshot.repository, commit: snapshot.commit, destination,
      local, status: local === null ? "new" as const : local === document.content ? "existing" as const : "conflict" as const }));
  }

  private async localDocument(root: string, target: string): Promise<string | null> {
    let current = root;
    const parts = target.split("/");
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) { if (hasErrorCode(error, "ENOENT")) return null; throw error; }
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new WorkspaceError("DOCUMENT_CONFLICT", "文档路径包含链接或非普通文件，已停止应用。");
    }
    const handle = await fs.open(current, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024 + 1); let length = 0;
      while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
      if (length > 1024 * 1024) throw new WorkspaceError("DOCUMENT_CONFLICT", "本地文档超过 1 MiB，请在编辑器中手动比较。");
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
      catch { throw new WorkspaceError("DOCUMENT_CONFLICT", "本地文件不是 UTF-8 文本，已停止应用。"); }
    } finally { await handle.close(); }
  }

  async installDocument(directory: string, id: string, commit: string, projectId?: string) {
    const context = await this.currentTeam(directory, projectId);
    const root = await this.projectRoot(directory, context.project.id);
    return withAssetLock(root, ".agentrecall-document.lock", async (assertOwned) => {
      const snapshot = await this.snapshot(context);
      if (snapshot.commit !== commit) throw new WorkspaceError("SNAPSHOT_CHANGED", "文档版本已改变，请重新预览。");
      const document = snapshot.schemaVersion === 3 ? snapshot.documents.find((item) => item.id === id) : undefined;
      if (!document) throw new WorkspaceError("DOCUMENT_NOT_FOUND", "找不到指定文档。");
      return this.commitForTeam(directory, context, async () => {
        assertOwned();
        const local = await this.localDocument(root, document.target);
        if (local === document.content) return { status: "existing" as const };
        if (local !== null) throw new WorkspaceError("DOCUMENT_CONFLICT", "本地已有不同内容，请先手动合并；不会覆盖原文件。");
        const destination = path.join(root, ...document.target.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await this.localDocument(root, document.target);
        assertOwned();
        const temporary = path.join(root, `.agentrecall-document-${randomUUID()}.tmp`);
        try {
          const handle = await fs.open(temporary, "wx", 0o600);
          try { await handle.writeFile(document.content); await handle.sync(); } finally { await handle.close(); }
          await this.localDocument(root, document.target);
          assertOwned();
          try { await fs.link(temporary, destination); }
          catch (error) { if (hasErrorCode(error, "EEXIST")) throw new WorkspaceError("DOCUMENT_CONFLICT", "目标文件刚刚被创建，请重新预览。"); throw error; }
        } finally { await fs.rm(temporary, { force: true }); }
        return { status: "installed" as const, digest: createHash("sha256").update(document.content).digest("hex") };
      });
    });
  }

  private findWorkConfig(snapshot: AssetSnapshot, id: string): WorkConfig {
    const config = "workConfigs" in snapshot ? snapshot.workConfigs.find((item) => item.id === id) : undefined;
    if (!config) throw new WorkspaceError("WORK_CONFIG_NOT_FOUND", "当前团队中找不到这个工作配置；请确认资产仓库使用 schemaVersion 2 并先运行 work-config list。");
    return config;
  }

  async listWorkConfigs(directory: string, projectId?: string) {
    const context = await this.currentTeam(directory, projectId);
    const snapshot = await this.snapshot(context);
    return this.commitForTeam(directory, context, () => ({
      teamId: context.team.id, repository: snapshot.repository, commit: snapshot.commit,
      workConfigs: "workConfigs" in snapshot ? snapshot.workConfigs : [],
    }));
  }

  async previewWorkConfig(directory: string, id: string, projectId?: string, target?: ProjectSkillTarget) {
    const context = await this.currentTeam(directory, projectId);
    const snapshot = await this.snapshot(context);
    const config = this.findWorkConfig(snapshot, id);
    const root = target ? await this.projectRoot(directory, context.project.id) : undefined;
    const preview = () => {
      const skills = config.skills.map((id) => snapshot.skills.find((skill) => skill.id === id)!);
      let configurationConflict: string | null = null;
      let installedRevision: string | null = null;
      if (root && target) {
        const records = new ProjectWorkConfigs(root);
        installedRevision = records.state.configs.find((item) => item.id === id && item.target === target)?.revision ?? null;
        try { records.prepareInstall(config, snapshot.repository, snapshot.commit, target, skills); }
        catch (error) { if (!(error instanceof WorkspaceError)) throw error; configurationConflict = error.message; }
      }
      return {
        teamId: context.team.id, repository: snapshot.repository, commit: snapshot.commit,
        id: config.id, name: config.name, description: config.description, target: target ?? null, installedRevision, configurationConflict,
        skills: skills.map((skill) => ({
          id: skill.id, description: skill.description, files: skill.files.length, digest: skill.digest,
          ...(root && target ? previewSkillInstall(root, skill, snapshot.repository, target)
            : { destination: null, status: "unselected" as const, installedRevision: null, reason: null }),
        })),
      };
    };
    if (!root) return this.commitForTeam(directory, context, preview);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => this.commitForTeam(root, context, () => {
      assertOwned();
      return preview();
    }));
  }

  async installWorkConfig(directory: string, id: string, target: ProjectSkillTarget, commit: string, projectId?: string) {
    const context = await this.currentTeam(directory, projectId);
    const root = await this.projectRoot(directory, context.project.id);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      const snapshot = await this.snapshot(context);
      if (snapshot.commit !== commit) throw new WorkspaceError("SNAPSHOT_CHANGED", "资产版本与预览不一致，请重新预览并使用返回的 --revision。");
      const config = this.findWorkConfig(snapshot, id);
      const skills = config.skills.map((skillId) => snapshot.skills.find((skill) => skill.id === skillId)!);
      const recordInstallation = new ProjectWorkConfigs(root).prepareInstall(config, snapshot.repository, snapshot.commit, target, skills);
      const installed = await installProjectSkills(root, skills, snapshot.repository, snapshot.commit, target,
        (publish) => this.commitForTeam(root, context, (assertConfigOwned) => publish(() => { assertOwned(); assertConfigOwned(); })), recordInstallation);
      return { workConfigId: config.id, name: config.name, path: root, commit, skills: installed };
    });
  }

  async installedWorkConfigs(directory: string, projectId?: string) {
    const root = await this.projectRoot(directory, projectId);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      assertOwned();
      return new ProjectWorkConfigs(root).state.configs;
    });
  }

  async diffWorkConfig(directory: string, id: string, target: ProjectSkillTarget, projectId?: string) {
    const context = await this.currentTeam(directory, projectId);
    const root = await this.projectRoot(directory, context.project.id);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      const snapshot = await this.snapshot(context);
      const config = this.findWorkConfig(snapshot, id);
      const skills = config.skills.map((id) => snapshot.skills.find((skill) => skill.id === id)!);
      return this.commitForTeam(root, context, (assertConfigOwned) => new ProjectWorkConfigs(root).planUpdate(config, snapshot.repository, snapshot.commit, target, skills, () => { assertOwned(); assertConfigOwned(); }));
    });
  }

  async updateWorkConfig(directory: string, id: string, target: ProjectSkillTarget, fromRevision: string, commit: string, projectId?: string) {
    const context = await this.currentTeam(directory, projectId);
    const root = await this.projectRoot(directory, context.project.id);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      const snapshot = await this.snapshot(context);
      if (snapshot.commit !== commit) throw new WorkspaceError("SNAPSHOT_CHANGED", "缓存与选定的新版本不同，请重新查看 work-config diff。");
      const config = this.findWorkConfig(snapshot, id);
      const skills = config.skills.map((id) => snapshot.skills.find((skill) => skill.id === id)!);
      return new ProjectWorkConfigs(root).update(config, snapshot.repository, snapshot.commit, target, skills, fromRevision, assertOwned,
        (publish) => this.commitForTeam(root, context, (assertConfigOwned) => publish(() => { assertOwned(); assertConfigOwned(); })));
    });
  }

  async workConfigStatus(directory: string, id: string, target: ProjectSkillTarget, projectId?: string) {
    const root = await this.projectRoot(directory, projectId);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      assertOwned();
      return new ProjectWorkConfigs(root).status(id, target);
    });
  }

  async uninstallWorkConfig(directory: string, id: string, target: ProjectSkillTarget, commit: string, projectId?: string) {
    const root = await this.projectRoot(directory, projectId);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      assertOwned();
      const records = new ProjectWorkConfigs(root);
      if (this.selection?.repository && records.status(id, target).repository !== this.selection.repository) throw new WorkspaceError("TEAM_CHANGED", "选中的安装来源已改变，请重新查看状态。");
      return records.uninstall(id, target, commit, assertOwned);
    });
  }

  async preview(directory: string, id: string, projectId?: string, target?: ProjectSkillTarget, file = "SKILL.md") {
    const context = await this.currentTeam(directory, projectId);
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
    if (this.selection && (status.project.id !== this.selection.projectId || checkout.root !== this.selection.root)) throw new WorkspaceError("PROJECT_MISMATCH", "项目绑定已改变，请刷新后重试。");
    return checkout.root;
  }

  async diff(directory: string, id: string, target: ProjectSkillTarget, projectId?: string, file?: string) {
    const context = await this.currentTeam(directory, projectId);
    const root = await this.projectRoot(directory, context.project.id);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      const snapshot = await this.snapshot(context);
      const skill = snapshot.skills.find((item) => item.id === id);
      if (!skill) throw new WorkspaceError("SKILL_NOT_FOUND", "当前团队中找不到这个 Skill。");
      return this.commitForTeam(root, context, () => {
        assertOwned();
        return diffProjectSkill(root, skill, snapshot.repository, snapshot.commit, target, file);
      });
    });
  }

  async install(directory: string, id: string, target: ProjectSkillTarget, commit: string, projectId?: string, fromRevision?: string) {
    const context = await this.currentTeam(directory, projectId);
    const root = await this.projectRoot(directory, context.project.id);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      new ProjectWorkConfigs(root).assertUnreferenced(id, target);
      const snapshot = await this.snapshot(context);
      if (snapshot.commit !== commit) throw new WorkspaceError("SNAPSHOT_CHANGED", "资产版本与预览不一致，请重新预览并使用返回的 --revision。");
      const skill = snapshot.skills.find((item) => item.id === id);
      if (!skill) throw new WorkspaceError("SKILL_NOT_FOUND", "当前团队中找不到这个 Skill。");
      const prepared = prepareSkillInstall(root, skill, snapshot.repository, snapshot.commit, target, fromRevision);
      try {
        return await this.commitForTeam(root, context, () => {
          assertOwned();
          new ProjectWorkConfigs(root).assertUnreferenced(id, target);
          return prepared.commit();
        });
      } finally { prepared.cleanup(); }
    });
  }

  async backups(directory: string, id: string, projectId?: string) {
    const root = await this.projectRoot(directory, projectId);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      assertOwned();
      return listSkillBackups(root, id);
    });
  }

  async rollback(directory: string, id: string, target: ProjectSkillTarget, backup: string, fromRevision: string | null, projectId?: string) {
    // Local recovery does not fetch team assets and remains available when disabled.
    const root = await this.projectRoot(directory, projectId);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      assertOwned();
      new ProjectWorkConfigs(root).assertUnreferenced(id, target);
      return rollbackProjectSkill(root, id, target, backup, fromRevision);
    });
  }

  async uninstall(directory: string, id: string, target: ProjectSkillTarget, projectId?: string) {
    // Explicit cleanup remains available when team access is disabled or removed.
    const root = await this.projectRoot(directory, projectId);
    return withAssetLock(root, ".agentrecall-skill-install.lock", async (assertOwned) => {
      assertOwned();
      new ProjectWorkConfigs(root).assertUnreferenced(id, target);
      return uninstallProjectSkill(root, id, target);
    });
  }
}
