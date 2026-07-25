import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BRIDGE_MARKER = ".agent-recall-staging-bridge.json";
const INSTALL_CHAIN = "  .then(extractFile)";
const INDEX_EXPORT = "module.exports = getElectronPath();";
const VERSION_DECLARATION = "const { version } = require('./package');";
const DARWIN_EXECUTABLE = "Electron.app/Contents/MacOS/Electron";
const DARWIN_DEFAULT_APP = "Electron.app/Contents/Resources/default_app.asar";
const STAGING_RUNTIME_SENTINEL = "agent-recall-staging-runtime\n";
const LEGACY_NODE_VERSION_BY_ELECTRON = new Map([
  ["42.3.0", "24.15.0"],
]);

function patchedElectronInstallSource(source, electronVersion, bridgedVersion) {
  if (!source.includes(INSTALL_CHAIN)) {
    throw new Error("Electron install.js no longer contains the expected extraction chain.");
  }
  if (!source.includes(VERSION_DECLARATION)) {
    throw new Error("Electron install.js no longer contains the expected version declaration.");
  }
  if (source.includes("applyAgentRecallStagingBridge")) {
    throw new Error("Electron install.js already contains the AgentRecall staging bridge.");
  }
  const versionDeclaration = `const version = '${electronVersion}';`;
  const hook = `

function applyAgentRecallStagingBridge() {
  if (
    process.env.AGENT_RECALL_STAGING_INSTALL !== '1'
    || process.env.AGENT_RECALL_SKIP_LEGACY_ELECTRON_BRIDGE === '1'
  ) return;
  const electronVersion = String(version || '').trim();
  const electronExecutable = process.env.ELECTRON_OVERRIDE_DIST_PATH
    ? path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, platformPath)
    : path.join(__dirname, 'dist', platformPath);
  const probedVersion = String(childProcess.execFileSync(electronExecutable, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  })).trim().replace(/^v/, '');
  const bridgedVersion = '${bridgedVersion}';
  if (probedVersion !== bridgedVersion) {
    throw new Error('AgentRecall could not prepare Electron metadata for a legacy update.');
  }
  const packageJsonPath = path.join(__dirname, 'package.json');
  const distVersionPath = path.join(__dirname, 'dist', 'version');
  const markerPath = path.join(__dirname, '${BRIDGE_MARKER}');
  const packageSource = fs.readFileSync(packageJsonPath, 'utf8');
  const distVersionSource = fs.readFileSync(distVersionPath, 'utf8');
  const electronPackage = JSON.parse(packageSource);
  const installedVersion = distVersionSource.trim().replace(/^v/, '');
  let markerSource = null;
  let existingMarker = null;
  try {
    markerSource = fs.readFileSync(markerPath, 'utf8');
    existingMarker = JSON.parse(markerSource);
  } catch {}
  const initialBridge = electronPackage.version === electronVersion && installedVersion === electronVersion;
  const repeatedBridge = installedVersion === electronVersion
    && electronPackage.version === bridgedVersion
    && existingMarker?.schemaVersion === 1
    && existingMarker.electronVersion === electronVersion
    && existingMarker.bridgedVersion === bridgedVersion;
  if (!initialBridge && !repeatedBridge) {
    throw new Error('AgentRecall found inconsistent Electron metadata while preparing a legacy update.');
  }
  try {
    electronPackage.version = bridgedVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(electronPackage, null, 2) + '\\n', 'utf8');
    fs.writeFileSync(distVersionPath, bridgedVersion, 'utf8');
    fs.writeFileSync(markerPath, JSON.stringify({
      schemaVersion: 1,
      electronVersion,
      bridgedVersion,
      stagingRuntimePlatforms: ['darwin'],
    }, null, 2) + '\\n', 'utf8');
  } catch (error) {
    fs.writeFileSync(packageJsonPath, packageSource, 'utf8');
    fs.writeFileSync(distVersionPath, distVersionSource, 'utf8');
    if (markerSource === null) {
      try { fs.rmSync(markerPath, { force: true }); } catch {}
    } else {
      fs.writeFileSync(markerPath, markerSource, 'utf8');
    }
    throw error;
  }
}
`;
  return `${source
    .replace(VERSION_DECLARATION, versionDeclaration)
    .replace(INSTALL_CHAIN, `${INSTALL_CHAIN}\n  .then(applyAgentRecallStagingBridge)`)}${hook}`;
}

