import { WorkspaceError, WorkspaceService, TeamAssetService } from "@agentrecall/workspace-core";
import path from "node:path";
import type { TeamPayload, TeamReply, TeamRequest } from "../../shared/ipc/team-workspace";

interface TeamDialogs {
  chooseFolder(owner: number): Promise<string | null>;
  confirm(owner: number, message: string): Promise<boolean>;
}

const writes = new Set<TeamRequest["action"]>(["enable", "add-team", "default-team", "add-project", "bind-project", "remove-project", "sync", "skill-install", "work-install", "work-update", "work-uninstall"]);

export class TeamWorkspaceService {
  private closed = false;
  private busy = false;
  private sync: { owner: number; abort: AbortController } | null = null;
  private readonly pending = new Set<Promise<TeamPayload>>();

  constructor(private readonly directory: string, private readonly dialogs: TeamDialogs) {}

  cancel(owner: number): void {
    if (this.sync?.owner === owner) this.sync.abort.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sync?.abort.abort();
    await Promise.allSettled([...this.pending]);
  }

  async request(owner: number, request: TeamRequest): Promise<TeamReply> {
    try {
      if (this.closed) throw new WorkspaceError("TEAM_CLOSED", "团队服务正在关闭，请稍后重试。");
      if (!this.directory.trim()) throw new WorkspaceError("INVALID_ARGUMENTS", "AGENTRECALL_HOME 不能为空，请检查启动配置。");
      const workspace = new WorkspaceService(this.directory);
      // Native dialogs belong to the requesting window. Closing the app cancels
      // those windows; no filesystem mutation starts until the result is checked.
      if (request.action === "choose-folder") return { ok: true, data: { kind: "folder", value: await this.dialogs.chooseFolder(owner) } };
      if (request.action === "cancel-sync") {
        this.cancel(owner);
        return { ok: true, data: { kind: "cancelled" } };
      }
      if (request.action === "work-uninstall" || request.action === "remove-project") {
        const config = await workspace.store.read();
        const id = request.action === "remove-project" ? request.id : request.scope.projectId;
        const root = request.action === "remove-project" ? request.root : request.scope.root;
        const project = config?.projects.find((project) => project.id === id && project.root === root);
        if (!project) throw new WorkspaceError("PROJECT_MISMATCH", "项目绑定已改变，请刷新后重试。");
        const message = request.action === "work-uninstall"
          ? "卸载项目「" + project.name + "」中 " + request.target + " 的工作配置「" + request.id + "」？共用和原有独立 Skill 会保留，其余受管内容移入备份。"
          : "移除项目「" + project.name + "」的绑定？代码仓库、已安装 Skill 和备份都将保留。";
        if (!await this.dialogs.confirm(owner, message)) return { ok: true, data: { kind: "cancelled" } };
      }
      if (this.closed) throw new WorkspaceError("TEAM_CLOSED", "团队服务已关闭，本次操作取消。");
      const mutating = writes.has(request.action);
      if (mutating && this.busy) throw new WorkspaceError("TEAM_BUSY", "另一个团队操作正在进行，请等待完成或取消同步后重试。");
      if (mutating) this.busy = true;
      const abort = new AbortController();
      if (request.action === "sync") this.sync = { owner, abort };
      const operation = this.execute(workspace, request, abort.signal);
      this.pending.add(operation);
      try { return { ok: true, data: await operation }; }
      finally {
        this.pending.delete(operation);
        if (request.action === "sync" && this.sync?.abort === abort) this.sync = null;
        if (mutating) this.busy = false;
      }
    } catch (error) {
      return { ok: false, error: error instanceof WorkspaceError
        ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
        : { code: "TEAM_OPERATION_FAILED", message: "团队操作未完成，请检查项目目录、文件权限及 Git 配置后重试。" } };
    }
  }

