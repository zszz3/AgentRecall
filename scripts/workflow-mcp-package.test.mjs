import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the package exposes an AgentRecall-owned Workflow MCP executable", async () => {
  const [manifest, launcher, buildScript, entrySource, serverSource] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../bin/agent-recall-workflow-mcp.mjs", import.meta.url), "utf8"),
    readFile(new URL("./build-mcp-bundle.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/mcp/workflow-entry.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/automation/engine/mcp/server.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(manifest.bin["agent-recall-workflow-mcp"], "bin/agent-recall-workflow-mcp.mjs");
  assert.match(launcher, /path\.join\(binDir,\s*"\.\.",\s*"out",\s*"mcp",\s*"workflow-entry\.js"\)/);
  assert.match(buildScript, /path\.join\(root,\s*"src",\s*"mcp",\s*"workflow-entry\.ts"\)/);
  assert.match(entrySource, /startStdioMcpServer\(\)/);
  assert.doesNotMatch(serverSource, /import\.meta\.url\s*===/);
  assert.doesNotMatch(launcher, /multi-agent-chat|\/Users\//);
});
