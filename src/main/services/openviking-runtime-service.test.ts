import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenVikingRuntimeService,
  assertSafeArchiveEntry,
  type OpenVikingRuntimeManifest,
} from "./openviking-runtime-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-runtime-"));
  roots.push(root);
  return root;
}

function manifest(
  overrides: Partial<OpenVikingRuntimeManifest> = {},
): OpenVikingRuntimeManifest {
  return {
    version: "0.4.11",
    platform: "darwin",
    arch: "arm64",
    url: "https://downloads.example/openviking.tar.gz",
    sha256: createHash("sha256").update("runtime archive").digest("hex"),
    executablePath: "bin/openviking-server",
    archiveType: "tar.gz",
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }
}

function runtimeHarness(root: string, options: {
  platform?: NodeJS.Platform;
  executablePath?: string;
  alive?: boolean;
} = {}) {
  const child = new FakeChild();
  const spawnCalls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
  const healthCheck = vi.fn(async () => undefined);
  const service = new OpenVikingRuntimeService({
    rootDir: root,
    platform: options.platform ?? "darwin",
    arch: options.platform === "win32" ? "x64" : "arm64",
    download: async (_url, destination) => {
      await writeFile(destination, "runtime archive");
    },
    extractArchive: async ({ destination, validateEntry }) => {
      const executablePath = options.executablePath ?? "bin/openviking-server";
      validateEntry(executablePath);
      const executable = path.join(destination, ...executablePath.split("/"));
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, "#!/bin/sh\n");
      if (options.platform !== "win32") await chmod(executable, 0o755);
    },
    allocatePort: async () => 21933,
    spawnProcess: (command, args, spawnOptions) => {
      spawnCalls.push({ command, args, cwd: spawnOptions.cwd });
      return child;
    },
    healthCheck,
    isProcessAlive: () => options.alive ?? false,
  });
  return { service, child, spawnCalls, healthCheck };
}

describe("OpenVikingRuntimeService", () => {
  it("installs, starts and stops an app-owned loopback runtime", async () => {
    const root = await temporaryRoot();
    const { service, child, spawnCalls, healthCheck } = runtimeHarness(root);

    await expect(service.getStatus()).resolves.toMatchObject({ state: "not-installed" });
    await service.install(manifest());
    await expect(service.getStatus()).resolves.toMatchObject({
      state: "stopped",
      version: "0.4.11",
    });

    await service.start({
      embedding: {
        dense: {
          provider: "local",
          model: "bge-small-zh-v1.5-f16",
          dimension: 512,
          model_path: "/models/bge-small-zh-v1.5-f16.gguf",
        },
      },
      vlm: { provider: "openai-codex", model: "gpt-5.4" },
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      state: "running",
      version: "0.4.11",
      port: 21933,
    });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe(path.join(root, "runtime", "0.4.11", "bin", "openviking-server"));
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining([
      "--host",
      "127.0.0.1",
      "--port",
      "21933",
      "--config",
      path.join(root, "ov.conf"),
    ]));
    expect(healthCheck).toHaveBeenCalledWith("http://127.0.0.1:21933", expect.any(String));

    const config = JSON.parse(await readFile(path.join(root, "ov.conf"), "utf8"));
    expect(config).toMatchObject({
      embedding: {
        dense: {
          provider: "local",
          model: "bge-small-zh-v1.5-f16",
          dimension: 512,
          model_path: "/models/bge-small-zh-v1.5-f16.gguf",
        },
      },
      storage: {
        workspace: path.join(root, "data"),
        agfs: { backend: "local" },
        vectordb: { backend: "local" },
      },
      server: {
        host: "127.0.0.1",
        port: 21933,
        auth_mode: "api_key",
        cors_origins: [],
      },
    });
    expect(config.server.root_api_key).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.getConnection()).resolves.toEqual({
      baseUrl: "http://127.0.0.1:21933",
      rootApiKey: config.server.root_api_key,
    });

    await service.stop();
    expect(child.killed).toBe(true);
    await expect(service.getStatus()).resolves.toMatchObject({ state: "stopped" });
  });

  it("rejects checksum mismatches before extracting anything", async () => {
    const root = await temporaryRoot();
    const extractArchive = vi.fn(async () => undefined);
    const { service } = runtimeHarness(root);
    const mismatched = new OpenVikingRuntimeService({
      rootDir: root,
      platform: "darwin",
      arch: "arm64",
      download: async (_url, destination) => writeFile(destination, "tampered"),
      extractArchive,
    });

    await expect(mismatched.install(manifest())).rejects.toThrow("checksum");
    expect(extractArchive).not.toHaveBeenCalled();
    await expect(service.getStatus()).resolves.toMatchObject({ state: "not-installed" });
  });

  it.each(["../escape", "/absolute", "folder/../../escape", "C:\\absolute"] as const)(
    "rejects unsafe archive entry %s",
    (entry) => {
      expect(() => assertSafeArchiveEntry(entry)).toThrow("Unsafe OpenViking archive entry");
    },
  );

  it("recovers a stale persisted PID as a stopped runtime", async () => {
    const root = await temporaryRoot();
    const runtime = path.join(root, "runtime", "0.4.11");
    await mkdir(path.join(runtime, "bin"), { recursive: true });
    await writeFile(path.join(runtime, "bin", "openviking-server"), "");
    await writeFile(path.join(root, "active-runtime.json"), JSON.stringify(manifest()));
    await writeFile(path.join(root, "runtime-state.json"), JSON.stringify({ pid: 99999, port: 21933 }));
    const { service } = runtimeHarness(root, { alive: false });

    await expect(service.getStatus()).resolves.toMatchObject({
      state: "stopped",
      version: "0.4.11",
    });
    await expect(readFile(path.join(root, "runtime-state.json"), "utf8")).rejects.toThrow();
  });

  it("uses the manifest's Windows executable path", async () => {
    const root = await temporaryRoot();
    const executablePath = "Scripts/openviking-server.exe";
    const { service, spawnCalls } = runtimeHarness(root, {
      platform: "win32",
      executablePath,
    });
    await service.install(manifest({
      platform: "win32",
      arch: "x64",
      executablePath,
    }));

    await service.start({
      embedding: { dense: { provider: "local", model: "model", dimension: 512 } },
      vlm: { provider: "openai-codex", model: "gpt-5.4" },
    });

    expect(spawnCalls[0].command).toBe(
      path.join(root, "runtime", "0.4.11", "Scripts", "openviking-server.exe"),
    );
  });
});
