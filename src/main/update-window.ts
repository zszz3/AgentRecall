import { app, BrowserWindow } from "electron";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { AppUpdateManifest, AppUpdateProgress } from "../core/app-update-types";
import { APP_UPDATE_EVENTS } from "../shared/ipc/app-update";
import {
  runDetachedUpdate,
  type StagedAppUpdate,
} from "./services/detached-update-window";

interface UpdateClient {
  formatUpdateError(error: unknown): string;
  launchInstalledApp(): unknown;
  parseUpdateManifest(value: unknown): AppUpdateManifest;
  showNativeUpdateFailure(errorMessage: string): boolean;
  stageUpdate(
    manifest: AppUpdateManifest,
    options: {
      nodePath: string;
      onProgress(progress: AppUpdateProgress): void;
    },
  ): Promise<StagedAppUpdate>;
  waitForProcessExit(pid: number, timeoutMs?: number): Promise<void>;
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argumentValue(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredProcessId(name: string): number {
  const value = Number(requiredArgument(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive process id.`);
  return value;
}

function loadUpdateClient(): UpdateClient {
  const requireCjs = createRequire(import.meta.url);
  return requireCjs(path.join(__dirname, "../../bin/update-client.cjs")) as UpdateClient;
}

async function createUpdateWindow(version: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 520,
    height: 330,
    minWidth: 520,
    minHeight: 330,
    maxWidth: 520,
    maxHeight: 330,
    resizable: false,
    maximizable: false,
    minimizable: true,
    closable: false,
    fullscreenable: false,
    show: false,
    title: "AgentRecall 更新",
    backgroundColor: "#f7f9fc",
    webPreferences: {
      preload: path.join(__dirname, "../preload/update-progress.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const loaded = new Promise<void>((resolve, reject) => {
    window.webContents.once("did-finish-load", () => resolve());
    window.webContents.once("did-fail-load", (_event, code, description) => {
      reject(new Error(`Update window failed to load (${code}): ${description}`));
    });
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL("update-progress.html", process.env.ELECTRON_RENDERER_URL);
    url.searchParams.set("version", version);
    await window.loadURL(url.toString());
  } else {
    await window.loadFile(path.join(__dirname, "../renderer/update-progress.html"), {
      query: { version },
    });
  }
  await loaded;
  window.show();
  return window;
}

async function main(): Promise<void> {
  const manifestPath = requiredArgument("--manifest");
  const mainProcessId = requiredProcessId("--wait-pid");
  const stableNodePath = process.env.AGENT_RECALL_NODE_PATH;
  const applyUpdatePath = process.env.AGENT_RECALL_APPLY_UPDATE_PATH;
  if (!stableNodePath) throw new Error("AGENT_RECALL_NODE_PATH is required.");
  if (!applyUpdatePath) throw new Error("AGENT_RECALL_APPLY_UPDATE_PATH is required.");

  const client = loadUpdateClient();
  const manifest = client.parseUpdateManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  const window = await createUpdateWindow(manifest.version);
  const publishProgress = (progress: AppUpdateProgress): void => {
    if (!window.isDestroyed()) window.webContents.send(APP_UPDATE_EVENTS.progress, progress);
  };
  publishProgress({ phase: "downloading", version: manifest.version, percent: 0 });

  try {
    await runDetachedUpdate({
      manifest,
      manifestPath,
      mainProcessId,
      updaterProcessId: process.pid,
      stableNodePath,
      applyUpdatePath,
      waitForProcessExit: client.waitForProcessExit,
      stageUpdate: client.stageUpdate,
      publishProgress,
      formatUpdateError: client.formatUpdateError,
      showNativeUpdateFailure: client.showNativeUpdateFailure,
      launchInstalledApp: client.launchInstalledApp,
    });
  } catch {
    process.exitCode = 1;
  }
}

async function handleBootstrapFailure(error: unknown): Promise<void> {
  console.error("AgentRecall updater failed to start:", error);
  const manifestPath = argumentValue("--manifest");
  try {
    const client = loadUpdateClient();
    const mainProcessId = Number(argumentValue("--wait-pid"));
    if (Number.isInteger(mainProcessId) && mainProcessId > 0) {
      await client.waitForProcessExit(mainProcessId, 30_000).catch(() => undefined);
    }
    const message = client.formatUpdateError(error);
    client.showNativeUpdateFailure(message);
    try {
      client.launchInstalledApp();
    } catch {
      // The user can still launch the unchanged installation manually.
    }
  } catch (fallbackError) {
    console.error("AgentRecall updater fallback failed:", fallbackError);
  }
  if (manifestPath) {
    await fs.rm(path.dirname(manifestPath), { recursive: true, force: true }).catch(() => undefined);
  }
  process.exitCode = 1;
}

app.setName("AgentRecall Updater");
void app.whenReady().then(async () => {
  try {
    await main();
    app.quit();
  } catch (error) {
    await handleBootstrapFailure(error);
    app.quit();
  }
});
