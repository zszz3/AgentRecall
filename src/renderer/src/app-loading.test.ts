import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const searchBoxSource = readFileSync(new URL("./features/search/search-box.tsx", import.meta.url), "utf8");

describe("app loading performance", () => {
  it("runs and records searches only when Enter is pressed", () => {
    expect(searchBoxSource).toContain("readSearchHistory(window.localStorage)");
    expect(searchBoxSource).toContain("recordSearch(window.localStorage");
    expect(searchBoxSource).toContain("deleteSearch(window.localStorage");
    expect(searchBoxSource).toContain("clearSearchHistory(window.localStorage)");
    expect(searchBoxSource).toContain("recent-search-dropdown");
    expect(searchBoxSource).toContain("onSearch(value)");
    expect(searchBoxSource).not.toContain("setTimeout");
    expect(searchBoxSource).not.toContain("SEARCH_DEBOUNCE_MS");
    expect(searchBoxSource).toContain("selectRecentSearch(query)");
    const handleChange = searchBoxSource.slice(
      searchBoxSource.indexOf("function handleChange"),
      searchBoxSource.indexOf("function selectRecentSearch"),
    );
    expect(handleChange).toContain('if (value.length > 0 && next.length === 0) onSearch("")');
    expect(handleChange).toContain("setFocused(next.length > 0)");
  });

  it("runs recent searches immediately on click", () => {
    const selectRecent = searchBoxSource.slice(
      searchBoxSource.indexOf("function selectRecentSearch"),
      searchBoxSource.indexOf("function runSearch"),
    );
    expect(selectRecent).toContain("setValue(query)");
    expect(selectRecent).toContain("onSearch(query)");
    expect(selectRecent).toContain("recordSearch(window.localStorage, current, query)");
  });

  it("does not focus the main search input on startup", () => {
    expect(searchBoxSource).not.toContain("autoFocus");
    expect(appSource).toContain("searchRef.current?.focus()");
  });

  it("keeps session search isolated from optional settings and detail loading", () => {
    const loadStart = appSource.indexOf("const load = useCallback(async () =>");
    const loadEnd = appSource.indexOf("useEffect(() => {", loadStart);
    const loadSessionsBlock = appSource.slice(loadStart, loadEnd);
    expect(loadSessionsBlock).toContain("api.searchSessionPage(options)");
    expect(loadSessionsBlock).toContain("setResults(page.sessions)");
    expect(loadSessionsBlock).toContain("setSessionTotalCount(page.totalCount)");
    expect(loadSessionsBlock).not.toContain(".filter(");
    expect(loadSessionsBlock).not.toContain("api.getSettings");
    expect(loadSessionsBlock).not.toContain("api.getSession");
    expect(loadSessionsBlock).not.toContain("api.getMessages");
  });

  it("loads terminal settings only after the minimal Settings surface opens", () => {
    expect(appSource).toContain('if (infoSection !== "settings" || appSettings) return');
    expect(appSource).toContain(".getSettings()");
    expect(appSource).toContain("api.setSettings({ defaultTerminal })");
  });

  it("does not start advanced data fetches or background polling", () => {
    for (const apiName of [
      "getLiveSessions",
      "getQuotas",
      "getStats",
      "getRemoteSessionStatus",
      "listSessionSyncItems",
      "listSkills",
      "refreshSkillUsage",
    ]) {
      expect(appSource).not.toContain(`sessionSearch.${apiName}`);
    }
    expect(appSource).not.toContain("setInterval");
  });
});
