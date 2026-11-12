import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SESSION_MCP_DESCRIPTIONS } from "../bin/agent-recall-mcp.mjs";

test("session MCP tool and parameter descriptions are written in Chinese", () => {
  const descriptions = Object.values(SESSION_MCP_DESCRIPTIONS);
  assert.ok(descriptions.length >= 20);
  for (const description of descriptions) {
    assert.match(description, /[\u3400-\u9fff]/u, description);
  }
});

test("session MCP exposes the focused 7-tool catalog", () => {
  const source = readFileSync(new URL("../bin/agent-recall-mcp.mjs", import.meta.url), "utf8");
  const toolNames = [...source.matchAll(/server\.registerTool\(\s*"([^"]+)"/gu)]
    .map((match) => match[1]);

  assert.equal(toolNames.length, 7);
  assert.ok(!toolNames.some((name) => name.startsWith("memory_")));
  assert.ok(!toolNames.includes("list_projects"));
  assert.ok(!toolNames.includes("list_tags"));
  assert.doesNotMatch(source, /export async function listProjects\(/u);
  assert.doesNotMatch(source, /export async function listTags\(/u);
  assert.ok(!Object.hasOwn(SESSION_MCP_DESCRIPTIONS, "listProjects"));
  assert.ok(!Object.hasOwn(SESSION_MCP_DESCRIPTIONS, "listTags"));
});
