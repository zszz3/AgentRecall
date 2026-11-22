import { describe, expect, it } from "vitest";
import { teamMcpFromToolSource, teamMcpToolSource } from "./team-mcp-tool-source";
import type { McpServerDefinition } from "../../../../automation/engine/shared/mcp/types";

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

describe("teamMcpFromToolSource", () => {
  const source = (extra: Partial<McpServerDefinition>): McpServerDefinition => ({ id: "local-1", name: "Exa Search", transport: "http", args: [], env: {}, enabled: true, tools: [], status: "connected", createdAt: 1, updatedAt: 1, ...extra });
  it("turns a tool source into a new team server whose secrets stay local variable references", () => {
    expect(teamMcpFromToolSource(source({ url: "https://mcp.exa.ai/mcp", headers: { Authorization: "EXA_AUTH" } }))).toEqual({ ok: true, value: { id: "exa-search", name: "Exa Search", transport: "http", url: "https://mcp.exa.ai/mcp", headers: { Authorization: { fromEnv: "EXA_AUTH" } }, targets: ["codex", "claude"] } });
    expect(teamMcpFromToolSource(source({ name: "本地 Docs", transport: "stdio", command: "npx", args: ["-y", "docs"], env: { DOCS_TOKEN: "DOCS_TOKEN" } }))).toEqual({ ok: true, value: { id: "docs", name: "本地 Docs", transport: "stdio", command: "npx", args: ["-y", "docs"], env: { DOCS_TOKEN: { fromEnv: "DOCS_TOKEN" } }, targets: ["codex", "claude"] } });
  });

  it("falls back to the tool source ID when the name has no letters a team ID can use", () => {
    expect(teamMcpFromToolSource(source({ name: "小红书", url: "https://example.invalid/mcp" }))).toMatchObject({ ok: true, value: { id: "mcp-local-1", name: "小红书" } });
  });

  it("refuses a command variable that reads a differently named local variable, which team servers cannot express", () => {
    expect(teamMcpFromToolSource(source({ transport: "stdio", command: "docs", env: { DOCS_TOKEN: "MY_DOCS_TOKEN" } }))).toEqual({ ok: false, variable: "DOCS_TOKEN", reads: "MY_DOCS_TOKEN" });
  });
});
