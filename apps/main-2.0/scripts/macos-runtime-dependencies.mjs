// Offline staging only: never install, prune or mutate the source dependency tree.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { restoreEmbeddedPostgresNativeLinks } from "../bin/staged-package-dependencies.cjs";

const execFileAsync = promisify(execFile);

const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".github", ".bin", "test", "tests", "__tests__", "fixtures", "__fixtures__",
  "coverage", ".nyc_output", "user-data", "userdata", "pgdata", "screenshots",
]);

// Keep runtime sources/assets and license notices. Removing every src, docs, key
// or certificate would break valid packages; fixture directories are excluded.
export function isReleaseContentPath(relativePath) {
  const parts = relativePath.replaceAll("\\", "/").split("/");
  const name = parts.at(-1);
  // node-gyp records developer paths in Makefiles, dependency files and object
  // archives. The linked .node/dylib files under build/Release remain runtime.
  const nativeBuildArtifact = parts.includes("build") && (
    parts.some(part => ["obj.target", ".deps"].includes(part))
    || /^(?:Makefile|binding\.Makefile|config\.gypi|gyp-mac-tool)$/u.test(name)
    || /\.(?:target\.mk|Makefile|o|a|d)$/u.test(name)
  );
  return !parts.some(part => EXCLUDED_DIRECTORIES.has(part) || part.endsWith(".dSYM"))
    && !nativeBuildArtifact
    && !parts.some((part, index) => part === "docs" && parts[index + 1] === "local-review")
    && !/^\.env(?:\..*)?$/iu.test(name)
    && !/^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.pgpass|\.DS_Store|auth\.json|credentials\.json|id_rsa|id_ed25519|postmaster\.pid)$/iu.test(name)
    && !/\.(?:map|log|sqlite3?|db)$/iu.test(name)
    && !/\.(?:test|spec)\.[^/]+$/iu.test(name);
}

async function stripStagedNativeDebugSymbols(file) {
  if (process.platform !== "darwin" || !file.endsWith(".node")) return false;
  const handle = await fs.open(file, "r");
  let magic;
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead < 4) return false;
    magic = header.readUInt32BE(0);
  } finally { await handle.close(); }
  if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return false;
  // -S removes only debug symbols (including absolute SO/OSO build paths).
  // Copy first; never strip the installed addon. App signing follows staging.
  await execFileAsync("/usr/bin/strip", ["-S", file]);
  return true;
}

// Call only on a newly copied staging tree, before signing. Symlinks are never
// followed, so another package or the installed dependency tree cannot change.
export async function stripStagedMacosDebugSymbols(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Native debug stripping requires a staged directory, not a link.");
  const files = [];
  let bytesRemoved = 0;
  const walk = async current => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith(".dSYM")) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(".node")) {
        const before = (await fs.stat(file)).size;
        if (await stripStagedNativeDebugSymbols(file)) {
          files.push(path.relative(directory, file).split(path.sep).join("/"));
          bytesRemoved += before - (await fs.stat(file)).size;
        }
      }
    }
  };
  await walk(directory);
  return { files, bytesRemoved };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function providedOutsideNodeModules(name) {
  // Electron is Contents/Frameworks, not a second downloaded runtime. Fonts are
  // build inputs copied into out/renderer; a missing font remains a build warning.
  return name === "electron" || name.startsWith("@fontsource-variable/");
}

