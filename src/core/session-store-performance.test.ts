import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const storeSource = readFileSync(new URL("./session-store.ts", import.meta.url), "utf8");

function sourceBlock(startNeedle: string, endNeedle: string): string {
  const start = storeSource.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = storeSource.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return storeSource.slice(start, end);
}

describe("SessionStore search performance", () => {
  it("pushes empty-query sorting and limits down to SQLite", () => {
    const candidatesBlock = sourceBlock("private getCandidateRows(", "private matchesTextFields");

    expect(candidatesBlock).toContain("query: string");
    expect(candidatesBlock).toContain("LIMIT ?");
    expect(candidatesBlock).toContain("ORDER BY pinned DESC");
  });

  it("keeps FTS candidate lookup key-only instead of generating snippets for every match", () => {
    const searchFtsBlock = sourceBlock("private searchFts(", "private getTagsForSession");

    expect(searchFtsBlock).toContain("SELECT session_key");
    expect(searchFtsBlock).not.toContain("snippet(session_fts");
  });
});
