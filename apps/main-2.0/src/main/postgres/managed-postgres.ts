import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Client } from "pg";

const moduleRequire = createRequire(import.meta.url);

export interface EmbeddedPostgresOptions {
  databaseDir: string;
  port: number;
  user: string;
  password: string;
  persistent: boolean;
  authMethod?: "scram-sha-256" | "password" | "md5";
  initdbFlags?: string[];
  postgresFlags?: string[];
  onLog?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export interface EmbeddedPostgresInstance {
  initialise(): Promise<void>;
  start(): Promise<void>;
  createDatabase(name: string): Promise<void>;
  stop(): Promise<void>;
}

export interface PostgresRuntime {
  connectionUrl: string;
  managed: boolean;
  stop(): Promise<void>;
}

interface StartPostgresRuntimeOptions {
  userDataPath: string;
  /** Only the exclusive session backend may adopt an orphaned managed instance. */
  adoptExisting?: boolean;
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  createEmbedded?: (
    options: EmbeddedPostgresOptions,
  ) => EmbeddedPostgresInstance | Promise<EmbeddedPostgresInstance>;
  probeExistingRuntime?: (
    connectionUrl: string,
  ) => Promise<ExistingPostgresRuntime | null>;
  resolveEmbeddedRuntime?: (
    platform: NodeJS.Platform,
    arch: string,
  ) => Promise<EmbeddedPostgresRuntime>;
  stopExistingRuntime?: (
    input: StopExistingPostgresRuntimeInput,
  ) => Promise<void>;
  choosePort?: () => Promise<number>;
  canBindPort?: (port: number, host: string) => Promise<boolean>;
  createPassword?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
}

interface ExistingPostgresRuntime {
  dataDirectory: string;
  libraryDirectory: string;
  majorVersion: number;
}

interface EmbeddedPostgresRuntime {
  pgCtlPath: string;
  libraryDirectory: string;
  majorVersion: number;
}

interface StopExistingPostgresRuntimeInput {
  pgCtlPath: string;
  dataDirectory: string;
}

interface RuntimeConfig {
  version: 1;
  host: "127.0.0.1";
  port: number;
  user: "agent_recall";
  password: string;
  database: "agent_recall";
  initialized: boolean;
}

const RUNTIME_CONFIG_NAME = "runtime.json";
const MAX_PORT_RECOVERY_RETRIES = 3;
const MAX_STARTUP_LOG_CHUNKS = 64;
const MAX_STARTUP_LOG_CHARS = 16_384;
const PG_READY_LOG_LINE = "database system is ready to accept connections";
const PORT_BIND_ERROR_CODES = new Set(["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"]);
const PORT_BIND_MESSAGE_PATTERN =
  /\b(?:EADDRINUSE|EACCES|EADDRNOTAVAIL)\b|could not bind\b|could not create listen socket|could not create any TCP\/IP sockets|address already in use|Only one usage of each socket address|access a socket in a way forbidden/iu;
const EMBEDDED_POSTGRES_PACKAGES: Record<string, Record<string, string>> = {
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
const EMBEDDED_POSTGRES_PROCESS_EVENTS = [
  "exit",
  "beforeExit",
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
  "SIGBREAK",
  "message",
] as const;

export async function startPostgresRuntime(
  options: StartPostgresRuntimeOptions,
): Promise<PostgresRuntime> {
  const environment = options.environment ?? process.env;
  const externalUrl = environment.AGENT_RECALL_DATABASE_URL?.trim();
  if (externalUrl) {
    assertPostgresUrl(externalUrl);
    return {
      connectionUrl: externalUrl,
      managed: false,
      stop: async () => undefined,
    };
  }

  const runtimeDirectory = path.join(options.userDataPath, "postgres");
  const configPath = path.join(runtimeDirectory, RUNTIME_CONFIG_NAME);
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const existingConfig = await readRuntimeConfig(configPath);
  const config: RuntimeConfig = existingConfig ?? {
    version: 1,
    host: "127.0.0.1",
    port: await (options.choosePort ?? chooseAvailablePort)(),
    user: "agent_recall",
    password: (options.createPassword ?? createRuntimePassword)(),
    database: "agent_recall",
    initialized: false,
  };
  if (!existingConfig) await writeRuntimeConfig(configPath, config);

  const dataDirectory = path.join(runtimeDirectory, "data");
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  let resolvedRuntime: EmbeddedPostgresRuntime | undefined;
  let portNeedsReallocation = false;

  if (existingConfig?.initialized) {
    resolvedRuntime = await (
      options.resolveEmbeddedRuntime ?? resolveEmbeddedRuntime
    )(platform, arch);
    const dataMajorVersion = await readPostgresDataMajorVersion(dataDirectory);
    if (dataMajorVersion !== resolvedRuntime.majorVersion) {
      throw new Error("Managed PostgreSQL data uses a different major version; automatic recovery was refused.");
    }
    let existingRuntime: ExistingPostgresRuntime | null = null;
    try {
      existingRuntime = await (
        options.probeExistingRuntime ?? probeExistingRuntime
      )(runtimeConnectionUrl(config));
    } catch (error) {
      if (await hasLivePostmasterPid(dataDirectory)) {
        throw error;
      }
      // Our offline cluster holds no live postmaster.pid, so a probe failure
      // indicates a foreign listener or OS obstacle on the saved port.
      portNeedsReallocation = true;
    }
    if (existingRuntime) {
      if (!await pathsReferToSameLocation(existingRuntime.dataDirectory, dataDirectory, platform)) {
        throw new Error("Managed PostgreSQL is running from an unexpected data directory; automatic recovery was refused.");
      }
      if (
        existingRuntime.majorVersion !== dataMajorVersion
        || existingRuntime.majorVersion !== resolvedRuntime.majorVersion
      ) {
        throw new Error("Managed PostgreSQL uses a different major version; automatic recovery was refused.");
      }
      if (
        await pathsReferToSameLocation(
          existingRuntime.libraryDirectory,
          resolvedRuntime.libraryDirectory,
          platform,
        )
      ) {
        const connectionUrl = runtimeConnectionUrl(config);
        const adoptedRuntime = resolvedRuntime;
        let stopped = false;
        return {
          connectionUrl,
          managed: true,
          stop: async () => {
            if (!options.adoptExisting || stopped) return;
            stopped = true;
            await (options.stopExistingRuntime ?? stopExistingRuntime)({ pgCtlPath: adoptedRuntime.pgCtlPath, dataDirectory });
          },
        };
      }
      await (options.stopExistingRuntime ?? stopExistingRuntime)({
        pgCtlPath: resolvedRuntime.pgCtlPath,
        dataDirectory,
      });
    }
  }

  const choosePort = options.choosePort ?? chooseAvailablePort;
  let remainingPortRetries = MAX_PORT_RECOVERY_RETRIES;
  const rotatePort = async (): Promise<void> => {
    const nextPort = await choosePort();
    if (nextPort !== config.port) {
      config.port = nextPort;
      await writeRuntimeConfig(configPath, config);
    }
  };
  if (portNeedsReallocation) {
    remainingPortRetries -= 1;
    await rotatePort();
  }

  // Only pre-check bindability on reused configs (e.g. Windows WinNAT changes
  // across reboots) or when explicitly injected; fresh starts already bound :0
  // via chooseAvailablePort and avoid breaking mocked createEmbedded tests.
  const checkBindable = options.canBindPort
    ?? (options.createEmbedded || !existingConfig ? undefined : canBindLocalPort);
  const resolveRuntimeForWrapper = async (): Promise<EmbeddedPostgresRuntime | undefined> => {
    if (resolvedRuntime) return resolvedRuntime;
    if (!options.resolveEmbeddedRuntime) return undefined;
    resolvedRuntime = await options.resolveEmbeddedRuntime(platform, arch);
    return resolvedRuntime;
  };
  const createEmbedded = options.createEmbedded
    ?? ((embeddedOptions: EmbeddedPostgresOptions) => defaultCreateEmbedded(embeddedOptions, {
      platform,
      arch,
      resolveRuntime: resolveRuntimeForWrapper,
    }));

  let dataInitialized = config.initialized;
  while (true) {
    if (checkBindable) {
      while (!await checkBindable(config.port, config.host)) {
        if (remainingPortRetries <= 0) {
          throw new Error(`Managed PostgreSQL could not bind local port ${config.port} after retries.`);
        }
        remainingPortRetries -= 1;
        await rotatePort();
      }
    }

    let recordingStartupLogs = true;
    const startupLogs: string[] = [];
    const startupErrors: unknown[] = [];
    const embedded = await createEmbedded({
      databaseDir: dataDirectory,
      port: config.port,
      user: config.user,
      password: config.password,
      persistent: true,
      authMethod: "scram-sha-256",
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-h", config.host],
      onLog: (message) => {
        if (!recordingStartupLogs) return;
        appendStartupLog(startupLogs, message);
      },
      onError: (error) => {
        if (!recordingStartupLogs) return;
        if (startupErrors.length < 16) startupErrors.push(error);
      },
    });

    let started = false;
    try {
      if (!dataInitialized) {
        await embedded.initialise();
        dataInitialized = true;
      }
      try {
        await embedded.start();
      } finally {
        recordingStartupLogs = false;
      }
      started = true;
      if (!config.initialized) {
        try {
          await embedded.createDatabase(config.database);
        } catch (error) {
          if (!isDuplicateDatabaseError(error)) throw error;
        }
        config.initialized = true;
        await writeRuntimeConfig(configPath, config);
      }

      const connectionUrl = runtimeConnectionUrl(config);
      let stopped = false;
      return {
        connectionUrl,
        managed: true,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          await embedded.stop();
        },
      };
    } catch (error) {
      recordingStartupLogs = false;
      if (started) {
        await embedded.stop().catch(() => undefined);
        throw error;
      }
      if (remainingPortRetries > 0 && isPortBindFailure(error, startupLogs, startupErrors)) {
        remainingPortRetries -= 1;
        await rotatePort();
        continue;
      }
      throw normalizeStartupError(error, startupLogs, startupErrors);
    }
  }
}

async function probeExistingRuntime(
  connectionUrl: string,
): Promise<ExistingPostgresRuntime | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client = new Client({
      connectionString: connectionUrl,
      connectionTimeoutMillis: 1_000,
      query_timeout: 1_000,
    });
    // Guard against asynchronous socket errors between connect/query/end on foreign listeners.
    client.on("error", () => undefined);
    try {
      await client.connect();
      const result = await client.query<{
        data_directory: string;
        library_directory: string;
        server_version_num: string;
      }>(`
        select
          current_setting('data_directory') as data_directory,
          current_setting('server_version_num') as server_version_num,
          (select setting from pg_config where name = 'PKGLIBDIR') as library_directory
      `);
      const row = result.rows[0];
      const serverVersion = Number(row?.server_version_num);
      if (
        typeof row?.data_directory !== "string"
        || !row.data_directory
        || typeof row.library_directory !== "string"
        || !row.library_directory
        || !Number.isInteger(serverVersion)
        || serverVersion <= 0
      ) {
        throw new Error("Managed PostgreSQL runtime identity is incomplete.");
      }
      return {
        dataDirectory: row.data_directory,
        libraryDirectory: row.library_directory,
        majorVersion: Math.floor(serverVersion / 10_000),
      };
    } catch (error) {
      if (postgresErrorCode(error) === "ECONNREFUSED") return null;
      if (isTransientPostgresIdentityError(error) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      throw new Error("Managed PostgreSQL runtime identity could not be verified.", { cause: error });
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  throw new Error("Managed PostgreSQL runtime identity could not be verified.");
}

async function resolveEmbeddedRuntime(
  platform: NodeJS.Platform,
  arch: string,
): Promise<EmbeddedPostgresRuntime> {
  const packageName = EMBEDDED_POSTGRES_PACKAGES[platform]?.[arch];
  if (!packageName) throw new Error(`AgentRecall V2 does not support ${platform}-${arch}.`);
  const entryPath = moduleRequire.resolve(packageName);
  const runtimeRoot = path.resolve(path.dirname(entryPath), "..");
  const runtimeManifest = JSON.parse(
    await fs.readFile(path.join(runtimeRoot, "package.json"), "utf8"),
  ) as { version?: unknown };
  const majorVersion = Number.parseInt(String(runtimeManifest.version || "").split(".")[0] || "", 10);
  if (!Number.isInteger(majorVersion) || majorVersion <= 0) {
    throw new Error(`Embedded PostgreSQL runtime ${packageName} has an invalid version.`);
  }
  const executableSuffix = platform === "win32" ? ".exe" : "";
  const extensionSuffix = platform === "win32"
    ? ".dll"
    : platform === "darwin"
      ? ".dylib"
      : ".so";
  const pgCtlPath = path.join(runtimeRoot, "native", "bin", `pg_ctl${executableSuffix}`);
  const libraryDirectory = platform === "win32"
    ? path.join(runtimeRoot, "native", "lib")
    : path.join(runtimeRoot, "native", "lib", "postgresql");
  await Promise.all([
    assertRuntimeFile(pgCtlPath),
    assertRuntimeFile(path.join(libraryDirectory, `pg_trgm${extensionSuffix}`)),
  ]);
  return { pgCtlPath, libraryDirectory, majorVersion };
}

async function assertRuntimeFile(filePath: string): Promise<void> {
  if (!(await fs.stat(filePath)).isFile()) {
    throw new Error(`Embedded PostgreSQL runtime file is invalid: ${filePath}`);
  }
}

async function readPostgresDataMajorVersion(dataDirectory: string): Promise<number> {
  let rawVersion: string;
  try {
    rawVersion = (await fs.readFile(path.join(dataDirectory, "PG_VERSION"), "utf8")).trim();
  } catch (error) {
    throw new Error("Managed PostgreSQL data version could not be verified.", { cause: error });
  }
  if (!/^\d+(?:\.\d+)?$/u.test(rawVersion)) {
    throw new Error("Managed PostgreSQL data version is invalid.");
  }
  const majorVersion = Number(rawVersion);
  if (!Number.isFinite(majorVersion) || majorVersion <= 0) {
    throw new Error("Managed PostgreSQL data version is invalid.");
  }
  return majorVersion;
}

async function pathsReferToSameLocation(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalRuntimePath(left, platform),
    canonicalRuntimePath(right, platform),
  ]);
  return canonicalLeft === canonicalRight;
}

