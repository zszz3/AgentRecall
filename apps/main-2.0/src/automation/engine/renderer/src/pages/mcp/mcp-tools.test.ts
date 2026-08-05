import { describe, expect, test } from "vitest";
import { enabledToolCount, toolCountLabel } from "./mcp-tools";

const tools = [
  { name: "read_file", inputSchema: {} },
  { name: "write_file", inputSchema: {} },
  { name: "list_dir", inputSchema: {} },
];

describe("MCP tool count labels", () => {
  test("shows a single total when nothing is disabled", () => {
    expect(toolCountLabel({ tools, disabledTools: [] }, "tools")).toBe("3 tools");
    expect(toolCountLabel({ tools }, "tools")).toBe("3 tools");
  });

  test("shows enabled/total once tools are disabled", () => {
    expect(enabledToolCount({ tools, disabledTools: ["write_file"] })).toBe(2);
    expect(toolCountLabel({ tools, disabledTools: ["write_file"] }, "tools")).toBe("2/3 tools");
  });

  test("ignores disabled names that are not in the discovered list", () => {
    expect(toolCountLabel({ tools, disabledTools: ["missing"] }, "tools")).toBe("3 tools");
  });
});
