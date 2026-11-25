import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const supportedPackageNames = new Set(["agent-recall"]);
const defaultMirrors = [
  "https://github.com/electron/electron/releases/download/",
  "https://npmmirror.com/mirrors/electron/",
];
const staleStagingAgeMs = 24 * 60 * 60 * 1000;
const staleCleanupRaceCodes = new Set(["EBUSY", "ENOENT", "ENOTEMPTY", "EPERM"]);
const transientLockCodes = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

async function retryOnTransientLock(operation, { maxRetries = 8, retryDelayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!transientLockCodes.has(error?.code) || attempt >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
}

async function renameWithRetry(source, destination, options = {}) {
  const renameImpl = options.renameImpl ?? rename;
  return retryOnTransientLock(() => renameImpl(source, destination), options);
}

async function rmWithRetry(targetPath, rmOptions, options = {}) {
  const rmImpl = options.rmImpl ?? rm;
  return retryOnTransientLock(() => rmImpl(targetPath, rmOptions), options);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? "inherit",
      shell: false,
      windowsHide: true,
      env: options.env ?? process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}.`));
      else if (code !== 0) reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 1}.`));
      else resolve();
    });
  });
}

export function electronCacheRoot(environment = process.env, homeDir = os.homedir(), platform = process.platform) {
  if (environment.electron_config_cache) return environment.electron_config_cache;
  if (platform === "win32") {
    return path.join(environment.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "electron", "Cache");
  }
  if (platform === "darwin") return path.join(homeDir, "Library", "Caches", "electron");
  return path.join(environment.XDG_CACHE_HOME || path.join(homeDir, ".cache"), "electron");
}

async function findCachedArchive(rootPath, fileName) {
  if (!rootPath) return null;
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name === fileName) return entryPath;
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
  return null;
}

function systemUnzipCommand(archivePath, distPath, platform = process.platform) {
  if (platform === "darwin") return ["ditto", ["-x", "-k", archivePath, distPath]];
  if (platform === "win32") return ["tar.exe", ["-xf", archivePath, "-C", distPath]];
  return ["unzip", ["-q", "-o", archivePath, "-d", distPath]];
}

async function extractElectronArchive(archive, stagedDist, {
  absoluteAppDirectory,
  electronDirectory,
  executable,
  platform,
  retryOptions,
}) {
  try {
    const electronRequire = createRequire(path.join(electronDirectory, "package.json"));
    let extractModule;
    try {
      extractModule = await import(pathToFileURL(electronRequire.resolve("@electron-internal/extract-zip")).href);
    } catch {
      const appRequire = createRequire(path.join(absoluteAppDirectory, "package.json"));
      extractModule = await import(pathToFileURL(appRequire.resolve("@electron-internal/extract-zip")).href);
    }
    await extractModule.extract(archive, { dir: stagedDist });
    await access(path.join(stagedDist, executable));
    return;
  } catch {
    // Electron <= 42.3 / Node 24 extract-zip can be unavailable or stall cleanly; fall back to OS archive tools.
  }

  await rmWithRetry(stagedDist, { recursive: true, force: true }, retryOptions).catch(() => undefined);
  await mkdir(stagedDist, { recursive: true });
  const [unzipCommand, unzipArgs] = systemUnzipCommand(archive, stagedDist, platform);
  await run(unzipCommand, unzipArgs, { stdio: ["ignore", "inherit", "pipe"] });
}

export function electronRuntimeDetails({ version, platform = process.platform, arch = process.arch }) {
  const normalizedPlatform = platform === "mas" ? "mas" : platform;
  const fileName = `electron-v${version}-${normalizedPlatform}-${arch}.zip`;
  const executable = normalizedPlatform === "darwin" || normalizedPlatform === "mas"
    ? "Electron.app/Contents/MacOS/Electron"
    : normalizedPlatform === "win32"
      ? "electron.exe"
      : "electron";
  return { fileName, executable };
}

export function electronDownloadUrls(version, fileName, configuredMirror = process.env.ELECTRON_MIRROR) {
  const mirrors = configuredMirror ? [configuredMirror, ...defaultMirrors] : defaultMirrors;
  return [...new Set(mirrors.map((mirror) => {
    const base = mirror.endsWith("/") ? mirror : `${mirror}/`;
    return base.includes("github.com/electron/electron/releases/download")
      ? `${base}v${version}/${fileName}`
      : `${base}${version}/${fileName}`;
  }))];
}

async function sha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).once("error", reject).once("end", resolve);
  });
  return hash.digest("hex");
}

async function runtimeReady(electronDirectory, executable, expectedVersion) {
  try {
    const [storedPath, storedVersion] = await Promise.all([
      readFile(path.join(electronDirectory, "path.txt"), "utf8"),
      readFile(path.join(electronDirectory, "dist", "version"), "utf8"),
    ]);
    if (storedPath !== executable || storedVersion.trim().replace(/^v/, "") !== expectedVersion) return false;
    await access(path.join(electronDirectory, "dist", executable));
    return true;
  } catch {
    return false;
  }
}

