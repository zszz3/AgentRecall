import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

import type {
  OpenVikingRuntimeInstallProgress,
  OpenVikingRuntimeStatus,
} from "../../core/openviking-memory";

const OPENVIKING_SERVER_BOOTSTRAP = [
  "from openviking_cli.server_bootstrap import main",
  "raise SystemExit(main())",
].join("; ");

export interface OpenVikingRuntimeManifest {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  url: string;
  sha256: string;
  executablePath: string;
  archiveType: "tar.gz";
}

export interface OpenVikingServerConfig {
  embedding: {
    dense: {
      provider: string;
      model: string;
      dimension: number;
      api_base?: string;
      api_key?: string;
      model_path?: string;
    };
  };
  vlm: {
    provider: string;
    model: string;
    api_base?: string;
    api_key?: string;
  };
}

interface RuntimeChild {
  pid?: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface ExtractArchiveInput {
  archivePath: string;
  destination: string;
  validateEntry(entryPath: string): void;
}

interface RuntimeServiceOptions {
  rootDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  allowLocalRuntime?: boolean;
  download?: (
    url: string,
    destination: string,
    onProgress?: (
      downloadedBytes: number,
      totalBytes?: number,
      bytesPerSecond?: number,
    ) => void,
  ) => Promise<void>;
  extractArchive?: (input: ExtractArchiveInput) => Promise<void>;
  allocatePort?: () => Promise<number>;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "ignore" },
  ) => RuntimeChild;
  healthCheck?: (baseUrl: string, rootApiKey: string) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
}

interface PersistedRuntimeState {
  pid: number;
  port: number;
}

export class OpenVikingRuntimeService {
  private readonly rootDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly allowLocalRuntime: boolean;
  private readonly download: NonNullable<RuntimeServiceOptions["download"]>;
  private readonly extractArchive: NonNullable<RuntimeServiceOptions["extractArchive"]>;
  private readonly allocatePort: NonNullable<RuntimeServiceOptions["allocatePort"]>;
  private readonly spawnProcess: NonNullable<RuntimeServiceOptions["spawnProcess"]>;
  private readonly healthCheck: NonNullable<RuntimeServiceOptions["healthCheck"]>;
  private readonly isProcessAlive: NonNullable<RuntimeServiceOptions["isProcessAlive"]>;
  private readonly killProcess: NonNullable<RuntimeServiceOptions["killProcess"]>;
  private child: RuntimeChild | null = null;
  private transientStatus: OpenVikingRuntimeStatus | null = null;

