"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const EXCLUDED_STAGE_ENTRIES = new Set([".bin", ".package-lock.json", "agent-recall"]);

async function materializeStagedPackageDependencies(options = {}) {
  if (!options.stageRoot) throw new Error("Staged dependency preparation requires a stage root.");
  const stageRoot = await fsp.realpath(path.resolve(options.stageRoot));
  const nodeModulesRoot = path.join(stageRoot, "node_modules");
  const expectedPackagePath = path.join(nodeModulesRoot, "agent-recall");
  const packagePath = await fsp.realpath(path.resolve(options.packagePath || expectedPackagePath));
  if (packagePath !== expectedPackagePath) {
    throw new Error("Staged AgentRecall package path does not match the stage root.");
  }

  const entries = (await fsp.readdir(nodeModulesRoot))
    .filter((name) => !name.startsWith(".") && !EXCLUDED_STAGE_ENTRIES.has(name))
    .sort();
  const destinationRoot = path.join(packagePath, "node_modules");
  await fsp.mkdir(destinationRoot, { recursive: true });
  for (const name of entries) {
    await fsp.cp(
      path.join(nodeModulesRoot, name),
      path.join(destinationRoot, name),
      { recursive: true, force: true },
    );
  }
  return { copied: entries };
}

module.exports = { materializeStagedPackageDependencies };
