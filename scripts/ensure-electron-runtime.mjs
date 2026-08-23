import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const supportedPackageNames = new Set(["agent-recall", "agent-recall-v2"]);
const defaultMirrors = [
  "https://github.com/electron/electron/releases/download/",
  "https://npmmirror.com/mirrors/electron/",
];
const staleStagingAgeMs = 24 * 60 * 60 * 1000;
const staleCleanupRaceCodes = new Set(["EBUSY", "ENOENT", "ENOTEMPTY", "EPERM"]);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? "inherit",
      shell: false,
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

export async function ensureElectronRuntime(appDirectory) {
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
      const setupCommand = applicationPackage.name === "agent-recall-v2" ? "npm run setup:v2" : "npm run setup:v1";
      throw new Error(`Electron dependencies are missing. Run \`${setupCommand}\` from the repository root.`);
    }
    throw error;
  }
  const { fileName, executable } = electronRuntimeDetails({ version: packageJson.version });
  await removeStaleStagingDirectories(electronDirectory);
  if (await runtimeReady(electronDirectory, executable, packageJson.version)) return;

  const expectedChecksum = checksums[fileName];
  if (!expectedChecksum) throw new Error(`Electron checksum is unavailable for ${fileName}.`);
  const temporaryDirectory = await mkdtemp(path.join(electronDirectory, ".agent-recall-electron-"));
  const archive = path.join(temporaryDirectory, fileName);
  const stagedDist = path.join(temporaryDirectory, "dist");
  const backupDist = path.join(temporaryDirectory, "previous-dist");
  try {
    await downloadWithSystemTrust(electronDownloadUrls(packageJson.version, fileName), archive);
    const actualChecksum = await sha256(archive);
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`Electron checksum mismatch for ${fileName}.`);
    }
    const require = createRequire(path.join(absoluteAppDirectory, "package.json"));
    const extractModule = await import(pathToFileURL(require.resolve("@electron-internal/extract-zip")).href);
    await extractModule.extract(archive, { dir: stagedDist });
    await access(path.join(stagedDist, executable));

    const currentDist = path.join(electronDirectory, "dist");
    let hadCurrentDist = false;
    try {
      await rename(currentDist, backupDist);
      hadCurrentDist = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(stagedDist, currentDist);
      await writeFile(path.join(electronDirectory, "path.txt"), executable);
      if (!(await runtimeReady(electronDirectory, executable, packageJson.version))) {
        throw new Error("Electron runtime validation failed after installation.");
      }
      await rm(backupDist, { recursive: true, force: true });
    } catch (error) {
      await rm(currentDist, { recursive: true, force: true });
      if (hadCurrentDist) await rename(backupDist, currentDist);
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  ensureElectronRuntime(process.argv[2]).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
