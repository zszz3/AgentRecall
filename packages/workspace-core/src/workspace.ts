import { WorkspaceError } from "./errors.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import {
  WorkspaceConfigStore,
  type WorkspaceConfig, type ProjectBinding, type TeamSpace, type DirectoryConnection,
} from "./config.js";
import { canonicalGitHubRepository, checkoutRepository, inspectCheckout, sameLocalPath } from "./git.js";

export interface WorkspaceStatus {
  initialized: boolean;
  configPath: string;
  teamEnabled: boolean;
  project: ProjectBinding | null;
  team: TeamSpace | null;
  teamSelection: "project" | "default" | "personal" | "unbound";
  reason: "not_initialized" | "team_disabled" | "no_project" | "no_team" | "ready";
}

export class WorkspaceService {
  readonly store: WorkspaceConfigStore;

  constructor(homeDirectory: string) {
    this.store = new WorkspaceConfigStore(homeDirectory);
  }

  async addTeam(input: { id?: string; name?: string; repository: string; transport?: "https" | "ssh"; makeDefault?: boolean }): Promise<TeamSpace> {
    const repository = canonicalGitHubRepository(input.repository);
    const team: TeamSpace = { id: input.id ?? `team-${randomUUID()}`, name: input.name ?? input.id ?? repository.slice("https://github.com/".length), repository, ...(input.transport ? { transport: input.transport } : {}) };
    await this.store.update((config) => {
      if (config.teams.some((item) => item.id === team.id)) throw new WorkspaceError("TEAM_EXISTS", "团队 ID 已存在，请选择另一个 ID。");
      if (!input.id && config.teams.some((item) => item.repository === repository)) throw new WorkspaceError("TEAM_EXISTS", "这个团队仓库已经添加，请从团队列表中选择。");
      return { ...config, ...(input.transport ? { schemaVersion: 4 as const, directories: this.directoryConnections(config) } : {}), teams: [...config.teams, team], ...(input.makeDefault ? { defaultTeamId: team.id } : {}) };
    });
    return team;
  }

  async setTeamTransport(id: string, transport: "https" | "ssh"): Promise<void> {
    await this.store.update((config) => {
      if (!config.teams.some((team) => team.id === id)) throw new WorkspaceError("NO_TEAM", "团队不存在，请刷新。");
      return { ...config, schemaVersion: 4, directories: this.directoryConnections(config), teams: config.teams.map((team) => team.id === id ? { ...team, transport } : team) };
    });
  }

  async setDefaultTeam(teamId: string | null): Promise<WorkspaceConfig> {
    return this.store.update((config) => ({ ...config, defaultTeamId: teamId }));
  }

  async setTeamEnabled(enabled: boolean): Promise<WorkspaceConfig> {
    return this.store.update((config) => ({ ...config, teamEnabled: enabled }));
  }

  async addProject(input: { id?: string; name?: string; directory: string; remote?: string; teamId?: string | null }): Promise<ProjectBinding & { root: string; gitCommonDir: string }> {
    const checkout = await inspectCheckout(input.directory);
    if (!checkout) throw new WorkspaceError("NOT_A_REPOSITORY", "请选择一个非裸 Git 仓库目录。");
    const identity = await checkoutRepository(checkout, input.remote);
    const project: ProjectBinding & { root: string; gitCommonDir: string } = {
      id: input.id ?? `project-${randomUUID()}`, name: input.name ?? input.id ?? path.basename(checkout.root).slice(0, 200), root: checkout.root, gitCommonDir: checkout.gitCommonDir,
      ...identity, ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    };
    await this.store.update((config) => {
      if (config.projects.some((item) => item.id === project.id || item.gitCommonDir !== null && sameLocalPath(item.gitCommonDir, project.gitCommonDir))) {
        throw new WorkspaceError("PROJECT_EXISTS", "项目 ID 或本地仓库已绑定，请使用 project bind 修改团队，或选择另一个 ID。");
      }
      return { ...config, projects: [...config.projects, project] };
    });
    return project;
  }

  directoryConnections(config: WorkspaceConfig): DirectoryConnection[] {
    if (config.schemaVersion >= 3) return config.directories ?? [];
    return config.projects.flatMap((project) => {
      const teamId = project.teamId === undefined ? config.defaultTeamId : project.teamId;
      return project.root && teamId ? [{ id: project.id, teamId, path: project.root, enabled: true, targets: ["codex", "claude"] as Array<"codex" | "claude"> }] : [];
    });
  }

