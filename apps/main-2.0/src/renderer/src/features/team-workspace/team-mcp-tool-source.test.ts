import { describe, expect, it } from "vitest";
import { teamMcpToolSource } from "./team-mcp-tool-source";

describe("teamMcpToolSource", () => {
  it("turns a team server into a disabled tool source that reads the same local variables", () => {
    expect(teamMcpToolSource({ id: "docs", name: "Docs", transport: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { DOCS_TOKEN: { fromEnv: "DOCS_TOKEN" } }, targets: ["codex"] }, { id: "example", name: "Example" }, 5)).toEqual({ ok: true, server: {
      id: "team-example-docs", name: "Docs", description: "来自团队 Example", transport: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: { DOCS_TOKEN: "DOCS_TOKEN" },
      enabled: false, tools: [], disabledTools: [], status: "untested", createdAt: 5, updatedAt: 5,
    } });
    expect(teamMcpToolSource({ id: "wiki", name: "Wiki", transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "WIKI_AUTH" } }, targets: ["claude"] }, { id: "example", name: "Example" }, 5)).toMatchObject({ ok: true, server: { id: "team-example-wiki", transport: "http", url: "https://example.invalid/mcp", args: [], env: {}, headers: { Authorization: "WIKI_AUTH" } } });
  });

  it("refuses fixed values, because tool sources only name local environment variables", () => {
    expect(teamMcpToolSource({ id: "docs", name: "Docs", transport: "stdio", command: "docs", args: [], env: { LOG_LEVEL: "debug", DOCS_TOKEN: { fromEnv: "DOCS_TOKEN" } }, targets: ["codex"] }, { id: "example", name: "Example" }, 5)).toEqual({ ok: false, fixed: ["LOG_LEVEL"] });
    expect(teamMcpToolSource({ id: "wiki", name: "Wiki", transport: "http", url: "https://example.invalid/mcp", headers: { "X-Team": "agentrecall" }, targets: ["codex"] }, { id: "example", name: "Example" }, 5)).toEqual({ ok: false, fixed: ["X-Team"] });
  });
});
