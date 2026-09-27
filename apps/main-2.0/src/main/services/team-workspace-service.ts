import { WorkspaceError, WorkspaceService, TeamAssetService } from "@agentrecall/workspace-core";
import path from "node:path";
import { readTeamLocalAssets } from "./team-local-assets";
import type { TeamSessionContext, TeamSessionSharing } from "./team-session-sharing";
import type { TeamPayload, TeamReply, TeamRequest } from "../../shared/ipc/team-workspace";

interface TeamDialogs {
  chooseFolder(owner: number): Promise<string | null>;
  confirm(owner: number, message: string): Promise<boolean>;
}

const writes = new Set<TeamRequest["action"]>(["connect-directory", "update-directory", "disconnect-directory", "create-project", "document-install", "session-preview", "session-publish", "session-withdraw", "session-download", "enable", "add-team", "default-team", "add-project", "bind-project", "remove-project", "sync", "skill-install", "work-install", "work-update", "work-uninstall"]);

export class TeamWorkspaceService {
  private closed = false;
  private busy = false;
  private readonly operations = new Map<AbortController, number>();
  private readonly pending = new Set<Promise<TeamPayload>>();

  constructor(private readonly directory: string, private readonly dialogs: TeamDialogs, private readonly sharing?: TeamSessionSharing) {}

