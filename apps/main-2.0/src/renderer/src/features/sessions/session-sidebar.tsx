import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  EyeOff,
  Folder,
  GitBranch,
  Laptop,
  Server,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { formatRelativeTime } from "../../../../core/format-session";
import { environmentTarget } from "../environments/environment-display";
import {
  displayTagName,
  isBranchTag,
  projectSortTimestamp,
  sourceFilterLabel,
} from "../../session-ui";
import type { SessionsPageActions, SessionsPageModel } from "./sessions-page";

const SIDEBAR_PROJECT_PAGE_SIZE = 30;

export function SessionSidebar({
  model,
  actions,
  l,
}: {
  model: SessionsPageModel;
  actions: SessionsPageActions;
  l(en: string, zh: string): string;
}): ReactElement {
  const [visibleProjectCounts, setVisibleProjectCounts] = useState<Record<string, number>>({});

  return (
    <section className="sidebar">
      <div className="session-sidebar-title">
        <strong>{l("Session scope", "会话范围")}</strong>
        <span>{model.sessionTotalCount}</span>
      </div>
      <SidebarSectionHeader
        title={l("Environments", "环境")}
        expanded={model.sidebarSections.environments}
        onToggle={() => actions.toggleSidebarSection("environments")}
      />
      <SessionDisclosure expanded={model.sidebarSections.environments}>
        <nav className="sidebar-tree">
          <button
            className={`tree-row tree-root ${
              model.environmentId === "all" && !model.projectPath && !model.tag ? "active" : ""
            }`}
            onClick={actions.selectAllSessions}
          >
            <span>{l("All Sessions", "全部会话")}</span>
          </button>
          {model.sidebarTree.map((group) => {
            const groupId = group.projects[0]?.environmentId ?? "unknown";
            const environmentCollapsed = model.collapsedProjectGroups.has(groupId);
            const environmentActive =
              model.environmentId === groupId && !model.projectPath && !model.tag;
            const visibleProjectCount = visibleProjectCounts[groupId] ?? SIDEBAR_PROJECT_PAGE_SIZE;
            const visibleProjects = group.projects.slice(0, visibleProjectCount);
            const selectedProject = group.projects.find((project) =>
              project.path === model.projectPath
              && project.environmentId === model.projectEnvironmentId);
            if (selectedProject && !visibleProjects.includes(selectedProject)) visibleProjects.push(selectedProject);
            // Subtract the projects actually rendered (which includes a selected project pulled
            // in from beyond the page), not just the page size, so "Show more" never overcounts.
            const hiddenProjectCount = Math.max(0, group.projects.length - visibleProjects.length);
            const nextProjectCount = Math.min(SIDEBAR_PROJECT_PAGE_SIZE, hiddenProjectCount);
            return (
              <div key={groupId} className="tree-group">
                <div className="tree-row tree-env-row">
                  <button
                    className="tree-chevron"
                    onClick={() => actions.toggleEnvironment(groupId)}
                    aria-expanded={!environmentCollapsed}
                    aria-label={environmentCollapsed ? l("Expand", "展开") : l("Collapse", "折叠")}
                  >
                    <ChevronRight size={13} />
                  </button>
                  <button
                    className={`tree-label ${environmentActive ? "active" : ""}`}
                    onClick={() => actions.selectEnvironment(groupId)}
                    title={group.environment
                      ? environmentTarget(group.environment, model.language)
                      : l("Unknown", "未知")}
                  >
                    {group.environment?.kind === "local"
                      ? <Laptop size={13} />
                      : <Server size={13} />}
                    <span>{group.environment?.label ?? l("Unknown", "未知")}</span>
                    <em className="tree-count">{group.projects.length}</em>
                  </button>
                </div>
                <SessionDisclosure expanded={!environmentCollapsed}>
                  {visibleProjects.map((project) => {
                      const projectKey = `${project.environmentId}:${project.path}`;
                      const expanded = model.expandedTreeProjects.has(projectKey);
                      const active =
                        model.projectPath === project.path
                        && model.projectEnvironmentId === project.environmentId
                        && !model.tag;
                      return (
                        <div key={projectKey} className="tree-group">
                          <div className="tree-row tree-proj-row">
                            {project.tags.length > 0 ? (
                              <button
                                className="tree-chevron"
                                onClick={() => actions.toggleProject(projectKey)}
                                aria-expanded={expanded}
                                aria-label={expanded ? l("Collapse", "折叠") : l("Expand", "展开")}
                              >
                                <ChevronRight size={13} />
                              </button>
                            ) : <span className="tree-chevron-spacer" />}
                            <button
                              className={`tree-label ${active ? "active" : ""}`}
                              onClick={() => actions.selectProject(project)}
                              title={project.path}
                            >
                              <Folder size={13} />
                              <span>{project.label}</span>
                              <em>{formatRelativeTime(projectSortTimestamp(project), model.language)}</em>
                            </button>
                          </div>
                          <SessionDisclosure expanded={expanded}>
                            {project.tags.map((tagName) => (
                                <div
                                  key={tagName}
                                  className={`tree-row tree-tag-row ${
                                    model.tag === tagName
                                    && model.projectPath === project.path
                                    && model.projectEnvironmentId === project.environmentId
                                      ? "active"
                                      : ""
                                  } ${isBranchTag(tagName) ? "branch-tag" : ""}`}
                                >
                                  <button
                                    className="tree-label"
                                    onClick={() => actions.toggleProjectTag(project, tagName)}
                                    title={l(
                                      `Filter by ${displayTagName(tagName)}`,
                                      `按 ${displayTagName(tagName)} 过滤`,
                                    )}
                                  >
                                    {isBranchTag(tagName)
                                      ? <GitBranch size={13} />
                                      : <Tag size={13} />}
                                    <span>{displayTagName(tagName)}</span>
                                  </button>
                                  <button
                                    className="tag-delete"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      actions.deleteTag(tagName);
                                    }}
                                    title={l(
                                      `Delete tag ${displayTagName(tagName)}`,
                                      `删除标签 ${displayTagName(tagName)}`,
                                    )}
                                    aria-label={l(
                                      `Delete tag ${displayTagName(tagName)}`,
                                      `删除标签 ${displayTagName(tagName)}`,
                                    )}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              ))}
                          </SessionDisclosure>
                        </div>
                      );
                    })}
                {hiddenProjectCount > 0 ? (
                  <button
                    type="button"
                    className="tree-project-more"
                    onClick={() => setVisibleProjectCounts((current) => ({
                      ...current,
                      [groupId]: visibleProjectCount + nextProjectCount,
                    }))}
                  >
                    <ChevronDown size={13} />
                    <span>{l(`Show ${nextProjectCount} more projects`, `再显示 ${nextProjectCount} 个项目`)}</span>
                  </button>
                ) : null}
                </SessionDisclosure>
              </div>
            );
          })}
        </nav>
      </SessionDisclosure>

      <SidebarSectionHeader
        title={l("Sources", "来源")}
        expanded={model.sidebarSections.sources}
        onToggle={() => actions.toggleSidebarSection("sources")}
      />
      <SessionDisclosure expanded={model.sidebarSections.sources}>
        <nav className="nav-group">
          {model.sourceFilters.map((item) => (
            <button
              key={item.label}
              className={model.source === item.value ? "active" : ""}
              aria-pressed={model.source === item.value}
              onClick={() => actions.setSource(item.value)}
            >
              {sourceFilterLabel(item, model.language)}
            </button>
          ))}
        </nav>
      </SessionDisclosure>

      <SidebarSectionHeader
        title={l("Views", "视图")}
        expanded={model.sidebarSections.views}
        onToggle={() => actions.toggleSidebarSection("views")}
      />
      <SessionDisclosure expanded={model.sidebarSections.views}>
        <nav className="nav-group">
          <button
            className={model.visibility === "default" ? "active" : ""}
            aria-pressed={model.visibility === "default"}
            onClick={() => actions.setVisibility("default")}
          >
            {l("All", "全部")}
          </button>
          <button
            className={model.visibility === "favorites" ? "active" : ""}
            aria-pressed={model.visibility === "favorites"}
            onClick={() => actions.setVisibility("favorites")}
          >
            <Star size={14} />
            {l("Favorites", "收藏")}
          </button>
          <button
            className={model.visibility === "hidden" ? "active" : ""}
            aria-pressed={model.visibility === "hidden"}
            onClick={() => actions.setVisibility("hidden")}
          >
            <EyeOff size={14} />
            {l("Hidden", "隐藏")}
          </button>
        </nav>
      </SessionDisclosure>
    </section>
  );
}

function SidebarSectionHeader({
  title,
  expanded,
  onToggle,
}: {
  title: string;
  expanded: boolean;
  onToggle(): void;
}): ReactElement {
  return (
    <button className="section-header" onClick={onToggle} aria-expanded={expanded}>
      <span>{title}</span>
      <ChevronRight size={14} />
    </button>
  );
}

// Keep children mounted for the closing transition, but remove them from keyboard
// navigation and the accessibility tree as soon as their parent closes.
function SessionDisclosure({ expanded, children }: { expanded: boolean; children: ReactNode }): ReactElement {
  return (
    <div className="session-disclosure" data-expanded={expanded} inert={!expanded} aria-hidden={!expanded}>
      <div>{children}</div>
    </div>
  );
}
