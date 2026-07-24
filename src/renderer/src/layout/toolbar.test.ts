import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Toolbar } from "./toolbar";

const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const noop = () => undefined;

function renderToolbar(): string {
  return renderToStaticMarkup(createElement(Toolbar, {
    language: "en",
    platform: "darwin",
    searchRef: { current: null },
    searchPlaceholder: "Search sessions",
    onSearch: noop,
    activeFilterCount: 0,
    queryBuilderOpen: false,
    onToggleQueryBuilder: noop,
    savedSearchesOpen: false,
    onToggleSavedSearches: noop,
    groupMode: "flat",
    onCycleGroupMode: noop,
    liveStatus: "all",
    onSelectLiveStatus: noop,
    dateRange: "all",
    onSelectDateRange: noop,
    sortBy: "smart",
    onSelectSortBy: noop,
    aiAssistantOpen: false,
    onOpenAiAssistant: noop,
    skillsOpen: false,
    onOpenSkills: noop,
    assetsOpen: false,
    onOpenAssets: noop,
    remoteSessionsOpen: false,
    onOpenRemoteSessions: noop,
    apiConfigOpen: false,
    onOpenApiConfig: noop,
    shouldSignalAppUpdate: false,
    onOpenSettings: noop,
  }));
}

describe("Toolbar layout", () => {
  it("keeps search tools in the first row and filters plus global actions in the second row", () => {
    const html = renderToolbar();
    const primaryRow = html.indexOf('class="toolbar-primary"');
    const searchBox = html.indexOf('class="searchbox"');
    const discoveryTools = html.indexOf('class="toolbar-discovery"');
    const secondaryRow = html.indexOf('class="toolbar-secondary"');
    const filters = html.indexOf('class="toolbar-filters"');
    const globalActions = html.indexOf('class="top-actions"');

    expect(primaryRow).toBeGreaterThanOrEqual(0);
    expect(searchBox).toBeGreaterThan(primaryRow);
    expect(discoveryTools).toBeGreaterThan(searchBox);
    expect(secondaryRow).toBeGreaterThan(discoveryTools);
    expect(filters).toBeGreaterThan(secondaryRow);
    expect(globalActions).toBeGreaterThan(filters);
  });

  it("renders the toolbar as two rows without wrapping either semantic row", () => {
    expect(styles).toMatch(/\.toolbar\s*\{[\s\S]*?display:\s*grid;/);
    expect(styles).toMatch(/\.toolbar-primary,\s*\.toolbar-secondary\s*\{[\s\S]*?display:\s*flex;/);
    expect(styles).toMatch(/\.toolbar-secondary\s*\{[\s\S]*?overflow-x:\s*auto;/);
    expect(styles).toMatch(/\.toolbar-primary\s*>\s*\.searchbox\s*\{[\s\S]*?flex:\s*1 1 180px;/);
  });
});
