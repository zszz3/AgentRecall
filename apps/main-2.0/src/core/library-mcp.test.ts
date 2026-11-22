import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

import { decodeServer, encodeServer, libraryMcpTargets, readMcpEntries, withMcpEntries, type LibraryMcpTarget } from "./library-mcp";

const stdio = { command: "npx", args: ["-y", "@x/server"], env: { TOKEN_FILE: "/tmp/t" } };
const http = { url: "https://mcp.example.com/mcp", headers: { "X-Team": "a" } };

function target(id: LibraryMcpTarget["id"]): LibraryMcpTarget {
  const found = libraryMcpTargets("/home/u", {}).find((item) => item.id === id);
  if (!found) throw new Error(`no target ${id}`);
  return found;
}

describe("library MCP targets", () => {
  it("names each agent's user-level MCP file and leaves out agents without one", () => {
    const targets = libraryMcpTargets("/home/u", { CODEX_HOME: "/codex", XDG_CONFIG_HOME: "relative" });
    expect(targets.map((item) => [item.id, item.file])).toEqual([
      ["claude-code", "/home/u/.claude.json"],
      ["codex", "/codex/config.toml"],
      ["gemini", "/home/u/.gemini/settings.json"],
      ["opencode", "/home/u/.config/opencode/opencode.json"],
      ["qwen", "/home/u/.qwen/settings.json"],
      ["cursor", "/home/u/.cursor/mcp.json"],
      ["zcode", "/home/u/.zcode/cli/config.json"],
    ]);
  });

  it("writes each agent's own shape and reads it back to the Library shape", () => {
    expect(encodeServer(target("claude-code"), "s", stdio)).toEqual({ type: "stdio", ...stdio });
    expect(encodeServer(target("claude-code"), "s", http)).toEqual({ type: "http", ...http });
    expect(encodeServer(target("gemini"), "s", http)).toEqual({ httpUrl: http.url, headers: http.headers });
    expect(encodeServer(target("cursor"), "s", stdio)).toEqual(stdio);
    expect(encodeServer(target("opencode"), "s", stdio)).toEqual({ type: "local", command: ["npx", "-y", "@x/server"], environment: stdio.env, enabled: true });
    expect(encodeServer(target("opencode"), "s", http)).toEqual({ type: "remote", url: http.url, headers: http.headers, enabled: true });
    expect(encodeServer(target("codex"), "s", http)).toBe('[mcp_servers.s]\nurl = "https://mcp.example.com/mcp"\n\n[mcp_servers.s.http_headers]\nX-Team = "a"');

    for (const id of ["claude-code", "gemini", "opencode", "qwen", "cursor", "zcode"] as const) {
      for (const server of [stdio, http]) expect(decodeServer(target(id), encodeServer(target(id), "s", server))).toEqual(server);
    }
    expect(decodeServer(target("claude-code"), { type: "sse", url: "https://x/sse" })).toEqual({ url: "https://x/sse" });
    expect(decodeServer(target("claude-code"), { command: 3 })).toBeNull();
  });
});

describe("library MCP entries", () => {
  it("adds and removes entries in JSON files without touching other keys", () => {
    const claude = target("claude-code");
    const before = JSON.stringify({ projects: { "/r": {} }, mcpServers: { mine: { command: "m" } } });
    const after = withMcpEntries(claude, before, { set: { s: encodeServer(claude, "s", stdio) }, remove: [] });
    expect(JSON.parse(after)).toEqual({ projects: { "/r": {} }, mcpServers: { mine: { command: "m" }, s: { type: "stdio", ...stdio } } });
    expect(readMcpEntries(claude, after)).toEqual({ mine: { command: "m" }, s: { type: "stdio", ...stdio } });
    expect(JSON.parse(withMcpEntries(claude, after, { set: {}, remove: ["s"] }))).toEqual(JSON.parse(before));

    const zcode = target("zcode");
    expect(JSON.parse(withMcpEntries(zcode, "", { set: { s: { command: "a" } }, remove: [] }))).toEqual({ mcp: { servers: { s: { command: "a" } } } });
    expect(() => readMcpEntries(claude, "{broken")).toThrow(/not valid JSON/);
  });

  it("keeps Codex comments and other tables and reads its own blocks as text", () => {
    const codex = target("codex");
    const before = '# my settings\nmodel = "x"\n\n[mcp_servers.mine]\ncommand = "m"\n';
    const block = encodeServer(codex, "s", stdio) as string;
    const added = withMcpEntries(codex, before, { set: { s: block }, remove: [] });
    expect(added.startsWith(before)).toBe(true);
    expect(parseToml(added)).toMatchObject({ model: "x", mcp_servers: { mine: { command: "m" }, s: { command: "npx", env: stdio.env } } });
    const entries = readMcpEntries(codex, added);
    expect(entries.s).toBe(block);
    expect(Object.keys(entries)).toEqual(["mine", "s"]);
    expect(decodeServer(codex, (parseToml(added).mcp_servers as Record<string, unknown>).s)).toEqual(stdio);
    expect(decodeServer(codex, { command: "a", bearer_token_env_var: "T" })).toBeNull();
    expect(withMcpEntries(codex, added, { set: {}, remove: ["s"] })).toBe(before);
    expect(() => withMcpEntries(codex, 'mcp_servers = { s = { command = "a" } }\n', { set: { s: block }, remove: [] })).toThrow(/config\.toml/);
  });
});