  private async execute(workspace: WorkspaceService, request: Exclude<TeamRequest, { action: "choose-folder" | "cancel-sync" }>, signal: AbortSignal): Promise<TeamPayload> {
    const snapshot = async (): Promise<TeamPayload> => ({ kind: "snapshot", value: { config: await workspace.store.read(), busy: false } });
    switch (request.action) {
      case "snapshot": return { kind: "snapshot", value: { config: await workspace.store.read(), busy: this.busy } };
      case "enable":
        await workspace.store.initialize();
        await workspace.setTeamEnabled(request.enabled);
        return snapshot();
      case "add-team":
        await workspace.addTeam({ id: request.id, name: request.name, repository: request.repository });
        return snapshot();
      case "default-team":
        await workspace.setDefaultTeam(request.id);
        return snapshot();
      case "add-project":
        if (!path.isAbsolute(request.directory)) throw new WorkspaceError("INVALID_ARGUMENTS", "请选择项目文件夹，或填写项目的完整绝对路径。");
        await workspace.addProject({ id: request.id, name: request.name, directory: request.directory, remote: request.remote, teamId: request.teamId });
        return snapshot();
      case "bind-project":
        await workspace.bindProject(request.id, request.teamId, request.root);
        return snapshot();
      case "remove-project": {
        const config = await workspace.store.read();
        if (config?.projects.find((project) => project.id === request.id)?.root !== request.root) throw new WorkspaceError("PROJECT_MISMATCH", "项目绑定已改变，取消移除。");
        await workspace.removeProject(request.id, request.root);
        return snapshot();
      }
    }
    const config = await workspace.store.read();
    const project = config?.projects.find((project) => project.id === request.scope.projectId);
    if (!project || project.root !== request.scope.root) throw new WorkspaceError("PROJECT_MISMATCH", "项目绑定已改变，请刷新后重新选择。");
    const assets = new TeamAssetService(workspace, undefined, request.scope);
    const root = project.root;
    const projectId = project.id;
    const complete = (message: string, backups: string[] = []): TeamPayload => ({ kind: "complete", message, backups });
    switch (request.action) {
      case "catalog": {
        const installed = await assets.installedWorkConfigs(root, projectId);
        if (!config?.teamEnabled) return { kind: "catalog", value: { projectId, root, assets: null, installed, notice: "团队功能未启用，仍可管理已有本地配置。" } };
        try { return { kind: "catalog", value: { projectId, root, assets: await assets.list(root, projectId), installed, notice: null } }; }
        catch (error) {
          if (!(error instanceof WorkspaceError) || !["ASSETS_NOT_SYNCED", "NO_TEAM"].includes(error.code)) throw error;
          return { kind: "catalog", value: { projectId, root, assets: null, installed, notice: error.message } };
        }
      }
      case "sync":
        await assets.sync(root, projectId, request.transport, signal);
        return complete("团队资产已同步，请先预览，再选择安装。");
      case "skill-preview": return { kind: "skill-preview", value: await assets.preview(root, request.id, projectId, request.target, request.file) };
      case "skill-install": {
        const result = await assets.install(root, request.id, request.target, request.revision, projectId);
        return complete(result.status === "existing" ? "相同内容已经安装。" : "Skill 已安装到所选项目。");
      }
      case "work-preview": return { kind: "work-preview", value: await assets.previewWorkConfig(root, request.id, projectId, request.target) };
      case "work-install":
        await assets.installWorkConfig(root, request.id, request.target, request.revision, projectId);
        return complete("工作配置已安装，共享引用已记录。");
      case "work-status": return { kind: "work-status", value: await assets.workConfigStatus(root, request.id, request.target, projectId) };
      case "work-diff": return { kind: "work-diff", value: await assets.diffWorkConfig(root, request.id, request.target, projectId) };
      case "work-update": {
        const result = await assets.updateWorkConfig(root, request.id, request.target, request.fromRevision, request.revision, projectId);
        return complete("工作配置已更新，旧内容的备份已保留。", result.effects.flatMap((item) => item.backupPath ? [item.backupPath] : []));
      }
      case "work-uninstall": {
        const result = await assets.uninstallWorkConfig(root, request.id, request.target, request.revision, projectId);
        return complete("工作配置已卸载，共用和原有独立 Skill 保留。", result.backups.map((item) => item.backupPath));
      }
    }
  }
}
