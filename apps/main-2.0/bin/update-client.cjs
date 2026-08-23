#!/usr/bin/env node
"use strict";

const { execFile, execFileSync, spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { assertEmbeddedPostgresRuntime } = require("./embedded-postgres-runtime.cjs");
const { materializeStagedPackageDependencies } = require("./staged-package-dependencies.cjs");

const execFileAsync = promisify(execFile);
const GITHUB_REPOSITORY = "zszz3/AgentRecall";
const TRUSTED_GITHUB_REPOSITORIES = new Set([GITHUB_REPOSITORY.toLowerCase(), "zszz3/agentrecall"]);
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases?per_page=100`;
const LATEST_RELEASE_URL = `https://github.com/${GITHUB_REPOSITORY}/releases`;
const RELEASE_REFS_URL = `https://github.com/${GITHUB_REPOSITORY}.git/info/refs?service=git-upload-pack`;
// V1's updater hardcodes `releases/latest/download/update.json`, so the
// repository-wide "Latest" marker cannot move to V2 without silently breaking
// auto-update for every installed V1 client. V2 therefore keeps its own rolling
// tag that always carries the newest package; this is the only V2 install URL
// that stays valid across releases.
const STABLE_INSTALL_TAG = "v2-latest";
const LATEST_PACKAGE_URL = `${LATEST_RELEASE_URL}/download/${STABLE_INSTALL_TAG}/agent-recall-v2.tgz`;
const UPDATE_ASSET_NAME = "update-v2.json";
const LATEST_UPDATE_MANIFEST_URL = `${LATEST_RELEASE_URL}/download/${STABLE_INSTALL_TAG}/${UPDATE_ASSET_NAME}`;
const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
const ELECTRON_FALLBACK_MIRROR = "https://npmmirror.com/mirrors/electron/";
const TRANSIENT_REMOVE_ERROR_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

function packageRoot() {
  return path.resolve(__dirname, "..");
}

function currentVersion(options = {}) {
  const root = options.packageRoot || packageRoot();
  const readPackageVersion = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0";
    } catch {
      return "0.0.0";
    }
  };

  // The repo's package.json version is a placeholder; the real version lives in git tags. Prefer the
  // tag when running from a checkout so source builds don't misreport their version. Installed npm
  // tarballs have no `.git`, so they keep reading the CI-stamped package.json version. A worktree
  // stores `.git` as a file, so accept any existing entry rather than requiring a directory.
  let hasGit = false;
  try {
    hasGit = fs.existsSync(path.join(root, ".git"));
  } catch {
    hasGit = false;
  }
  if (!hasGit) return readPackageVersion();

  try {
    const runGit = options.execFileSyncImpl || execFileSync;
    const described = runGit("git", ["describe", "--tags", "--abbrev=0", "--match", "v2-[0-9]*"], {
      cwd: root,
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
    const normalized = described.replace(/^v2-/, "");
    // Guard compareVersions/parseStableVersion, which throw on anything but strict x.y.z.
    if (/^\d+\.\d+\.\d+$/.test(normalized)) return normalized;
  } catch {
    // git missing, shallow clone with no tags, permission error, etc. -> fall back below.
  }
  return readPackageVersion();
}

function stateDirectory(homeDir = os.homedir()) {
  return path.join(homeDir, ".agent-recall-v2");
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

function electronRuntimeLockPath(homeDir = os.homedir()) {
  return updateLockPath(homeDir);
}

async function waitForUpdateCompletion(options = {}) {
  const filePath = options.lockPath || updateLockPath(options.homeDir);
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  let waiting = false;
  while (Date.now() < deadline) {
    const current = await readJson(filePath);
    if (!current) return waiting;
    const ownerPid = Number(current.pid);
    if (!Number.isInteger(ownerPid) || ownerPid <= 0 || !isProcessRunning(ownerPid)) {
      await fsp.rm(filePath, { force: true }).catch(() => undefined);
      return waiting;
    }
    if (ownerPid === (options.currentPid ?? process.pid)) return waiting;
    if (!waiting) {
      waiting = true;
      options.onWait?.();
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
  }
  throw new Error(options.timeoutMessage || "等待正在进行的更新完成超时，请稍后重试。");
}

async function readInstallStatus(options = {}) {
  return readJson(options.statusPath || installStatusPath(options.homeDir));
}

async function clearInstallStatus(options = {}) {
  await fsp.rm(options.statusPath || installStatusPath(options.homeDir), { force: true });
}

function isUpdateRecoverySibling(candidatePath, packagePath, prefix) {
  if (typeof candidatePath !== "string" || !candidatePath) return false;
  const resolvedPackagePath = path.resolve(packagePath);
  const resolvedCandidatePath = path.resolve(candidatePath);
  return path.dirname(resolvedCandidatePath) === path.dirname(resolvedPackagePath)
    && path.basename(resolvedCandidatePath).startsWith(prefix);
}

async function recoverInterruptedUpdate(options = {}) {
  const statusPath = options.statusPath || installStatusPath(options.homeDir);
  const status = await readJson(statusPath);
  const recovery = status?.status === "installing" ? status.recovery : null;
  const livePackagePath = path.resolve(options.packagePath || packageRoot());
  if (
    !recovery
    || path.resolve(String(recovery.livePackagePath || "")) !== livePackagePath
    || !isUpdateRecoverySibling(recovery.backupPath, livePackagePath, ".agent-recall-backup-")
    || !fs.existsSync(recovery.backupPath)
  ) {
    return false;
  }

  await fsp.mkdir(livePackagePath, { recursive: true });
  await fsp.cp(recovery.backupPath, livePackagePath, { recursive: true, force: true });
  await writeJsonAtomic(statusPath, {
    status: "error",
    version: status.version,
    updatedAt: Date.now(),
    error: "自动更新意外中断，已恢复到更新前的版本。",
  });
  await fsp.rm(recovery.backupPath, { recursive: true, force: true });
  if (isUpdateRecoverySibling(recovery.stageRoot, livePackagePath, ".agent-recall-stage-")) {
    await fsp.rm(recovery.stageRoot, { recursive: true, force: true });
  }
  return true;
}

async function acquireUpdateLock(options = {}) {
  const filePath = options.lockPath || updateLockPath(options.homeDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidatePath = `${filePath}.${process.pid}.${randomUUID()}.candidate`;
    try {
      await fsp.writeFile(candidatePath, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, { encoding: "utf8", flag: "wx" });
      await fsp.link(candidatePath, filePath);
      await fsp.rm(candidatePath, { force: true });
      return {
        path: filePath,
        release: async () => {
          const current = await readJson(filePath);
          if (Number(current?.pid) === process.pid) await fsp.rm(filePath, { force: true });
        },
      };
    } catch (error) {
      await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
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
  if (value.tag !== `v2-${value.version}`) throw new Error("Update manifest tag does not match its version.");
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
    const pathParts = url.pathname.split("/").filter(Boolean);
    const repository = `${pathParts[0] || ""}/${pathParts[1] || ""}`.toLowerCase();
    return url.protocol === "https:" && url.hostname === "github.com" && TRUSTED_GITHUB_REPOSITORIES.has(repository) && pathParts[2] === "releases" && pathParts[3] === "download";
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
    return updateResult(version, cached.manifest || null, cached.checkedAt, true, null, cached, options);
  }

  try {
    const requestHeaders = {
      Accept: "application/vnd.github+json",
      "User-Agent": "agent-recall-updater",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    let release = null;
    let releaseListEtag = null;
    let releasePageUrl = LATEST_RELEASE_API;
    let releaseTag = null;
    let manifestResponse;
    try {
      const visitedReleasePages = new Set();
      while (releasePageUrl) {
        if (visitedReleasePages.has(releasePageUrl)) throw new Error("GitHub release pagination contains a loop.");
        visitedReleasePages.add(releasePageUrl);
        const headers = { ...requestHeaders };
        if (releasePageUrl === LATEST_RELEASE_API && cached?.etag) headers["If-None-Match"] = cached.etag;
        const releaseResponse = await fetchWithTimeout(fetchImpl, releasePageUrl, { headers }, options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS);
        if (releaseResponse.status === 304 && cached) {
          await writeJsonAtomic(cachePath, { ...cached, checkedAt: now });
          return updateResult(version, cached.manifest || null, now, false, null, cached, options);
        }
        if (releaseResponse.status === 404 && releasePageUrl === LATEST_RELEASE_API) {
          await writeJsonAtomic(cachePath, { checkedAt: now, etag: null, manifest: null });
          return updateResult(version, null, now, false, null, null, options);
        }
        if (!releaseResponse.ok) throw new Error(`GitHub release check failed (${releaseResponse.status}).`);
        if (releasePageUrl === LATEST_RELEASE_API) releaseListEtag = releaseResponse.headers.get("etag");
        const releases = await releaseResponse.json();
        if (!Array.isArray(releases)) throw new Error("GitHub release list is invalid.");
        release = releases.find((item) =>
          item?.draft !== true
          && item?.prerelease !== true
          && /^v2-\d+\.\d+\.\d+$/.test(item?.tag_name)
          && Array.isArray(item.assets)
          && item.assets.some((asset) => asset?.name === UPDATE_ASSET_NAME && asset?.browser_download_url));
        if (release) break;
        releasePageUrl = nextGitHubReleasePage(releaseResponse.headers.get("link"));
      }
      if (!release) {
        const cache = { checkedAt: now, etag: releaseListEtag, manifest: null };
        await writeJsonAtomic(cachePath, cache);
        return updateResult(version, null, now, false, null, cache, options);
      }
      const asset = release.assets.find((item) => item?.name === UPDATE_ASSET_NAME);
      manifestResponse = await fetchWithTimeout(fetchImpl, asset.browser_download_url, {
        headers: { "User-Agent": "agent-recall-v2-updater" },
      }, options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS);
      if (!manifestResponse.ok) throw new Error(`Update manifest download failed (${manifestResponse.status}).`);
      releaseTag = release.tag_name;
    } catch (releaseError) {
      try {
        manifestResponse = await fetchWithTimeout(fetchImpl, LATEST_UPDATE_MANIFEST_URL, {
          headers: { "User-Agent": "agent-recall-v2-updater" },
        }, options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS);
        if (!manifestResponse.ok) throw new Error(`Stable update manifest download failed (${manifestResponse.status}).`);
        releaseListEtag = null;
      } catch {
        manifestResponse = null;
        try {
          const refsResponse = await fetchWithTimeout(fetchImpl, RELEASE_REFS_URL, {
            headers: { Accept: "application/x-git-upload-pack-advertisement", "User-Agent": "agent-recall-v2-updater" },
          }, options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS);
          if (!refsResponse.ok) throw new Error(`GitHub release refs check failed (${refsResponse.status}).`);
          const advertisement = await refsResponse.text();
          const tags = [...new Set([...advertisement.matchAll(/refs\/tags\/(v2-\d+\.\d+\.\d+)(?=\^\{\}|[\u0000\n]|$)/g)]
            .map((match) => match[1]))]
            .sort((left, right) => compareVersions(right.replace(/^v2-/, ""), left.replace(/^v2-/, "")));
          if (tags.length === 0) throw new Error("GitHub release refs do not contain a V2 release.");
          for (const tag of tags.slice(0, 10)) {
            const manifestUrl = `https://github.com/${GITHUB_REPOSITORY}/releases/download/${tag}/${UPDATE_ASSET_NAME}`;
            const response = await fetchWithTimeout(fetchImpl, manifestUrl, {
              headers: { "User-Agent": "agent-recall-v2-updater" },
            }, options.timeoutMs ?? UPDATE_REQUEST_TIMEOUT_MS);
            if (response.status === 404) continue;
            if (!response.ok) throw new Error(`Direct update manifest download failed (${response.status}).`);
            releaseTag = tag;
            manifestResponse = response;
            break;
          }
          if (!manifestResponse) throw new Error("GitHub release refs do not point to a published V2 manifest.");
          releaseListEtag = null;
        } catch {
          throw releaseError;
        }
      }
    }
    const manifest = parseUpdateManifest(await manifestResponse.json());
    if (releaseTag && releaseTag !== manifest.tag) throw new Error(`GitHub Release tag does not match ${UPDATE_ASSET_NAME}.`);
    const sameSnoozedVersion = cached?.snoozedVersion === manifest.version;
    const sameSkippedVersion = cached?.skippedVersion === manifest.version;
    const cache = {
      checkedAt: now,
      etag: releaseListEtag,
      manifest,
      snoozedVersion: sameSnoozedVersion ? cached.snoozedVersion : null,
      snoozedUntil: sameSnoozedVersion ? cached.snoozedUntil : 0,
      skippedVersion: sameSkippedVersion ? cached.skippedVersion : null,
    };
    await writeJsonAtomic(cachePath, cache);
    return updateResult(version, manifest, now, false, null, cache, options);
  } catch (error) {
    return updateResult(version, cached?.manifest || null, cached?.checkedAt || 0, Boolean(cached), error instanceof Error ? error.message : String(error), cached, options);
  }
}

function nextGitHubReleasePage(linkHeader) {
  for (const part of String(linkHeader || "").split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (!match || match[2] !== "next") continue;
    const url = new URL(match[1]);
    if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
      throw new Error("GitHub release pagination returned an untrusted URL.");
    }
    return url.toString();
  }
  return null;
}

function updateResult(version, manifest, checkedAt, fromCache, error, cache = null, options = {}) {
  let updateAvailable = false;
  try {
    updateAvailable = Boolean(manifest && compareVersions(version, manifest.version) < 0);
  } catch {
    updateAvailable = false;
  }
  const showSkipped = options.showSkipped === true || options.force === true;
  const promptSnoozed = !showSkipped && Boolean(updateAvailable && manifest && cache?.snoozedVersion === manifest.version && Number(cache.snoozedUntil) > Date.now());
  const updateSkipped = !showSkipped && Boolean(updateAvailable && manifest && cache?.skippedVersion === manifest.version);
  return { currentVersion: version, checkedAt, fromCache, updateAvailable, updateSkipped, promptSnoozed, manifest, error };
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

async function skipUpdateVersion(version, options = {}) {
  const cachePath = options.cachePath || defaultCachePath(options.homeDir);
  const cache = (await readJson(cachePath)) || {};
  await writeJsonAtomic(cachePath, {
    ...cache,
    skippedVersion: version,
    snoozedVersion: cache.snoozedVersion === version ? null : cache.snoozedVersion,
    snoozedUntil: cache.snoozedVersion === version ? 0 : cache.snoozedUntil,
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

function releaseUrl(version) {
  parseStableVersion(version);
  return `${LATEST_RELEASE_URL}/tag/v2-${version}`;
}

function manualInstallCommand() {
  return `npm install -g ${LATEST_PACKAGE_URL}`;
}

function formatManualUpdateFallback(version) {
  if (!version) {
    return [
      "自动更新未完成。你可以手动覆盖安装最新版本：",
      manualInstallCommand(),
      `Release 页面：${LATEST_RELEASE_URL}`,
    ].join("\n");
  }
  return [
    "自动更新未完成。你可以手动覆盖安装最新版本：",
    manualInstallCommand(),
    `Release 页面：${releaseUrl(version)}`,
  ].join("\n");
}

function formatUpdateError(error, fallback = "未知错误") {
  const missingExecutable = error && typeof error === "object" ? String(error.path || "") : "";
  const errorMessage = error && typeof error === "object" ? String(error.message || "") : "";
  if (
    error
    && typeof error === "object"
    && error.code === "ENOENT"
    && (
      /(?:^|[/\\])npm(?:\.cmd)?$/i.test(missingExecutable)
      || /\bspawn(?:Sync)?\s+npm(?:\.cmd)?\s+ENOENT\b/i.test(errorMessage)
    )
  ) {
    return "应用进程找不到 npm。请在终端中手动运行更新命令。";
  }
  const candidates = error && typeof error === "object"
    ? [error.stderr, error.stdout, error.message, error]
    : [error];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const text = Buffer.isBuffer(candidate) || candidate instanceof Uint8Array
      ? Buffer.from(candidate).toString("utf8")
      : String(candidate);
    const readable = text
      .replace(/\uFFFD/g, "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (readable && readable !== "[object Object]") return readable.slice(0, 2_000);
  }
  return fallback;
}

function showNativeUpdateFailure(errorMessage, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.execFileSyncImpl || execFileSync;
  const spawnImpl = options.spawnImpl || spawn;
  const command = manualInstallCommand();
  const productReleaseUrl = options.version ? releaseUrl(options.version) : LATEST_RELEASE_URL;
  const environment = {
    ...process.env,
    ...options.env,
    AGENT_RECALL_UPDATE_ERROR: formatUpdateError(errorMessage),
    AGENT_RECALL_UPDATE_COMMAND: command,
    AGENT_RECALL_UPDATE_RELEASE_URL: productReleaseUrl,
  };

  try {
    if (platform === "darwin") {
      const script = [
        'set errorDetail to system attribute "AGENT_RECALL_UPDATE_ERROR"',
        'set installCommand to system attribute "AGENT_RECALL_UPDATE_COMMAND"',
        'set dialogText to "自动更新未能完成，应用会尝试继续启动已安装的版本。" & return & return & "原因：" & errorDetail & return & return & "你可以复制命令手动覆盖安装，或打开 GitHub Release 页面。" & return & installCommand',
        'display dialog dialogText with title "AgentRecall 更新失败" buttons {"稍后处理", "打开 Release 页面", "复制安装命令"} default button "复制安装命令" with icon caution',
      ].join("\n");
      const output = String(run("osascript", ["-e", script], { encoding: "utf8", env: environment }) || "");
      if (output.includes("复制安装命令")) {
        run("pbcopy", [], { input: `${command}\n`, encoding: "utf8", env: environment });
      } else if (output.includes("打开 Release 页面")) {
        const child = spawnImpl("open", [productReleaseUrl], { detached: true, stdio: "ignore", env: environment });
        child.unref();
      }
      return true;
    }

    if (platform === "win32") {
      const script = [
        "Add-Type -AssemblyName PresentationFramework",
        '$text = "自动更新未能完成，应用会尝试继续启动已安装的版本。`n`n原因：$env:AGENT_RECALL_UPDATE_ERROR`n`n选择“是”复制安装命令，选择“否”打开 GitHub Release 页面。"',
        '$choice = [System.Windows.MessageBox]::Show($text, "AgentRecall 更新失败", "YesNoCancel", "Error")',
        'if ($choice -eq "Yes") { Set-Clipboard -Value $env:AGENT_RECALL_UPDATE_COMMAND }',
        'elseif ($choice -eq "No") { Start-Process $env:AGENT_RECALL_UPDATE_RELEASE_URL }',
      ].join("; ");
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        env: environment,
        windowsHide: true,
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function updateProgress(version, phase, values = {}) {
  return { phase, version, ...values };
}

function resolveNpmCommand(options = {}) {
  if (options.npmCommand) return options.npmCommand;
  const platform = options.platform || process.platform;
  const executableName = platform === "win32" ? "npm.cmd" : "npm";
  if (platform === "win32") return executableName;
  const nodePath = options.nodePath;
  if (nodePath && path.isAbsolute(nodePath)) {
    const adjacentNpm = path.join(path.dirname(nodePath), executableName);
    if (fs.existsSync(adjacentNpm)) return adjacentNpm;
  }
  return executableName;
}

function npmSubprocessEnvironment(environment = process.env, nodePath) {
  const result = { ...environment };
  if (nodePath && path.isAbsolute(nodePath)) {
    const nodeDirectory = path.dirname(nodePath);
    const pathKey = Object.keys(result).find((key) => key.toLowerCase() === "path") || "PATH";
    const pathEntries = String(result[pathKey] || "")
      .split(path.delimiter)
      .filter(Boolean);
    result[pathKey] = [nodeDirectory, ...pathEntries.filter((entry) => entry !== nodeDirectory)].join(path.delimiter);
  }
  delete result.ELECTRON_RUN_AS_NODE;
  return result;
}

async function downloadUpdatePackage(manifest, archivePath, options = {}) {
  const response = await fetchWithTimeout(
    options.fetchImpl || globalThis.fetch,
    manifest.package.url,
    { headers: { "User-Agent": "agent-recall-updater" } },
    options.timeoutMs ?? 120_000,
  );
  if (!response.ok || !response.body) {
    throw new Error(`Update package download failed (${response.status}).`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : undefined;
  const reader = response.body.getReader();
  const output = await fsp.open(archivePath, "w");
  const hash = createHash("sha256");
  const startedAt = (options.now || Date.now)();
  let downloadedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      await output.write(chunk);
      hash.update(chunk);
      downloadedBytes += chunk.length;
      const elapsedMs = Math.max(1, (options.now || Date.now)() - startedAt);
      options.onProgress?.(updateProgress(manifest.version, "downloading", {
        downloadedBytes,
        totalBytes,
        percent: totalBytes ? Math.min(100, Math.round(downloadedBytes / totalBytes * 100)) : undefined,
        bytesPerSecond: Math.round(downloadedBytes * 1000 / elapsedMs),
      }));
    }
  } finally {
    await output.close();
  }
  options.onProgress?.(updateProgress(manifest.version, "verifying", {
    downloadedBytes,
    totalBytes,
    percent: totalBytes ? 100 : undefined,
  }));
  if (hash.digest("hex") !== manifest.package.sha256) {
    throw new Error("Update package checksum mismatch.");
  }
  return { downloadedBytes, totalBytes };
}

async function stageUpdate(manifest, options = {}) {
  const parsed = parseUpdateManifest(manifest);
  const packagePath = options.packagePath || packageRoot();
  const stageRoot = options.stageRoot
    || path.join(path.dirname(packagePath), `.agent-recall-stage-${process.pid}-${randomUUID()}`);
  const archivePath = path.join(stageRoot, parsed.package.name);
  const stagedPackagePath = path.join(stageRoot, "node_modules", "agent-recall-v2");
  const backupPath = path.join(path.dirname(packagePath), `.agent-recall-backup-${process.pid}-${randomUUID()}`);
  const statusPath = options.statusPath || installStatusPath(options.homeDir);
  await fsp.mkdir(stageRoot, { recursive: true });
  await writeJsonAtomic(statusPath, {
    status: "installing",
    version: parsed.version,
    updatedAt: Date.now(),
    error: null,
  });
  try {
    await downloadUpdatePackage(parsed, archivePath, options);
    options.onProgress?.(updateProgress(parsed.version, "staging", {
      message: "正在安装到临时目录…",
    }));
    const npmCommand = resolveNpmCommand(options);
    const registry = options.registry || process.env.AGENT_RECALL_NPM_REGISTRY || DEFAULT_NPM_REGISTRY;
    const installEnvironment = {
      ...npmSubprocessEnvironment(process.env, options.nodePath),
      AGENT_RECALL_STAGING_INSTALL: "1",
      AGENT_RECALL_STAGE_ROOT: stageRoot,
    };
    try {
      await (options.execFileImpl || execFileAsync)(npmCommand, [
        "install",
        "--prefix",
        stageRoot,
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
      throw new Error(`npm 安装失败：${formatUpdateError(error)}`);
    }
    await materializeStagedPackageDependencies({
      stageRoot,
      packagePath: stagedPackagePath,
    });
    assertEmbeddedPostgresRuntime({
      packagePath: stagedPackagePath,
      requireSelfContained: true,
    });
    options.onProgress?.(updateProgress(parsed.version, "validating", {
      message: "正在检查应用和 Electron 运行时…",
    }));
    const stagedPackage = JSON.parse(await fsp.readFile(path.join(stagedPackagePath, "package.json"), "utf8"));
    if (stagedPackage.name !== "agent-recall-v2" || stagedPackage.version !== parsed.version) {
      throw new Error("Staged update package metadata does not match the release.");
    }
    await Promise.all([
      fsp.access(path.join(stagedPackagePath, "bin", "agent-recall.cjs")),
      fsp.access(path.join(stagedPackagePath, "out", "main", "index.js")),
    ]);
    await (options.ensureElectronImpl || ensureInstalledElectron)({
      npmCommand,
      nodePath: options.nodePath,
      packagePath: stagedPackagePath,
      runtimeSourcePath: packagePath,
      env: installEnvironment,
      timeoutMs: options.electronInstallTimeoutMs,
    });
    return {
      version: parsed.version,
      stageRoot,
      archivePath,
      stagedPackagePath,
      livePackagePath: packagePath,
      backupPath,
      statusPath,
    };
  } catch (error) {
    await writeJsonAtomic(statusPath, {
      status: "error",
      version: parsed.version,
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    if (!options.keepStageOnError) {
      await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function installUpdate(manifest, options = {}) {
  const parsed = parseUpdateManifest(manifest);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-recall-update-"));
  const archivePath = path.join(tempDirectory, parsed.package.name);
  const packagePath = options.packagePath || globalPackageRoot({ npmCommand: options.npmCommand });
  const packageBackupPath = path.join(tempDirectory, "previous-package");
  const statusPath = options.statusPath || installStatusPath(options.homeDir);
  let installationStarted = false;
  let packageBackedUp = false;
  await writeJsonAtomic(statusPath, {
    status: "installing",
    version: parsed.version,
    updatedAt: Date.now(),
    error: null,
  });
  try {
    await downloadUpdatePackage(parsed, archivePath, {
      fetchImpl,
      timeoutMs: options.timeoutMs,
      onProgress: options.onProgress,
      now: options.now,
    });
    if (fs.existsSync(packagePath)) {
      await fsp.cp(packagePath, packageBackupPath, { recursive: true, force: true });
      packageBackedUp = true;
    }
    const npmCommand = options.npmCommand || (process.platform === "win32" ? "npm.cmd" : "npm");
    const registry = options.registry || process.env.AGENT_RECALL_NPM_REGISTRY || DEFAULT_NPM_REGISTRY;
    const installEnvironment = { ...process.env };
    delete installEnvironment.ELECTRON_RUN_AS_NODE;
    try {
      installationStarted = true;
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
      const detail = formatUpdateError(error);
      throw new Error(`npm 安装失败：${detail}`);
    }
    assertEmbeddedPostgresRuntime({ packagePath });
    await (options.ensureElectronImpl || ensureInstalledElectron)({
      npmCommand,
      nodePath: options.nodePath,
      packagePath,
      env: installEnvironment,
      timeoutMs: options.electronInstallTimeoutMs,
    });
    await writeJsonAtomic(statusPath, {
      status: "installed",
      version: parsed.version,
      updatedAt: Date.now(),
      error: null,
    });
    return parsed.version;
  } catch (error) {
    let failure = error;
    if (installationStarted) {
      try {
        await fsp.rm(packagePath, { recursive: true, force: true });
        if (packageBackedUp) await fsp.cp(packageBackupPath, packagePath, { recursive: true, force: true });
      } catch (rollbackError) {
        failure = new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    await writeJsonAtomic(statusPath, {
      status: "error",
      version: parsed.version,
      updatedAt: Date.now(),
      error: failure instanceof Error ? failure.message : String(failure),
    }).catch(() => undefined);
    throw failure;
  } finally {
    await fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function globalPackageRoot(options = {}) {
  const npmCommand = options.npmCommand || (process.platform === "win32" ? "npm.cmd" : "npm");
  const npmRoot = (options.execFileSyncImpl || execFileSync)(npmCommand, ["root", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  }).trim();
  if (!npmRoot) throw new Error("无法确定 npm 全局安装目录。");
  return path.join(npmRoot, "agent-recall-v2");
}

function nodeSubprocessEnvironment(baseEnvironment = {}) {
  const environment = { ...process.env, ...baseEnvironment };
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = "1";
  else delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function electronSubprocessEnvironment(baseEnvironment = {}) {
  const environment = { ...process.env, ...baseEnvironment };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function nodeSubprocessPath(options = {}) {
  if (!process.versions.electron) return process.execPath;
  const candidate = options.nodePath || process.env.NODE || "node";
  if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  return "node";
}

function electronRuntimePaths(platform = process.platform) {
  const relativeExecutable = platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");
  return { relativeExecutable, relativeDefaultApp };
}

function electronCacheRoot(environment = process.env, homeDir = os.homedir(), platform = process.platform) {
  if (environment.electron_config_cache) return environment.electron_config_cache;
  if (platform === "win32") {
    return path.join(environment.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "electron", "Cache");
  }
  if (platform === "darwin") return path.join(homeDir, "Library", "Caches", "electron");
  return path.join(environment.XDG_CACHE_HOME || path.join(homeDir, ".cache"), "electron");
}

async function findFileRecursive(rootPath, fileName) {
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
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

async function removeRuntimeDirectory(directoryPath, options = {}) {
  const maxRetries = options.maxRetries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 50;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rm(directoryPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!TRANSIENT_REMOVE_ERROR_CODES.has(error?.code) || attempt >= maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
}

async function ensureInstalledElectron(options = {}) {
  const packagePath = options.packagePath || globalPackageRoot({ npmCommand: options.npmCommand });
  const electronModulePath = path.join(packagePath, "node_modules", "electron");
  const installScript = path.join(electronModulePath, "install.js");
  const nodeEnvironment = nodeSubprocessEnvironment(options.env);
  nodeEnvironment.AGENT_RECALL_SKIP_LEGACY_ELECTRON_BRIDGE = "1";
  const electronEnvironment = electronSubprocessEnvironment(options.env);
  const run = options.execFileImpl || execFileAsync;
  const nodePath = nodeSubprocessPath(options);
  const timeout = options.timeoutMs ?? 5 * 60_000;
  const homeDir = options.homeDir || os.homedir();
  const { relativeExecutable, relativeDefaultApp } = electronRuntimePaths(options.platform);
  const bridgeMarkerPath = path.join(electronModulePath, ".agent-recall-staging-bridge.json");
  let bridgeMarker = null;
  if (fs.existsSync(bridgeMarkerPath)) {
    try {
      bridgeMarker = JSON.parse(await fsp.readFile(bridgeMarkerPath, "utf8"));
    } catch {
      throw new Error("Electron staging bridge metadata is invalid.");
    }
    if (!bridgeMarker || typeof bridgeMarker !== "object" || Array.isArray(bridgeMarker)) {
      throw new Error("Electron staging bridge metadata is invalid.");
    }
  }
  if (bridgeMarker) {
    const electronVersion = String(bridgeMarker.electronVersion || "").trim();
    const bridgedVersion = String(bridgeMarker.bridgedVersion || "").trim();
    if (
      bridgeMarker.schemaVersion !== 1
      || !/^\d+\.\d+\.\d+$/.test(electronVersion)
      || !/^\d+\.\d+\.\d+$/.test(bridgedVersion)
    ) {
      throw new Error("Electron staging bridge metadata is invalid.");
    }
    const agentRecallPackagePath = path.join(packagePath, "package.json");
    const packageJsonPath = path.join(electronModulePath, "package.json");
    const distVersionPath = path.join(electronModulePath, "dist", "version");
    const agentRecallPackage = JSON.parse(await fsp.readFile(agentRecallPackagePath, "utf8"));
    const electronPackage = JSON.parse(await fsp.readFile(packageJsonPath, "utf8"));
    let installedVersion = "";
    try {
      installedVersion = (await fsp.readFile(distVersionPath, "utf8")).trim().replace(/^v/, "");
    } catch {
      // Install scripts may be blocked; normal runtime repair will populate dist after metadata restoration.
    }
    const dependencyVersion = String(agentRecallPackage.dependencies?.electron || "").trim();
    const expectedMetadataVersions = new Set([electronVersion, bridgedVersion]);
    if (
      !expectedMetadataVersions.has(electronPackage.version)
      || !expectedMetadataVersions.has(dependencyVersion)
      || (installedVersion !== "" && !expectedMetadataVersions.has(installedVersion))
    ) {
      throw new Error("Electron staging bridge metadata does not match the installed runtime.");
    }
    agentRecallPackage.dependencies.electron = electronVersion;
    electronPackage.version = electronVersion;
    if (Array.isArray(electronPackage.files)) {
      electronPackage.files = electronPackage.files.filter((entry) => entry !== ".agent-recall-staging-bridge.json");
    }
    await writeJsonAtomic(agentRecallPackagePath, agentRecallPackage);
    await writeJsonAtomic(packageJsonPath, electronPackage);
    if (installedVersion && installedVersion !== electronVersion) {
      await fsp.writeFile(distVersionPath, electronVersion, "utf8");
    }
    await fsp.rm(bridgeMarkerPath, { force: true });
  }
  let expectedVersion = "";
  try {
    expectedVersion = String(JSON.parse(await fsp.readFile(path.join(electronModulePath, "package.json"), "utf8")).version || "").trim();
  } catch {
    throw new Error("Electron package version is missing.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error("Electron package version is invalid.");
  const validationScript = `process.stdout.write(require(${JSON.stringify(electronModulePath)}));`;
  const distPath = path.join(electronModulePath, "dist");
  const pathFile = path.join(electronModulePath, "path.txt");
  const validate = async () => {
    const resolved = await run(nodePath, ["-e", validationScript], {
      env: nodeEnvironment,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    const executable = String(resolved?.stdout || "").trim();
    if (!executable || !fs.existsSync(executable)) throw new Error(`Electron executable is missing: ${executable || "unknown"}`);
    const loaded = await run(executable, ["--version"], {
      env: electronEnvironment,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const loadedVersion = String(loaded?.stdout || loaded?.stderr || "").trim().replace(/^v/, "");
    if (loadedVersion && loadedVersion !== expectedVersion) {
      throw new Error(`Electron executable version mismatch: expected ${expectedVersion}, got ${loadedVersion}.`);
    }
    const installedVersion = (await fsp.readFile(path.join(distPath, "version"), "utf8")).trim();
    if (installedVersion !== expectedVersion) throw new Error(`Electron runtime version mismatch: expected ${expectedVersion}, got ${installedVersion || "unknown"}.`);
    if (!isElectronRuntimeReady(packagePath)) throw new Error("Electron runtime files are incomplete.");
  };
  const cleanupBackups = async (distBackup, pathBackup, cleanupPath) => {
    await fsp.rm(pathBackup, { force: true }).catch(() => undefined);
    if (fs.existsSync(distBackup)) await fsp.rename(distBackup, cleanupPath);
    await removeRuntimeDirectory(cleanupPath).catch(() => undefined);
  };
  const repairViaInstallScript = async ({ forceNoCache = false, mirror, customDir } = {}) => {
    const environment = { ...nodeEnvironment };
    if (forceNoCache) environment.force_no_cache = "true";
    if (mirror !== undefined) environment.ELECTRON_MIRROR = mirror;
    if (customDir !== undefined) environment.ELECTRON_CUSTOM_DIR = customDir;
    await run(nodePath, [installScript], {
      cwd: electronModulePath,
      env: environment,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
  };
  const repairMissingPathFile = async () => {
    if (fs.existsSync(pathFile)) return false;
    const executablePath = path.join(distPath, relativeExecutable);
    const defaultAppPath = path.join(distPath, relativeDefaultApp);
    const versionFilePath = path.join(distPath, "version");
    if (!fs.existsSync(executablePath) || !fs.existsSync(defaultAppPath) || !fs.existsSync(versionFilePath)) return false;
    await fsp.writeFile(pathFile, relativeExecutable, "utf8");
    return true;
  };
  const repairFromRuntimeSource = async () => {
    const sourceRoot = options.runtimeSourcePath;
    if (!sourceRoot || sourceRoot === packagePath) return false;
    if (!isElectronRuntimeReady(sourceRoot)) return false;
    const sourceElectronPath = path.join(sourceRoot, "node_modules", "electron");
    let sourcePackageVersion = "";
    let sourceDistVersion = "";
    try {
      sourcePackageVersion = String(JSON.parse(await fsp.readFile(path.join(sourceElectronPath, "package.json"), "utf8")).version || "").trim();
      sourceDistVersion = (await fsp.readFile(path.join(sourceElectronPath, "dist", "version"), "utf8")).trim().replace(/^v/, "");
    } catch {
      return false;
    }
    if (sourcePackageVersion !== expectedVersion || sourceDistVersion !== expectedVersion) return false;
    await removeRuntimeDirectory(distPath).catch(() => undefined);
    await fsp.rm(pathFile, { force: true }).catch(() => undefined);
    await fsp.cp(path.join(sourceElectronPath, "dist"), distPath, { recursive: true, force: true });
    await fsp.copyFile(path.join(sourceElectronPath, "path.txt"), pathFile);
    return true;
  };
  const repairFromCachedArchive = async () => {
    const archivePath = options.findCachedArchiveImpl
      ? await options.findCachedArchiveImpl({ expectedVersion, environment: nodeEnvironment, homeDir, platform: options.platform || process.platform, arch: options.arch || process.arch })
      : await findFileRecursive(
        electronCacheRoot(nodeEnvironment, homeDir, options.platform || process.platform),
        `electron-v${expectedVersion}-${options.platform || process.platform}-${options.arch || process.arch}.zip`,
      );
    if (!archivePath) return false;
    await removeRuntimeDirectory(distPath).catch(() => undefined);
    await fsp.rm(pathFile, { force: true }).catch(() => undefined);
    await fsp.mkdir(distPath, { recursive: true });
    if (options.extractArchiveImpl) {
      await options.extractArchiveImpl({ archivePath, distPath, electronModulePath });
    } else {
      // Extract in a Node subprocess. Running the Electron archive extractor inside Electron's main
      // process can deadlock while holding the update UI on "validating".
      const extractScript = [
        "const { createRequire } = require(\"node:module\");",
        `const requireFromElectron = createRequire(${JSON.stringify(path.join(electronModulePath, "package.json"))});`,
        "const { extract } = requireFromElectron(\"@electron-internal/extract-zip\");",
        `extract(${JSON.stringify(archivePath)}, { dir: ${JSON.stringify(distPath)} }).then(`,
        "  () => process.exit(0),",
        "  (error) => {",
        "    console.error(error instanceof Error ? (error.stack || error.message) : String(error));",
        "    process.exit(1);",
        "  }",
        ");",
      ].join("");
      await run(nodePath, ["-e", extractScript], {
        cwd: electronModulePath,
        env: nodeEnvironment,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      });
    }
    await repairMissingPathFile();
    return true;
  };

  try {
    await validate();
    return;
  } catch {
    // Sentinel files are not sufficient: a damaged executable must be repaired.
  }

  const repairId = `${process.pid}-${randomUUID()}`;
  const distBackup = path.join(electronModulePath, `.agent-recall-dist-${repairId}.backup`);
  const pathBackup = path.join(electronModulePath, `.agent-recall-path-${repairId}.backup`);
  const cleanupPath = path.join(path.dirname(packagePath), `.agent-recall-electron-cleanup-${repairId}`);
  if (fs.existsSync(distPath)) await fsp.rename(distPath, distBackup);
  if (fs.existsSync(pathFile)) await fsp.rename(pathFile, pathBackup);
  let repairError = null;
  const attemptRepair = async (operation) => {
    try {
      const result = await operation();
      if (result === false) return false;
      await validate();
      await cleanupBackups(distBackup, pathBackup, cleanupPath);
      return true;
    } catch (error) {
      repairError = error;
      return false;
    }
  };
  try {
    if (await attemptRepair(repairFromRuntimeSource)) return;
    if (await attemptRepair(() => repairViaInstallScript())) return;
    if (await attemptRepair(repairMissingPathFile)) return;
    if (await attemptRepair(repairFromCachedArchive)) return;
    await removeRuntimeDirectory(distPath).catch(() => undefined);
    await fsp.rm(pathFile, { force: true }).catch(() => undefined);
    if (await attemptRepair(() => repairViaInstallScript({ forceNoCache: true }))) return;
    if (await attemptRepair(repairMissingPathFile)) return;
    await removeRuntimeDirectory(distPath).catch(() => undefined);
    await fsp.rm(pathFile, { force: true }).catch(() => undefined);
    if (await attemptRepair(() => repairViaInstallScript({
      forceNoCache: true,
      mirror: ELECTRON_FALLBACK_MIRROR,
      customDir: "{{ version }}",
    }))) return;
    if (await attemptRepair(repairMissingPathFile)) return;
    throw repairError || new Error("Electron runtime files are incomplete.");
  } catch (error) {
    await removeRuntimeDirectory(distPath).catch(() => undefined);
    await fsp.rm(pathFile, { force: true }).catch(() => undefined);
    if (fs.existsSync(distBackup)) await fsp.rename(distBackup, distPath).catch(() => undefined);
    if (fs.existsSync(pathBackup)) await fsp.rename(pathBackup, pathFile).catch(() => undefined);
    try {
      await validate();
      return;
    } catch {
      // Fall through to the original installation failure when the restored runtime is still unusable.
    }
    const detail = formatUpdateError(error);
    throw new Error(`Electron 运行时安装失败：${detail}`);
  }
}

function isElectronRuntimeReady(packagePath = packageRoot()) {
  const electronModulePath = path.join(packagePath, "node_modules", "electron");
  try {
    const relativeExecutable = fs.readFileSync(path.join(electronModulePath, "path.txt"), "utf8").trim();
    if (!relativeExecutable) return false;
    const distPath = path.join(electronModulePath, "dist");
    const defaultAppPath = process.platform === "darwin"
      ? path.join(distPath, "Electron.app", "Contents", "Resources", "default_app.asar")
      : path.join(distPath, "resources", "default_app.asar");
    return (
      fs.existsSync(path.join(distPath, relativeExecutable)) &&
      fs.existsSync(path.join(distPath, "version")) &&
      fs.existsSync(defaultAppPath)
    );
  } catch {
    return false;
  }
}

async function ensureElectronRuntimeForLaunch(options = {}) {
  const lockPath = options.lockPath || electronRuntimeLockPath(options.homeDir);
  let lock = null;
  for (let attempt = 0; attempt < 3 && !lock; attempt += 1) {
    await waitForUpdateCompletion({
      lockPath,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      currentPid: options.currentPid,
      onWait: options.onWait,
      timeoutMessage: "等待 Electron 运行时安装完成超时，请稍后重试。",
    });
    try {
      lock = await acquireUpdateLock({ lockPath });
    } catch (error) {
      if (error?.code !== "UPDATE_IN_PROGRESS" || attempt === 2) throw error;
    }
  }
  if (!lock) throw new Error("无法获取 Electron 运行时安装锁。");
  try {
    const packagePath = options.packagePath || packageRoot();
    await (options.ensureElectronImpl || ensureInstalledElectron)({
      packagePath,
      timeoutMs: options.timeoutMs,
      execFileImpl: options.execFileImpl,
      env: options.env,
      nodePath: options.nodePath,
    });
  } finally {
    await lock.release().catch(() => undefined);
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

async function findInstalledAppProcessIds(options = {}) {
  const platform = options.platform || process.platform;
  const packagePath = options.packagePath || globalPackageRoot({ npmCommand: options.npmCommand });
  const appEntry = path.join(packagePath, "out", "main", "index.js");
  const run = options.execFileImpl || execFileAsync;
  const result = platform === "win32"
    ? await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
    ], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    : await run("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  const expected = platform === "win32" ? appEntry.replaceAll("\\", "/").toLowerCase() : appEntry;
  return String(result?.stdout || "")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return [];
      const command = platform === "win32" ? match[2].replaceAll("\\", "/").toLowerCase() : match[2];
      const pid = Number(match[1]);
      return command.includes(expected) && pid !== process.pid ? [pid] : [];
    });
}

async function stopRunningApp(options = {}) {
  const processFile = options.processPath || appProcessPath(options.homeDir);
  const entry = await readJson(processFile);
  const pid = Number(entry?.pid);
  const processIds = new Set();
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isProcessRunning(pid)) {
    processIds.add(pid);
  } else if (Number.isInteger(pid) && pid > 0) {
    await fsp.rm(processFile, { force: true }).catch(() => undefined);
  }
  const discovered = await findInstalledAppProcessIds(options).catch(() => []);
  for (const discoveredPid of discovered) {
    if (Number.isInteger(discoveredPid) && discoveredPid > 0 && discoveredPid !== process.pid) processIds.add(discoveredPid);
  }
  if (processIds.size === 0) return false;
  for (const appPid of processIds) {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(appPid), "/T", "/F"], { timeout: 10_000 }).catch(() => undefined);
    } else {
      try { process.kill(appPid, "SIGTERM"); } catch { processIds.delete(appPid); }
    }
  }
  await Promise.all([...processIds].map((appPid) => waitForProcessExit(appPid, options.waitTimeoutMs ?? 15_000)));
  await fsp.rm(processFile, { force: true }).catch(() => undefined);
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
  throw new Error("The running AgentRecall process did not exit in time.");
}

function globalCommandPath(options = {}) {
  const platform = options.platform || process.platform;
  const environment = { ...process.env, ...options.env };
  const nodePath = options.nodePath || environment.AGENT_RECALL_NODE_PATH;
  const npmCommand = resolveNpmCommand({ npmCommand: options.npmCommand, nodePath, platform });
  const prefix = (options.execFileSyncImpl || execFileSync)(npmCommand, ["prefix", "-g"], {
    encoding: "utf8",
    shell: platform === "win32",
    env: npmSubprocessEnvironment(environment, nodePath),
  }).trim();
  return platform === "win32" ? path.join(prefix, "agent-recall-v2.cmd") : path.join(prefix, "bin", "agent-recall-v2");
}

function launchInstalledApp(options = {}) {
  const command = options.command || globalCommandPath(options);
  const environment = { ...process.env, ...options.env, AGENT_RECALL_NO_UPDATE_CHECK: "1" };
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
  LATEST_PACKAGE_URL,
  LATEST_RELEASE_API,
  LATEST_RELEASE_URL,
  STABLE_INSTALL_TAG,
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
  electronRuntimeLockPath,
  ensureElectronRuntimeForLaunch,
  ensureInstalledElectron,
  formatUpdateError,
  formatManualUpdateFallback,
  formatUpdateNotice,
  globalPackageRoot,
  globalCommandPath,
  installStatusPath,
  installUpdate,
  downloadUpdatePackage,
  isElectronRuntimeReady,
  launchInstalledApp,
  manualInstallCommand,
  parseUpdateManifest,
  readUpdatePreference,
  readInstallStatus,
  recoverInterruptedUpdate,
  releaseUrl,
  skipUpdateVersion,
  snoozeUpdatePrompt,
  showNativeUpdateFailure,
  stageUpdate,
  stateDirectory,
  stopRunningApp,
  updateLockPath,
  updatePreferencePath,
  waitForUpdateCompletion,
  waitForProcessExit,
  writeAppProcess,
  writeJsonAtomic,
  writeUpdatePreference,
};