async function removeStaleStagingDirectories(electronDirectory, now = Date.now()) {
  const entries = await readdir(electronDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".agent-recall-electron-")) continue;
    const entryPath = path.join(electronDirectory, entry.name);
    try {
      const metadata = await stat(entryPath);
      if (now - metadata.mtimeMs < staleStagingAgeMs) continue;
      await rm(entryPath, { recursive: true, force: true });
    } catch (error) {
      // Another startup may still own or have already removed this staging directory.
      if (!staleCleanupRaceCodes.has(error?.code)) throw error;
    }
  }
}

async function downloadWithSystemTrust(urls, destination) {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const errors = [];
  for (const url of urls) {
    try {
      process.stdout.write(`Downloading Electron runtime from ${new URL(url).host}...\n`);
      await run(curl, [
        "--fail",
        "--location",
        "--proto", "=https",
        "--proto-redir", "=https",
        "--retry", "2",
        "--connect-timeout", "20",
        "--output", destination,
        url,
      ], {
        stdio: ["ignore", "inherit", "pipe"],
      });
      return;
    } catch (error) {
      errors.push(`${new URL(url).host}: ${error.message}`);
    }
  }
  throw new Error(`Electron runtime download failed. ${errors.join(" | ")}`);
}

export async function ensureElectronRuntime(appDirectory, options = {}) {
  const absoluteAppDirectory = path.resolve(appDirectory);
  let applicationPackage;
  try {
    applicationPackage = JSON.parse(await readFile(path.join(absoluteAppDirectory, "package.json"), "utf8"));
  } catch {
    throw new Error(`Electron application package was not found at ${absoluteAppDirectory}.`);
  }
  if (!supportedPackageNames.has(applicationPackage.name)) {
    throw new Error(`Unsupported Electron application package: ${applicationPackage.name ?? "unknown"}.`);
  }
  const electronDirectory = path.join(absoluteAppDirectory, "node_modules", "electron");
  let packageJson;
  let checksums;
  try {
    [packageJson, checksums] = await Promise.all([
      readFile(path.join(electronDirectory, "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(electronDirectory, "checksums.json"), "utf8").then(JSON.parse),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Electron dependencies are missing. Run `npm run setup` from the repository root.");
    }
    throw error;
  }
  const runtimePlatform = options.platform ?? process.platform;
  const runtimeArch = options.arch ?? process.arch;
  const runtimeEnv = options.env ?? process.env;
  const runtimeHome = options.homeDir ?? os.homedir();
  const { fileName, executable } = electronRuntimeDetails({
    version: packageJson.version,
    platform: runtimePlatform,
    arch: runtimeArch,
  });
  await removeStaleStagingDirectories(electronDirectory);
  if (await runtimeReady(electronDirectory, executable, packageJson.version)) return;

  const expectedChecksum = checksums[fileName];
  if (!expectedChecksum) throw new Error(`Electron checksum is unavailable for ${fileName}.`);
  const temporaryDirectory = await mkdtemp(path.join(electronDirectory, ".agent-recall-electron-"));
  const archive = path.join(temporaryDirectory, fileName);
  const stagedDist = path.join(temporaryDirectory, "dist");
  const backupDist = path.join(temporaryDirectory, "previous-dist");
  const retryOptions = {
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
    renameImpl: options.renameImpl,
    rmImpl: options.rmImpl,
  };
  try {
    if (options.download) {
      await options.download(electronDownloadUrls(packageJson.version, fileName, runtimeEnv.ELECTRON_MIRROR), archive);
    } else {
      const cachedArchive = await findCachedArchive(electronCacheRoot(runtimeEnv, runtimeHome, runtimePlatform), fileName);
      if (cachedArchive && (await sha256(cachedArchive)) === expectedChecksum) {
        await copyFile(cachedArchive, archive);
      } else {
        await downloadWithSystemTrust(electronDownloadUrls(packageJson.version, fileName, runtimeEnv.ELECTRON_MIRROR), archive);
      }
    }
    const actualChecksum = await sha256(archive);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`Electron checksum mismatch for ${fileName}.`);
    }
    if (options.extract) {
      await options.extract(archive, { dir: stagedDist });
    } else {
      await extractElectronArchive(archive, stagedDist, {
        absoluteAppDirectory,
        electronDirectory,
        executable,
        platform: runtimePlatform,
        retryOptions,
      });
    }
    await access(path.join(stagedDist, executable));

    const currentDist = path.join(electronDirectory, "dist");
    let hadCurrentDist = false;
    try {
      await renameWithRetry(currentDist, backupDist, retryOptions);
      hadCurrentDist = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await renameWithRetry(stagedDist, currentDist, retryOptions);
      await writeFile(path.join(electronDirectory, "path.txt"), executable);
      if (!(await runtimeReady(electronDirectory, executable, packageJson.version))) {
        throw new Error("Electron runtime validation failed after installation.");
      }
      await rmWithRetry(backupDist, { recursive: true, force: true }, retryOptions);
    } catch (error) {
      await rmWithRetry(currentDist, { recursive: true, force: true }, retryOptions).catch(() => undefined);
      if (hadCurrentDist) await renameWithRetry(backupDist, currentDist, retryOptions).catch(() => undefined);
      throw error;
    }
  } finally {
    // A transient AV scan lock on the staging container should not fail an already-installed runtime.
    await rmWithRetry(temporaryDirectory, { recursive: true, force: true }, retryOptions).catch(() => undefined);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  ensureElectronRuntime(process.argv[2]).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