  constructor(options: RuntimeServiceOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.allowLocalRuntime = options.allowLocalRuntime === true;
    this.download = options.download ?? downloadFile;
    this.extractArchive = options.extractArchive ?? extractTarGz;
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      spawn(command, [...args], spawnOptions) as ChildProcess);
    this.healthCheck = options.healthCheck ?? waitForHealthyServer;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.killProcess = options.killProcess ?? ((pid) => process.kill(pid, "SIGTERM"));
  }

  async getStatus(): Promise<OpenVikingRuntimeStatus> {
    if (this.transientStatus) return this.transientStatus;
    const manifest = await this.readActiveManifest();
    if (!manifest) return { state: "not-installed" };
    if (this.child?.exitCode === null) {
      const state = await this.readRuntimeState();
      return {
        state: "running",
        version: manifest.version,
        ...(state ? { port: state.port } : {}),
      };
    }
    const persisted = await this.readRuntimeState();
    if (persisted) {
      if (this.isProcessAlive(persisted.pid)) {
        return { state: "running", version: manifest.version, port: persisted.port };
      }
      await rm(this.runtimeStatePath(), { force: true });
    }
    return { state: "stopped", version: manifest.version };
  }

  async install(
    manifest: OpenVikingRuntimeManifest,
    onProgress?: (progress: OpenVikingRuntimeInstallProgress) => void,
  ): Promise<OpenVikingRuntimeStatus> {
    this.validateManifest(manifest);
    const reportProgress = (progress: OpenVikingRuntimeInstallProgress) => {
      this.transientStatus = {
        state: "installing",
        version: manifest.version,
        progress,
      };
      onProgress?.(progress);
    };
    reportProgress({ phase: "downloading-runtime" });
    const downloadsDir = this.resolveOwnedPath("downloads");
    const runtimeDir = this.resolveOwnedPath("runtime");
    const archivePath = path.join(downloadsDir, `openviking-${manifest.version}-${manifest.platform}-${manifest.arch}.tar.gz`);
    const partialPath = `${archivePath}.part`;
    const stagingPath = path.join(runtimeDir, `.staging-${manifest.version}-${randomUUID()}`);
    const targetPath = path.join(runtimeDir, manifest.version);
    try {
      await mkdir(downloadsDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
      await rm(partialPath, { force: true });
      await this.download(manifest.url, partialPath, (downloadedBytes, totalBytes, bytesPerSecond) => {
        reportProgress({
          phase: "downloading-runtime",
          downloadedBytes,
          ...(totalBytes === undefined ? {} : { totalBytes }),
          ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
        });
      });
      reportProgress({ phase: "verifying-runtime" });
      const actualSha = await sha256File(partialPath);
      if (actualSha !== manifest.sha256.toLowerCase()) {
        throw new Error(`OpenViking runtime checksum mismatch: expected ${manifest.sha256}, received ${actualSha}.`);
      }
      await rename(partialPath, archivePath);
      reportProgress({ phase: "installing-runtime" });
      await mkdir(stagingPath, { recursive: true });
      await this.extractArchive({
        archivePath,
        destination: stagingPath,
        validateEntry: assertSafeArchiveEntry,
      });
      const executable = resolveArchivePath(stagingPath, manifest.executablePath);
      const executableStat = await stat(executable);
      if (!executableStat.isFile()) throw new Error("OpenViking runtime executable is not a regular file.");
      if (this.platform !== "win32") await chmod(executable, 0o755);
      await rm(targetPath, { recursive: true, force: true });
      await rename(stagingPath, targetPath);
      await this.writePrivateJson(this.activeManifestPath(), manifest);
      this.transientStatus = null;
      return this.getStatus();
    } catch (error) {
      await rm(partialPath, { force: true });
      await rm(stagingPath, { recursive: true, force: true });
      this.transientStatus = null;
      throw error;
    }
  }

  async start(config: OpenVikingServerConfig): Promise<OpenVikingRuntimeStatus> {
    const current = await this.getStatus();
    if (current.state === "running") return current;
    const manifest = await this.readActiveManifest();
    if (!manifest) throw new Error("OpenViking runtime is not installed.");
    this.validateManifest(manifest);
    this.transientStatus = { state: "starting", version: manifest.version };
    const runtimePath = this.resolveOwnedPath("runtime", manifest.version);
    const executable = resolveArchivePath(runtimePath, manifest.executablePath);
    await access(executable);
    const python = resolveArchivePath(
      runtimePath,
      this.platform === "win32" ? "python.exe" : "bin/python3",
    );
    await access(python);
    const port = await this.allocatePort();
    const rootApiKey = await this.loadOrCreateRootApiKey();
    await mkdir(this.resolveOwnedPath("data"), { recursive: true });
    const configPath = this.resolveOwnedPath("ov.conf");
    await this.writePrivateJson(configPath, {
      ...config,
      storage: {
        workspace: this.resolveOwnedPath("data"),
        agfs: { backend: "local" },
        vectordb: { backend: "local" },
      },
      server: {
        host: "127.0.0.1",
        port,
        auth_mode: "api_key",
        root_api_key: rootApiKey,
        cors_origins: [],
      },
    });
    const args = [
      "-c",
      OPENVIKING_SERVER_BOOTSTRAP,
      "--config",
      configPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ];
    const child = this.spawnProcess(python, args, {
      cwd: this.resolveOwnedPath("data"),
      env: {
        ...process.env,
        OPENVIKING_CONFIG_FILE: configPath,
        OPENVIKING_SERVER_HOST: "127.0.0.1",
      },
      stdio: "ignore",
    });
    if (!child.pid) {
      child.kill();
      this.transientStatus = null;
      throw new Error("OpenViking runtime did not report a process ID.");
    }
    this.child = child;
    await this.writePrivateJson(this.runtimeStatePath(), { pid: child.pid, port });
    child.once("exit", () => {
      if (this.child === child) this.child = null;
      void rm(this.runtimeStatePath(), { force: true });
    });
    try {
      await this.healthCheck(`http://127.0.0.1:${port}`, rootApiKey);
      this.transientStatus = null;
      return this.getStatus();
    } catch (error) {
      child.kill();
      await rm(this.runtimeStatePath(), { force: true });
      this.child = null;
      this.transientStatus = null;
      throw new Error("OpenViking runtime failed its health check.", { cause: error });
    }
  }

  async stop(): Promise<OpenVikingRuntimeStatus> {
    const state = await this.readRuntimeState();
    if (this.child?.exitCode === null) {
      this.child.kill("SIGTERM");
      this.child = null;
    } else if (state && this.isProcessAlive(state.pid)) {
      this.killProcess(state.pid);
    }
    await rm(this.runtimeStatePath(), { force: true });
    this.transientStatus = null;
    return this.getStatus();
  }

  async getConnection(): Promise<{ baseUrl: string; rootApiKey: string }> {
    const status = await this.getStatus();
    if (status.state !== "running" || !status.port) {
      throw new Error("OpenViking runtime is not running.");
    }
    return {
      baseUrl: `http://127.0.0.1:${status.port}`,
      rootApiKey: await this.loadOrCreateRootApiKey(),
    };
  }

  private validateManifest(manifest: OpenVikingRuntimeManifest): void {
    if (manifest.platform !== this.platform || manifest.arch !== this.arch) {
      throw new Error(`OpenViking runtime does not match ${this.platform}-${this.arch}.`);
    }
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(manifest.version)) {
      throw new Error("OpenViking runtime version is invalid.");
    }
    const runtimeUrl = new URL(manifest.url);
    if (runtimeUrl.protocol === "file:" && this.allowLocalRuntime) {
      const localPath = path.resolve(fileURLToPath(runtimeUrl));
      const relative = path.relative(this.rootDir, localPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("OpenViking development runtime escaped the application-owned directory.");
      }
    } else if (runtimeUrl.protocol !== "https:") {
      throw new Error("OpenViking runtime URL must use HTTPS.");
    }
    if (!/^[a-f0-9]{64}$/u.test(manifest.sha256.toLowerCase())) {
      throw new Error("OpenViking runtime checksum is invalid.");
    }
    assertSafeArchiveEntry(manifest.executablePath);
  }

  private async readActiveManifest(): Promise<OpenVikingRuntimeManifest | null> {
    return readJsonFile<OpenVikingRuntimeManifest>(this.activeManifestPath());
  }

  private async readRuntimeState(): Promise<PersistedRuntimeState | null> {
    const state = await readJsonFile<PersistedRuntimeState>(this.runtimeStatePath());
    if (!state || !Number.isInteger(state.pid) || !Number.isInteger(state.port)) return null;
    return state;
  }

  private async loadOrCreateRootApiKey(): Promise<string> {
    const keyPath = this.resolveOwnedPath("root-api-key");
    try {
      const current = (await readFile(keyPath, "utf8")).trim();
      if (/^[a-f0-9]{64}$/u.test(current)) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const key = randomBytes(32).toString("hex");
    await mkdir(path.dirname(keyPath), { recursive: true });
    await writeFile(keyPath, `${key}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(keyPath, 0o600);
    return key;
  }

  private async writePrivateJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(filePath, 0o600);
  }

  private activeManifestPath(): string {
    return this.resolveOwnedPath("active-runtime.json");
  }

  private runtimeStatePath(): string {
    return this.resolveOwnedPath("runtime-state.json");
  }

  private resolveOwnedPath(...segments: string[]): string {
    const resolved = path.resolve(this.rootDir, ...segments);
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("OpenViking path escaped the application-owned directory.");
    }
    return resolved;
  }
}

export function assertSafeArchiveEntry(entryPath: string): void {
  const portable = entryPath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(portable);
  if (
    !portable
    || portable.includes("\0")
    || path.posix.isAbsolute(portable)
    || /^[A-Za-z]:\//u.test(portable)
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error(`Unsafe OpenViking archive entry: ${entryPath}`);
  }
}

function resolveArchivePath(root: string, archivePath: string): string {
  assertSafeArchiveEntry(archivePath);
  const resolved = path.resolve(root, ...archivePath.replaceAll("\\", "/").split("/"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe OpenViking archive entry: ${archivePath}`);
  }
  return resolved;
}

