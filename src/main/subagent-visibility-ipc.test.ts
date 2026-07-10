import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("subagent visibility IPC", () => {
  it("injects the stored setting into user-visible session queries", () => {
    expect(mainSource).toContain("excludeSubagents: getSettings().hideSubagentSessions");
    expect(mainSource).toContain('store.searchSessions(visibleSearchOptions(options))');
    expect(mainSource).toContain('store.searchSessionPage(visibleSearchOptions(options))');
    expect(mainSource).toContain('store.getStats(visibleStatsOptions(options))');
    expect(mainSource).toContain('store.listProjects(visibleProjectOptions())');
  });

  it("applies the same visibility to AI finder searches", () => {
    expect(mainSource).toContain('store.searchSessions(visibleSearchOptions({ query, limit: 12 }))');
    expect(mainSource).toContain('const sessions = store.searchSessions(visibleSearchOptions({');
    expect(mainSource).toContain('const projects = store.listProjects(visibleProjectOptions())');
  });
});