async function canonicalRuntimePath(
  value: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  let resolved = pathApi.resolve(value);
  try {
    resolved = await fs.realpath(resolved);
  } catch {
    // A deleted previous runtime cannot be resolved, but its absolute path is
    // still sufficient to prove that it differs from the current runtime.
  }
  return platform === "win32"
    ? resolved.replace(/\//gu, "\\").toLowerCase()
    : resolved;
}

function stopExistingRuntime(
  input: StopExistingPostgresRuntimeInput,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(input.pgCtlPath, [
      "stop",
      "-D", input.dataDirectory,
      "-m", "fast",
      "-w",
      "-t", "10",
    ], {
      timeout: 15_000,
      windowsHide: true,
    }, (error) => {
      if (error) reject(new Error("Unable to stop the stale managed PostgreSQL runtime safely.", { cause: error }));
      else resolve();
    });
  });
}

function postgresErrorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? code : undefined;
}

function isTransientPostgresIdentityError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || code === "57P03";
}

interface DefaultCreateEmbeddedContext {
  platform: NodeJS.Platform;
  arch: string;
  resolveRuntime: () => Promise<EmbeddedPostgresRuntime | undefined>;
}

interface WindowsX64Binaries {
  initdbPath: string;
  postgresPath: string;
  pgCtlPath: string;
}