function packageNameParts(name) {
  const parts = name.split("/");
  if (parts.length !== (name.startsWith("@") ? 2 : 1)
    || parts.some(part => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new Error(`Invalid dependency name: ${name}`);
  }
  return parts;
}

function matchesHost(values, actual) {
  if (!values) return true;
  return !values.includes(`!${actual}`)
    && (!values.some(value => !value.startsWith("!")) || values.includes(actual));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function installedPackage(owner, name, packageRoot) {
  const parts = packageNameParts(name);
  for (let directory = owner; inside(packageRoot, directory); directory = path.dirname(directory)) {
    if (path.basename(directory) === "node_modules") continue;
    const candidate = path.join(directory, "node_modules", ...parts);
    let stat;
    try { stat = await fs.lstat(candidate); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Dependency must be an installed directory, not a link: ${name}`);
    }
    const real = await fs.realpath(candidate);
    if (!inside(packageRoot, real)) throw new Error(`Dependency escapes package tree: ${name}`);
    return candidate;
  }
  return null;
}

async function collectPackages(packageRoot, manifest, lock, summary) {
  const packages = new Map();
  const walk = async (owner, ownerManifest) => {
    const edges = new Map();
    for (const name of Object.keys(ownerManifest.peerDependencies ?? {})) {
      edges.set(name, { optional: ownerManifest.peerDependenciesMeta?.[name]?.optional === true });
    }
    for (const name of Object.keys(ownerManifest.dependencies ?? {})) edges.set(name, { optional: false });
    for (const name of Object.keys(ownerManifest.optionalDependencies ?? {})) edges.set(name, { optional: true });
    for (const [name, { optional }] of edges) {
      if (providedOutsideNodeModules(name)) {
        summary.providedSeparately.add(name);
        continue;
      }
      const source = await installedPackage(owner, name, packageRoot);
      if (!source) {
        if (optional) { summary.omittedOptional.add(name); continue; }
        throw new Error(`Required production dependency is missing: ${name}`);
      }
      const relative = path.relative(packageRoot, source).split(path.sep).join("/");
      if (packages.has(relative)) continue;
      const installed = await readJson(path.join(source, "package.json"));
      if (!matchesHost(installed.os, process.platform) || !matchesHost(installed.cpu, process.arch)) {
        if (optional) { summary.omittedOptional.add(name); continue; }
        throw new Error(`Production dependency does not support this host: ${name}`);
      }
      const locked = lock.packages[relative];
      if (!locked || locked.link || locked.version !== installed.version) {
        throw new Error(`Installed production dependency does not match package-lock.json: ${relative}`);
      }
      packages.set(relative, { source, manifest: installed });
      await walk(source, installed);
    }
  };
  await walk(packageRoot, manifest);
  return packages;
}

async function copyPackage(source, destination, sourceRoot, summary, relative = "") {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name === "node_modules" || !isReleaseContentPath(name)) {
      summary.excludedEntries++;
      continue;
    }
    const input = path.join(source, entry.name);
    const output = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(output, { recursive: true });
      await copyPackage(input, output, sourceRoot, summary, name);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(input);
      if (path.isAbsolute(target) || !inside(sourceRoot, path.resolve(path.dirname(input), target))
        || !inside(sourceRoot, await fs.realpath(input))) {
        throw new Error(`Runtime symlink escapes dependency tree: ${name}`);
      }
      await fs.symlink(target, output);
      summary.symlinkCount++;
    } else if (entry.isFile()) {
      await fs.copyFile(input, output, constants.COPYFILE_FICLONE);
      const stat = await fs.stat(output);
      summary.bytes += stat.size;
      summary.fileCount++;
    } else {
      throw new Error(`Unsupported runtime dependency entry: ${name}`);
    }
  }
}

async function verifyStagedLinks(directory, destination) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await verifyStagedLinks(file, destination);
    else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(file);
      if (path.isAbsolute(target) || !inside(destination, path.resolve(path.dirname(file), target))) {
        throw new Error(`Staged runtime symlink escapes dependency tree: ${path.relative(destination, file)}`);
      }
      // Also rejects dangling links and a chain escaping through another link.
      if (!inside(destination, await fs.realpath(file))) {
        throw new Error(`Staged runtime symlink resolves outside dependency tree: ${path.relative(destination, file)}`);
      }
    }
  }
}

export async function stageProductionDependencies(packageRoot, destination) {
  packageRoot = await fs.realpath(packageRoot);
  destination = path.resolve(destination);
  // Resolve the existing parent before mkdir so a linked ancestor cannot create
  // directories in the input tree before the overlap guard rejects the request.
  destination = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
  if (inside(packageRoot, destination) || inside(destination, packageRoot)) {
    throw new Error("Production dependency staging must be outside the source package tree.");
  }
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  const lock = await readJson(path.join(packageRoot, "package-lock.json"));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) {
    throw new Error("Production dependency staging requires a v2/v3 package-lock.json.");
  }
  const summary = { providedSeparately: new Set(), omittedOptional: new Set(), fileCount: 0, symlinkCount: 0, bytes: 0, excludedEntries: 0, strippedNativeFiles: [] };
  // Discover/validate the complete closure before writing any package files.
  const packages = await collectPackages(packageRoot, manifest, lock, summary);
  await fs.mkdir(destination).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await fs.lstat(destination);
  const realDestination = await fs.realpath(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink() || inside(packageRoot, realDestination)
    || inside(realDestination, packageRoot) || (await fs.readdir(destination)).length > 0) {
    throw new Error("Production dependency destination must be a new or empty directory outside the source tree.");
  }
  destination = realDestination;
  for (const [relative, { source }] of packages) {
    const target = path.join(destination, relative.slice("node_modules/".length));
    await fs.mkdir(target, { recursive: true });
    await copyPackage(source, target, packageRoot, summary);
  }
  const restoredNativeLinks = await restoreEmbeddedPostgresNativeLinks(destination);
  await verifyStagedLinks(destination, destination);
  const stripped = await stripStagedMacosDebugSymbols(destination);
  summary.strippedNativeFiles = stripped.files.map(file => `node_modules/${file}`);
  summary.bytes -= stripped.bytesRemoved;
  return { ...summary, packageCount: packages.size, restoredNativeLinks,
    providedSeparately: [...summary.providedSeparately].sort(), omittedOptional: [...summary.omittedOptional].sort() };
}
