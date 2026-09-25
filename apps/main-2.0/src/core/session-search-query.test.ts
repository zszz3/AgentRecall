import { describe, expect, it } from "vitest";
import { escapeLike, parseSearchClauses } from "./session-search-query";
// @ts-expect-error -- standalone MCP JavaScript boundary
import { searchSessions } from "../../bin/agent-recall-mcp.mjs";

describe("UI and MCP query contract", () => {
  it.each([
    ["", []], ["ab AND ab 中 x", ["ab"]], ['"中" "a" "retry timeout"', ["中", "a", "retry timeout"]],
    ['"AND" and', []], ["😀 🐱猫", ["🐱猫"]], [String.raw`a_b 25% C:\tmp`, ["a_b", "25%", String.raw`C:\tmp`]],
  ] as const)("keeps parsing and literal SQL escaping aligned for %s", async (query, expected) => {
    expect(parseSearchClauses(query)).toEqual(expected);
    let captured: unknown[] = [];
    await searchSessions({ query: async (_sql: string, values: unknown[]) => {
      captured = values;
      return { rows: [] };
    } }, { query });
    expect(captured).toEqual(expected.length > 0
      ? [...expected.map(term => `%${escapeLike(term)}%`), query.trim(), 20] : [20]);
  });
});