async function defaultCreateEmbedded(
  options: EmbeddedPostgresOptions,
  context?: DefaultCreateEmbeddedContext,
): Promise<EmbeddedPostgresInstance> {
  const platform = context?.platform ?? process.platform;
  const arch = context?.arch ?? process.arch;
  if (platform === "win32" && arch === "arm64") {
    return createWindowsArm64EmbeddedPostgres(options, context);
  }

  const processEvents = process as unknown as {
    listeners(event: string): Array<(...args: unknown[]) => void>;
    removeListener(event: string, listener: (...args: unknown[]) => void): void;
  };
  const existingListeners = new Map(
    EMBEDDED_POSTGRES_PROCESS_EVENTS.map((event) => [event, new Set(processEvents.listeners(event))]),
  );
  let EmbeddedPostgres: typeof import("embedded-postgres")["default"];
  try {
    ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  } finally {
    for (const event of EMBEDDED_POSTGRES_PROCESS_EVENTS) {
      const previous = existingListeners.get(event)!;
      for (const listener of processEvents.listeners(event)) {
        if (!previous.has(listener)) processEvents.removeListener(event, listener);
      }
    }
  }
  return new EmbeddedPostgres(options);
}

async function resolveWindowsX64Binaries(
  context?: DefaultCreateEmbeddedContext,
): Promise<WindowsX64Binaries> {
  const injectedRuntime = await context?.resolveRuntime();
  if (injectedRuntime) {
    const binDir = path.dirname(injectedRuntime.pgCtlPath);
    return {
      initdbPath: path.join(binDir, "initdb.exe"),
      postgresPath: path.join(binDir, "postgres.exe"),
      pgCtlPath: injectedRuntime.pgCtlPath,
    };
  }
  const entryPath = moduleRequire.resolve("@embedded-postgres/windows-x64");
  const runtimeRoot = path.resolve(path.dirname(entryPath), "..");
  const binDir = path.join(runtimeRoot, "native", "bin");
  const binaries: WindowsX64Binaries = {
    initdbPath: path.join(binDir, "initdb.exe"),
    postgresPath: path.join(binDir, "postgres.exe"),
    pgCtlPath: path.join(binDir, "pg_ctl.exe"),
  };
  await Promise.all([
    assertRuntimeFile(binaries.initdbPath),
    assertRuntimeFile(binaries.postgresPath),
    assertRuntimeFile(binaries.pgCtlPath),
  ]);
  return binaries;
}

