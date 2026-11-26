#!/usr/bin/env node
// Bundles the unified AgentRecall CLI (src/cli/index.ts + packages/workspace-core)
// into out/cli/index.js so bin/agent-recall.cjs runs without tsx or TypeScript at runtime.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const outdir = path.join(root, "out", "cli");
const workspaceCoreEntry = path.resolve(root, "..", "..", "packages", "workspace-core", "src", "index.ts");

await build({
  entryPoints: [path.join(root, "src", "cli", "index.ts")],
  outdir,
  entryNames: "[name]",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  packages: "external",
  alias: {
    "@agentrecall/workspace-core": workspaceCoreEntry,
  },
  logLevel: "info",
});
