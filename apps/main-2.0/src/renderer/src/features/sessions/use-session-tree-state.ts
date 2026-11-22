import { useCallback, useEffect, useState } from "react";
import {
  readSidebarSections,
  serializeSidebarSections,
  toggleSidebarSection,
  type SidebarSectionId,
  type SidebarSectionsState,
} from "../../sidebar-sections";

const SIDEBAR_SECTIONS_STORAGE_KEY = "agent-recall-sidebar-sections";
const COLLAPSED_PROJECT_GROUPS_STORAGE_KEY = "agent-recall-collapsed-project-groups";

export interface SessionTreeState {
  sections: SidebarSectionsState;
  /** Folded environments, kept across restarts. */
  collapsedEnvironments: ReadonlySet<string>;
  /** Unfolded projects; projects start folded and are not remembered across restarts. */
  expandedProjects: ReadonlySet<string>;
  toggleSection(section: SidebarSectionId): void;
  toggleEnvironment(environmentId: string): void;
  toggleProject(projectKey: string): void;
}

function readCollapsedEnvironments(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === "string")) : new Set();
  } catch {
    // A hand-edited or truncated value only loses the folded state, so start unfolded.
    return new Set();
  }
}

function toggled(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Folding state of the Session page sidebar: its sections, environments and projects. */
export function useSessionTreeState(): SessionTreeState {
  const [sections, setSections] = useState(() => readSidebarSections(window.localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY)));
  const [collapsedEnvironments, setCollapsedEnvironments] = useState<ReadonlySet<string>>(readCollapsedEnvironments);
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, serializeSidebarSections(sections));
  }, [sections]);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY, JSON.stringify([...collapsedEnvironments]));
  }, [collapsedEnvironments]);

  const toggleSection = useCallback((section: SidebarSectionId) => setSections((current) => toggleSidebarSection(current, section)), []);
  const toggleEnvironment = useCallback((environmentId: string) => setCollapsedEnvironments((current) => toggled(current, environmentId)), []);
  const toggleProject = useCallback((projectKey: string) => setExpandedProjects((current) => toggled(current, projectKey)), []);

  return { sections, collapsedEnvironments, expandedProjects, toggleSection, toggleEnvironment, toggleProject };
}