  async connectDirectory(teamId: string, directory: string, targets: Array<"codex" | "claude">): Promise<void> {
    if (!path.isAbsolute(directory)) throw new WorkspaceError("INVALID_ARGUMENTS", "请选择本地目录。");
    const root = await fs.realpath(directory);
    if (!(await fs.stat(root)).isDirectory()) throw new WorkspaceError("LOCAL_DIRECTORY_REQUIRED", "请选择已有的本地目录。");
    await this.store.update((config) => {
      if (!config.teams.some((team) => team.id === teamId)) throw new WorkspaceError("NO_TEAM", "团队不存在，请刷新。");
      const directories = this.directoryConnections(config);
      if (directories.some((entry) => sameLocalPath(entry.path, root))) throw new WorkspaceError("DIRECTORY_CONNECTED", "此工作目录已经接入团队，请在列表中管理。");
      return { ...config, schemaVersion: config.schemaVersion === 4 ? 4 : 3, directories: [...directories, { id: `directory-${randomUUID()}`, teamId, path: root, enabled: true, targets }] };
    });
  }

  async updateDirectory(teamId: string, id: string, expectedPath: string, change: { enabled: boolean; targets: Array<"codex" | "claude"> } | null): Promise<void> {
    await this.store.update((config) => {
      const directories = this.directoryConnections(config);
      if (!directories.some((entry) => entry.id === id && entry.teamId === teamId && entry.path === expectedPath)) throw new WorkspaceError("PROJECT_MISMATCH", "工作目录连接已改变，请刷新。");
      return { ...config, schemaVersion: config.schemaVersion === 4 ? 4 : 3, directories: change ? directories.map((entry) => entry.id === id ? { ...entry, ...change } : entry) : directories.filter((entry) => entry.id !== id) };
    });
  }

  async teamContext(teamId: string, connectionId?: string, expectedPath?: string, requireEnabled = true) {
    const config = await this.store.read();
    if (!config) throw new WorkspaceError("NOT_INITIALIZED", "请先连接团队。");
    const team = config.teams.find((item) => item.id === teamId);
    if (!team) throw new WorkspaceError("NO_TEAM", "团队不存在，请刷新。");
    if (requireEnabled && !config.teamEnabled) throw new WorkspaceError("TEAM_DISABLED", "团队功能已关闭，请在设置中开启。");
    const directory = connectionId ? this.directoryConnections(config).find((item) => item.id === connectionId && item.teamId === teamId) : null;
    if (connectionId && (!directory || directory.path !== expectedPath)) throw new WorkspaceError("PROJECT_MISMATCH", "工作目录连接已改变，请重新选择。");
    if (requireEnabled && directory && !directory.enabled) throw new WorkspaceError("DIRECTORY_DISABLED", "该工作目录已停用，请先启用再应用资产。");
    if (!connectionId && expectedPath) throw new WorkspaceError("LOCAL_DIRECTORY_REQUIRED", "请选择已经接入的工作目录。");
    return { team, directory: directory ?? null };
  }

  async createProject(input: { name: string; teamId: string }): Promise<ProjectBinding> {
    const name = input.name.trim();
    if (!name || name.length > 200) throw new WorkspaceError("INVALID_ARGUMENTS", "请输入 1—200 字的项目名称。");
    // Identity belongs to the collaboration space, not its local installation directory.
    // Same normalized name within the same team resolves consistently on other members' devices.
    const sharingKey = `space:${createHash("sha256").update(name.normalize("NFKC").toLowerCase()).digest("hex")}`;
    const project = { id: `project-${randomUUID()}`, name, teamId: input.teamId, sharingKey, root: null, gitCommonDir: null, repository: null, remote: null };
    await this.store.update((config) => {
      if (!config.teams.some((team) => team.id === input.teamId)) throw new WorkspaceError("NO_TEAM", "请先选择一个已连接的团队。");
      if (config.projects.some((item) => (item.teamId === undefined ? config.defaultTeamId : item.teamId) === input.teamId && item.name.normalize("NFKC").trim().toLowerCase() === name.normalize("NFKC").toLowerCase())) throw new WorkspaceError("PROJECT_EXISTS", "此团队已有同名项目，请打开已有项目。");
      return { ...config, schemaVersion: config.schemaVersion >= 3 ? config.schemaVersion : 2, projects: [...config.projects, project] };
    });
    return project;
  }

