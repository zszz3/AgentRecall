"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const lockfile = require("proper-lockfile");

const MAX_RESPONSE_BYTES = 1024 * 1024;
const START_TIMEOUT_MS = 120_000;
const UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"]);

function userDataDirectory(options, homeDir) {
  if (options.userDataPath || process.env.AGENT_RECALL_USER_DATA_DIR) {
    return path.resolve(options.userDataPath || process.env.AGENT_RECALL_USER_DATA_DIR);
  }
  if (process.env.AGENT_RECALL_APP_DATA_DIR) return path.resolve(process.env.AGENT_RECALL_APP_DATA_DIR, "agent-recall-v2");
  if (process.platform === "darwin") return path.join(homeDir, "Library", "Application Support", "agent-recall-v2");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "agent-recall-v2");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "agent-recall-v2");
}

async function discoveryAt(discoveryPath) {
  let file;
  try {
    file = await fsp.open(discoveryPath, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error("Invalid session backend discovery file or permissions.");
    }
    let value;
    try {
      value = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new Error("Invalid session backend discovery JSON; inspect or remove the stale discovery file before retrying.");
    }
    if (!value || value.protocolVersion !== 1 || value.host !== "127.0.0.1"
      || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.token !== "string" || !/^[a-f0-9]{64}$/i.test(value.token)
      || typeof value.packagePath !== "string" || !path.isAbsolute(value.packagePath)
      || typeof value.appVersion !== "string" || !value.appVersion.trim()) {
      throw new Error("Invalid session backend discovery configuration; only the authenticated local backend is supported.");
    }
    return value;
  } finally {
    await file.close();
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function request(discovery, action, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const encoded = JSON.stringify(body);
    const req = http.request({
      host: discovery.host,
      port: discovery.port,
      path: `/session/${action}`,
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(encoded),
      },
    }, (response) => {
      let size = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          const error = new Error("Session backend response exceeds the 1 MiB limit.");
          finish(error);
          response.destroy();
          req.destroy();
        } else chunks.push(chunk);
      });
      response.on("error", (error) => finish(error));
      response.on("end", () => {
        if (settled) return;
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          finish(new Error(`Session backend returned invalid JSON (HTTP ${response.statusCode}).`));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const detail = typeof value?.error === "string" ? value.error.split(discovery.token).join("[redacted]") : "Request failed";
          finish(new Error(`Session backend HTTP ${response.statusCode}: ${detail}`));
          return;
        }
        finish(null, value);
      });
    });
    const timer = setTimeout(() => {
      const error = new Error(`Session backend request timed out after ${timeoutMs} ms.`);
      error.code = "ETIMEDOUT";
      finish(error);
      req.destroy();
    }, timeoutMs);
    req.on("error", (error) => finish(error));
    req.end(encoded);
  });
}

