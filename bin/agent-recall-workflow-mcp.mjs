#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const entryPath = path.join(binDir, "..", "out", "mcp", "workflow-entry.js");

await import(pathToFileURL(entryPath).href).catch((error) => {
  process.stderr.write(`AgentRecall Workflow MCP failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
