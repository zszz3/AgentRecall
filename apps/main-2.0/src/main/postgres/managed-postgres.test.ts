import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startPostgresRuntime,
  type EmbeddedPostgresInstance,
  type EmbeddedPostgresOptions,
} from "./managed-postgres";

const temporaryDirectories: string[] = [];
const moduleRequire = createRequire(import.meta.url);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryUserData(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-postgres-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeDataVersion(userDataPath: string, version = "18"): Promise<void> {
  const dataDirectory = path.join(userDataPath, "postgres", "data");
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(path.join(dataDirectory, "PG_VERSION"), `${version}\n`);
}

class FakeEmbeddedPostgres implements EmbeddedPostgresInstance {
  readonly initialise = vi.fn(async () => undefined);
  readonly start = vi.fn(async () => undefined);
  readonly createDatabase = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
}

describe("startPostgresRuntime", () => {
  it("uses an external PostgreSQL URL without starting a managed server", async () => {
    const createEmbedded = vi.fn();
    const probeExistingRuntime = vi.fn();
    const resolveEmbeddedRuntime = vi.fn();
    const stopExistingRuntime = vi.fn();
    const runtime = await startPostgresRuntime({
      userDataPath: await temporaryUserData(),
      environment: {
        AGENT_RECALL_DATABASE_URL: "postgresql://agent:secret@db.example/recall",
      },
      createEmbedded,
      probeExistingRuntime,
      resolveEmbeddedRuntime,
      stopExistingRuntime,
    });

    expect(runtime.connectionUrl).toBe("postgresql://agent:secret@db.example/recall");
    expect(runtime.managed).toBe(false);
    expect(createEmbedded).not.toHaveBeenCalled();
    expect(probeExistingRuntime).not.toHaveBeenCalled();
    expect(resolveEmbeddedRuntime).not.toHaveBeenCalled();
    expect(stopExistingRuntime).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("initializes a persistent loopback-only PostgreSQL cluster and reuses its credentials", async () => {
    const userDataPath = await temporaryUserData();
    const instances: FakeEmbeddedPostgres[] = [];
    const options: EmbeddedPostgresOptions[] = [];
    const createEmbedded = vi.fn((input: EmbeddedPostgresOptions) => {
      options.push(input);
      const instance = new FakeEmbeddedPostgres();
      instances.push(instance);
      return instance;
    });

    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
      choosePort: async () => 55439,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    await writeDataVersion(userDataPath);
    const second = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
      probeExistingRuntime: async () => null,
      resolveEmbeddedRuntime: async () => ({
        pgCtlPath: path.join(userDataPath, "runtime", "bin", "pg_ctl"),
        libraryDirectory: path.join(userDataPath, "runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
      choosePort: async () => 59999,
      createPassword: () => "must-not-replace-secret",
    });

    expect(first.connectionUrl).toBe("postgresql://agent_recall:local-test-secret@127.0.0.1:55439/agent_recall");
    expect(second.connectionUrl).toBe(first.connectionUrl);
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      databaseDir: path.join(userDataPath, "postgres", "data"),
      user: "agent_recall",
      password: "local-test-secret",
      port: 55439,
      persistent: true,
    });
    expect(instances[0]?.initialise).toHaveBeenCalledOnce();
    expect(instances[0]?.start).toHaveBeenCalledOnce();
    expect(instances[0]?.createDatabase).toHaveBeenCalledWith("agent_recall");
    expect(instances[0]?.stop).toHaveBeenCalledOnce();

    const credentialsPath = path.join(userDataPath, "postgres", "runtime.json");
    const mode = (await fs.stat(credentialsPath)).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    await second.stop();
  });

  it("reuses a healthy managed server left running by an earlier app process", async () => {
    const userDataPath = await temporaryUserData();
    const firstInstance = new FakeEmbeddedPostgres();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => firstInstance,
      choosePort: async () => 55441,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    await writeDataVersion(userDataPath);

    const createEmbedded = vi.fn();
    const libraryDirectory = path.join(userDataPath, "runtime", "lib", "postgresql");
    const probeExistingRuntime = vi.fn(async () => ({
      dataDirectory: path.join(userDataPath, "postgres", "data"),
      libraryDirectory,
      majorVersion: 18,
    }));
    const resolveEmbeddedRuntime = vi.fn(async () => ({
      pgCtlPath: path.join(userDataPath, "runtime", "bin", "pg_ctl"),
      libraryDirectory,
      majorVersion: 18,
    }));
    const stopExistingRuntime = vi.fn(async () => undefined);
    const reused = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
      probeExistingRuntime,
      resolveEmbeddedRuntime,
      stopExistingRuntime,
    });

    expect(probeExistingRuntime).toHaveBeenCalledWith(first.connectionUrl);
    expect(resolveEmbeddedRuntime).toHaveBeenCalledOnce();
    expect(stopExistingRuntime).not.toHaveBeenCalled();
    expect(createEmbedded).not.toHaveBeenCalled();
    expect(reused.connectionUrl).toBe(first.connectionUrl);
    expect(reused.managed).toBe(true);
    await reused.stop();
    expect(firstInstance.stop).toHaveBeenCalledOnce();
  });

  it("resolves the installed platform runtime layout before reusing a live server", async () => {
    const userDataPath = await temporaryUserData();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => new FakeEmbeddedPostgres(),
      choosePort: async () => 55447,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    await writeDataVersion(userDataPath);

    const runtimePackages: Partial<Record<NodeJS.Platform, Record<string, string>>> = {
      darwin: {
        arm64: "@embedded-postgres/darwin-arm64",
        x64: "@embedded-postgres/darwin-x64",
      },
      linux: {
        arm: "@embedded-postgres/linux-arm",
        arm64: "@embedded-postgres/linux-arm64",
        ia32: "@embedded-postgres/linux-ia32",
        ppc64: "@embedded-postgres/linux-ppc64",
        x64: "@embedded-postgres/linux-x64",
      },
      win32: {
        x64: "@embedded-postgres/windows-x64",
      },
    };
    const packageName = runtimePackages[process.platform]?.[process.arch];
    expect(packageName).toBeTruthy();
    const entryPath = moduleRequire.resolve(packageName!);
    const runtimeRoot = path.resolve(path.dirname(entryPath), "..");
    const libraryDirectory = process.platform === "win32"
      ? path.join(runtimeRoot, "native", "lib")
      : path.join(runtimeRoot, "native", "lib", "postgresql");
    const createEmbedded = vi.fn();

    const reused = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
      probeExistingRuntime: async () => ({
        dataDirectory: path.join(userDataPath, "postgres", "data"),
        libraryDirectory,
        majorVersion: 18,
      }),
    });

    expect(createEmbedded).not.toHaveBeenCalled();
    expect(reused.connectionUrl).toBe(first.connectionUrl);
    await reused.stop();
  });

  it("restarts the same cluster with the current runtime when the previous library path moved", async () => {
    const userDataPath = await temporaryUserData();
    const firstInstance = new FakeEmbeddedPostgres();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => firstInstance,
      choosePort: async () => 55443,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    const dataDirectory = path.join(userDataPath, "postgres", "data");
    await writeDataVersion(userDataPath);
    const sentinelPath = path.join(dataDirectory, "keep-existing-data");
    await fs.writeFile(sentinelPath, "preserved");

    const replacement = new FakeEmbeddedPostgres();
    const createEmbedded = vi.fn(() => replacement);
    const stopExistingRuntime = vi.fn(async () => undefined);
    const runtime = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
      probeExistingRuntime: async () => ({
        dataDirectory,
        libraryDirectory: path.join(userDataPath, "deleted-worktree", "lib", "postgresql"),
        majorVersion: 18,
      }),
      resolveEmbeddedRuntime: async () => ({
        pgCtlPath: path.join(userDataPath, "current-runtime", "bin", "pg_ctl"),
        libraryDirectory: path.join(userDataPath, "current-runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
      stopExistingRuntime,
    });

    expect(stopExistingRuntime).toHaveBeenCalledWith({
      pgCtlPath: path.join(userDataPath, "current-runtime", "bin", "pg_ctl"),
      dataDirectory,
    });
    expect(stopExistingRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      createEmbedded.mock.invocationCallOrder[0],
    );
    expect(replacement.initialise).not.toHaveBeenCalled();
    expect(replacement.start).toHaveBeenCalledOnce();
    expect(replacement.createDatabase).not.toHaveBeenCalled();
    expect(await fs.readFile(sentinelPath, "utf8")).toBe("preserved");
    await runtime.stop();
    expect(replacement.stop).toHaveBeenCalledOnce();
  });

  it("refuses to stop a server whose data directory is not owned by this app", async () => {
    const userDataPath = await temporaryUserData();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => new FakeEmbeddedPostgres(),
      choosePort: async () => 55444,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    await writeDataVersion(userDataPath);
    const createEmbedded = vi.fn();
    const stopExistingRuntime = vi.fn();

    await expect(startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
      probeExistingRuntime: async () => ({
        dataDirectory: path.join(userDataPath, "some-other-cluster"),
        libraryDirectory: path.join(userDataPath, "old-runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
      resolveEmbeddedRuntime: async () => ({
        pgCtlPath: path.join(userDataPath, "current-runtime", "bin", "pg_ctl"),
        libraryDirectory: path.join(userDataPath, "current-runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
      stopExistingRuntime,
    })).rejects.toThrow("unexpected data directory");
    expect(stopExistingRuntime).not.toHaveBeenCalled();
    expect(createEmbedded).not.toHaveBeenCalled();
  });

  it("refuses to restart a stale server with a different PostgreSQL major version", async () => {
    const userDataPath = await temporaryUserData();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => new FakeEmbeddedPostgres(),
      choosePort: async () => 55446,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    const dataDirectory = path.join(userDataPath, "postgres", "data");
    await writeDataVersion(userDataPath);
    const createEmbedded = vi.fn();
    const stopExistingRuntime = vi.fn();

    await expect(startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
      probeExistingRuntime: async () => ({
        dataDirectory,
        libraryDirectory: path.join(userDataPath, "old-runtime", "lib", "postgresql"),
        majorVersion: 17,
      }),
      resolveEmbeddedRuntime: async () => ({
        pgCtlPath: path.join(userDataPath, "current-runtime", "bin", "pg_ctl"),
        libraryDirectory: path.join(userDataPath, "current-runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
      stopExistingRuntime,
    })).rejects.toThrow("different major version");
    expect(stopExistingRuntime).not.toHaveBeenCalled();
    expect(createEmbedded).not.toHaveBeenCalled();
  });

  it("refuses to open an offline data directory from a different PostgreSQL major version", async () => {
    const userDataPath = await temporaryUserData();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => new FakeEmbeddedPostgres(),
      choosePort: async () => 55448,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    await writeDataVersion(userDataPath, "17");
    const createEmbedded = vi.fn();
    const probeExistingRuntime = vi.fn();

    await expect(startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
      probeExistingRuntime,
      resolveEmbeddedRuntime: async () => ({
        pgCtlPath: path.join(userDataPath, "current-runtime", "bin", "pg_ctl"),
        libraryDirectory: path.join(userDataPath, "current-runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
    })).rejects.toThrow("data uses a different major version");
    expect(probeExistingRuntime).not.toHaveBeenCalled();
    expect(createEmbedded).not.toHaveBeenCalled();
  });

  it("does not start a replacement or remove data when a stale server cannot stop safely", async () => {
    const userDataPath = await temporaryUserData();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => new FakeEmbeddedPostgres(),
      choosePort: async () => 55445,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    const dataDirectory = path.join(userDataPath, "postgres", "data");
    await writeDataVersion(userDataPath);
    const sentinelPath = path.join(dataDirectory, "keep-existing-data");
    await fs.writeFile(sentinelPath, "preserved");
    const createEmbedded = vi.fn();

    await expect(startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
      probeExistingRuntime: async () => ({
        dataDirectory,
        libraryDirectory: path.join(userDataPath, "deleted-worktree", "lib", "postgresql"),
        majorVersion: 18,
      }),
      resolveEmbeddedRuntime: async () => ({
        pgCtlPath: path.join(userDataPath, "current-runtime", "bin", "pg_ctl"),
        libraryDirectory: path.join(userDataPath, "current-runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
      stopExistingRuntime: async () => {
        throw new Error("pg_ctl refused");
      },
    })).rejects.toThrow("pg_ctl refused");
    expect(createEmbedded).not.toHaveBeenCalled();
    expect(await fs.readFile(sentinelPath, "utf8")).toBe("preserved");
  });

  it("stops a managed server when database creation fails", async () => {
    const instance = new FakeEmbeddedPostgres();
    instance.createDatabase.mockRejectedValueOnce(new Error("cannot create"));

    await expect(startPostgresRuntime({
      userDataPath: await temporaryUserData(),
      environment: {},
      createEmbedded: () => instance,
      choosePort: async () => 55440,
      createPassword: () => "local-test-secret",
    })).rejects.toThrow("cannot create");
    expect(instance.stop).toHaveBeenCalledOnce();
  });

  it("removes process lifecycle hooks installed by embedded-postgres", async () => {
    const exitHook = vi.fn();
    const signalHook = vi.fn();
    const initialise = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const createDatabase = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const exitListeners = process.listeners("exit");
    const signalListeners = process.listeners("SIGTERM");
    vi.doMock("embedded-postgres", () => {
      process.on("exit", exitHook);
      process.on("SIGTERM", signalHook);
      return {
        default: class MockEmbeddedPostgres {
          initialise = initialise;
          start = start;
          createDatabase = createDatabase;
          stop = stop;
        },
      };
    });

    try {
      const runtime = await startPostgresRuntime({
        userDataPath: await temporaryUserData(),
        environment: {},
        choosePort: async () => 55442,
        createPassword: () => "local-test-secret",
      });

      expect(process.listeners("exit")).toEqual(exitListeners);
      expect(process.listeners("SIGTERM")).toEqual(signalListeners);
      expect(initialise).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
      expect(createDatabase).toHaveBeenCalledWith("agent_recall");
      await runtime.stop();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      process.removeListener("exit", exitHook);
      process.removeListener("SIGTERM", signalHook);
      vi.doUnmock("embedded-postgres");
    }
  });
});
