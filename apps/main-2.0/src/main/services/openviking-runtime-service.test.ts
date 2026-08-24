import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
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

async function withFakePs<T>(
  root: string,
  script: string,
  operation: () => Promise<T>,
): Promise<T> {
  const binDir = path.join(root, "fake-bin");
  const executable = path.join(binDir, "ps");
  await mkdir(binDir, { recursive: true });
  await writeFile(executable, `#!/bin/sh\n${script}\n`);
  await chmod(executable, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    return await operation();
  } finally {
    process.env.PATH = originalPath;
  }
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

function partialArchivePath(root: string): string {
  return path.join(root, "downloads", "openviking-0.4.11-darwin-arm64.tar.gz.part");
}

async function runtimeWithPersistedCurrentProcess(
  root: string,
): Promise<OpenVikingRuntimeService> {
  await writeFile(
    path.join(root, "active-runtime.json"),
    JSON.stringify(manifest({ platform: process.platform, arch: process.arch })),
  );
  await writeFile(
    path.join(root, "runtime-state.json"),
    JSON.stringify({ pid: process.pid, port: 21933 }),
  );
  return new OpenVikingRuntimeService({
    rootDir: root,
    codexAuthBootstrapPath: path.join(root, "synthetic-codex-home", "auth.json"),
    platform: process.platform,
    arch: process.arch,
  });
}

async function persistedRuntimeFixture(root: string): Promise<void> {
  const runtime = path.join(root, "runtime", "0.4.11");
  await mkdir(path.join(runtime, "bin"), { recursive: true });
  await writeFile(path.join(runtime, "bin", "openviking-server"), "");
  await writeFile(path.join(root, "active-runtime.json"), JSON.stringify(manifest()));
  await writeFile(path.join(root, "runtime-state.json"), JSON.stringify({ pid: 99999, port: 21933 }));
  await writeFile(path.join(root, "root-api-key"), `${"b".repeat(64)}\n`);
}

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  killed = false;

  constructor(private readonly exitsOnKill = true) {
    super();
  }

  kill(): boolean {
    this.killed = true;
    if (this.exitsOnKill) this.finishExit();
    return true;
  }

  finishExit(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

function runtimeHarness(root: string, options: {
  platform?: NodeJS.Platform;
  executablePath?: string;
  alive?: boolean;
  healthy?: boolean;
  codexAuthBootstrapPath?: string;
  download?: (url: string, destination: string) => Promise<void>;
  child?: FakeChild;
  isProcessAlive?: (pid: number) => boolean;
  stopTimeoutMs?: number;
} = {}) {
  const child = options.child ?? new FakeChild();
  const spawnCalls: Array<{
    command: string;
    args: readonly string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
  }> = [];
  const healthCheck = vi.fn(async () => undefined);
  const healthProbe = vi.fn(async () => options.healthy ?? true);
  const killProcess = vi.fn();
  const forceKillProcess = vi.fn();
  const service = new OpenVikingRuntimeService({
    rootDir: root,
    codexAuthBootstrapPath: options.codexAuthBootstrapPath
      ?? path.join(root, "synthetic-codex-home", "auth.json"),
    platform: options.platform ?? "darwin",
    arch: options.platform === "win32" ? "x64" : "arm64",
    download: options.download ?? (async (_url, destination) => {
      await writeFile(destination, "runtime archive");
    }),
    extractArchive: async ({ destination, validateEntry }) => {
      const executablePath = options.executablePath ?? "bin/openviking-server";
      validateEntry(executablePath);
      const executable = path.join(destination, ...executablePath.split("/"));
      const python = options.platform === "win32"
        ? path.join(destination, "python.exe")
        : path.join(destination, "bin", "python3");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, "#!/bin/sh\n");
      await mkdir(path.dirname(python), { recursive: true });
      await writeFile(python, "");
      if (options.platform !== "win32") {
        await chmod(executable, 0o755);
        await chmod(python, 0o755);
      }
    },
    allocatePort: async () => 21933,
    spawnProcess: (command, args, spawnOptions) => {
      spawnCalls.push({
        command,
        args,
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
      });
      return child;
    },
    healthCheck,
    healthProbe,
    isProcessAlive: options.isProcessAlive ?? (() => options.alive ?? false),
    killProcess,
    forceKillProcess,
    ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
  });
  return { service, child, spawnCalls, healthCheck, healthProbe, killProcess, forceKillProcess };
}

describe("OpenVikingRuntimeService", () => {
  it("imports Codex OAuth into an app-owned OpenViking credential store", async () => {
    const root = await temporaryRoot();
    const authFile = path.join(root, "synthetic-codex-home", "auth.json");
    await mkdir(path.dirname(authFile), { recursive: true });
    await writeFile(authFile, JSON.stringify({
      tokens: {
        access_token: "synthetic-access-token",
        refresh_token: "synthetic-refresh-token",
      },
    }));
    const { service, spawnCalls } = runtimeHarness(root, {
      codexAuthBootstrapPath: authFile,
    });
    await service.install(manifest());

    await service.start({
      embedding: { dense: { provider: "local", model: "model", dimension: 512 } },
      vlm: { provider: "openai-codex", model: "gpt-5.4" },
    });

    expect(spawnCalls[0].env).toMatchObject({
      OPENVIKING_CODEX_BOOTSTRAP_PATH: authFile,
      OPENVIKING_CODEX_AUTH_PATH: path.join(root, "auth", "codex_auth.json"),
      // Keeps litellm from stalling its import on a remote price table fetch.
      LITELLM_LOCAL_MODEL_COST_MAP: "True",
    });
    const config = await readFile(path.join(root, "ov.conf"), "utf8");
    expect(config).not.toContain("synthetic-access-token");
    expect(config).not.toContain("synthetic-refresh-token");
  });

  it("installs, starts and stops an app-owned loopback runtime", async () => {
    const root = await temporaryRoot();
    const { service, child, spawnCalls, healthCheck, healthProbe } = runtimeHarness(root);

    await expect(service.getStatus()).resolves.toMatchObject({ state: "not-installed" });
    await service.install(manifest());
    await expect(service.getStatus()).resolves.toMatchObject({
      state: "stopped",
      version: "0.4.11",
      installedBytes: Buffer.byteLength("runtime archive"),
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
    expect(child.listenerCount("exit")).toBe(1);

    await expect(service.getStatus()).resolves.toMatchObject({
      state: "running",
      version: "0.4.11",
      port: 21933,
    });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe(path.join(root, "runtime", "0.4.11", "bin", "python3"));
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining([
      "-c",
      expect.stringContaining("openviking_cli.server_bootstrap"),
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
    const runtimeState = JSON.parse(await readFile(path.join(root, "runtime-state.json"), "utf8"));
    expect(runtimeState).toMatchObject({
      pid: 4242,
      port: 21933,
      startedAt: expect.stringMatching(/^2026-|^20\d{2}-/),
    });
    await expect(service.getDiagnostics()).resolves.toMatchObject({
      status: { state: "running", version: "0.4.11", port: 21933 },
      health: "healthy",
      pid: 4242,
      port: 21933,
      startedAt: runtimeState.startedAt,
      uptimeSeconds: expect.any(Number),
      healthLatencyMs: expect.any(Number),
      events: expect.arrayContaining([
        expect.objectContaining({ type: "start" }),
        expect.objectContaining({ type: "ready" }),
      ]),
    });
    expect(healthProbe).toHaveBeenCalledWith("http://127.0.0.1:21933", config.server.root_api_key);

    await service.stop();
    expect(child.killed).toBe(true);
    await expect(service.getStatus()).resolves.toMatchObject({ state: "stopped" });
    await expect(service.getDiagnostics()).resolves.toMatchObject({
      health: "not-running",
      events: expect.arrayContaining([
        expect.objectContaining({ type: "stop", message: "OpenViking stopped." }),
        expect.objectContaining({ type: "exit" }),
      ]),
    });
  });

  it("clears OpenViking data without removing installed components", async () => {
    const root = await temporaryRoot();
    const { service } = runtimeHarness(root);
    const runtimeFile = path.join(root, "runtime", "0.4.11", "bin", "python3");
    const modelFile = path.join(root, "models", "bge-small", "model.gguf");
    const downloadFile = path.join(root, "downloads", "openviking.tar.gz");
    const dataFiles = [
      path.join(root, "data", "_system", "queue", "queue.db"),
      path.join(root, "data", "vectordb", "context", "store", "index.bin"),
    ];
    for (const filePath of [runtimeFile, modelFile, downloadFile, ...dataFiles]) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "fixture");
    }

    await service.clearData();

    for (const filePath of dataFiles) {
      await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const filePath of [runtimeFile, modelFile, downloadFile]) {
      await expect(readFile(filePath, "utf8")).resolves.toBe("fixture");
    }
  });

  it("restarts from the last persisted model config for maintenance operations", async () => {
    const root = await temporaryRoot();
    const { service, spawnCalls } = runtimeHarness(root);
    await service.install(manifest());
    await writeFile(path.join(root, "ov.conf"), JSON.stringify({
      embedding: {
        dense: {
          provider: "local",
          model: "persisted-embedding",
          dimension: 512,
          model_path: "/models/persisted.gguf",
        },
      },
      vlm: {
        provider: "openai",
        model: "persisted-model",
        api_base: "https://provider.example/v1",
        api_key: "persisted-key",
      },
      memory: {
        custom_templates_dir: path.join(root, "memory-templates"),
      },
      server: { host: "0.0.0.0", port: 9999, root_api_key: "stale-root-key" },
      storage: { workspace: "/stale/path" },
    }));

    await service.startFromPersistedConfig();

    expect(spawnCalls).toHaveLength(1);
    const config = JSON.parse(await readFile(path.join(root, "ov.conf"), "utf8"));
    expect(config.embedding.dense.model).toBe("persisted-embedding");
    expect(config.vlm.model).toBe("persisted-model");
    expect(config.memory.custom_templates_dir).toBe(path.join(root, "memory-templates"));
    expect(config.server).toMatchObject({ host: "127.0.0.1", port: 21933 });
    expect(config.storage.workspace).toBe(path.join(root, "data"));
  });

  it("does not report a managed runtime as stopped until its process has exited", async () => {
    const root = await temporaryRoot();
    const child = new FakeChild(false);
    const { service } = runtimeHarness(root, { child });
    await service.install(manifest());
    await service.start({
      embedding: { dense: { provider: "local", model: "model", dimension: 512 } },
      vlm: { provider: "openai-codex", model: "gpt-5.4" },
    });

    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });

    await vi.waitFor(() => expect(child.killed).toBe(true));
    expect(stopped).toBe(false);
    child.finishExit();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("allows a slow first boot to become healthy after the old ten-second deadline", async () => {
    const root = await temporaryRoot();
    const child = new FakeChild();
    const service = new OpenVikingRuntimeService({
      rootDir: root,
      codexAuthBootstrapPath: path.join(root, "synthetic-codex-home", "auth.json"),
      platform: "darwin",
      arch: "arm64",
      download: async (_url, destination) => {
        await writeFile(destination, "runtime archive");
      },
      extractArchive: async ({ destination }) => {
        const launcher = path.join(destination, "bin", "openviking-server");
        const python = path.join(destination, "bin", "python3");
        await mkdir(path.dirname(launcher), { recursive: true });
        await writeFile(launcher, "");
        await writeFile(python, "");
        await chmod(launcher, 0o755);
        await chmod(python, 0o755);
      },
      allocatePort: async () => 21933,
      spawnProcess: () => child,
      isProcessAlive: () => false,
    });
    await service.install(manifest());

    vi.useFakeTimers();
    let healthy = false;
    let markFirstProbe: () => void = () => undefined;
    const firstProbe = new Promise<void>((resolve) => {
      markFirstProbe = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      markFirstProbe();
      if (!healthy) throw new Error("server is still starting");
      return new Response(null, { status: 200 });
    });
    try {
      const starting = service.start({
        embedding: { dense: { provider: "local", model: "model", dimension: 512 } },
        vlm: { provider: "openai-codex", model: "gpt-5.4" },
      }).then(
        (status) => ({ status }),
        (error: unknown) => ({ error }),
      );
      await firstProbe;
      await vi.advanceTimersByTimeAsync(10_500);
      healthy = true;
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(starting).resolves.toMatchObject({
        status: { state: "running", port: 21933 },
      });
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("reports a child startup error immediately instead of waiting for the health timeout", async () => {
    const root = await temporaryRoot();
    const child = new FakeChild() as FakeChild & { stderr: PassThrough };
    child.stderr = new PassThrough();
    const service = new OpenVikingRuntimeService({
      rootDir: root,
      codexAuthBootstrapPath: path.join(root, "synthetic-codex-home", "auth.json"),
      platform: "darwin",
      arch: "arm64",
      download: async (_url, destination) => {
        await writeFile(destination, "runtime archive");
      },
      extractArchive: async ({ destination }) => {
        const launcher = path.join(destination, "bin", "openviking-server");
        const python = path.join(destination, "bin", "python3");
        await mkdir(path.dirname(launcher), { recursive: true });
        await writeFile(launcher, "");
        await writeFile(python, "");
        await chmod(launcher, 0o755);
        await chmod(python, 0o755);
      },
      allocatePort: async () => 21933,
      spawnProcess: (_command, _args, options) => {
        expect(options.stdio).toEqual(["ignore", "ignore", "pipe"]);
        queueMicrotask(() => {
          child.stderr.end("ModuleNotFoundError: No module named 'mcp.server.fastmcp'");
          child.exitCode = 1;
          child.emit("exit", 1, null);
        });
        return child;
      },
      healthCheck: () => new Promise(() => undefined),
      isProcessAlive: () => false,
    });
    await service.install(manifest());

    await expect(
      service.start({
        embedding: { dense: { provider: "local", model: "model", dimension: 512 } },
        vlm: { provider: "openai-codex", model: "gpt-5.4" },
      }),
    ).rejects.toThrow(
      "ModuleNotFoundError: No module named 'mcp.server.fastmcp'",
    );
  });

  it("rejects checksum mismatches before extracting anything", async () => {
    const root = await temporaryRoot();
    const extractArchive = vi.fn(async () => undefined);
    const { service } = runtimeHarness(root);
    const mismatched = new OpenVikingRuntimeService({
      rootDir: root,
      codexAuthBootstrapPath: path.join(root, "synthetic-codex-home", "auth.json"),
      platform: "darwin",
      arch: "arm64",
      download: async (_url, destination) => writeFile(destination, "tampered"),
      extractArchive,
    });

    await expect(mismatched.install(manifest())).rejects.toThrow("checksum");
    expect(extractArchive).not.toHaveBeenCalled();
    await expect(service.getStatus()).resolves.toMatchObject({ state: "not-installed" });
    // Unusable bytes must not be resumed by the next attempt.
    await expect(access(partialArchivePath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the partial archive after a failed transfer so the next attempt resumes it", async () => {
    const root = await temporaryRoot();
    let attempt = 0;
    const { service } = runtimeHarness(root, {
      download: async (_url, destination) => {
        attempt += 1;
        if (attempt === 1) {
          await writeFile(destination, "runtime ");
          throw new Error("connection reset");
        }
        // The second attempt appends the remainder, exactly as a range request would.
        await writeFile(destination, `${await readFile(destination, "utf8")}archive`);
      },
    });

    await expect(service.install(manifest())).rejects.toThrow("connection reset");
    await expect(readFile(partialArchivePath(root), "utf8")).resolves.toBe("runtime ");

    await expect(service.install(manifest())).resolves.toMatchObject({ state: "stopped" });
  });

  it("reports real download bytes while installing the runtime", async () => {
    const root = await temporaryRoot();
    let finishDownload: () => void = () => undefined;
    const downloadGate = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    const service = new OpenVikingRuntimeService({
      rootDir: root,
      codexAuthBootstrapPath: path.join(root, "synthetic-codex-home", "auth.json"),
      platform: "darwin",
      arch: "arm64",
      download: async (_url, destination, ...args: unknown[]) => {
        const report = args[0] as undefined | ((
          downloadedBytes: number,
          totalBytes?: number,
          bytesPerSecond?: number,
        ) => void);
        report?.(64, 128, 256);
        await downloadGate;
        await writeFile(destination, "runtime archive");
      },
      extractArchive: async ({ destination }) => {
        const executable = path.join(destination, "bin", "openviking-server");
        await mkdir(path.dirname(executable), { recursive: true });
        await writeFile(executable, "#!/bin/sh\n");
      },
    });
    const installation = service.install(manifest());

    try {
      await vi.waitFor(async () => {
        await expect(service.getStatus()).resolves.toMatchObject({
          state: "installing",
          progress: {
            phase: "downloading-runtime",
            downloadedBytes: 64,
            totalBytes: 128,
            bytesPerSecond: 256,
          },
        });
      });
    } finally {
      finishDownload();
      await installation;
    }
  });

  it("requires reinstalling a runtime left behind by a translated Intel process", async () => {
    const root = await temporaryRoot();
    const { service } = runtimeHarness(root);
    await writeFile(
      path.join(root, "active-runtime.json"),
      JSON.stringify(manifest({ arch: "x64" })),
    );

    await expect(service.getStatus()).resolves.toEqual({ state: "not-installed" });
  });

  it("requires reinstalling an older runtime build revision", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "active-runtime.json"),
      JSON.stringify(manifest({ version: "0.4.11" })),
    );
    const service = new OpenVikingRuntimeService({
      rootDir: root,
      codexAuthBootstrapPath: path.join(root, "synthetic-codex-home", "auth.json"),
      platform: "darwin",
      arch: "arm64",
      version: "0.4.11-r4",
    });

    await expect(service.getStatus()).resolves.toEqual({ state: "not-installed" });
    // Starting it anyway would leave a live server the rest of the app treats as
    // absent, which silently disables long-term memory for every hook.
    await expect(
      service.start({
        embedding: { dense: { provider: "local", model: "model", dimension: 512 } },
        vlm: { provider: "openai-codex", model: "gpt-5.4" },
      }),
    ).rejects.toThrow("this build requires 0.4.11-r4");
  });

  it("installs a checksummed local archive only when development mode enables it", async () => {
    const root = await temporaryRoot();
    const archivePath = path.join(root, "development-runtime.tar.gz");
    await writeFile(archivePath, "runtime archive");
    const extractArchive = vi.fn(async ({ destination }: { destination: string }) => {
      const executable = path.join(destination, "bin", "openviking-server");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, "#!/bin/sh\n");
    });
    const service = new OpenVikingRuntimeService({
      rootDir: root,
      codexAuthBootstrapPath: path.join(root, "synthetic-codex-home", "auth.json"),
      platform: "darwin",
      arch: "arm64",
      allowLocalRuntime: true,
      extractArchive,
    });

    await expect(service.install(manifest({
      url: pathToFileURL(archivePath).href,
    }))).resolves.toMatchObject({
      state: "stopped",
      version: "0.4.11",
    });
    expect(extractArchive).toHaveBeenCalledOnce();
  });

  it("rejects a local runtime archive outside development mode", async () => {
    const root = await temporaryRoot();
    const archivePath = path.join(root, "development-runtime.tar.gz");
    await writeFile(archivePath, "runtime archive");
    const service = new OpenVikingRuntimeService({
      rootDir: root,
      codexAuthBootstrapPath: path.join(root, "synthetic-codex-home", "auth.json"),
      platform: "darwin",
      arch: "arm64",
    });

    await expect(service.install(manifest({
      url: pathToFileURL(archivePath).href,
    }))).rejects.toThrow("must use HTTPS");
  });

  it.each(["../escape", "/absolute", "folder/../../escape", "C:\\absolute"] as const)(
    "rejects unsafe archive entry %s",
    (entry) => {
      expect(() => assertSafeArchiveEntry(entry)).toThrow("Unsafe OpenViking archive entry");
    },
  );

  it("does not trust or stop a live PID that fails the persisted runtime health probe", async () => {
    const root = await temporaryRoot();
    const runtime = path.join(root, "runtime", "0.4.11");
    await mkdir(path.join(runtime, "bin"), { recursive: true });
    await writeFile(path.join(runtime, "bin", "openviking-server"), "");
    await writeFile(path.join(root, "active-runtime.json"), JSON.stringify(manifest()));
    await writeFile(path.join(root, "runtime-state.json"), JSON.stringify({ pid: 99999, port: 21933 }));
    const rootApiKey = "b".repeat(64);
    await writeFile(path.join(root, "root-api-key"), `${rootApiKey}\n`);
    const { service, healthProbe, killProcess } = runtimeHarness(root, {
      alive: true,
      healthy: false,
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      state: "stopped",
      version: "0.4.11",
    });
    expect(healthProbe).toHaveBeenCalledWith("http://127.0.0.1:21933", rootApiKey);
    await expect(readFile(path.join(root, "runtime-state.json"), "utf8")).rejects.toThrow();
    await service.stop();
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("terminates a healthy persisted runtime with SIGTERM alone", async () => {
    const root = await temporaryRoot();
    await persistedRuntimeFixture(root);
    let alive = true;
    const { service, killProcess, forceKillProcess } = runtimeHarness(root, {
      isProcessAlive: () => alive,
      stopTimeoutMs: 100,
    });
    killProcess.mockImplementation(() => {
      alive = false;
    });

    await service.stop();
    expect(killProcess).toHaveBeenCalledWith(99999);
    expect(forceKillProcess).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, "runtime-state.json"), "utf8")).rejects.toThrow();
    await expect(service.getStatus()).resolves.toMatchObject({ state: "stopped" });
  });

  it("escalates to SIGKILL when the persisted runtime ignores SIGTERM", async () => {
    const root = await temporaryRoot();
    await persistedRuntimeFixture(root);
    let alive = true;
    const { service, killProcess, forceKillProcess } = runtimeHarness(root, {
      isProcessAlive: () => alive,
      stopTimeoutMs: 100,
    });
    forceKillProcess.mockImplementation(() => {
      alive = false;
    });

    await service.stop();
    expect(killProcess).toHaveBeenCalledWith(99999);
    expect(forceKillProcess).toHaveBeenCalledWith(99999);
    await expect(readFile(path.join(root, "runtime-state.json"), "utf8")).rejects.toThrow();
  });

  it("records a warning when the persisted runtime survives forced termination", async () => {
    const root = await temporaryRoot();
    await persistedRuntimeFixture(root);
    const { service, killProcess, forceKillProcess } = runtimeHarness(root, {
      isProcessAlive: () => true,
      stopTimeoutMs: 100,
    });

    await service.stop();
    expect(killProcess).toHaveBeenCalledWith(99999);
    expect(forceKillProcess).toHaveBeenCalledWith(99999);
    const diagnostics = await service.getDiagnostics();
    expect(diagnostics.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "warning",
        type: "stop",
        message: expect.stringContaining("did not exit after forced termination"),
      }),
    ]));
  }, 10_000);

  it("waits for the owned runtime child to exit after escalating to SIGKILL", async () => {
    const root = await temporaryRoot();
    const child = new FakeChild(false);
    const signals: Array<string | undefined> = [];
    child.kill = ((signal?: string) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        setTimeout(() => child.finishExit(), 30);
      }
      return true;
    }) as FakeChild["kill"];
    const { service } = runtimeHarness(root, { child, stopTimeoutMs: 100 });
    await service.install(manifest());
    await service.start({
      embedding: { dense: { provider: "local", model: "model", dimension: 512 } },
      vlm: { provider: "openai-codex", model: "gpt-5.4" },
    });

    await service.stop();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.exitCode).toBe(0);
    await expect(service.getStatus()).resolves.toMatchObject({ state: "stopped" });
  });

  it.runIf(process.platform !== "win32")(
    "treats a zombie persisted process as stopped",
    async () => {
      const root = await temporaryRoot();
      const service = await runtimeWithPersistedCurrentProcess(root);
      await withFakePs(root, 'printf "Z\\n"', async () => {
        await expect(service.getStatus()).resolves.toMatchObject({ state: "stopped" });
        await expect(readFile(path.join(root, "runtime-state.json"), "utf8")).rejects.toThrow();
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "treats a persisted process that disappears before ps returns as stopped",
    async () => {
      const root = await temporaryRoot();
      const service = await runtimeWithPersistedCurrentProcess(root);
      await withFakePs(root, "exit 1", async () => {
        await expect(service.getStatus()).resolves.toMatchObject({ state: "stopped" });
        await expect(readFile(path.join(root, "runtime-state.json"), "utf8")).rejects.toThrow();
      });
    },
  );

  it("uses the packaged Windows Python instead of the non-relocatable pip launcher", async () => {
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
      path.join(root, "runtime", "0.4.11", "python.exe"),
    );
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining([
      "-c",
      expect.stringContaining("openviking_cli.server_bootstrap"),
    ]));
  });
});
