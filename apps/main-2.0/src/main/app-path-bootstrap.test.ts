import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapApplicationPaths, type ApplicationPathApi } from "./app-path-bootstrap";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeApp(defaults: Record<string, string>): ApplicationPathApi & { paths: Map<string, string> } {
  const paths = new Map(Object.entries(defaults));
  return {
    paths,
    getPath(name) {
      const value = paths.get(name);
      if (!value) throw new Error(`Missing ${name}`);
      return value;
    },
    setPath(name, value) {
      paths.set(name, value);
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("bootstrapApplicationPaths", () => {
  it("keeps HOME, app data, user data, and temp inside explicit test roots", () => {
    const root = temporaryDirectory("agent-recall-v2-paths-");
    const app = fakeApp({
      home: "/real/home",
      appData: "/real/app-data",
      userData: "/real/user-data",
      temp: "/real/temp",
    });

    const paths = bootstrapApplicationPaths({
      app,
      userDataName: "agent-recall-v2",
      env: {
        AGENT_RECALL_HOME_DIR: path.join(root, "home"),
        AGENT_RECALL_APP_DATA_DIR: path.join(root, "app-data"),
        AGENT_RECALL_USER_DATA_DIR: path.join(root, "user-data"),
        AGENT_RECALL_TEMP_DIR: path.join(root, "temp"),
      },
      platform: "darwin",
    });

    expect(paths).toEqual({
      home: path.join(root, "home"),
      appData: path.join(root, "app-data"),
      userData: path.join(root, "user-data"),
      temp: path.join(root, "temp"),
    });
    expect(Object.values(paths).every((value) => fs.statSync(value).isDirectory())).toBe(true);
    expect(app.paths.get("userData")).toBe(paths.userData);
  });

  it.each([
    ["darwin", ["Library", "Application Support"]],
    ["win32", ["AppData", "Roaming"]],
    ["linux", [".config"]],
  ] as const)("rebases app data and retains the internal data name with an isolated HOME on %s", (platform, parts) => {
    const root = temporaryDirectory("agent-recall-v2-home-");
    const app = fakeApp({
      home: "/real/home",
      appData: "/real/app-data",
      userData: "/real/user-data",
      temp: path.join(root, "temp"),
    });

    const paths = bootstrapApplicationPaths({
      app,
      userDataName: "agent-recall-v2",
      env: { AGENT_RECALL_HOME_DIR: root },
      platform,
    });

    expect(paths.appData).toBe(path.join(root, ...parts));
    expect(paths.userData).toBe(path.join(paths.appData, "agent-recall-v2"));
  });

  it("keeps existing V2 settings, database and credentials when Electron defaults to the new display name", () => {
    const root = temporaryDirectory("agent-recall-v2-display-name-");
    const appData = path.join(root, "app-data");
    const userData = path.join(appData, "agent-recall-v2");
    const displayNameData = path.join(appData, "AgentRecall");
    const fixtures = {
      "config.json": '{"theme":"dark"}',
      "ssh-credentials.json": '{"synthetic":"unchanged-fixture"}',
      "postgres/data/PG_VERSION": "18\n",
    };
    for (const [name, content] of Object.entries(fixtures)) {
      const filename = path.join(userData, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    }
    const app = fakeApp({ home: root, appData, userData: displayNameData, temp: path.join(root, "temp") });

    const paths = bootstrapApplicationPaths({ app, userDataName: "agent-recall-v2", env: {}, platform: "darwin" });

    expect(paths.userData).toBe(userData);
    expect(app.paths.get("userData")).toBe(userData);
    expect(fs.existsSync(displayNameData)).toBe(false);
    for (const [name, content] of Object.entries(fixtures)) {
      expect(fs.readFileSync(path.join(paths.userData, name), "utf8")).toBe(content);
    }
  });

  it("uses the internal data name under an explicit app-data directory", () => {
    const root = temporaryDirectory("agent-recall-v2-app-data-");
    const appData = path.join(root, "selected-app-data");
    const app = fakeApp({
      home: root,
      appData: path.join(root, "default-app-data"),
      userData: path.join(root, "AgentRecall"),
      temp: path.join(root, "temp"),
    });

    const paths = bootstrapApplicationPaths({
      app,
      userDataName: "agent-recall-v2",
      env: { AGENT_RECALL_APP_DATA_DIR: appData },
      platform: "darwin",
    });

    expect(paths.appData).toBe(appData);
    expect(paths.userData).toBe(path.join(appData, "agent-recall-v2"));
  });

  it("migrates legacy data only inside the selected app-data root", () => {
    const root = temporaryDirectory("agent-recall-v2-legacy-");
    const appData = path.join(root, "app-data");
    const legacy = path.join(appData, "Agent-Session-Search");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "config.json"), "legacy");
    const app = fakeApp({ home: root, appData, userData: "/real/user-data", temp: path.join(root, "temp") });

    const paths = bootstrapApplicationPaths({
      app,
      userDataName: "AgentRecall",
      legacyProductNames: ["Agent-Session-Search"],
      env: {
        AGENT_RECALL_HOME_DIR: root,
        AGENT_RECALL_APP_DATA_DIR: appData,
        AGENT_RECALL_TEMP_DIR: path.join(root, "temp"),
      },
      platform: "darwin",
    });

    expect(paths.userData).toBe(path.join(appData, "AgentRecall"));
    expect(fs.readFileSync(path.join(paths.userData, "config.json"), "utf8")).toBe("legacy");
  });
});
