import { WorkspaceError } from "./errors.js";
import {
  WorkspaceConfigStore,
  type WorkspaceConfig, type ProjectBinding, type TeamSpace,
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

  async addTeam(input: { id: string; name?: string; repository: string }): Promise<TeamSpace> {
    const team: TeamSpace = { id: input.id, name: input.name ?? input.id, repository: canonicalGitHubRepository(input.repository) };
    await this.store.update((config) => {
      if (config.teams.some((item) => item.id === team.id)) throw new WorkspaceError("TEAM_EXISTS", "团队 ID 已存在，请选择另一个 ID。");
      return { ...config, teams: [...config.teams, team] };
    });
    return team;
  }

  async setDefaultTeam(teamId: string | null): Promise<WorkspaceConfig> {
    return this.store.update((config) => ({ ...config, defaultTeamId: teamId }));
  }

  async setTeamEnabled(enabled: boolean): Promise<WorkspaceConfig> {
    return this.store.update((config) => ({ ...config, teamEnabled: enabled }));
  }

  async addProject(input: { id: string; name?: string; directory: string; remote?: string; teamId?: string | null }): Promise<ProjectBinding> {
    const checkout = await inspectCheckout(input.directory);
    if (!checkout) throw new WorkspaceError("NOT_A_REPOSITORY", "请选择一个非裸 Git 仓库目录。");
    const identity = await checkoutRepository(checkout, input.remote);
    const project: ProjectBinding = {
      id: input.id, name: input.name ?? input.id, root: checkout.root, gitCommonDir: checkout.gitCommonDir,
      ...identity, ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
    };
    await this.store.update((config) => {
      if (config.projects.some((item) => item.id === project.id || sameLocalPath(item.gitCommonDir, project.gitCommonDir))) {
        throw new WorkspaceError("PROJECT_EXISTS", "项目 ID 或本地仓库已绑定，请使用 project bind 修改团队，或选择另一个 ID。");
      }
      return { ...config, projects: [...config.projects, project] };
    });
    return project;
  }

  async bindProject(projectId: string, teamId: string | null | undefined): Promise<ProjectBinding> {
    const config = await this.store.update((current) => {
      if (!current.projects.some((project) => project.id === projectId)) throw new WorkspaceError("PROJECT_NOT_FOUND", "项目不存在，请先运行 project list 查看项目 ID。");
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

  async removeProject(projectId: string): Promise<void> {
    await this.store.update((config) => {
      if (!config.projects.some((project) => project.id === projectId)) throw new WorkspaceError("PROJECT_NOT_FOUND", "项目不存在，请先运行 project list 查看项目 ID。");
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
    const checkout = await inspectCheckout(directory);
    let project: ProjectBinding | undefined;
    if (!checkout) {
      project = projectId ? config.projects.find((item) => item.id === projectId) : undefined;
    } else {
      const local = config.projects.filter((item) => sameLocalPath(item.gitCommonDir, checkout.gitCommonDir) || sameLocalPath(item.root, checkout.root));
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
