import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findAgentMcpServers } from "./agent-mcp-servers";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mcp-"));
  roots.push(root);
  return root;
}

async function put(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("findAgentMcpServers", () => {
  it("lists the servers each agent and project configures once, without the values of variables, headers or secrets", async () => {
    const home = await tempDir();
    const project = path.join(home, "work", "app");
    await put(path.join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        github: { type: "stdio", command: "npx", args: ["-y", "@github/mcp", "--token", "ghp_secretvalue1234567890"], env: { GITHUB_TOKEN: "ghp_secretvalue1234567890" } },
      },
      projects: { [project]: { mcpServers: { local: { command: "node", args: ["server.js"] } } } },
    }));
    await put(path.join(home, ".codex", "config.toml"), [
      "[mcp_servers.github]",
      'command = "npx"',
      'args = ["-y", "@github/mcp", "--token", "ghp_secretvalue1234567890"]',
      "[mcp_servers.github.env]",
      'GITHUB_TOKEN = "ghp_secretvalue1234567890"',
      "",
      "[mcp_servers.docs]",
      'url = "https://docs.example.com/mcp?apiKey=abc123&lang=en"',
      'bearer_token_env_var = "DOCS_TOKEN"',
      "enabled = false",
      "",
    ].join("\n"));
    await put(path.join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { search: { httpUrl: "https://search.example.com/mcp", headers: { Authorization: "Bearer secret" } } } }));
    await put(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: { browser: { type: "local", command: ["npx", "browser-mcp"], environment: { BROWSER: "chrome" }, enabled: true } } }));
    await put(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { db: { type: "http", url: "https://db.example.com/mcp" } } }));
    await put(path.join(project, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { db: { url: "https://db.example.com/mcp" } } }));

    const { servers, problems } = await findAgentMcpServers({ home, env: {}, projects: [project, path.join(home, "missing")] });

    expect(problems).toEqual([]);
    expect(servers.map((server) => server.name)).toEqual(["browser", "db", "docs", "github", "local", "search"]);
    const github = servers.find((server) => server.name === "github")!;
    expect(github).toMatchObject({ transport: "stdio", command: "npx", url: null, envNames: ["GITHUB_TOKEN"], headerNames: [] });
    expect(github.args).toEqual(["-y", "@github/mcp", "--token", "[redacted]"]);
    expect(github.locations.map((location) => location.agent)).toEqual(["Claude Code", "Codex"]);
    expect(github.locations.every((location) => location.scope === "user" && location.project === null)).toBe(true);
    expect(servers.find((server) => server.name === "docs")).toMatchObject({
      transport: "http",
      url: "https://docs.example.com/mcp?apiKey=[redacted]&lang=en",
      headerNames: ["Authorization"],
      disabled: true,
    });
    expect(servers.find((server) => server.name === "search")).toMatchObject({ transport: "http", headerNames: ["Authorization"] });
    expect(servers.find((server) => server.name === "browser")).toMatchObject({ command: "npx", args: ["browser-mcp"], envNames: ["BROWSER"], disabled: false });
    const db = servers.find((server) => server.name === "db")!;
    expect(db.locations).toEqual([
      { agent: "Claude Code", scope: "project", project, file: path.join(project, ".mcp.json") },
      { agent: "Cursor", scope: "project", project, file: path.join(project, ".cursor", "mcp.json") },
    ]);
    expect(servers.find((server) => server.name === "local")!.locations).toEqual([
      { agent: "Claude Code", scope: "project", project, file: path.join(home, ".claude.json") },
    ]);
    expect(JSON.stringify(servers)).not.toContain("ghp_secretvalue");
    expect(JSON.stringify(servers)).not.toContain("Bearer secret");
    expect(JSON.stringify(servers)).not.toContain("abc123");
  });

  it("reports a file it cannot read and still lists the others", async () => {
    const home = await tempDir();
    await put(path.join(home, ".cursor", "mcp.json"), "{ not json");
    await put(path.join(home, ".codex", "config.toml"), "[mcp_servers.ok]\ncommand = \"ok\"\n");

    const { servers, problems } = await findAgentMcpServers({ home, env: {}, projects: [] });

    expect(servers.map((server) => server.name)).toEqual(["ok"]);
    expect(problems).toEqual([{ file: path.join(home, ".cursor", "mcp.json"), message: "mcp.json is not valid JSON." }]);
  });

  it("reads a user-level file once when a project folder is the home folder", async () => {
    const home = await tempDir();
    await put(path.join(home, ".codex", "config.toml"), "[mcp_servers.repl]\ncommand = \"node\"\n");

    const { servers } = await findAgentMcpServers({ home, env: {}, projects: [home] });

    expect(servers.map((server) => [server.name, server.locations])).toEqual([
      ["repl", [{ agent: "Codex", scope: "user", project: null, file: path.join(home, ".codex", "config.toml") }]],
    ]);
  });
});