async function waitForStopped(discovery, discoveryPath, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  while (Date.now() < deadline) {
    const current = await discoveryAt(discoveryPath);
    if (!processIsAlive(discovery.pid) && (!current || current.token !== discovery.token)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Session backend shutdown did not complete; its process or discovery file remains. Inspect session-backend.log before retrying.");
}

/** Holds off cold starts while the updater/uninstaller changes the installed package. */
async function acquireSessionBackendMaintenance(options = {}) {
  const homeDir = path.resolve(options.homeDir || process.env.AGENT_RECALL_HOME_DIR || os.homedir());
  const userDataPath = userDataDirectory(options, homeDir);
  await fsp.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path.join(userDataPath, "session-backend-start"), {
    realpath: false,
    retries: { retries: 300, factor: 1, minTimeout: 100, maxTimeout: 100 },
  });
  try {
    await requestSessionBackend("stop", {}, { ...options, homeDir, userDataPath, start: false });
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

async function requestSessionBackend(action, body = {}, options = {}) {
  if (typeof action !== "string" || !/^[a-z][a-z0-9-]*$/.test(action)) throw new Error("Invalid session backend action.");
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Session backend timeout must be positive.");
  const homeDir = path.resolve(options.homeDir || process.env.AGENT_RECALL_HOME_DIR || os.homedir());
  const userDataPath = userDataDirectory(options, homeDir);
  const packagePath = await fsp.realpath(path.resolve(options.packagePath || path.join(__dirname, "..")));
  const appVersion = JSON.parse(await fsp.readFile(path.join(packagePath, "package.json"), "utf8")).version;
  const discoveryPath = path.join(userDataPath, "session-backend.json");

  async function available() {
    const discovery = await discoveryAt(discoveryPath);
    if (!discovery || !processIsAlive(discovery.pid)) return null;
    // Explicit lifecycle commands must remain usable after an in-place upgrade.
    if (action !== "status" && action !== "stop") {
      let ownerPackagePath;
      try { ownerPackagePath = await fsp.realpath(discovery.packagePath); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (ownerPackagePath !== packagePath || discovery.appVersion !== appVersion) {
        throw new Error("A different AgentRecall package or version owns the running session backend. Stop the session backend before switching or upgrading packages.");
      }
    }
    try {
      const status = await request(discovery, "status", {}, Math.min(timeoutMs, 5_000));
      if (status?.running !== true || status.protocolVersion !== 1 || status.pid !== discovery.pid) {
        throw new Error("Session backend returned an invalid status response.");
      }
      return discovery;
    } catch (error) {
      if (UNREACHABLE.has(error.code)) return null;
      throw error;
    }
  }

  let discovery = await available();
  if (!discovery && options.start === false) {
    if (action === "status" || action === "stop") return { running: false };
    throw new Error("Session backend is not running.");
  }
  if (!discovery) {
    await fsp.mkdir(userDataPath, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + START_TIMEOUT_MS;
    const release = await lockfile.lock(path.join(userDataPath, "session-backend-start"), {
      realpath: false,
      retries: { retries: 1200, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
    try {
      discovery = await available();
      // After a crash, proper-lockfile's owner lease can outlive the dead PID
      // briefly. Wait for expiry instead of spawning a child that must fail.
      while (!discovery && await lockfile.check(path.join(userDataPath, "session-backend-owner"), { realpath: false })) {
        if (Date.now() >= deadline) throw new Error("Session backend ownership is still held but it is not ready. Inspect session-backend.log before retrying.");
        await new Promise((resolve) => setTimeout(resolve, 100));
        discovery = await available();
      }
      if (!discovery) {
        const entryPath = path.join(packagePath, "out", "main", "session-backend-entry.js");
        await fsp.access(entryPath);
        // npm/electron-vite development also needs a real Node executable.
        const nodePath = options.nodePath || process.env.AGENT_RECALL_NODE_PATH || process.env.npm_node_execpath || (!process.versions.electron ? process.execPath : "node");
        const logPath = path.join(userDataPath, "session-backend.log");
        const logFd = fs.openSync(logPath, "a", 0o600);
        if (process.platform !== "win32") fs.fchmodSync(logFd, 0o600);
        const env = { ...process.env, AGENT_RECALL_USER_DATA_DIR: userDataPath, AGENT_RECALL_SESSION_HOME: homeDir };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.AGENT_RECALL_SESSION_DESKTOP_PID;
        if (Number.isSafeInteger(options.desktopPid) && options.desktopPid > 0) env.AGENT_RECALL_SESSION_DESKTOP_PID = String(options.desktopPid);
        let child;
        try {
          child = spawn(nodePath, [entryPath], { cwd: packagePath, env, detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
        } finally {
          fs.closeSync(logFd);
        }
        let exited = false;
        let childError;
        child.once("exit", () => { exited = true; });
        child.on("error", (error) => { childError = error; });
        child.unref();
        try {
          while (!discovery) {
            if (childError || exited) throw new Error(`Session backend exited before becoming ready. See ${logPath}.`);
            if (Date.now() >= deadline) throw new Error(`Session backend did not become ready within 120 seconds. See ${logPath}.`);
            discovery = await available();
            if (!discovery) await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error) {
          if (!exited && child.pid) child.kill("SIGTERM");
          throw error;
        }
      }
    } finally {
      await release();
    }
  }
  const result = await request(discovery, action, body, timeoutMs);
  if (action === "stop") {
    if (result?.stopped !== true) throw new Error("Session backend returned an invalid shutdown response.");
    await waitForStopped(discovery, discoveryPath, timeoutMs);
  }
  return result;
}

module.exports = { requestSessionBackend, acquireSessionBackendMaintenance };
