"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const EXCLUDED_STAGE_ENTRIES = new Set([".bin", ".package-lock.json", "agent-recall-v2"]);

function isMissing(error) {
  return error?.code === "ENOENT";
}

function resolvePackageFile(packageRoot, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Embedded PostgreSQL ${label} path is invalid.`);
  }
  const resolved = path.resolve(packageRoot, relativePath);
  const relative = path.relative(packageRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Embedded PostgreSQL ${label} path escapes its package.`);
  }
  return resolved;
}

async function restoreEmbeddedPostgresNativeLinks(nodeModulesRoot) {
  const packageScope = path.join(nodeModulesRoot, "@embedded-postgres");
  let packages;
  try {
    packages = await fsp.readdir(packageScope, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }

  let restored = 0;
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(packageScope, entry.name);
    const manifestPath = path.join(packageRoot, "native", "pg-symlinks.json");
    let links;
    try {
      links = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    } catch (error) {
      if (isMissing(error)) continue;
      throw new Error(`Could not read embedded PostgreSQL native links for ${entry.name}.`, {
        cause: error,
      });
    }
    if (!Array.isArray(links)) {
      throw new Error(`Embedded PostgreSQL native links for ${entry.name} are invalid.`);
    }

    for (const link of links) {
      const sourcePath = resolvePackageFile(packageRoot, link?.source, "source");
      const targetPath = resolvePackageFile(packageRoot, link?.target, "target");
      const sourceStat = await fsp.stat(sourcePath).catch((error) => {
        throw new Error(`Embedded PostgreSQL native link source is missing: ${link?.source}`, {
          cause: error,
        });
      });
      if (!sourceStat.isFile()) {
        throw new Error(`Embedded PostgreSQL native link source is not a file: ${link.source}`);
      }

      const relativeSource = path.relative(path.dirname(targetPath), sourcePath);
      const targetStat = await fsp.lstat(targetPath).catch((error) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (targetStat?.isSymbolicLink()) {
        if (await fsp.readlink(targetPath) === relativeSource) continue;
        await fsp.unlink(targetPath);
      } else if (targetStat?.isFile()) {
        continue;
      } else if (targetStat) {
        throw new Error(`Embedded PostgreSQL native link target is not a file: ${link.target}`);
      }

      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        await fsp.symlink(relativeSource, targetPath, "file");
      } catch (error) {
        if (!["EACCES", "ENOSYS", "EPERM"].includes(error?.code)) throw error;
        await fsp.copyFile(sourcePath, targetPath);
      }
      restored++;
    }
  }
  return restored;
}

async function materializeStagedPackageDependencies(options = {}) {
  if (!options.stageRoot) throw new Error("Staged dependency preparation requires a stage root.");
  const stageRoot = await fsp.realpath(path.resolve(options.stageRoot));
  const nodeModulesRoot = path.join(stageRoot, "node_modules");
  const expectedPackagePath = path.join(nodeModulesRoot, "agent-recall-v2");
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
      { recursive: true, force: true, verbatimSymlinks: true },
    );
  }
  const restoredNativeLinks = await restoreEmbeddedPostgresNativeLinks(destinationRoot);
  return { copied: entries, restoredNativeLinks };
}

module.exports = {
  materializeStagedPackageDependencies,
  restoreEmbeddedPostgresNativeLinks,
};
