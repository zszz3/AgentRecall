import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapApplicationPaths, type ApplicationPathApi } from "./app-path-bootstrap";

const testRoots: string[] = [];

function testRoot(): string {
  const root = path.join(os.tmpdir(), `agent-recall-path-test-${process.pid}-${testRoots.length}`);
  mkdirSync(root, { recursive: true });
  testRoots.push(root);
  return root;
}

function fakeApp(paths: Partial<Record<"home" | "appData" | "userData" | "temp", string | Error>>): {
  app: ApplicationPathApi;
  configured: Map<string, string>;
} {
  const configured = new Map<string, string>();
  return {
    configured,
    app: {
      getPath(name) {
        const value = paths[name];
        if (value instanceof Error) throw value;
        if (!value) throw new Error(`missing ${name}`);
        return value;
      },
      setPath(name, value) {
        configured.set(name, value);
      },
    },
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bootstrapApplicationPaths", () => {
  it("registers validated Electron paths before application services are constructed", () => {
    const root = testRoot();
    const paths = {
      home: path.join(root, "home"),
      appData: path.join(root, "appdata"),
      userData: path.join(root, "appdata", "AgentRecall"),
      temp: path.join(root, "temp"),
    };
    const { app, configured } = fakeApp(paths);

    expect(bootstrapApplicationPaths({ app, productName: "AgentRecall" })).toEqual(paths);
    expect(Object.fromEntries(configured)).toEqual(paths);
    expect(Object.values(paths).every(existsSync)).toBe(true);
  });

  it("falls back to stable Windows paths when Electron path resolution fails", () => {
    const root = testRoot();
    const home = path.join(root, "profile");
    const appData = path.join(root, "roaming");
    const temp = path.join(root, "temp");
    const { app, configured } = fakeApp({
      home: new Error("home unavailable"),
      appData: new Error("appData unavailable"),
      userData: new Error("userData unavailable"),
      temp: new Error("temp unavailable"),
    });
    const warn = vi.fn();

    const result = bootstrapApplicationPaths({
      app,
      productName: "AgentRecall",
      platform: "win32",
      env: { USERPROFILE: home, APPDATA: appData, TEMP: temp },
      homedir: () => home,
      tmpdir: () => temp,
      warn,
    });

    expect(result).toEqual({ home, appData, userData: path.join(appData, "AgentRecall"), temp });
    expect(Object.fromEntries(configured)).toEqual(result);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("honors an explicit user-data recovery path", () => {
    const root = testRoot();
    const { app } = fakeApp({
      home: path.join(root, "home"),
      appData: path.join(root, "appdata"),
      userData: new Error("broken shell path"),
      temp: path.join(root, "temp"),
    });
    const override = path.join(root, "recovery-data");

    const result = bootstrapApplicationPaths({
      app,
      productName: "AgentRecall",
      env: { AGENT_RECALL_USER_DATA_DIR: override },
      warn: vi.fn(),
    });

    expect(result.userData).toBe(override);
    expect(existsSync(override)).toBe(true);
  });

  it("migrates legacy data before creating a new user-data directory", () => {
    const root = testRoot();
    const appData = path.join(root, "appdata");
    const legacy = path.join(appData, "Agent-Session-Search");
    const userData = path.join(appData, "AgentRecall");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "settings.json"), "legacy", "utf8");
    const { app } = fakeApp({
      home: path.join(root, "home"),
      appData,
      userData,
      temp: path.join(root, "temp"),
    });

    bootstrapApplicationPaths({
      app,
      productName: "AgentRecall",
      legacyProductNames: ["Agent-Session-Search", "agent-session-search"],
    });

    expect(readFileSync(path.join(userData, "settings.json"), "utf8")).toBe("legacy");
  });

  it("fails with an actionable error instead of silently writing data into the working directory", () => {
    const { app } = fakeApp({
      home: new Error("home unavailable"),
      appData: new Error("appData unavailable"),
      userData: new Error("userData unavailable"),
      temp: new Error("temp unavailable"),
    });

    expect(() => bootstrapApplicationPaths({
      app,
      productName: "AgentRecall",
      env: {},
      homedir: () => "",
      tmpdir: () => "",
      warn: vi.fn(),
    })).toThrow("could not resolve a stable home directory");
  });
});
