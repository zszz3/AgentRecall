import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function sourceBlock(startNeedle: string, endNeedles: string[]): string {
  const start = appSource.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const ends = endNeedles.map((needle) => appSource.indexOf(needle, start + startNeedle.length)).filter((index) => index >= 0);
  expect(ends.length).toBeGreaterThan(0);
  return appSource.slice(start, Math.min(...ends));
}

describe("app loading performance", () => {
  it("runs and records searches only when Enter is pressed", () => {
    const searchBox = sourceBlock("const SearchBox = forwardRef", ["export function App"]);
    expect(searchBox).toContain("readSearchHistory(window.localStorage)");
    expect(searchBox).toContain("recordSearch(window.localStorage");
    expect(searchBox).toContain("deleteSearch(window.localStorage");
    expect(searchBox).toContain("clearSearchHistory(window.localStorage)");
    expect(searchBox).toContain("recent-search-dropdown");
    expect(searchBox).toContain("onSearch(value)");
    expect(searchBox).not.toContain("setTimeout");
    expect(searchBox).not.toContain("SEARCH_DEBOUNCE_MS");
    expect(searchBox).toContain("selectRecentSearch(query)");
  });

  it("fills recent searches without running them until Enter", () => {
    const searchBox = sourceBlock("const SearchBox = forwardRef", ["export function App"]);
    const selectRecent = searchBox.slice(searchBox.indexOf("function selectRecentSearch"), searchBox.indexOf("function runSearch"));
    expect(selectRecent).toContain("setValue(query)");
    expect(selectRecent).not.toContain("onSearch");
    expect(selectRecent).not.toContain("recordSearch");
  });

  it("keeps session search isolated from sidebar metadata and stats refreshes", () => {
    const loadSessionsBlock = sourceBlock("const load = useCallback(async () =>", [
      "const loadSidebarMetadata = useCallback",
      "const refreshStats = useCallback",
    ]);

    expect(loadSessionsBlock).toContain("window.sessionSearch.searchSessionPage(options)");
    expect(loadSessionsBlock).toContain("setSessionTotalCount(page.totalCount)");
    expect(appSource).toContain('t(`${sessionTotalCount} sessions`, `${sessionTotalCount} 个会话`)');
    expect(appSource).not.toContain("displayedResults.length} /");
    expect(loadSessionsBlock).not.toContain("window.sessionSearch.listTags()");
    expect(loadSessionsBlock).not.toContain("window.sessionSearch.listProjects()");
    expect(loadSessionsBlock).not.toContain("window.sessionSearch.getStats");
  });

  it("refreshes skill usage when the Skills dialog is opened before listing skills", () => {
    const loadSkillsBlock = sourceBlock("const loadSkills = useCallback(async (options:", [
      "const deleteSkill = useCallback",
      "useEffect(() => {",
    ]);
    const skillsOpenEffect = sourceBlock("useEffect(() => {\n    if (skillsOpen)", [
      "useEffect(() => {\n    if (!settingsOpen)",
      "const toggleSkillUsageHook = useCallback",
    ]);

    expect(loadSkillsBlock).toContain("window.sessionSearch.refreshSkillUsage()");
    expect(loadSkillsBlock.indexOf("window.sessionSearch.refreshSkillUsage()")).toBeLessThan(
      loadSkillsBlock.indexOf("window.sessionSearch.listSkills()"),
    );
    expect(skillsOpenEffect).toContain("loadSkills({ refreshUsage: true, silent: true })");
  });
});