function patchedElectronIndexSource(source, electronVersion, bridgedVersion) {
  if (!source.includes(INDEX_EXPORT)) {
    throw new Error("Electron index.js no longer contains the expected export.");
  }
  if (source.includes("getAgentRecallStagingBridgePath")) {
    throw new Error("Electron index.js already contains the AgentRecall staging bridge.");
  }
  const hook = `

function getAgentRecallStagingBridgePath() {
  if (
    process.env.AGENT_RECALL_STAGING_INSTALL !== '1'
    || process.env.AGENT_RECALL_SKIP_LEGACY_ELECTRON_BRIDGE === '1'
  ) return null;
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(__dirname, '${BRIDGE_MARKER}'), 'utf8'));
  } catch {}
  const executable = path.join(__dirname, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const defaultApp = path.join(__dirname, 'dist', 'Electron.app', 'Contents', 'Resources', 'default_app.asar');
  let installedVersion = '';
  let relativeExecutable = '';
  let sentinel = '';
  try {
    installedVersion = fs.readFileSync(path.join(__dirname, 'dist', 'version'), 'utf8').trim();
    relativeExecutable = fs.readFileSync(path.join(__dirname, 'path.txt'), 'utf8');
    sentinel = fs.readFileSync(defaultApp, 'utf8');
  } catch {
    return null;
  }
  if (
    installedVersion !== '${bridgedVersion}'
    || relativeExecutable !== '${DARWIN_EXECUTABLE}'
    || sentinel !== '${STAGING_RUNTIME_SENTINEL.replace(/\n/g, "\\n")}'
    || !fs.existsSync(executable)
  ) return null;
  const validMarker = marker?.schemaVersion === 1
    && marker?.electronVersion === '${electronVersion}'
    && marker?.bridgedVersion === '${bridgedVersion}'
    && Array.isArray(marker?.stagingRuntimePlatforms)
    && marker.stagingRuntimePlatforms.includes('darwin');
  if (validMarker && process.platform === 'darwin') {
    return executable;
  }
  fs.rmSync(path.join(__dirname, 'dist'), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  fs.rmSync(path.join(__dirname, 'path.txt'), { force: true });
  return null;
}
`;
  return source.replace(
    INDEX_EXPORT,
    `${hook}\nmodule.exports = getAgentRecallStagingBridgePath() || getElectronPath();`,
  );
}

function parsePackResult(stdout) {
  const lines = stdout.split(/\r?\n/);
  const jsonStart = lines.findIndex((line) => line === "[" || line === "{");
  if (jsonStart === -1) throw new Error("npm pack did not emit a JSON result.");
  const result = JSON.parse(lines.slice(jsonStart).join("\n"));
  const packed = Array.isArray(result) ? result[0] : Object.values(result)[0];
  if (!packed?.filename) throw new Error("npm pack did not return an archive name.");
  return packed.filename;
}