/**
 * Direct binary wrapper for Windows ARM64 Prism emulation using
 * `@embedded-postgres/windows-x64`, bypassing `embedded-postgres`'s eager
 * `getBinaries()` check that rejects `win32-arm64` at module evaluation time.
 */
async function createWindowsArm64EmbeddedPostgres(
  options: EmbeddedPostgresOptions,
  context?: DefaultCreateEmbeddedContext,
): Promise<EmbeddedPostgresInstance> {
  const binaries = await resolveWindowsX64Binaries(context);
  let childProcess: ChildProcess | undefined;
  let stopPromise: Promise<void> | undefined;

  return {
    async initialise(): Promise<void> {
      const passwordFile = path.join(
        os.tmpdir(),
        `agent-recall-pg-password-${randomBytes(8).toString("hex")}`,
      );
      await fs.writeFile(passwordFile, `${options.password}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(binaries.initdbPath, [
            `--pgdata=${options.databaseDir}`,
            `--auth=${options.authMethod ?? "scram-sha-256"}`,
            `--username=${options.user}`,
            `--pwfile=${passwordFile}`,
            "--lc-messages=C",
            ...(options.initdbFlags ?? []),
          ], {
            windowsHide: true,
            env: { ...process.env, LC_MESSAGES: "C" },
          });
          const stdoutDecoder = new StringDecoder("utf8");
          const stderrDecoder = new StringDecoder("utf8");
          let stderrOutput = "";
          let settled = false;
          const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            if (error !== undefined) reject(error);
            else resolve();
          };
          child.stdout?.on("data", (chunk: Buffer) => {
            const text = stdoutDecoder.write(chunk);
            if (text) options.onLog?.(text);
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            const text = stderrDecoder.write(chunk);
            if (text) {
              stderrOutput = `${stderrOutput}${text}`.slice(-MAX_STARTUP_LOG_CHARS);
              options.onLog?.(`[STDERR] ${text}`);
            }
          });
          child.once("error", (error) => {
            options.onError?.(error);
            finish(error);
          });
          child.once("close", (code, signal) => {
            const stdoutTail = stdoutDecoder.end();
            if (stdoutTail) options.onLog?.(stdoutTail);
            const stderrTail = stderrDecoder.end();
            if (stderrTail) {
              stderrOutput = `${stderrOutput}${stderrTail}`.slice(-MAX_STARTUP_LOG_CHARS);
              options.onLog?.(`[STDERR] ${stderrTail}`);
            }
            if (code === 0) finish();
            else {
              finish(
                new Error(
                  `Postgres init script failed (code: ${code ?? "null"}, signal: ${signal ?? "null"}). ERROR OUTPUT: ${stderrOutput}`,
                ),
              );
            }
          });
        });
      } finally {
        await fs.unlink(passwordFile).catch(() => undefined);
      }
    },

    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binaries.postgresPath, [
          "-D",
          options.databaseDir,
          "-p",
          String(options.port),
          ...(options.postgresFlags ?? []),
        ], {
          windowsHide: true,
          env: { ...process.env, LC_MESSAGES: "C" },
        });
        childProcess = child;
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        let stderrTail = "";
        let settled = false;
        const markReady = () => {
          if (settled) return;
          settled = true;
          stderrTail = "";
          resolve();
        };
        const failStartup = (error: unknown) => {
          if (settled) return;
          settled = true;
          if (childProcess === child) childProcess = undefined;
          reject(error);
        };
        const handleStderrText = (text: string) => {
          if (!text) return;
          options.onLog?.(text);
          if (!settled) {
            stderrTail = `${stderrTail}${text}`.slice(-MAX_STARTUP_LOG_CHARS);
            if (stderrTail.includes(PG_READY_LOG_LINE)) {
              markReady();
            }
          }
        };

        child.stdout?.on("data", (chunk: Buffer) => {
          const text = stdoutDecoder.write(chunk);
          if (text) options.onLog?.(text);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          handleStderrText(stderrDecoder.write(chunk));
        });
        child.on("error", (error) => {
          options.onError?.(error);
          failStartup(error);
        });
        child.once("close", (code, signal) => {
          const stdoutTail = stdoutDecoder.end();
          if (stdoutTail) options.onLog?.(stdoutTail);
          handleStderrText(stderrDecoder.end());
          if (childProcess === child) childProcess = undefined;
          if (!settled) {
            const detail = stderrTail.trim();
            failStartup(
              new Error(
                detail
                  ? `PostgreSQL exited before becoming ready (code: ${code ?? "null"}, signal: ${signal ?? "null"}): ${detail}`
                  : `PostgreSQL exited before becoming ready (code: ${code ?? "null"}, signal: ${signal ?? "null"}).`,
              ),
            );
          }
        });
      });
    },

    async createDatabase(name: string): Promise<void> {
      if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null) {
        throw new Error("Managed PostgreSQL cluster must be running before creating a database.");
      }
      const client = new Client({
        host: "127.0.0.1",
        port: options.port,
        user: options.user,
        password: options.password,
        database: "postgres",
      });
      client.on("error", (error) => options.onError?.(error));
      try {
        await client.connect();
        await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const runningChild = childProcess;
        if (runningChild && runningChild.exitCode === null && runningChild.signalCode === null) {
          let stoppedCleanly = false;
          try {
            await stopExistingRuntime({
              pgCtlPath: binaries.pgCtlPath,
              dataDirectory: options.databaseDir,
            });
            stoppedCleanly = await waitForChildExit(runningChild, 2_000);
          } catch {
            // pg_ctl can fail if the postmaster is unresponsive or postmaster.pid is missing; fall back to taskkill.
          }
          if (!stoppedCleanly && runningChild.exitCode === null && runningChild.signalCode === null && runningChild.pid) {
            await forceKillWindowsProcessTree(runningChild);
          }
        }
        if (childProcess === runningChild) childProcess = undefined;
        if (options.persistent === false) {
          await fs.rm(options.databaseDir, { recursive: true, force: true });
        }
      })();
      try {
        await stopPromise;
      } finally {
        stopPromise = undefined;
      }
    },
  };
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    timer.unref();
    const onDone = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("close", onDone);
      child.removeListener("exit", onDone);
    };
    child.once("close", onDone);
    child.once("exit", onDone);
  });
}

async function forceKillWindowsProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], {
      timeout: 10_000,
      windowsHide: true,
    }, (error) => {
      if (!error || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      reject(new Error("Unable to terminate the managed PostgreSQL process tree.", { cause: error }));
    });
  });
  await waitForChildExit(child, 5_000);
}

async function hasLivePostmasterPid(dataDirectory: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(path.join(dataDirectory, "postmaster.pid"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Any non-ENOENT failure leaves postmaster ownership unverified, so refuse to treat the cluster as offline.
    return true;
  }
  const firstLine = content.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (!/^\d+$/u.test(firstLine)) return true;
  const pid = Number(firstLine);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  return isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM (or any unexpected signal check failure) means we cannot prove the process is absent.
    return true;
  }
}

async function canBindLocalPort(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code && PORT_BIND_ERROR_CODES.has(error.code)) {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen({ host, port }, () => {
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve(true);
      });
    });
  });
}

function appendStartupLog(logs: string[], message: string): void {
  if (!message) return;
  logs.push(message);
  if (logs.length > MAX_STARTUP_LOG_CHUNKS) {
    logs.splice(0, logs.length - MAX_STARTUP_LOG_CHUNKS);
  }
}

function hasPortBindSignal(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || value === undefined || seen.has(value)) return false;
  if (typeof value === "string") return PORT_BIND_MESSAGE_PATTERN.test(value);
  if (typeof value !== "object") return false;
  seen.add(value);
  const record = value as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof record.code === "string" && PORT_BIND_ERROR_CODES.has(record.code)) return true;
  if (typeof record.message === "string" && PORT_BIND_MESSAGE_PATTERN.test(record.message)) return true;
  return hasPortBindSignal(record.cause, seen);
}

function isPortBindFailure(
  error: unknown,
  startupLogs: string[],
  startupErrors: unknown[],
): boolean {
  if (hasPortBindSignal(error)) return true;
  if (startupErrors.some((entry) => hasPortBindSignal(entry))) return true;
  return startupLogs.length > 0 && PORT_BIND_MESSAGE_PATTERN.test(startupLogs.join("\n"));
}

function normalizeStartupError(
  error: unknown,
  startupLogs: string[],
  startupErrors: unknown[],
): Error {
  if (error instanceof Error) return error;
  if (error !== undefined && error !== null) return new Error(String(error));
  const loggedError = startupErrors.find((entry) => entry instanceof Error);
  if (loggedError instanceof Error) return loggedError;
  const logDetail = startupLogs.join("").trim().slice(-2_000);
  return new Error(
    logDetail
      ? `Managed PostgreSQL failed to start: ${logDetail}`
      : "Managed PostgreSQL failed to start.",
  );
}

async function readRuntimeConfig(configPath: string): Promise<RuntimeConfig | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<RuntimeConfig>;
    if (
      parsed.version !== 1 ||
      parsed.host !== "127.0.0.1" ||
      !Number.isInteger(parsed.port) ||
      Number(parsed.port) <= 0 ||
      Number(parsed.port) > 65_535 ||
      parsed.user !== "agent_recall" ||
      typeof parsed.password !== "string" ||
      parsed.password.length < 8 ||
      parsed.database !== "agent_recall" ||
      typeof parsed.initialized !== "boolean"
    ) {
      throw new Error("Managed PostgreSQL runtime configuration is invalid");
    }
    return parsed as RuntimeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeRuntimeConfig(configPath: string, config: RuntimeConfig): Promise<void> {
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await fs.chmod(configPath, 0o600);
}

function runtimeConnectionUrl(config: RuntimeConfig): string {
  const url = new URL("postgresql://127.0.0.1");
  url.username = config.user;
  url.password = config.password;
  url.hostname = config.host;
  url.port = String(config.port);
  url.pathname = `/${config.database}`;
  return url.toString().replace(/\/$/, "");
}

function createRuntimePassword(): string {
  return randomBytes(32).toString("base64url");
}

async function chooseAvailablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("Unable to allocate a local PostgreSQL port"));
      });
    });
  });
}

function assertPostgresUrl(connectionUrl: string): void {
  const protocol = new URL(connectionUrl).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("AGENT_RECALL_DATABASE_URL must use postgres:// or postgresql://");
  }
}

function isDuplicateDatabaseError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "42P04" || (
    typeof value.message === "string" &&
    /database .* already exists/iu.test(value.message)
  );
}