  cancel(owner: number): void {
    for (const [abort, requestOwner] of this.operations) if (requestOwner === owner) abort.abort();
    this.sharing?.cancel(owner);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const abort of this.operations.keys()) abort.abort();
    this.sharing?.close();
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
      if (request.action === "work-uninstall" && !("teamId" in request.scope) || request.action === "remove-project") {
        const config = await workspace.store.read();
        const id = request.action === "remove-project" ? request.id : "projectId" in request.scope ? request.scope.projectId : undefined;
        const root = request.action === "remove-project" ? request.root : "root" in request.scope ? request.scope.root : null;
        const project = config?.projects.find((project) => project.id === id && project.root === root);
        if (!project) throw new WorkspaceError("PROJECT_MISMATCH", "项目绑定已改变，请刷新后重试。");
        const message = request.action === "work-uninstall"
          ? "卸载项目「" + project.name + "」中 " + request.target + " 的工作配置「" + request.id + "」？共用和原有独立 Skill 会保留，其余受管内容移入备份。"
          : "移除项目「" + project.name + "」的绑定？代码仓库、已安装 Skill 和备份都将保留。";
        if (!await this.dialogs.confirm(owner, message)) return { ok: true, data: { kind: "cancelled" } };
      }
      if (request.action === "enable" && !request.enabled) {
        for (const abort of this.operations.keys()) abort.abort();
        this.sharing?.close();
        await Promise.allSettled([...this.pending]);
      }
      if (this.closed) throw new WorkspaceError("TEAM_CLOSED", "团队服务已关闭，本次操作取消。");
      const mutating = writes.has(request.action);
      if (mutating && this.busy) throw new WorkspaceError("TEAM_BUSY", "另一个团队操作正在进行，请等待完成或取消同步后重试。");
      if (mutating) this.busy = true;
      const abort = new AbortController();
      this.operations.set(abort, owner);
      const operation = this.execute(workspace, request, abort.signal, owner);
      this.pending.add(operation);
      try { return { ok: true, data: await operation }; }
      finally {
        this.pending.delete(operation);
        this.operations.delete(abort);
        if (mutating) this.busy = false;
      }
    } catch (error) {
      return { ok: false, error: error instanceof WorkspaceError
        ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
        : { code: "TEAM_OPERATION_FAILED", message: "团队操作未完成，请检查项目目录、文件权限及 Git 配置后重试。" } };
    }
  }

  private async execute(workspace: WorkspaceService, request: Exclude<TeamRequest, { action: "choose-folder" | "cancel-sync" }>, signal: AbortSignal, owner: number): Promise<TeamPayload> {
    const snapshot = async (): Promise<TeamPayload> => {
      const config = await workspace.store.read();
      return { kind: "snapshot", value: { config, busy: request.action === "snapshot" ? this.busy : false, directories: config ? workspace.directoryConnections(config) : [] } };
    };
    switch (request.action) {
      case "snapshot": return snapshot();
      case "enable":
        await workspace.store.initialize();
        await workspace.setTeamEnabled(request.enabled);
        return snapshot();
      case "add-team":
        await workspace.store.initialize();
        await workspace.addTeam({ id: request.id, name: request.name, repository: request.repository, makeDefault: request.makeDefault });
        return snapshot();
      case "default-team":
        await workspace.setDefaultTeam(request.id);
        return snapshot();
      case "connect-directory":
        await workspace.connectDirectory(request.teamId, request.directory, request.targets);
        return snapshot();
      case "update-directory":
        await workspace.updateDirectory(request.teamId, request.id, request.directory, { enabled: request.enabled, targets: request.targets });
        return snapshot();
      case "disconnect-directory":
        if (!await this.dialogs.confirm(owner, `断开工作目录 ${request.directory}？本地文件、已安装资产和已分享会话均保留。`)) return { kind: "cancelled" };
        if (signal.aborted) throw new WorkspaceError("CANCELLED", "操作已取消。");
        await workspace.updateDirectory(request.teamId, request.id, request.directory, null);
        return snapshot();
      case "create-project":
        await workspace.createProject({ name: request.name, teamId: request.teamId });
        return snapshot();
      case "add-project":
        if (!path.isAbsolute(request.directory)) throw new WorkspaceError("INVALID_ARGUMENTS", "请选择项目文件夹，或填写项目的完整绝对路径。");
        await workspace.store.initialize();
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
    const teamScope = "teamId" in request.scope ? request.scope : null;
    const legacyScope = "projectId" in request.scope ? request.scope : null;
    const project = legacyScope ? config?.projects.find((entry) => entry.id === legacyScope.projectId) : undefined;
    if (legacyScope && (!project || project.root !== legacyScope.root)) throw new WorkspaceError("PROJECT_MISMATCH", "项目绑定已改变，请刷新后重新选择。");
    const teamContext = teamScope ? await workspace.teamContext(teamScope.teamId, teamScope.connectionId, teamScope.directory, false) : null;
    if (teamScope && teamContext?.team.repository !== teamScope.repository) throw new WorkspaceError("TEAM_CHANGED", "团队仓库已改变，请重新选择。");
    if (teamContext?.directory && "target" in request && !teamContext.directory.targets.includes(request.target)) throw new WorkspaceError("CLIENT_DISABLED", "此工作目录没有启用该客户端，请到工作目录设置中调整。");
    const assets = new TeamAssetService(workspace, undefined, request.scope);
    if (request.scope.directory && (!path.isAbsolute(request.scope.directory) || legacyScope && project?.root !== null)) throw new WorkspaceError("INVALID_ARGUMENTS", "本地位置无效，请重新选择目录。");
    const localDirectory = teamScope ? teamContext?.directory?.path : project?.root ?? request.scope.directory;
    if (request.action === "local-assets") {
      if (!localDirectory) throw new WorkspaceError("LOCAL_DIRECTORY_REQUIRED", "请先选择要查看的本地工作目录。");
      const result = await readTeamLocalAssets(localDirectory, request.kind, request.file, signal);
      if (teamScope) await workspace.teamContext(teamScope.teamId, teamScope.connectionId, teamScope.directory, false);
      else {
        const fresh = (await workspace.store.read())?.projects.find((item) => item.id === project?.id);
        if (!fresh || JSON.stringify(fresh) !== JSON.stringify(project)) throw new WorkspaceError("PROJECT_MISMATCH", "项目已改变，请重新选择。");
      }
      return "entries" in result ? { kind: "local-assets", value: result } : { kind: "local-preview", value: result };
    }
    const root = project?.root ?? this.directory;
    const projectId = project?.id;
    const complete = (message: string, backups: string[] = []): TeamPayload => ({ kind: "complete", message, backups });
    const sessionContext = async (): Promise<TeamSessionContext> => {
      if (teamScope) {
        const current = await workspace.teamContext(teamScope.teamId);
        if (current.team.repository !== teamScope.repository) throw new WorkspaceError("TEAM_CHANGED", "团队仓库已改变，请重新选择。");
        return { repository: current.team.repository, teamWide: true, projectIdentity: "team:shared", projectId: "", root: null, projectName: current.team.name };
      }
      const current = await workspace.currentTeam(root, projectId);
      if (current.project.root !== legacyScope?.root || current.team.repository !== request.scope.repository) throw new WorkspaceError("PROJECT_MISMATCH", "团队或项目已改变，请重新选择。");
      const identity = current.project.sharingKey ?? current.project.repository ?? `legacy:${current.project.id}`;
      return { repository: current.team.repository, projectIdentity: identity, projectName: current.project.name, root: current.project.root, projectId: current.project.id };
    };
    if (request.action.startsWith("session-")) {
      const sharing = this.sharing;
      if (!sharing) throw new WorkspaceError("TEAM_SESSION_UNAVAILABLE", "会话分享服务不可用，请重启应用。");
      const context = await sessionContext();
      const assertContext = async () => {
        if (signal.aborted) throw new WorkspaceError("CANCELLED", "操作已取消。");
        if (JSON.stringify(await sessionContext()) !== JSON.stringify(context)) throw new WorkspaceError("PROJECT_MISMATCH", "分享目标已改变，请重新预览。");
      };
      switch (request.action) {
        case "session-list": return { kind: "session-list", value: await sharing.list(context, request.page, signal) };
        case "session-preview": return { kind: "session-preview", value: await sharing.prepare(owner, context, request.sessionKey, signal) };
        case "session-detail": return { kind: "session-detail", value: await sharing.detail(context, request.id, signal) };
        case "session-publish": return await sharing.publish(owner, context, request.token, signal, assertContext) ? complete("会话已分享到团队。本地原会话保留。") : { kind: "cancelled" };
        case "session-download": return await sharing.download(owner, context, request.id, signal) ? complete("完整会话包已保存。") : { kind: "cancelled" };
        case "session-withdraw": return await sharing.withdraw(owner, context, request.id, signal, assertContext) ? complete("分享已撤回。本地原会话保留。") : { kind: "cancelled" };
      }
    }
    switch (request.action) {
      case "document-preview": return { kind: "document-preview", value: await assets.previewDocument(root, request.id, projectId) };
      case "document-install": {
        if (!localDirectory) throw new WorkspaceError("LOCAL_DIRECTORY_REQUIRED", "请先选择本次应用的本地目录。");
        if (!await this.dialogs.confirm(owner, `将文档应用到 ${localDirectory ?? "未选择目录"}？相同文件将保留，不同的已有内容不会被覆盖。`)) return { kind: "cancelled" };
        if (signal.aborted) throw new WorkspaceError("CANCELLED", "操作已取消。");
        await assets.installDocument(root, request.id, request.revision, projectId);
        return complete("文档已应用到项目，已有内容保留。");
      }
      case "catalog": {
        const installed = await assets.installedWorkConfigs(root, projectId);
        if (!config?.teamEnabled) return { kind: "catalog", value: { projectId: projectId ?? "", root: project?.root ?? null, assets: null, installed, notice: "团队功能未启用，仍可管理已有本地配置。" } };
        try { return { kind: "catalog", value: { projectId: projectId ?? "", root: project?.root ?? null, assets: await assets.list(root, projectId), installed, notice: null } }; }
        catch (error) {
          if (!(error instanceof WorkspaceError) || !["ASSETS_NOT_SYNCED", "NO_TEAM"].includes(error.code)) throw error;
          return { kind: "catalog", value: { projectId: projectId ?? "", root: project?.root ?? null, assets: null, installed, notice: error.message } };
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
        if (teamScope && !await this.dialogs.confirm(owner, `卸载 ${localDirectory ?? "所选目录"} 的工作配置？其他配置共用的 Skill 和原有独立内容保留。`)) return { kind: "cancelled" };
        if (signal.aborted) throw new WorkspaceError("CANCELLED", "操作已取消。");
        const result = await assets.uninstallWorkConfig(root, request.id, request.target, request.revision, projectId);
        return complete("工作配置已卸载，共用和原有独立 Skill 保留。", result.backups.map((item) => item.backupPath));
      }
    }
    throw new WorkspaceError("INVALID_ARGUMENTS", "未知团队操作。");
  }
}
