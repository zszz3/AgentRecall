#!/usr/bin/env node
// Bundles the MCP migration entry point into a single ESM file so the standalone
// MCP server (bin/agent-recall-mcp.mjs) can call migrate_session without
// --experimental-strip-types and without resolving src/core imports at runtime.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const entry = path.join(root, "src", "mcp", "migration-entry.ts");
const outdir = path.join(root, "out", "mcp");

await build({
  entryPoints: [entry],
  outdir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  // node: built-ins are resolved at runtime by the host; everything else from
  // src/core is inlined into the bundle.
  packages: "external",
  logLevel: "info",
});
