export type SidebarSectionId = "views" | "environments" | "sources";

export type SidebarSectionsState = Record<SidebarSectionId, boolean>;

export const DEFAULT_SIDEBAR_SECTIONS: SidebarSectionsState = {
  environments: true,
  sources: true,
  views: false,
};

export function readSidebarSections(value: string | null): SidebarSectionsState {
  if (!value) return { ...DEFAULT_SIDEBAR_SECTIONS };
  try {
    const parsed = JSON.parse(value) as Partial<Record<SidebarSectionId, unknown>>;
    return {
      environments:
        typeof parsed.environments === "boolean" ? parsed.environments : DEFAULT_SIDEBAR_SECTIONS.environments,
      sources: typeof parsed.sources === "boolean" ? parsed.sources : DEFAULT_SIDEBAR_SECTIONS.sources,
      views: typeof parsed.views === "boolean" ? parsed.views : DEFAULT_SIDEBAR_SECTIONS.views,
    };
  } catch {
    return { ...DEFAULT_SIDEBAR_SECTIONS };
  }
}

export function serializeSidebarSections(state: SidebarSectionsState): string {
  return JSON.stringify(state);
}

export function toggleSidebarSection(state: SidebarSectionsState, section: SidebarSectionId): SidebarSectionsState {
  return { ...state, [section]: !state[section] };
}
