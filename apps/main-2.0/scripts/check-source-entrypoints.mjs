#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(appRoot, "src");
const productionEntries = [
  "src/main/index.ts",
  "src/main/live-session-worker.ts",
  "src/preload/index.ts",
  "src/renderer/src/main.tsx",
  "src/renderer/src/quick-search-main.tsx",
  "src/mcp/migration-entry.ts",
  "src/mcp/skill-entry.ts",
  "src/mcp/gateway-entry.ts",
  "src/mcp/workflow-entry.ts",
  "src/mcp/eval-entry.ts",
];
const testSupportModules = new Set([
  "src/automation/engine/main/platform/test-cli-fixtures.ts",
  "src/core/postgres/test-pglite.ts",
  "src/core/postgres/test-session-store.ts",
].map(resolveAppPath));

const sourceFiles = collectSourceFiles(sourceRoot);
const sourceFileSet = new Set(sourceFiles);
const importsByFile = new Map(sourceFiles.map((file) => [file, relativeImports(file)]));
const reachable = collectReachable(productionEntries.map(resolveAppPath));
const unreachable = sourceFiles
  .filter((file) => !reachable.has(file))
  .filter((file) => !testSupportModules.has(file))
  .map((file) => path.relative(appRoot, file))
  .sort();

if (unreachable.length > 0) {
  console.error("Production source modules are unreachable from the declared entry points:");
  for (const file of unreachable) console.error(`- ${file}`);
  process.exitCode = 1;
} else {
  console.log(`Source entrypoint check passed (${reachable.size} production modules).`);
}

function collectSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
      continue;
    }
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    files.push(path.resolve(entryPath));
  }
  return files;
}

function relativeImports(file) {
  const source = fs.readFileSync(file, "utf8");
  const imports = ts.preProcessFile(source, true, true).importedFiles;
  return imports
    .map(({ fileName }) => resolveRelativeImport(file, fileName))
    .filter((resolved) => resolved !== null);
}

function resolveRelativeImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    unresolved.replace(/\.js$/, ".ts"),
    unresolved.replace(/\.js$/, ".tsx"),
    path.join(unresolved, "index.ts"),
    path.join(unresolved, "index.tsx"),
  ];
  return candidates.find((candidate) => sourceFileSet.has(candidate)) ?? null;
}

function collectReachable(entries) {
  const seen = new Set();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    if (!sourceFileSet.has(file)) throw new Error(`Missing production entry point: ${path.relative(appRoot, file)}`);
    seen.add(file);
    pending.push(...(importsByFile.get(file) ?? []));
  }
  return seen;
}

function resolveAppPath(relativePath) {
  return path.resolve(appRoot, relativePath);
}
