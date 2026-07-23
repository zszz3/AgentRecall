import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startPostgresRuntime,
  type EmbeddedPostgresInstance,
  type EmbeddedPostgresOptions,
} from "./managed-postgres";

const temporaryDirectories: string[] = [];

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

class FakeEmbeddedPostgres implements EmbeddedPostgresInstance {
  readonly initialise = vi.fn(async () => undefined);
  readonly start = vi.fn(async () => undefined);
  readonly createDatabase = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
}

describe("startPostgresRuntime", () => {
  it("uses an external PostgreSQL URL without starting a managed server", async () => {
    const createEmbedded = vi.fn();
    const runtime = await startPostgresRuntime({
      userDataPath: await temporaryUserData(),
      environment: {
        AGENT_RECALL_DATABASE_URL: "postgresql://agent:secret@db.example/recall",
      },
      createEmbedded,
    });

    expect(runtime.connectionUrl).toBe("postgresql://agent:secret@db.example/recall");
    expect(runtime.managed).toBe(false);
    expect(createEmbedded).not.toHaveBeenCalled();
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
    const second = await startPostgresRuntime({
      userDataPath,
      environment: {},
      createEmbedded,
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
});
