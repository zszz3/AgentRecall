import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
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

  const connectionUrl = runtimeConnectionUrl(config);
  const dataDirectory = path.join(runtimeDirectory, "data");
  if (existingConfig?.initialized) {
    const platform = options.platform ?? process.platform;
    const embeddedRuntime = await (
      options.resolveEmbeddedRuntime ?? resolveEmbeddedRuntime
    )(platform, options.arch ?? process.arch);
    const dataMajorVersion = await readPostgresDataMajorVersion(dataDirectory);
    if (dataMajorVersion !== embeddedRuntime.majorVersion) {
      throw new Error("Managed PostgreSQL data uses a different major version; automatic recovery was refused.");
    }
    const existingRuntime = await (
      options.probeExistingRuntime ?? probeExistingRuntime
    )(connectionUrl);
    if (existingRuntime) {
      if (!await pathsReferToSameLocation(existingRuntime.dataDirectory, dataDirectory, platform)) {
        throw new Error("Managed PostgreSQL is running from an unexpected data directory; automatic recovery was refused.");
      }
      if (
        existingRuntime.majorVersion !== dataMajorVersion
        || existingRuntime.majorVersion !== embeddedRuntime.majorVersion
      ) {
        throw new Error("Managed PostgreSQL uses a different major version; automatic recovery was refused.");
      }
      if (
        await pathsReferToSameLocation(
          existingRuntime.libraryDirectory,
          embeddedRuntime.libraryDirectory,
          platform,
        )
      ) {
        return {
          connectionUrl,
          managed: true,
          stop: async () => undefined,
        };
      }
      await (options.stopExistingRuntime ?? stopExistingRuntime)({
        pgCtlPath: embeddedRuntime.pgCtlPath,
        dataDirectory,
      });
    }
  }

  const createEmbedded = options.createEmbedded ?? defaultCreateEmbedded;
  const embedded = await createEmbedded({
    databaseDir: dataDirectory,
    port: config.port,
    user: config.user,
    password: config.password,
    persistent: true,
    authMethod: "scram-sha-256",
    initdbFlags: ["--encoding=UTF8"],
    postgresFlags: ["-h", config.host],
    onLog: () => undefined,
    onError: () => undefined,
  });

  let started = false;
  try {
    if (!config.initialized) await embedded.initialise();
    await embedded.start();
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
  } catch (error) {
    if (started) await embedded.stop().catch(() => undefined);
    throw error;
  }

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

async function defaultCreateEmbedded(options: EmbeddedPostgresOptions): Promise<EmbeddedPostgresInstance> {
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
