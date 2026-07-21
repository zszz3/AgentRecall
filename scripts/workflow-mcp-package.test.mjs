import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the package exposes an AgentRecall-owned Workflow MCP executable", async () => {
  const [manifest, launcher, buildScript] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../bin/agent-recall-workflow-mcp.mjs", import.meta.url), "utf8"),
    readFile(new URL("./build-mcp-bundle.mjs", import.meta.url), "utf8"),
  ]);

  assert.equal(manifest.bin["agent-recall-workflow-mcp"], "bin/agent-recall-workflow-mcp.mjs");
  assert.match(launcher, /path\.join\(binDir,\s*"\.\.",\s*"out",\s*"mcp",\s*"workflow-entry\.js"\)/);
  assert.match(buildScript, /path\.join\(root,\s*"src",\s*"mcp",\s*"workflow-entry\.ts"\)/);
  assert.doesNotMatch(launcher, /multi-agent-chat|\/Users\//);
});