  async bindProject(projectId: string, teamId: string | null | undefined, expectedRoot?: string | null): Promise<ProjectBinding> {
    const config = await this.store.update((current) => {
      if (!current.projects.some((project) => project.id === projectId)) throw new WorkspaceError("PROJECT_NOT_FOUND", "项目不存在，请先运行 project list 查看项目 ID。");
      if (expectedRoot !== undefined && current.projects.find((project) => project.id === projectId)?.root !== expectedRoot) throw new WorkspaceError("PROJECT_MISMATCH", "项目绑定已改变，请刷新后重试。");
      return {
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          const { teamId: _previous, ...base } = project;
          return { ...base, ...(teamId !== undefined ? { teamId } : {}) };
        }),
      };
    });
    return config.projects.find((project) => project.id === projectId)!;
  }

  async removeProject(projectId: string, expectedRoot?: string | null): Promise<void> {
    await this.store.update((config) => {
      if (!config.projects.some((project) => project.id === projectId)) throw new WorkspaceError("PROJECT_NOT_FOUND", "项目不存在，请先运行 project list 查看项目 ID。");
      if (expectedRoot !== undefined && config.projects.find((project) => project.id === projectId)?.root !== expectedRoot) throw new WorkspaceError("PROJECT_MISMATCH", "项目绑定已改变，取消移除。");
      return { ...config, projects: config.projects.filter((project) => project.id !== projectId) };
    });
  }

  async status(directory: string, projectId?: string): Promise<WorkspaceStatus> {
    const config = await this.store.read();
    const empty: WorkspaceStatus = {
      initialized: Boolean(config), configPath: this.store.filePath,
      teamEnabled: config?.teamEnabled ?? false, project: null, team: null,
      teamSelection: "unbound", reason: "not_initialized",
    };
    if (!config) return empty;
    if (projectId && !config.projects.some((project) => project.id === projectId)) {
      throw new WorkspaceError("PROJECT_NOT_FOUND", "项目不存在，请先运行 project list 查看项目 ID。");
    }
    const explicit = projectId ? config.projects.find((item) => item.id === projectId) : undefined;
    const checkout = explicit?.root === null ? null : await inspectCheckout(directory);
    let project: ProjectBinding | undefined;
    if (!checkout) {
      project = projectId ? config.projects.find((item) => item.id === projectId) : undefined;
    } else {
      const local = config.projects.filter((item) => item.gitCommonDir !== null && sameLocalPath(item.gitCommonDir, checkout.gitCommonDir) || item.root !== null && sameLocalPath(item.root, checkout.root));
      if (local.length > 1) throw new WorkspaceError("AMBIGUOUS_PROJECT", "本地仓库被重复绑定，请检查项目配置。");
      if (local[0]) {
        project = local[0];
        if (projectId && project.id !== projectId) throw new WorkspaceError("PROJECT_MISMATCH", "当前目录已绑定另一个项目，请进入目标仓库或在仓库外使用 --project。");
        const identity = await checkoutRepository(checkout, project.remote);
        if (identity.repository !== project.repository) {
          throw new WorkspaceError("REPOSITORY_CHANGED", "仓库 remote 已改变，已停止使用原团队配置。请恢复 remote，或用 project remove 移除旧绑定后重新 project add。");
        }
      } else {
        // A new clone may use a non-origin remote. Only remotes explicitly selected by a binding count.
        const candidates: ProjectBinding[] = [];
        for (const remote of checkout.remotes) {
          const bindings = config.projects.filter((item) => item.remote === remote && (!projectId || item.id === projectId));
          if (bindings.length === 0) continue;
          const identity = await checkoutRepository(checkout, remote);
          candidates.push(...bindings.filter((item) => item.repository === identity.repository));
        }
        if (candidates.length > 1) throw new WorkspaceError("AMBIGUOUS_PROJECT", "多个项目匹配此仓库，请使用 --project <id> 明确选择。");
        project = candidates[0];
        if (projectId && !project) throw new WorkspaceError("PROJECT_MISMATCH", "所选项目与当前 Git 仓库不匹配，已停止使用团队配置。");
      }
    }
    if (!project) return { ...empty, reason: config.teamEnabled ? "no_project" : "team_disabled" };
    const teamId = project.teamId === undefined ? config.defaultTeamId : project.teamId;
    const team = config.teams.find((item) => item.id === teamId) ?? null;
    return {
      ...empty, project, team,
      teamSelection: project.teamId === null ? "personal" : project.teamId === undefined ? "default" : "project",
      reason: !config.teamEnabled ? "team_disabled" : !team ? "no_team" : "ready",
    };
  }

  async currentTeam(directory: string, projectId?: string): Promise<{ project: ProjectBinding; team: TeamSpace }> {
    // Enforce the switch at the service boundary, not just in the CLI command list.
    const status = await this.status(directory, projectId);
    if (!status.initialized) throw new WorkspaceError("NOT_INITIALIZED", "请先运行 agentrecall init。");
    if (!status.teamEnabled) throw new WorkspaceError("TEAM_DISABLED", "团队功能已关闭。需要使用时，请主动运行 agentrecall team enable。");
    if (!status.project) throw new WorkspaceError("NO_PROJECT", "当前目录未绑定项目，请运行 project add 或使用 --project <id>。");
    if (!status.team) throw new WorkspaceError("NO_TEAM", "当前项目使用个人配置，请用 project bind --team <id> 或 team use 指定团队。");
    return { project: status.project, team: status.team };
  }
}
