import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const preloadConfigSource = readFileSync(
  new URL("../../electron.vite.config.ts", import.meta.url),
  "utf8",
);
const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const launcherSource = readFileSync(
  new URL("../../start.sh", import.meta.url),
  "utf8",
);

describe("Core production bootstrap", () => {
  it("starts only the Core application boundary", () => {
    expect(mainSource).toContain('from "./ipc/core"');
    expect(mainSource).not.toContain("legacy-application");
    for (const forbidden of [
      "ProviderService",
      "RemoteSessionService",
      "RemoteEnvironmentLifecycle",
      "RemoteWatchManager",
      "SkillService",
      "session-summarizer",
      "session-sync-queue",
      "setup-mcp",
      "writeDbPointer",
      "ensureAgentRecallMcpPreference",
    ]) {
      expect(mainSource).not.toContain(forbidden);
    }
  });

  it("keeps the renderer sandboxed and the preload fully bundled as CJS", () => {
    expect(mainSource).toContain("app.enableSandbox()");
    expect(mainSource).toContain(
      'preload: path.join(__dirname, "../preload/index.cjs")',
    );
    expect(mainSource).toMatch(/sandbox:\s*true/);
    expect(mainSource).toMatch(/contextIsolation:\s*true/);
    expect(mainSource).toMatch(/nodeIntegration:\s*false/);
    expect(preloadConfigSource).toMatch(/format:\s*"cjs"/);
    expect(preloadConfigSource).toMatch(/inlineDynamicImports:\s*true/);
    const preloadBlock =
      preloadConfigSource.match(/preload:\s*\{([\s\S]*?)\n\s*\},\n\s*renderer:/)?.[1]
      ?? "";
    expect(preloadBlock).not.toContain("externalizeDepsPlugin");
  });

  it("guards every production Core IPC handler with the trusted sender boundary", () => {
    expect(mainSource).toContain("createTrustedCoreIpcRegistrar()");
    expect(mainSource).toContain("isTrustedCoreIpcSender(");
    expect(mainSource).toContain("Rejected untrusted Core IPC sender");
    expect(mainSource).toMatch(
      /registerCoreIpc\(createTrustedCoreIpcRegistrar\(\),/,
    );
  });

  it("scopes indexing without pruning and starts it only after a usable window", () => {
    expect(mainSource).toContain("allowedSources: CORE_SESSION_SOURCES");
    expect(mainSource).toContain("pruneMissingSessions: false");
    expect(mainSource).not.toContain("deleteSessionsBySource");
    expect(mainSource).toMatch(
      /async function runIndexSync[\s\S]*if \(!firstWindowAvailable\) return indexStatus;/,
    );
    expect(mainSource).toMatch(
      /function markWindowAvailable[\s\S]*firstWindowAvailable = true;[\s\S]*startCoreBackgroundAfterFirstWindow\(\)/,
    );
    expect(mainSource).toMatch(
      /function startCoreBackgroundAfterFirstWindow[\s\S]*scheduleInitialCheck\(\)[\s\S]*setTimeout\([\s\S]*runIndexSync/,
    );
  });

  it("creates a visible window before opening the local database", () => {
    expect(mainSource).toMatch(/backgroundColor:[\s\S]*show:\s*true|show:\s*true[\s\S]*backgroundColor:/);
    const readyBlock = mainSource.slice(mainSource.indexOf("void app.whenReady().then"));
    expect(readyBlock.indexOf("createWindow()")).toBeGreaterThanOrEqual(0);
    expect(readyBlock.indexOf("createWindow()")).toBeLessThan(
      readyBlock.indexOf("new SessionStore("),
    );
  });

  it("has no automatic npm install lifecycle or launcher MCP setup", () => {
    for (const lifecycle of ["preinstall", "install", "postinstall"]) {
      expect(packageManifest.scripts).not.toHaveProperty(lifecycle);
    }
    expect(launcherSource).not.toContain("SETUP_MCP=");
    expect(launcherSource).not.toContain('"$SETUP_MCP"');
    expect(launcherSource).toContain("out/preload/index.cjs");
  });
});