async function downloadFile(
  url: string,
  destination: string,
  onProgress?: (
    downloadedBytes: number,
    totalBytes?: number,
    bytesPerSecond?: number,
  ) => void,
): Promise<void> {
  const source = new URL(url);
  if (source.protocol === "file:") {
    const sourcePath = fileURLToPath(source);
    const totalBytes = (await stat(sourcePath)).size;
    await pipeline(
      createReadStream(sourcePath),
      createDownloadProgressTransform(totalBytes, onProgress),
      createWriteStream(destination, { mode: 0o600 }),
    );
    return;
  }
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`OpenViking runtime download failed with HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  const totalBytes = Number.isSafeInteger(contentLength) && contentLength > 0
    ? contentLength
    : undefined;
  const body = Readable.fromWeb(response.body as never);
  await pipeline(
    body,
    createDownloadProgressTransform(totalBytes, onProgress),
    createWriteStream(destination, { mode: 0o600 }),
  );
}

function createDownloadProgressTransform(
  totalBytes: number | undefined,
  onProgress?: (
    downloadedBytes: number,
    totalBytes?: number,
    bytesPerSecond?: number,
  ) => void,
): Transform {
  let downloadedBytes = 0;
  const startedAt = Date.now();
  onProgress?.(downloadedBytes, totalBytes);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.byteLength;
      const elapsedMs = Date.now() - startedAt;
      const bytesPerSecond = elapsedMs >= 250
        ? Math.round(downloadedBytes / (elapsedMs / 1_000))
        : undefined;
      onProgress?.(downloadedBytes, totalBytes, bytesPerSecond);
      callback(null, chunk);
    },
  });
}

async function extractTarGz(input: ExtractArchiveInput): Promise<void> {
  await tar.x({
    cwd: input.destination,
    file: input.archivePath,
    gzip: true,
    preservePaths: false,
    strict: true,
    onReadEntry(entry) {
      input.validateEntry(entry.path);
      if (entry.linkpath) input.validateEntry(entry.linkpath);
    },
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealthyServer(baseUrl: string, rootApiKey: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${rootApiKey}` },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("OpenViking health endpoint did not become ready.", { cause: lastError });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
