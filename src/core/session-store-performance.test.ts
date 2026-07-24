import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const storeSource = readFileSync(new URL("./store/sessions.ts", import.meta.url), "utf8");

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
    expect(candidatesBlock).toContain("ORDER BY favorited DESC");
    expect(storeSource).toContain("if (result.favorited) score += 25");
    expect(storeSource).toContain("result.favorited ? 1.2 : 1.0");
    expect(storeSource).not.toContain("result.pinned");
  });

  it("keeps FTS candidate lookup key-only instead of generating snippets for every match", () => {
    const searchFtsBlock = sourceBlock("private searchFts(", "private getTagsForSession");

    expect(searchFtsBlock).toContain("SELECT session_key");
    expect(searchFtsBlock).not.toContain("snippet(session_fts");
  });

  it("builds FTS from the messages already loaded for indexing", () => {
    const upsertBlock = sourceBlock("  upsertIndexedSession(", "  isIndexedSessionFresh(");

    expect(upsertBlock).toContain("this.refreshFtsForSession(session.sessionKey, messages)");
  });
});
