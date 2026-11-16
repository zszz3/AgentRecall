import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
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

  it.each([false, true])("reuses a managed server with explicit backend adoption=%s", async (adoptExisting) => {
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
      adoptExisting,
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
    await reused.stop();
    expect(stopExistingRuntime).toHaveBeenCalledTimes(adoptExisting ? 1 : 0);
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
        arm64: "@embedded-postgres/windows-x64",
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

  it("passes --encoding=UTF8 and --locale=C to initdb for locale safety", async () => {
    const userDataPath = await temporaryUserData();
    let capturedOptions: EmbeddedPostgresOptions | undefined;
    const runtime = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: (input) => {
        capturedOptions = input;
        return new FakeEmbeddedPostgres();
      },
      choosePort: async () => 55449,
      createPassword: () => "local-test-secret",
    });

    expect(capturedOptions?.initdbFlags).toEqual(["--encoding=UTF8", "--locale=C"]);
    await runtime.stop();
  });

  it("rotates an unbindable saved port when probeExistingRuntime returns null", async () => {
    const userDataPath = await temporaryUserData();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => new FakeEmbeddedPostgres(),
      choosePort: async () => 55450,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    await writeDataVersion(userDataPath);

    const observedPorts: number[] = [];
    const replacement = new FakeEmbeddedPostgres();
    const second = await startPostgresRuntime({
      userDataPath,
      environment: {},
      probeExistingRuntime: async () => null,
      canBindPort: async (port) => port !== 55450,
      choosePort: async () => 55451,
      resolveEmbeddedRuntime: async () => ({
        pgCtlPath: path.join(userDataPath, "runtime", "bin", "pg_ctl"),
        libraryDirectory: path.join(userDataPath, "runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
      createEmbedded: (input) => {
        observedPorts.push(input.port);
        return replacement;
      },
    });

    expect(observedPorts).toEqual([55451]);
    expect(second.connectionUrl).toBe("postgresql://agent_recall:local-test-secret@127.0.0.1:55451/agent_recall");
    expect(replacement.initialise).not.toHaveBeenCalled();
    expect(replacement.start).toHaveBeenCalledOnce();
    const saved = JSON.parse(
      await fs.readFile(path.join(userDataPath, "postgres", "runtime.json"), "utf8"),
    ) as { port: number; initialized: boolean };
    expect(saved).toMatchObject({ port: 55451, initialized: true });
    await second.stop();
  });

  it("detects a real occupied saved port on restarts before starting embedded-postgres", async () => {
    const userDataPath = await temporaryUserData();
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const occupiedPort = (squatter.address() as net.AddressInfo).port;
    const probeServer = net.createServer();
    await new Promise<void>((resolve) => probeServer.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const replacementPort = (probeServer.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => probeServer.close((error) => error ? reject(error) : resolve()));

    const observedPorts: number[] = [];
    vi.doMock("embedded-postgres", () => ({
      default: class MockEmbeddedPostgres {
        constructor(input: EmbeddedPostgresOptions) {
          observedPorts.push(input.port);
        }
        initialise = vi.fn(async () => undefined);
        start = vi.fn(async () => undefined);
        createDatabase = vi.fn(async () => undefined);
        stop = vi.fn(async () => undefined);
      },
    }));

    try {
      const postgresDir = path.join(userDataPath, "postgres");
      await fs.mkdir(postgresDir, { recursive: true });
      await fs.writeFile(
        path.join(postgresDir, "runtime.json"),
        `${JSON.stringify({
          version: 1,
          host: "127.0.0.1",
          port: occupiedPort,
          user: "agent_recall",
          password: "local-test-secret",
          database: "agent_recall",
          initialized: true,
        })}\n`,
      );
      await writeDataVersion(userDataPath);

      const runtime = await startPostgresRuntime({
        userDataPath,
        environment: {},
        probeExistingRuntime: async () => null,
        resolveEmbeddedRuntime: async () => ({
          pgCtlPath: path.join(userDataPath, "runtime", "bin", "pg_ctl"),
          libraryDirectory: path.join(userDataPath, "runtime", "lib", "postgresql"),
          majorVersion: 18,
        }),
        choosePort: async () => replacementPort,
      });

      expect(observedPorts).toEqual([replacementPort]);
      expect(runtime.connectionUrl).toBe(`postgresql://agent_recall:local-test-secret@127.0.0.1:${replacementPort}/agent_recall`);
      await runtime.stop();
    } finally {
      vi.doUnmock("embedded-postgres");
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("recovers from a foreign TCP listener on the saved port when no live postmaster.pid exists", async () => {
    const userDataPath = await temporaryUserData();
    const foreignServer = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => foreignServer.listen({ host: "127.0.0.1", port: 0 }, resolve));
    const squattedPort = (foreignServer.address() as net.AddressInfo).port;

    try {
      const postgresDir = path.join(userDataPath, "postgres");
      await fs.mkdir(postgresDir, { recursive: true });
      await fs.writeFile(
        path.join(postgresDir, "runtime.json"),
        `${JSON.stringify({
          version: 1,
          host: "127.0.0.1",
          port: squattedPort,
          user: "agent_recall",
          password: "local-test-secret",
          database: "agent_recall",
          initialized: true,
        })}\n`,
      );
      await writeDataVersion(userDataPath);
      // A stale postmaster.pid from a dead PID must not block recovery.
      await fs.writeFile(path.join(postgresDir, "data", "postmaster.pid"), "9999999\n");

      const observedPorts: number[] = [];
      const replacement = new FakeEmbeddedPostgres();
      const runtime = await startPostgresRuntime({
        userDataPath,
        environment: {},
        resolveEmbeddedRuntime: async () => ({
          pgCtlPath: path.join(userDataPath, "runtime", "bin", "pg_ctl"),
          libraryDirectory: path.join(userDataPath, "runtime", "lib", "postgresql"),
          majorVersion: 18,
        }),
        choosePort: async () => 55452,
        createEmbedded: (input) => {
          observedPorts.push(input.port);
          return replacement;
        },
      });

      expect(observedPorts).toEqual([55452]);
      expect(runtime.connectionUrl).toBe("postgresql://agent_recall:local-test-secret@127.0.0.1:55452/agent_recall");
      expect(replacement.initialise).not.toHaveBeenCalled();
      expect(replacement.start).toHaveBeenCalledOnce();
      const saved = JSON.parse(await fs.readFile(path.join(postgresDir, "runtime.json"), "utf8")) as { port: number };
      expect(saved.port).toBe(55452);
      await runtime.stop();
    } finally {
      await new Promise<void>((resolve) => foreignServer.close(() => resolve()));
    }
  });

  it("refuses to treat a probe failure as a foreign squatter while a live postmaster.pid exists", async () => {
    const userDataPath = await temporaryUserData();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => new FakeEmbeddedPostgres(),
      choosePort: async () => 55453,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    await writeDataVersion(userDataPath);
    await fs.writeFile(path.join(userDataPath, "postgres", "data", "postmaster.pid"), `${process.pid}\n`);

    const choosePort = vi.fn(async () => 55459);
    const createEmbedded = vi.fn();

    await expect(startPostgresRuntime({
      userDataPath,
      environment: {},
      probeExistingRuntime: async () => {
        throw new Error("Managed PostgreSQL runtime identity could not be verified.");
      },
      resolveEmbeddedRuntime: async () => ({
        pgCtlPath: path.join(userDataPath, "runtime", "bin", "pg_ctl"),
        libraryDirectory: path.join(userDataPath, "runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
      choosePort,
      createEmbedded,
    })).rejects.toThrow("Managed PostgreSQL runtime identity could not be verified.");

    expect(choosePort).not.toHaveBeenCalled();
    expect(createEmbedded).not.toHaveBeenCalled();
    const saved = JSON.parse(
      await fs.readFile(path.join(userDataPath, "postgres", "runtime.json"), "utf8"),
    ) as { port: number };
    expect(saved.port).toBe(55453);
  });

  it("rotates port and retries when embedded.start() rejects with undefined after logging a bind error", async () => {
    const userDataPath = await temporaryUserData();
    const first = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded: () => new FakeEmbeddedPostgres(),
      choosePort: async () => 55454,
      createPassword: () => "local-test-secret",
    });
    await first.stop();
    await writeDataVersion(userDataPath);

    const observedPorts: number[] = [];
    const secondInstance = new FakeEmbeddedPostgres();
    const createEmbedded = vi.fn((input: EmbeddedPostgresOptions) => {
      observedPorts.push(input.port);
      if (observedPorts.length === 1) {
        const failed = new FakeEmbeddedPostgres();
        failed.start.mockImplementationOnce(async () => {
          input.onLog?.('LOG:  could not bind IPv4 address "127.0.0.1": Address already in use\nFATAL:  could not create any TCP/IP sockets\n');
          throw undefined;
        });
        return failed;
      }
      return secondInstance;
    });

    const runtime = await startPostgresRuntime({
      userDataPath,
      environment: {},
      probeExistingRuntime: async () => null,
      resolveEmbeddedRuntime: async () => ({
        pgCtlPath: path.join(userDataPath, "runtime", "bin", "pg_ctl"),
        libraryDirectory: path.join(userDataPath, "runtime", "lib", "postgresql"),
        majorVersion: 18,
      }),
      choosePort: async () => 55455,
      createEmbedded,
    });

    expect(observedPorts).toEqual([55454, 55455]);
    expect(secondInstance.initialise).not.toHaveBeenCalled();
    expect(secondInstance.start).toHaveBeenCalledOnce();
    expect(runtime.connectionUrl).toBe("postgresql://agent_recall:local-test-secret@127.0.0.1:55455/agent_recall");
    const saved = JSON.parse(
      await fs.readFile(path.join(userDataPath, "postgres", "runtime.json"), "utf8"),
    ) as { port: number };
    expect(saved.port).toBe(55455);
    await runtime.stop();
  });

  it("recovers from an initial start bind race without re-running initialise", async () => {
    const userDataPath = await temporaryUserData();
    const ports = [55456, 55457];
    const observedPorts: number[] = [];
    const firstInstance = new FakeEmbeddedPostgres();
    const secondInstance = new FakeEmbeddedPostgres();

    const runtime = await startPostgresRuntime({
      userDataPath,
      environment: {},
      choosePort: async () => ports.shift()!,
      createPassword: () => "local-test-secret",
      createEmbedded: (input) => {
        observedPorts.push(input.port);
        if (observedPorts.length === 1) {
          firstInstance.start.mockImplementationOnce(async () => {
            input.onLog?.("WARNING:  could not create listen socket for \"127.0.0.1\"\n");
            throw undefined;
          });
          return firstInstance;
        }
        return secondInstance;
      },
    });

    expect(observedPorts).toEqual([55456, 55457]);
    expect(firstInstance.initialise).toHaveBeenCalledOnce();
    expect(firstInstance.stop).not.toHaveBeenCalled();
    expect(secondInstance.initialise).not.toHaveBeenCalled();
    expect(secondInstance.start).toHaveBeenCalledOnce();
    expect(secondInstance.createDatabase).toHaveBeenCalledWith("agent_recall");
    expect(runtime.connectionUrl).toBe("postgresql://agent_recall:local-test-secret@127.0.0.1:55457/agent_recall");
    const saved = JSON.parse(
      await fs.readFile(path.join(userDataPath, "postgres", "runtime.json"), "utf8"),
    ) as { port: number; initialized: boolean };
    expect(saved).toMatchObject({ port: 55457, initialized: true });
    await runtime.stop();
  });

  it("bounds port-bind retries and surfaces non-port startup failures as Errors", async () => {
    const userDataPath = await temporaryUserData();
    let nextPort = 55460;
    const observedPorts: number[] = [];
    await expect(startPostgresRuntime({
      userDataPath,
      environment: {},
      choosePort: async () => nextPort++,
      createPassword: () => "local-test-secret",
      createEmbedded: (input) => {
        observedPorts.push(input.port);
        const failed = new FakeEmbeddedPostgres();
        failed.start.mockImplementationOnce(async () => {
          input.onLog?.('LOG:  could not bind IPv4 address "127.0.0.1": EACCES\n');
          throw undefined;
        });
        return failed;
      },
    })).rejects.toThrow("could not bind IPv4 address");
    expect(observedPorts).toEqual([55460, 55461, 55462, 55463]);

    const nonPortUserData = await temporaryUserData();
    const createNonPortEmbedded = vi.fn((input: EmbeddedPostgresOptions) => {
      const failed = new FakeEmbeddedPostgres();
      failed.start.mockImplementationOnce(async () => {
        input.onLog?.("FATAL:  corrupt control file\n");
        throw undefined;
      });
      return failed;
    });
    await expect(startPostgresRuntime({
      userDataPath: nonPortUserData,
      environment: {},
      choosePort: async () => 55464,
      createPassword: () => "local-test-secret",
      createEmbedded: createNonPortEmbedded,
    })).rejects.toThrow("corrupt control file");
    expect(createNonPortEmbedded).toHaveBeenCalledOnce();
  });

  it("uses a direct windows-x64 wrapper on win32-arm64 without importing embedded-postgres", async () => {
    const userDataPath = await temporaryUserData();
    const binDir = path.join(userDataPath, "windows-x64", "native", "bin");
    const libDir = path.join(userDataPath, "windows-x64", "native", "lib");
    const spawnCalls: Array<{ command: string; args: string[]; windowsHide?: boolean; lcMessages?: string }> = [];
    const execFileCalls: Array<{ command: string; args: string[]; windowsHide?: boolean }> = [];
    const queries: string[] = [];
    const pgClientConfigs: Array<Record<string, unknown>> = [];

    class FakeChildProcess extends EventEmitter {
      stdout = new PassThrough();
      stderr = new PassThrough();
      pid = 43210;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
    }
    let postgresChild: FakeChildProcess | undefined;

    vi.resetModules();
    vi.doMock("embedded-postgres", () => {
      throw new Error('Unsupported arch "arm64" for platform "win32"');
    });
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn((command: string, args: string[], spawnOptions: { windowsHide?: boolean; env?: Record<string, string | undefined> }) => {
        spawnCalls.push({
          command,
          args,
          windowsHide: spawnOptions.windowsHide,
          lcMessages: spawnOptions.env?.LC_MESSAGES,
        });
        const child = new FakeChildProcess();
        if (command.endsWith("initdb.exe")) {
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("close", 0, null);
          });
        } else if (command.endsWith("postgres.exe")) {
          postgresChild = child;
          queueMicrotask(() => {
            child.stderr.write("2026-11-16 LOG:  starting PostgreSQL 18.4\n");
            child.stderr.write("2026-11-16 LOG:  database system is ready ");
            child.stderr.write("to accept connections\n");
          });
        }
        return child;
      }),
      execFile: vi.fn((command: string, args: string[], execOptions: { windowsHide?: boolean }, callback: (error: Error | null) => void) => {
        execFileCalls.push({ command, args, windowsHide: execOptions.windowsHide });
        if (command.endsWith("pg_ctl.exe")) {
          callback(new Error("pg_ctl timed out"));
          return;
        }
        if (command === "taskkill" && postgresChild) {
          postgresChild.exitCode = 1;
          postgresChild.emit("close", 1, null);
        }
        callback(null);
      }),
    }));
    vi.doMock("pg", () => ({
      Client: class MockPgClient extends EventEmitter {
        constructor(config: Record<string, unknown>) {
          super();
          pgClientConfigs.push(config);
        }
        connect = vi.fn(async () => undefined);
        query = vi.fn(async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        });
        end = vi.fn(async () => undefined);
        escapeIdentifier = (value: string) => `"${value}"`;
      },
    }));

    try {
      const { startPostgresRuntime: startArm64Runtime } = await import("./managed-postgres");
      const runtime = await startArm64Runtime({
        userDataPath,
        environment: {},
        platform: "win32",
        arch: "arm64",
        choosePort: async () => 55465,
        createPassword: () => "local-test-secret",
        resolveEmbeddedRuntime: async (platform, arch) => {
          expect(platform).toBe("win32");
          expect(arch).toBe("arm64");
          return {
            pgCtlPath: path.join(binDir, "pg_ctl.exe"),
            libraryDirectory: libDir,
            majorVersion: 18,
          };
        },
      });

      expect(runtime.connectionUrl).toBe("postgresql://agent_recall:local-test-secret@127.0.0.1:55465/agent_recall");
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0]?.command).toBe(path.join(binDir, "initdb.exe"));
      expect(spawnCalls[0]?.windowsHide).toBe(true);
      expect(spawnCalls[0]?.lcMessages).toBe("C");
      expect(spawnCalls[0]?.args).toContain("--encoding=UTF8");
      expect(spawnCalls[0]?.args).toContain("--locale=C");
      expect(spawnCalls[0]?.args).toContain("--lc-messages=C");

      expect(spawnCalls[1]?.command).toBe(path.join(binDir, "postgres.exe"));
      expect(spawnCalls[1]?.windowsHide).toBe(true);
      expect(spawnCalls[1]?.lcMessages).toBe("C");
      expect(spawnCalls[1]?.args).toEqual([
        "-D",
        path.join(userDataPath, "postgres", "data"),
        "-p",
        "55465",
        "-h",
        "127.0.0.1",
      ]);

      expect(pgClientConfigs).toEqual([{
        host: "127.0.0.1",
        port: 55465,
        user: "agent_recall",
        password: "local-test-secret",
        database: "postgres",
      }]);
      expect(queries).toEqual(['CREATE DATABASE "agent_recall"']);

      await runtime.stop();
      expect(execFileCalls).toEqual([
        {
          command: path.join(binDir, "pg_ctl.exe"),
          args: ["stop", "-D", path.join(userDataPath, "postgres", "data"), "-m", "fast", "-w", "-t", "10"],
          windowsHide: true,
        },
        {
          command: "taskkill",
          args: ["/pid", "43210", "/T", "/F"],
          windowsHide: true,
        },
      ]);
    } finally {
      vi.doUnmock("pg");
      vi.doUnmock("node:child_process");
      vi.doUnmock("embedded-postgres");
      vi.resetModules();
    }
  });

  it("recovers from win32-arm64 postgres.exe port bind failure and stops cleanly via pg_ctl", async () => {
    const userDataPath = await temporaryUserData();
    const binDir = path.join(userDataPath, "windows-x64", "native", "bin");
    const libDir = path.join(userDataPath, "windows-x64", "native", "lib");
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const execFileCalls: Array<{ command: string; args: string[] }> = [];
    const ports = [55466, 55467];

    class FakeChildProcess extends EventEmitter {
      stdout = new PassThrough();
      stderr = new PassThrough();
      pid = 54321;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
    }
    let activePostgresChild: FakeChildProcess | undefined;
    let postgresLaunchCount = 0;

    vi.resetModules();
    vi.doMock("embedded-postgres", () => {
      throw new Error('Unsupported arch "arm64" for platform "win32"');
    });
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn((command: string, args: string[]) => {
        spawnCalls.push({ command, args });
        const child = new FakeChildProcess();
        if (command.endsWith("initdb.exe")) {
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("close", 0, null);
          });
        } else if (command.endsWith("postgres.exe")) {
          postgresLaunchCount += 1;
          activePostgresChild = child;
          queueMicrotask(() => {
            if (postgresLaunchCount === 1) {
              child.stderr.write('LOG:  could not bind IPv4 address "127.0.0.1": EACCES\n');
              child.exitCode = 1;
              child.emit("close", 1, null);
            } else {
              child.stderr.write("LOG:  database system is ready to accept connections\n");
            }
          });
        }
        return child;
      }),
      execFile: vi.fn((command: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
        execFileCalls.push({ command, args });
        if (command.endsWith("pg_ctl.exe") && activePostgresChild) {
          activePostgresChild.exitCode = 0;
          activePostgresChild.emit("close", 0, null);
        }
        callback(null);
      }),
    }));
    vi.doMock("pg", () => ({
      Client: class MockPgClient extends EventEmitter {
        connect = vi.fn(async () => undefined);
        query = vi.fn(async () => ({ rows: [] }));
        end = vi.fn(async () => undefined);
        escapeIdentifier = (value: string) => `"${value}"`;
      },
    }));

    try {
      const { startPostgresRuntime: startArm64Runtime } = await import("./managed-postgres");
      const runtime = await startArm64Runtime({
        userDataPath,
        environment: {},
        platform: "win32",
        arch: "arm64",
        choosePort: async () => ports.shift()!,
        createPassword: () => "local-test-secret",
        resolveEmbeddedRuntime: async () => ({
          pgCtlPath: path.join(binDir, "pg_ctl.exe"),
          libraryDirectory: libDir,
          majorVersion: 18,
        }),
      });

      expect(runtime.connectionUrl).toBe("postgresql://agent_recall:local-test-secret@127.0.0.1:55467/agent_recall");
      expect(spawnCalls.filter((call) => call.command.endsWith("initdb.exe"))).toHaveLength(1);
      expect(spawnCalls.filter((call) => call.command.endsWith("postgres.exe"))).toHaveLength(2);

      await runtime.stop();
      expect(execFileCalls).toEqual([{
        command: path.join(binDir, "pg_ctl.exe"),
        args: ["stop", "-D", path.join(userDataPath, "postgres", "data"), "-m", "fast", "-w", "-t", "10"],
      }]);
    } finally {
      vi.doUnmock("pg");
      vi.doUnmock("node:child_process");
      vi.doUnmock("embedded-postgres");
      vi.resetModules();
    }
  });
});
