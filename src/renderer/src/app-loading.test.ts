import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const searchBoxSource = readFileSync(new URL("./features/search/search-box.tsx", import.meta.url), "utf8");
const remoteSessionsSource = readFileSync(new URL("./features/remote-sessions/remote-sessions-dialog.tsx", import.meta.url), "utf8");

function sourceBlock(startNeedle: string, endNeedles: string[]): string {
  const start = appSource.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const ends = endNeedles.map((needle) => appSource.indexOf(needle, start + startNeedle.length)).filter((index) => index >= 0);
  expect(ends.length).toBeGreaterThan(0);
  return appSource.slice(start, Math.min(...ends));
}

describe("app loading performance", () => {
  it("runs and records searches only when Enter is pressed", () => {
    const searchBox = searchBoxSource;
    expect(searchBox).toContain("readSearchHistory(window.localStorage)");
    expect(searchBox).toContain("recordSearch(window.localStorage");
    expect(searchBox).toContain("deleteSearch(window.localStorage");
    expect(searchBox).toContain("clearSearchHistory(window.localStorage)");
    expect(searchBox).toContain("recent-search-dropdown");
    expect(searchBox).toContain("onSearch(value)");
    expect(searchBox).not.toContain("setTimeout");
    expect(searchBox).not.toContain("SEARCH_DEBOUNCE_MS");
    expect(searchBox).toContain("selectRecentSearch(query)");
    const handleChange = searchBox.slice(searchBox.indexOf("function handleChange"), searchBox.indexOf("function selectRecentSearch"));
    expect(handleChange).toContain('if (value.length > 0 && next.length === 0) onSearch("")');
    expect(handleChange).toContain("setFocused(next.length > 0)");
  });

  it("runs recent searches immediately on click", () => {
    const searchBox = searchBoxSource;
    const selectRecent = searchBox.slice(searchBox.indexOf("function selectRecentSearch"), searchBox.indexOf("function runSearch"));
    expect(selectRecent).toContain("setValue(query)");
    expect(selectRecent).toContain("onSearch(query)");
    expect(selectRecent).toContain("recordSearch(window.localStorage, current, query)");
  });

  it("does not focus the main search input on startup", () => {
    const searchBox = searchBoxSource;
    expect(searchBox).not.toContain("autoFocus");
    expect(appSource).toContain("searchRef.current?.focus()");
  });

  it("lets the toolbar give unused scope-filter space to the search box", () => {
    expect(appSource).toContain('<div className="scope-filter" data-count={activeScopeFilters.length}');
    expect(appSource).not.toContain('className="scope-filter-slot"');
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

  it("refreshes sidebar metadata after a session title changes", () => {
    const submitDialogBlock = sourceBlock("async function submitDialog", [
      "async function removeTag",
    ]);
    expect(submitDialogBlock).toContain('dialogKind === "rename" || (dialogKind === "tag" && Boolean(value))');
    expect(submitDialogBlock).toContain("refreshAfterAction({ metadata:");
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

  it("preloads and caches remote sessions instead of reloading them whenever the dialog opens", () => {
    const cacheLoader = sourceBlock("const loadRemoteSessionsCache = useCallback", [
      "const cacheRemoteSessionUpload = useCallback",
    ]);
    const startupEffect = sourceBlock("useEffect(() => {\n    void loadRemoteSessionsCache();", [
      "useEffect(() => {\n    if (skillsOpen)",
    ]);

    expect(cacheLoader).toContain("window.sessionSearch.getRemoteSessionStatus()");
    expect(cacheLoader).toContain("window.sessionSearch.listSessionSyncItems()");
    expect(cacheLoader).toContain("if (remoteSessionsLoadPromiseRef.current) return remoteSessionsLoadPromiseRef.current");
    expect(startupEffect).toContain("loadRemoteSessionsCache()");
    expect(appSource).toContain("cache={remoteSessionsCache}");
    expect(appSource).toContain("onRefresh={loadRemoteSessionsCache}");
    expect(remoteSessionsSource).not.toContain("window.sessionSearch.getRemoteSessionStatus()");
    expect(remoteSessionsSource).not.toContain("window.sessionSearch.listSessionSyncItems()");
    expect(remoteSessionsSource).toContain("onRemoteSessionUploaded(item.local.sessionKey, result.remoteSession)");
    expect(remoteSessionsSource).toContain("onRemoteSessionsDeleted([...removedIds])");
  });
});
