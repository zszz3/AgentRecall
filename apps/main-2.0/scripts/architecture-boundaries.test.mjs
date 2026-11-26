import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(appRoot, "src");
const coreRoot = path.join(sourceRoot, "core");
const mainRoot = path.join(sourceRoot, "main");
const rendererRoot = path.join(sourceRoot, "renderer");

function collectProductionSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectProductionSourceFiles(entryPath));
      continue;
    }
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    files.push(path.resolve(entryPath));
  }
  return files;
}

function listImportedSpecifiers(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return ts.preProcessFile(content, true, true).importedFiles.map((item) => item.fileName);
}

function isInside(targetPath, rootDir) {
  const rel = path.relative(rootDir, targetPath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

test("src/core production modules do not import electron, src/main, or src/renderer", () => {
  const violations = [];
  for (const filePath of collectProductionSourceFiles(coreRoot)) {
    for (const specifier of listImportedSpecifiers(filePath)) {
      if (specifier === "electron" || specifier.startsWith("electron/")) {
        violations.push(`${path.relative(appRoot, filePath)} imports "${specifier}"`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(filePath), specifier);
      if (isInside(resolved, mainRoot) || isInside(resolved, rendererRoot)) {
        violations.push(`${path.relative(appRoot, filePath)} imports "${specifier}"`);
      }
    }
  }
  assert.deepEqual(violations, [], `Boundary violations in src/core:\n${violations.join("\n")}`);
});

test("src/renderer production modules do not import electron, src/main, or node built-ins", () => {
  const violations = [];
  for (const filePath of collectProductionSourceFiles(rendererRoot)) {
    for (const specifier of listImportedSpecifiers(filePath)) {
      if (specifier === "electron" || specifier.startsWith("electron/") || specifier.startsWith("node:")) {
        violations.push(`${path.relative(appRoot, filePath)} imports "${specifier}"`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(filePath), specifier);
      if (isInside(resolved, mainRoot)) {
        violations.push(`${path.relative(appRoot, filePath)} imports "${specifier}"`);
      }
    }
  }
  assert.deepEqual(violations, [], `Boundary violations in src/renderer:\n${violations.join("\n")}`);
});

test("src/main/index.ts delegates IPC handlers to domain registrars with no raw ipcMain.handle/on calls", () => {
  const mainEntry = fs.readFileSync(path.join(mainRoot, "index.ts"), "utf8");
  const rawCalls = [...mainEntry.matchAll(/\bipcMain\.(?:handle|on)\s*\(/g)];
  assert.equal(
    rawCalls.length,
    0,
    `Expected zero raw ipcMain.handle/on calls in src/main/index.ts, found ${rawCalls.length}. Register IPC handlers in src/main/ipc/*.ts instead.`,
  );
});

test("core orchestrator entrypoints remain under architectural LOC ceilings", () => {
  const ceilings = [
    { relativePath: "src/core/platform.ts", maxLines: 80 },
    { relativePath: "src/main/index.ts", maxLines: 1100 },
    { relativePath: "src/renderer/src/App.tsx", maxLines: 900 },
  ];

  for (const { relativePath, maxLines } of ceilings) {
    const content = fs.readFileSync(path.join(appRoot, relativePath), "utf8");
    const lineCount = content.trimEnd() ? content.trimEnd().split("\n").length : 0;
    assert.ok(
      lineCount <= maxLines,
      `${relativePath} has ${lineCount} lines, exceeding the ${maxLines}-line ceiling. Extract cohesive domain modules instead of growing the entrypoint.`,
    );
  }
});
