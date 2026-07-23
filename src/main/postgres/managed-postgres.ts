import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

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
  choosePort?: () => Promise<number>;
  createPassword?: () => string;
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

  const createEmbedded = options.createEmbedded ?? defaultCreateEmbedded;
  const embedded = await createEmbedded({
    databaseDir: path.join(runtimeDirectory, "data"),
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
    connectionUrl: runtimeConnectionUrl(config),
    managed: true,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await embedded.stop();
    },
  };
}

async function defaultCreateEmbedded(options: EmbeddedPostgresOptions): Promise<EmbeddedPostgresInstance> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
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
