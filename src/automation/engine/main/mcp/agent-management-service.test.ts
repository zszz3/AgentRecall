import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { McpAgentManagementService } from "./agent-management-service";

const temporaryHomes: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function service(homeDir: string, runtimeForAgent: (agentId: string) => string) {
  return new McpAgentManagementService({
    homeDir: () => homeDir,
    appDataDir: () => homeDir,
    workDir: () => homeDir,
    serverPath: () => path.join(homeDir, "workflow-server.js"),
    bridgePath: () => path.join(homeDir, "bridge.json"),
    bridgeRunning: () => true,
    workflowCreateAvailable: () => true,
    runtimeForAgent,
  } as ConstructorParameters<typeof McpAgentManagementService>[0]);
}

describe("McpAgentManagementService", () => {
  test("refuses to write a non-Codex Agent into the Codex config", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-recall-mcp-home-"));
    temporaryHomes.push(home);

    await expect(service(home, () => "claude").install({ agentId: "claude-agent", catalogId: "filesystem" }))
      .rejects.toThrow(/Codex/i);
    await expect(access(path.join(home, ".codex", "config.toml"))).rejects.toThrow();
  });

  test("still installs managed catalog entries for Codex Agents", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-recall-mcp-home-"));
    temporaryHomes.push(home);

    await service(home, () => "codex").install({ agentId: "codex-agent", catalogId: "filesystem", allowedPath: home });
    expect(await readFile(path.join(home, ".codex", "config.toml"), "utf8"))
      .toContain("agent=codex-agent catalog=filesystem");
  });

  test("can remove a managed entry after its Agent changes runtime", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-recall-mcp-home-"));
    temporaryHomes.push(home);
    await service(home, () => "codex").install({
      agentId: "changed-agent",
      catalogId: "filesystem",
      allowedPath: home,
    });

    await service(home, () => "claude").uninstall({
      agentId: "changed-agent",
      catalogId: "filesystem",
    });

    expect(await readFile(path.join(home, ".codex", "config.toml"), "utf8"))
      .not.toContain("agent=changed-agent catalog=filesystem");
  });
});
