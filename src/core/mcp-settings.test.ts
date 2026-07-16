import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpAppSettings, resolveMcpConfigPath } from "./mcp-settings";

describe("resolveMcpConfigPath", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-settings-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(filePath: string, contents = "{}") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
  }

  it("always prefers an explicit config override", () => {
    const override = path.join(root, "explicit.json");
    expect(resolveMcpConfigPath({
      platform: "linux",
      home: root,
      env: { AGENT_RECALL_CONFIG: `  ${override}  `, XDG_CONFIG_HOME: path.join(root, "xdg") },
    })).toBe(override);
  });

  it("resolves the packaged macOS Electron userData directory before the legacy name", () => {
    const packaged = path.join(root, "Library", "Application Support", "AgentRecall", "config.json");
    const legacy = path.join(root, "Library", "Application Support", "agent-recall", "config.json");
    touch(legacy);
    touch(packaged);
    expect(resolveMcpConfigPath({ platform: "darwin", home: root, env: {} })).toBe(packaged);
  });

  it("resolves the packaged Electron app name under Windows APPDATA", () => {
    const appData = path.join(root, "Roaming");
    const packaged = path.join(appData, "AgentRecall", "config.json");
    touch(packaged);
    expect(resolveMcpConfigPath({ platform: "win32", home: root, env: { APPDATA: appData } })).toBe(packaged);
  });

  it("falls back from empty or missing Windows APPDATA to home AppData/Roaming", () => {
    const home = path.join(root, "user");
    const packaged = path.join(home, "AppData", "Roaming", "AgentRecall", "config.json");
    touch(packaged);
    expect(resolveMcpConfigPath({ platform: "win32", home, env: { APPDATA: "  " } })).toBe(packaged);
  });

  it("resolves Linux XDG_CONFIG_HOME and falls back to ~/.config when its config is absent", () => {
    const xdg = path.join(root, "xdg");
    const fallback = path.join(root, ".config", "AgentRecall", "config.json");
    touch(fallback);
    expect(resolveMcpConfigPath({ platform: "linux", home: root, env: { XDG_CONFIG_HOME: xdg } })).toBe(fallback);
    const xdgConfig = path.join(xdg, "AgentRecall", "config.json");
    touch(xdgConfig);
    expect(resolveMcpConfigPath({ platform: "linux", home: root, env: { XDG_CONFIG_HOME: xdg } })).toBe(xdgConfig);
  });

  it("returns null when no platform candidate exists", () => {
    expect(resolveMcpConfigPath({ platform: "linux", home: root, env: {} })).toBeNull();
  });

  it("loads a Windows GUI optional-source switch from APPDATA", () => {
    const appData = path.join(root, "Roaming");
    const configPath = path.join(appData, "AgentRecall", "config.json");
    touch(configPath, JSON.stringify({ includeTcodex: true }));
    expect(readMcpAppSettings({ platform: "win32", home: root, env: { APPDATA: appData } }).includeTcodex).toBe(true);
  });
});