async function copyPackageEntry(root, packRoot, entry) {
  const normalized = path.normalize(entry);
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Package file entry is outside the project: ${entry}`);
  }
  const source = path.join(root, normalized);
  const destination = path.join(packRoot, normalized);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function copyOptionalPackageEntry(root, packRoot, entry) {
  try {
    await copyPackageEntry(root, packRoot, entry);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function installedPackageRoot(sourcePackageRoot, dependencyName) {
  const resolveFromPackage = createRequire(path.join(sourcePackageRoot, "package.json"));
  let resolvedPath;
  try {
    resolvedPath = resolveFromPackage.resolve(`${dependencyName}/package.json`);
  } catch {
    resolvedPath = resolveFromPackage.resolve(dependencyName);
  }
  let candidate = resolvedPath.endsWith("package.json")
    ? path.dirname(resolvedPath)
    : path.dirname(resolvedPath);
  while (candidate !== path.dirname(candidate)) {
    try {
      const packageJson = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
      if (packageJson.name === dependencyName) return candidate;
    } catch {
      // Keep walking up from an exported entry point until the owning package is found.
    }
    candidate = path.dirname(candidate);
  }
  throw new Error(`Could not locate installed dependency ${dependencyName}.`);
}

async function copyInstalledPackageTree(sourcePackageRoot, targetPackageRoot, ancestors = new Set()) {
  await mkdir(path.dirname(targetPackageRoot), { recursive: true });
  await cp(sourcePackageRoot, targetPackageRoot, {
    recursive: true,
    filter: (source) => path.basename(source) !== "node_modules",
  });
  const packageJson = JSON.parse(await readFile(path.join(sourcePackageRoot, "package.json"), "utf8"));
  const requiredDependencies = packageJson.dependencies || {};
  const optionalDependencies = packageJson.optionalDependencies || {};
  const dependencyNames = [...new Set([
    ...Object.keys(requiredDependencies),
    ...Object.keys(optionalDependencies),
  ])];
  const nextAncestors = new Set([...ancestors, sourcePackageRoot]);
  for (const dependencyName of dependencyNames) {
    let dependencyRoot;
    try {
      dependencyRoot = await installedPackageRoot(sourcePackageRoot, dependencyName);
    } catch (error) {
      if (Object.hasOwn(optionalDependencies, dependencyName)) continue;
      throw error;
    }
    const targetDependencyRoot = path.join(targetPackageRoot, "node_modules", ...dependencyName.split("/"));
    if (nextAncestors.has(dependencyRoot)) {
      await mkdir(path.dirname(targetDependencyRoot), { recursive: true });
      await cp(dependencyRoot, targetDependencyRoot, {
        recursive: true,
        filter: (source) => path.basename(source) !== "node_modules",
      });
      continue;
    }
    await copyInstalledPackageTree(dependencyRoot, targetDependencyRoot, nextAncestors);
  }
}

export async function packReleaseArchive(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const destination = path.resolve(options.destination || root);
  const electronRoot = path.join(root, "node_modules", "electron");
  const rootPackagePath = path.join(root, "package.json");
  const electronPackagePath = path.join(electronRoot, "package.json");
  const electronIndexPath = path.join(electronRoot, "index.js");
  const electronInstallPath = path.join(electronRoot, "install.js");
  const originalRootPackageSource = await readFile(rootPackagePath, "utf8");
  const originalElectronPackageSource = await readFile(electronPackagePath, "utf8");
  const rootPackage = JSON.parse(originalRootPackageSource);
  const electronPackage = JSON.parse(originalElectronPackageSource);
  const electronVersion = String(electronPackage.version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) {
    throw new Error("Electron package version is missing or invalid.");
  }
  const bridgedVersion = LEGACY_NODE_VERSION_BY_ELECTRON.get(electronVersion);
  if (!bridgedVersion) {
    throw new Error(`Electron ${electronVersion} does not have a verified legacy Node bridge version.`);
  }
  if (rootPackage.dependencies?.electron !== electronVersion) {
    throw new Error("The root Electron dependency does not match the bundled Electron package.");
  }
  if (rootPackage.scripts && typeof rootPackage.scripts === "object") {
    rootPackage.scripts = { ...rootPackage.scripts };
    for (const lifecycle of ["prepack", "prepare", "postpack"]) {
      delete rootPackage.scripts[lifecycle];
    }
  }
  rootPackage.dependencies.electron = bridgedVersion;
  electronPackage.version = bridgedVersion;
  electronPackage.files = Array.isArray(electronPackage.files)
    ? [...new Set([...electronPackage.files, BRIDGE_MARKER, "dist", "path.txt"])]
    : [BRIDGE_MARKER, "dist", "path.txt"];
  const markerSource = `${JSON.stringify({
    schemaVersion: 1,
    electronVersion,
    bridgedVersion,
    stagingRuntimePlatforms: ["darwin"],
  }, null, 2)}\n`;
  const originalInstallSource = await readFile(electronInstallPath, "utf8");
  const originalIndexSource = await readFile(electronIndexPath, "utf8");
  const patchedInstallSource = patchedElectronInstallSource(originalInstallSource, electronVersion, bridgedVersion);
  const patchedIndexSource = patchedElectronIndexSource(originalIndexSource, electronVersion, bridgedVersion);
  const npmCommand = options.npmCommand || (process.platform === "win32" ? "npm.cmd" : "npm");
  await mkdir(destination, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-release-pack-"));
  const packRoot = path.join(temporaryRoot, "package");
  try {
    await mkdir(packRoot, { recursive: true });
    if (!Array.isArray(rootPackage.files) || rootPackage.files.length === 0) {
      throw new Error("package.json must declare release files.");
    }
    await Promise.all(rootPackage.files.map((entry) => copyPackageEntry(root, packRoot, entry)));
    await Promise.all([
      copyOptionalPackageEntry(root, packRoot, "README.md"),
      copyOptionalPackageEntry(root, packRoot, "LICENSE"),
      copyOptionalPackageEntry(root, packRoot, "LICENSE.md"),
    ]);
    const packedElectronRoot = path.join(packRoot, "node_modules", "electron");
    await copyInstalledPackageTree(electronRoot, packedElectronRoot);
    await Promise.all([
      rm(path.join(packedElectronRoot, "dist"), { recursive: true, force: true }),
      rm(path.join(packedElectronRoot, "path.txt"), { force: true }),
    ]);
    const stagingExecutable = path.join(packedElectronRoot, "dist", ...DARWIN_EXECUTABLE.split("/"));
    const stagingDefaultApp = path.join(packedElectronRoot, "dist", ...DARWIN_DEFAULT_APP.split("/"));
    await Promise.all([
      mkdir(path.dirname(stagingExecutable), { recursive: true }),
      mkdir(path.dirname(stagingDefaultApp), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(packRoot, "package.json"), `${JSON.stringify(rootPackage, null, 2)}\n`, "utf8"),
      writeFile(path.join(packedElectronRoot, "package.json"), `${JSON.stringify(electronPackage, null, 2)}\n`, "utf8"),
      writeFile(path.join(packedElectronRoot, "index.js"), patchedIndexSource, "utf8"),
      writeFile(path.join(packedElectronRoot, "install.js"), patchedInstallSource, "utf8"),
      writeFile(path.join(packedElectronRoot, BRIDGE_MARKER), markerSource, "utf8"),
      writeFile(path.join(packedElectronRoot, "dist", "version"), bridgedVersion, "utf8"),
      writeFile(path.join(packedElectronRoot, "path.txt"), DARWIN_EXECUTABLE, "utf8"),
      writeFile(stagingExecutable, `#!/bin/sh\nprintf 'v${bridgedVersion}\\n'\n`, "utf8"),
      writeFile(stagingDefaultApp, STAGING_RUNTIME_SENTINEL, "utf8"),
    ]);
    await chmod(stagingExecutable, 0o755);
    const { stdout } = await execFile(npmCommand, [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
    ], {
      cwd: packRoot,
      env: options.environment || process.env,
      shell: process.platform === "win32",
      maxBuffer: 16 * 1024 * 1024,
    });
    return path.join(destination, parsePackResult(stdout));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const archive = await packReleaseArchive({
    root: process.cwd(),
    destination: argumentValue("--pack-destination") || process.cwd(),
  });
  process.stdout.write(`${path.basename(archive)}\n`);
}
