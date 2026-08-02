import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
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
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as tar from "tar";

import type {
  OpenVikingRuntimeInstallProgress,
  OpenVikingRuntimeStatus,
} from "../../core/openviking-memory";
import type { OpenVikingExtractionReasoningEffort } from "../../core/platform";
import { downloadFileWithResume } from "./openviking-download";

const OPENVIKING_SERVER_BOOTSTRAP = [
  "from openviking_cli.server_bootstrap import main",
  "raise SystemExit(main())",
].join("; ");
const SUPPORTED_OPENVIKING_PACKAGE_VERSION = "0.4.11";
const execFileAsync = promisify(execFile);

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
    reasoning_effort?: OpenVikingExtractionReasoningEffort;
  };
}

interface RuntimeChild {
  pid?: number;
  exitCode: number | null;
  stderr?: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: "exit", listener: (...args: unknown[]) => void): this;
}

interface ExtractArchiveInput {
  archivePath: string;
  destination: string;
  validateEntry(entryPath: string): void;
}

interface RuntimeServiceOptions {
  rootDir: string;
  codexAuthBootstrapPath: string;
  configuredRuntimePath?: () => string | undefined;
  resolveRuntimeVersion?: (pythonPath: string) => Promise<string>;
  version?: string;
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
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: ["ignore", "ignore", "pipe"];
    },
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
  private readonly codexAuthBootstrapPath: string;
  private readonly configuredRuntimePath: NonNullable<RuntimeServiceOptions["configuredRuntimePath"]>;
  private readonly resolveRuntimeVersion: NonNullable<RuntimeServiceOptions["resolveRuntimeVersion"]>;
  private readonly version: string | undefined;
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
    this.codexAuthBootstrapPath = path.resolve(options.codexAuthBootstrapPath);
    this.configuredRuntimePath = options.configuredRuntimePath ?? (() => undefined);
    this.resolveRuntimeVersion = options.resolveRuntimeVersion ?? resolveInstalledOpenVikingVersion;
    this.version = options.version;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.allowLocalRuntime = options.allowLocalRuntime === true;
    this.download = options.download ?? downloadFileWithResume;
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
    const configured = (this.configuredRuntimePath() ?? "").trim();
    const manifest = configured ? null : await this.readActiveManifest();
    if (!configured) {
      if (!manifest) return { state: "not-installed" };
      if (
        (this.version !== undefined && manifest.version !== this.version)
        || manifest.platform !== this.platform
        || manifest.arch !== this.arch
      ) {
        return { state: "not-installed" };
      }
    }
    let installedBytes: number | undefined;
    if (manifest) {
      try {
        installedBytes = (await stat(this.runtimeArchivePath(manifest))).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const version = manifest?.version ?? this.version;
    if (this.child?.exitCode === null) {
      const state = await this.readRuntimeState();
      return {
        state: "running",
        ...(version ? { version } : {}),
        ...(state ? { port: state.port } : {}),
        ...(installedBytes === undefined ? {} : { installedBytes }),
      };
    }
    const persisted = await this.readRuntimeState();
    if (persisted) {
      if (this.isProcessAlive(persisted.pid)) {
        return {
          state: "running",
          ...(version ? { version } : {}),
          port: persisted.port,
          ...(installedBytes === undefined ? {} : { installedBytes }),
        };
      }
      await rm(this.runtimeStatePath(), { force: true });
    }
    if (configured) {
      try {
        const configuredPath = this.configuredRuntimeRoot(configured);
        const pythonPath = await this.requireRuntimeExecutables(configuredPath);
        await this.requireSupportedVersion(pythonPath);
        return {
          state: "stopped",
          ...(version ? { version } : {}),
        };
      } catch (error) {
        return {
          state: "error",
          ...(version ? { version } : {}),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      state: "stopped",
      version: manifest!.version,
      ...(installedBytes === undefined ? {} : { installedBytes }),
    };
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
    const archivePath = this.runtimeArchivePath(manifest);
    const partialPath = `${archivePath}.part`;
    const stagingPath = path.join(runtimeDir, `.staging-${manifest.version}-${randomUUID()}`);
    const targetPath = path.join(runtimeDir, manifest.version);
    try {
      await mkdir(downloadsDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
      // A partial file from an interrupted attempt is kept so the download resumes there.
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
        // The bytes on disk are unusable, so a retry has to start over rather than resume.
        await rm(partialPath, { force: true });
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
      await rm(stagingPath, { recursive: true, force: true });
      this.transientStatus = null;
      throw error;
    }
  }

  async start(config: OpenVikingServerConfig): Promise<OpenVikingRuntimeStatus> {
    const current = await this.getStatus();
    if (current.state === "running") return current;
    const configured = (this.configuredRuntimePath() ?? "").trim();
    const configuredPath = configured ? this.configuredRuntimeRoot(configured) : null;
    const manifest = configuredPath ? null : await this.readActiveManifest();
    if (!configuredPath && !manifest) throw new Error("OpenViking runtime is not installed.");
    if (manifest) this.validateManifest(manifest);
    const runtimePath = configuredPath ?? this.resolveOwnedPath("runtime", manifest!.version);
    const executablePath = manifest?.executablePath
      ?? (this.platform === "win32" ? "Scripts/openviking-server.exe" : "bin/openviking-server");
    const python = await this.requireRuntimeExecutables(runtimePath, executablePath);
    if (configuredPath) await this.requireSupportedVersion(python);
    this.transientStatus = {
      state: "starting",
      version: manifest?.version ?? this.version,
      ...(current.installedBytes === undefined ? {} : { installedBytes: current.installedBytes }),
    };
    const port = await this.allocatePort();
    const rootApiKey = await this.loadOrCreateRootApiKey();
    await mkdir(this.resolveOwnedPath("data"), { recursive: true });
    await mkdir(this.resolveOwnedPath("auth"), { recursive: true });
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
        OPENVIKING_CODEX_AUTH_PATH: this.resolveOwnedPath("auth", "codex_auth.json"),
        OPENVIKING_CODEX_BOOTSTRAP_PATH: this.codexAuthBootstrapPath,
        OPENVIKING_SERVER_HOST: "127.0.0.1",
        // litellm otherwise fetches its price table from raw.githubusercontent.com while
        // importing, which costs ~8s on networks that cannot reach it. Local embedding and
        // Codex VLM never read those prices, so the bundled backup table is enough.
        LITELLM_LOCAL_MODEL_COST_MAP: "True",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (!child.pid) {
      child.kill();
      this.transientStatus = null;
      throw new Error("OpenViking runtime did not report a process ID.");
    }
    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-16_384);
    });
    this.child = child;
    let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
    const exited = new Promise<Error>((resolve) => {
      exitListener = (code, signal) => {
        const detail = stderrTail.trim();
        const reason = signal
          ? `signal ${signal}`
          : `exit code ${code ?? "unknown"}`;
        resolve(new Error(
          detail
            ? `OpenViking process exited with ${reason}:\n${detail}`
            : `OpenViking process exited with ${reason}.`,
        ));
      };
      child.once("exit", exitListener);
    });
    const runtimeStateWrite = this.writePrivateJson(this.runtimeStatePath(), { pid: child.pid, port });
    child.once("exit", () => {
      if (this.child === child) this.child = null;
      void runtimeStateWrite.then(
        () => rm(this.runtimeStatePath(), { force: true }),
        () => undefined,
      );
    });
    try {
      await runtimeStateWrite;
      const startupError = await Promise.race([
        this.healthCheck(`http://127.0.0.1:${port}`, rootApiKey).then(() => null),
        exited,
      ]);
      if (startupError) throw startupError;
      if (exitListener) child.removeListener("exit", exitListener);
      this.transientStatus = null;
      return this.getStatus();
    } catch (error) {
      if (child.exitCode === null) child.kill();
      await rm(this.runtimeStatePath(), { force: true });
      this.child = null;
      this.transientStatus = null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenViking runtime failed to start: ${detail}`, { cause: error });
    }
  }

  async startFromPersistedConfig(): Promise<OpenVikingRuntimeStatus> {
    const configPath = this.resolveOwnedPath("ov.conf");
    let persisted: Partial<OpenVikingServerConfig>;
    try {
      persisted = JSON.parse(await readFile(configPath, "utf8")) as Partial<OpenVikingServerConfig>;
    } catch (error) {
      throw new Error("OpenViking has no usable previous configuration for cleanup.", { cause: error });
    }
    if (!persisted.embedding?.dense || !persisted.vlm) {
      throw new Error("OpenViking has no usable previous configuration for cleanup.");
    }
    return this.start({
      embedding: persisted.embedding,
      vlm: persisted.vlm,
    });
  }

  async stop(): Promise<OpenVikingRuntimeStatus> {
    const state = await this.readRuntimeState();
    const child = this.child;
    if (child?.exitCode === null) {
      await stopRuntimeChild(child);
      this.child = null;
    } else if (state && this.isProcessAlive(state.pid)) {
      this.killProcess(state.pid);
      await waitForProcessExit(state.pid, this.isProcessAlive);
    }
    await rm(this.runtimeStatePath(), { force: true });
    this.transientStatus = null;
    return this.getStatus();
  }

  async clearData(): Promise<void> {
    if ((await this.getStatus()).state === "running") {
      throw new Error("Stop OpenViking before clearing its data.");
    }
    await rm(this.resolveOwnedPath("data"), { recursive: true, force: true });
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

  private runtimeArchivePath(manifest: OpenVikingRuntimeManifest): string {
    return path.join(
      this.resolveOwnedPath("downloads"),
      `openviking-${manifest.version}-${manifest.platform}-${manifest.arch}.tar.gz`,
    );
  }

  async validateConfiguredPath(configuredPath?: string): Promise<void> {
    const configured = (configuredPath ?? "").trim();
    if (!configured) return;
    const python = await this.requireRuntimeExecutables(this.configuredRuntimeRoot(configured));
    await this.requireSupportedVersion(python);
  }

  private async requireSupportedVersion(pythonPath: string): Promise<void> {
    const installedVersion = await this.resolveRuntimeVersion(pythonPath);
    if (installedVersion !== SUPPORTED_OPENVIKING_PACKAGE_VERSION) {
      throw new Error(
        `OpenViking ${installedVersion || "unknown"} is not supported. Install OpenViking ${SUPPORTED_OPENVIKING_PACKAGE_VERSION} and configure that runtime directory.`,
      );
    }
  }

  private configuredRuntimeRoot(configured: string): string {
    if (!path.isAbsolute(configured)) {
      throw new Error("OpenViking runtime path must be an absolute path.");
    }
    return path.resolve(configured);
  }

  private async requireRuntimeExecutables(
    runtimePath: string,
    executablePath = this.platform === "win32" ? "Scripts/openviking-server.exe" : "bin/openviking-server",
  ): Promise<string> {
    const executable = resolveArchivePath(runtimePath, executablePath);
    const python = resolveArchivePath(
      runtimePath,
      this.platform === "win32" ? "python.exe" : "bin/python3",
    );
    try {
      await Promise.all([access(executable), access(python)]);
    } catch (error) {
      throw new Error(
        `OpenViking runtime path does not contain ${executablePath} and ${this.platform === "win32" ? "python.exe" : "bin/python3"}.`,
        { cause: error },
      );
    }
    return python;
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

async function resolveInstalledOpenVikingVersion(pythonPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      pythonPath,
      ["-c", "from importlib.metadata import version; print(version('openviking'))"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    return stdout.trim();
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : "";
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`Could not inspect the configured OpenViking runtime: ${detail}`, { cause: error });
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

async function stopRuntimeChild(child: RuntimeChild): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve();
    };
    const onExit = () => finish();
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 15_000);
    child.once("exit", onExit);
    child.kill("SIGTERM");
  });
}

async function waitForProcessExit(
  pid: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "state="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  const state = result.stdout?.trim();
  if (!state) {
    return result.status !== 1 || Boolean(result.stderr?.trim());
  }
  return !state.startsWith("Z");
}
