import type { ProjectSummary, ProjectTagEntry, SessionEnvironment } from "../../../../core/types";
import { isSidebarProjectVisible } from "../../session-ui";

export interface SidebarEnvironmentGroup {
  environment: SessionEnvironment | null;
  projects: Array<ProjectSummary & { tags: string[] }>;
  emptyProjects: Array<ProjectSummary & { tags: string[] }>;
}

export function findSelectedProject(
  projects: ProjectSummary[],
  projectPath: string | undefined,
  projectEnvironmentId: string | undefined,
): ProjectSummary | null {
  return (
    projects.find((project) => project.path === projectPath && project.environmentId === projectEnvironmentId)
    || (projectPath ? projects.find((project) => project.path === projectPath) || null : null)
  );
}

/**
 * Builds the environment -> project -> tag tree. Tags are scoped per environment+project
 * so the same branch name on different environments displays separately.
 */
export function buildSidebarTree(
  projects: ProjectSummary[],
  environments: SessionEnvironment[],
  projectTags: ProjectTagEntry[],
  projectPath: string | undefined,
  projectEnvironmentId: string | undefined,
): SidebarEnvironmentGroup[] {
  const tagMap = new Map<string, string[]>();
  for (const entry of projectTags) {
    tagMap.set(`${entry.environmentId}\0${entry.projectPath}`, entry.tags);
  }
  const groups = new Map<string, SidebarEnvironmentGroup>();
  for (const project of projects) {
    const environment = environments.find((env) => env.id === project.environmentId) ?? null;
    const key = project.environmentId;
    const projectTagsList = tagMap.get(`${project.environmentId}\0${project.path}`) ?? [];
    const group = groups.get(key);
    const target = isSidebarProjectVisible(project, projectPath, projectEnvironmentId) ? "projects" : "emptyProjects";
    if (group) {
      group[target].push({ ...project, tags: projectTagsList });
    } else {
      groups.set(key, {
        environment,
        projects: target === "projects" ? [{ ...project, tags: projectTagsList }] : [],
        emptyProjects: target === "emptyProjects" ? [{ ...project, tags: projectTagsList }] : [],
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      (a.environment ? 0 : 1) - (b.environment ? 0 : 1)
      || (a.environment?.label ?? "").localeCompare(b.environment?.label ?? ""),
  );
}
