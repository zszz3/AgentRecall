import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMcpCatalogService } from "./agent-mcp-catalog-service";

let root = "";
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

describe("AgentMcpCatalogService", () => {
  it("opens and reveals only configuration files it listed, looking again before refusing", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-catalog-"));
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { db: { url: "https://db.example.com/mcp" } } }));
    await fs.writeFile(path.join(home, ".claude.json"), "{ broken");
    const openPath = vi.fn(async () => "");
    const revealPath = vi.fn();
    const service = new AgentMcpCatalogService({ home, env: {}, localProjects: async () => [repo], openPath, revealPath });

    await service.open(path.join(repo, ".mcp.json"));
    // A file that could not be parsed is still listed so the user can open and fix it.
    await service.reveal(path.join(home, ".claude.json"));
    await expect(service.open(path.join(root, "other.json"))).rejects.toThrow("other.json is not one of the MCP configuration files any more. Refresh the list and try again.");

    expect(openPath).toHaveBeenCalledWith(path.join(repo, ".mcp.json"));
    expect(revealPath).toHaveBeenCalledWith(path.join(home, ".claude.json"));
    const listed = await service.list();
    expect(listed.servers.map((server) => server.name)).toEqual(["db"]);
    expect(listed.problems).toEqual([{ file: path.join(home, ".claude.json"), message: ".claude.json is not valid JSON." }]);

    openPath.mockResolvedValueOnce("No application knows how to open this file");
    await expect(service.open(path.join(repo, ".mcp.json"))).rejects.toThrow("Could not open .mcp.json: No application knows how to open this file");
  });
});
