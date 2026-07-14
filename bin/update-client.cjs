#!/usr/bin/env node
"use strict";

const { execFile, execFileSync, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const GITHUB_REPOSITORY = "zszz3/agent-session-search";
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
const UPDATE_ASSET_NAME = "update.json";
const LATEST_UPDATE_MANIFEST_URL = `https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/${UPDATE_ASSET_NAME}`;
const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";

function packageRoot() {
  return path.resolve(__dirname, "..");
}

function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function stateDirectory(homeDir = os.homedir()) {
  return path.join(homeDir, ".agent-session-search");
}

function defaultCachePath(homeDir = os.homedir()) {
  return path.join(stateDirectory(homeDir), "update-check.json");
}

function appProcessPath(homeDir = os.homedir()) {
  return path.join(stateDirectory(homeDir), "app-process.json");
}

function installStatusPath(homeDir = os.homedir()) {
  return path.join(stateDirectory(homeDir), "update-install-status.json");
}

function updateLockPath(homeDir = os.homedir()) {
  return path.join(stateDirectory(homeDir), "update-install.lock");
}

async function readInstallStatus(options = {}) {
  return readJson(options.statusPath || installStatusPath(options.homeDir));
}

async function clearInstallStatus(options = {}) {
  await fsp.rm(options.statusPath || installStatusPath(options.homeDir), { force: true });
}

async function acquireUpdateLock(options = {}) {
  const filePath = options.lockPath || updateLockPath(options.homeDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(filePath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, "utf8");
      await handle.close();
      return {
        path: filePath,
        release: async () => {
          const current = await readJson(filePath);
          if (Number(current?.pid) === process.pid) await fsp.rm(filePath, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = await readJson(filePath);
      const ownerPid = Number(current?.pid);
      if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessRunning(ownerPid)) {
        const lockError = new Error("另一个更新正在安装，请等待完成后再试。");
        lockError.code = "UPDATE_IN_PROGRESS";
        throw lockError;
      }
      await fsp.rm(filePath, { force: true });
    }
  }
  throw new Error("无法获取更新安装锁。");
}

function updatePreferencePath(homeDir = os.homedir()) {
  return path.join(stateDirectory(homeDir), "update-preferences.json");
}

async function readUpdatePreference(options = {}) {
  const value = await readJson(options.preferencePath || updatePreferencePath(options.homeDir));
  return value?.enabled !== false;
}

async function writeUpdatePreference(enabled, options = {}) {
  await writeJsonAtomic(options.preferencePath || updatePreferencePath(options.homeDir), { enabled: Boolean(enabled) });
}

function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function parseStableVersion(value) {
  const match = String(value || "").trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid stable semantic version: ${value}`);
  return match.slice(1).map(Number);
}

function parseUpdateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Update manifest must be an object.");
  if (value.schemaVersion !== 1) throw new Error("Unsupported update manifest schema.");
  parseStableVersion(value.version);
  if (value.tag !== `v${value.version}`) throw new Error("Update manifest tag does not match its version.");
  if (typeof value.title !== "string" || !value.title.trim()) throw new Error("Update manifest title is missing.");
  if (!value.notes || !Array.isArray(value.notes.features) || !Array.isArray(value.notes.fixes)) throw new Error("Update manifest notes are invalid.");
  if (![...value.notes.features, ...value.notes.fixes].every((item) => typeof item === "string" && item.trim())) throw new Error("Update manifest contains an invalid release-note item.");
  if (!value.package || typeof value.package !== "object") throw new Error("Update manifest package is missing.");
  if (typeof value.package.url !== "string" || !isTrustedReleaseUrl(value.package.url)) throw new Error("Update package URL is not trusted.");
  if (typeof value.package.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.package.sha256)) throw new Error("Update package checksum is invalid.");
  if (typeof value.package.name !== "string" || !/^[A-Za-z0-9._-]+\.tgz$/.test(value.package.name)) throw new Error("Update package name is invalid.");
  return {
    schemaVersion: 1,
    version: value.version,
    tag: value.tag,
    title: value.title.trim(),
    publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : "",
    releaseUrl: typeof value.releaseUrl === "string" ? value.releaseUrl : "",
    notes: { features: [...value.notes.features], fixes: [...value.notes.fixes] },
    package: {
      name: value.package.name,
      url: value.package.url,
      sha256: value.package.sha256.toLowerCase(),
      checksumUrl: typeof value.package.checksumUrl === "string" ? value.package.checksumUrl : "",
    },
  };
}

function isTrustedReleaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith(`/${GITHUB_REPOSITORY}/releases/download/`);
  } catch {
    return false;
  }
}

async function checkForUpdate(options = {}) {
  const version = options.currentVersion || currentVersion();
  const cachePath = options.cachePath || defaultCachePath(options.homeDir);
  const now = options.now || Date.now();
  const ttlMs = options.ttlMs ?? UPDATE_CACHE_TTL_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cached = await readJson(cachePath);

  if (!options.force && cached && Number.isFinite(cached.checkedAt) && now - cached.checkedAt < ttlMs) {
    return updateResult(version, cached.manifest || null, cached.checkedAt, true, null, cached);
  }

  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "agent-session-search-updater",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    let manifestResponse;
    let releaseTag = null;
    let etag = null;
    try {
      const releaseResponse = await fetchWithTimeout(fetchImpl, LATEST_RELEASE_API, { headers }, options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS);
      if (releaseResponse.status === 304 && cached) {
        await writeJsonAtomic(cachePath, { ...cached, checkedAt: now });
        return updateResult(version, cached.manifest || null, now, false, null, cached);
      }
      if (releaseResponse.status === 404) {
        await writeJsonAtomic(cachePath, { checkedAt: now, etag: null, manifest: null });
        return updateResult(version, null, now, false, null, null);
      }
      if (!releaseResponse.ok) throw new Error(`GitHub release check failed (${releaseResponse.status}).`);
      const release = await releaseResponse.json();
      const asset = Array.isArray(release.assets) ? release.assets.find((item) => item?.name === UPDATE_ASSET_NAME) : null;
      if (!asset?.browser_download_url) throw new Error("Latest GitHub Release does not contain update.json.");
      manifestResponse = await fetchWithTimeout(fetchImpl, asset.browser_download_url, {
        headers: { "User-Agent": "agent-session-search-updater" },
      }, options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS);
      if (!manifestResponse.ok) throw new Error(`Update manifest download failed (${manifestResponse.status}).`);
      releaseTag = typeof release.tag_name === "string" ? release.tag_name : null;
      etag = releaseResponse.headers.get("etag");
    } catch (releaseError) {
      try {
        manifestResponse = await fetchWithTimeout(fetchImpl, LATEST_UPDATE_MANIFEST_URL, {
          headers: { "User-Agent": "agent-session-search-updater", ...(cached?.etag ? { "If-None-Match": cached.etag } : {}) },
        }, options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS);
        if (manifestResponse.status === 304 && cached) {
          await writeJsonAtomic(cachePath, { ...cached, checkedAt: now });
          return updateResult(version, cached.manifest || null, now, false, null, cached);
        }
        if (!manifestResponse.ok) throw new Error(`Direct update manifest download failed (${manifestResponse.status}).`);
        etag = manifestResponse.headers.get("etag");
      } catch {
        throw releaseError;
      }
    }
    const manifest = parseUpdateManifest(await manifestResponse.json());
    if (releaseTag && releaseTag !== manifest.tag) throw new Error("GitHub Release tag does not match update.json.");
    const sameSnoozedVersion = cached?.snoozedVersion === manifest.version;
    const cache = {
      checkedAt: now,
      etag,
      manifest,
      snoozedVersion: sameSnoozedVersion ? cached.snoozedVersion : null,
      snoozedUntil: sameSnoozedVersion ? cached.snoozedUntil : 0,
    };
    await writeJsonAtomic(cachePath, cache);
    return updateResult(version, manifest, now, false, null, cache);
  } catch (error) {
    return updateResult(version, cached?.manifest || null, cached?.checkedAt || 0, Boolean(cached), error instanceof Error ? error.message : String(error), cached);
  }
}

function updateResult(version, manifest, checkedAt, fromCache, error, cache = null) {
  let updateAvailable = false;
  try {
    updateAvailable = Boolean(manifest && compareVersions(version, manifest.version) < 0);
  } catch {
    updateAvailable = false;
  }
  const promptSnoozed = Boolean(updateAvailable && manifest && cache?.snoozedVersion === manifest.version && Number(cache.snoozedUntil) > Date.now());
  return { currentVersion: version, checkedAt, fromCache, updateAvailable, promptSnoozed, manifest, error };
}

async function snoozeUpdatePrompt(version, options = {}) {
  const cachePath = options.cachePath || defaultCachePath(options.homeDir);
  const cache = (await readJson(cachePath)) || {};
  await writeJsonAtomic(cachePath, {
    ...cache,
    snoozedVersion: version,
    snoozedUntil: (options.now || Date.now()) + (options.durationMs ?? UPDATE_CACHE_TTL_MS),
  });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`The GitHub request timed out after ${timeoutMs} ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function formatUpdateNotice(result) {
  if (!result.updateAvailable || !result.manifest) return "";
  const lines = [`发现新版本：v${result.currentVersion} → v${result.manifest.version}`, ""];
  if (result.manifest.notes.features.length > 0) {
    lines.push("新增功能：", ...result.manifest.notes.features.map((item) => `- ${item}`), "");
  }
  if (result.manifest.notes.fixes.length > 0) {
    lines.push("Bug 修复：", ...result.manifest.notes.fixes.map((item) => `- ${item}`), "");
  }
  return lines.join("\n").trimEnd();
}

async function installUpdate(manifest, options = {}) {
  const parsed = parseUpdateManifest(manifest);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-session-search-update-"));
  const archivePath = path.join(tempDirectory, parsed.package.name);
  const statusPath = options.statusPath || installStatusPath(options.homeDir);
  await writeJsonAtomic(statusPath, {
    status: "installing",
    version: parsed.version,
    updatedAt: Date.now(),
    error: null,
  });
  try {
    const response = await fetchWithTimeout(fetchImpl, parsed.package.url, { headers: { "User-Agent": "agent-session-search-updater" } }, options.timeoutMs ?? 120_000);
    if (!response.ok) throw new Error(`Update package download failed (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (checksum !== parsed.package.sha256) throw new Error("Update package checksum mismatch.");
    await fsp.writeFile(archivePath, bytes);
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const registry = options.registry || process.env.AGENT_SESSION_SEARCH_NPM_REGISTRY || DEFAULT_NPM_REGISTRY;
    const installEnvironment = { ...process.env };
    delete installEnvironment.ELECTRON_RUN_AS_NODE;
    try {
      await (options.execFileImpl || execFileAsync)(npmCommand, [
        "install",
        "-g",
        archivePath,
        "--registry",
        registry,
        "--no-audit",
        "--no-fund",
        "--fetch-retries",
        "2",
        "--fetch-timeout",
        "30000",
      ], {
        shell: process.platform === "win32",
        timeout: options.installTimeoutMs ?? 10 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: installEnvironment,
      });
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || error?.message || error).trim();
      throw new Error(`npm 安装失败：${detail}`);
    }
    await writeJsonAtomic(statusPath, {
      status: "installed",
      version: parsed.version,
      updatedAt: Date.now(),
      error: null,
    });
    return parsed.version;
  } catch (error) {
    await writeJsonAtomic(statusPath, {
      status: "error",
      version: parsed.version,
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  } finally {
    await fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function writeAppProcess(pid = process.pid, options = {}) {
  const filePath = options.processPath || appProcessPath(options.homeDir);
  await writeJsonAtomic(filePath, { pid, startedAt: Date.now() });
  return filePath;
}

async function clearAppProcess(pid = process.pid, options = {}) {
  const filePath = options.processPath || appProcessPath(options.homeDir);
  const current = await readJson(filePath);
  if (!current || current.pid === pid) await fsp.rm(filePath, { force: true });
}

async function stopRunningApp(options = {}) {
  const processFile = options.processPath || appProcessPath(options.homeDir);
  const entry = await readJson(processFile);
  const pid = Number(entry?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (!isProcessRunning(pid)) {
    await fsp.rm(processFile, { force: true }).catch(() => undefined);
    return false;
  }
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T"], { timeout: 10_000 }).catch(() => undefined);
  } else {
    try { process.kill(pid, "SIGTERM"); } catch { return false; }
  }
  await waitForProcessExit(pid, options.waitTimeoutMs ?? 15_000);
  return true;
}

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The running Agent-Session-Search process did not exit in time.");
}

function globalCommandPath() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const prefix = execFileSync(npmCommand, ["prefix", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  return process.platform === "win32" ? path.join(prefix, "agent-session-search.cmd") : path.join(prefix, "bin", "agent-session-search");
}

function launchInstalledApp(options = {}) {
  const command = options.command || globalCommandPath();
  const environment = { ...process.env, ...options.env, AGENT_SESSION_SEARCH_NO_UPDATE_CHECK: "1" };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = (options.spawnImpl || spawn)(command, options.args || ["--no-update-check"], {
    detached: true,
    stdio: "ignore",
    shell: false,
    ...(process.platform === "win32" ? { shell: true } : {}),
    env: environment,
  });
  child.unref();
  return child;
}

async function readJson(filePath) {
  try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return null; }
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    await fsp.rm(filePath, { force: true });
    await fsp.rename(tempPath, filePath);
  }
}

module.exports = {
  DEFAULT_NPM_REGISTRY,
  GITHUB_REPOSITORY,
  LATEST_RELEASE_API,
  UPDATE_CACHE_TTL_MS,
  UPDATE_REQUEST_TIMEOUT_MS,
  acquireUpdateLock,
  appProcessPath,
  checkForUpdate,
  clearAppProcess,
  clearInstallStatus,
  compareVersions,
  currentVersion,
  defaultCachePath,
  formatUpdateNotice,
  globalCommandPath,
  installStatusPath,
  installUpdate,
  launchInstalledApp,
  parseUpdateManifest,
  readUpdatePreference,
  readInstallStatus,
  snoozeUpdatePrompt,
  stateDirectory,
  stopRunningApp,
  updateLockPath,
  updatePreferencePath,
  waitForProcessExit,
  writeAppProcess,
  writeJsonAtomic,
  writeUpdatePreference,
};
