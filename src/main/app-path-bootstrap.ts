import { cpSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type AppPathName = "home" | "appData" | "userData" | "temp";

export interface ApplicationPathApi {
  getPath(name: AppPathName): string;
  setPath(name: AppPathName, value: string): void;
}

export interface ApplicationPaths {
  home: string;
  appData: string;
  userData: string;
  temp: string;
}

interface BootstrapApplicationPathsOptions {
  app: ApplicationPathApi;
  productName: string;
  legacyProductNames?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  tmpdir?: () => string;
  warn?: (message: string, error?: unknown) => void;
}

function absolutePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed && path.isAbsolute(trimmed) ? path.normalize(trimmed) : undefined;
}

function electronPath(app: ApplicationPathApi, name: AppPathName, warn: BootstrapApplicationPathsOptions["warn"]): string | undefined {
  try {
    return absolutePath(app.getPath(name));
  } catch (error) {
    warn?.(`[startup] Electron could not resolve the ${name} path; using a platform fallback.`, error);
    return undefined;
  }
}

function ensureDirectory(value: string, label: AppPathName): string {
  try {
    mkdirSync(value, { recursive: true });
    return value;
  } catch (error) {
    throw new Error(`AgentRecall could not prepare its ${label} directory at ${value}.`, { cause: error });
  }
}

function registerApplicationPath(app: ApplicationPathApi, name: AppPathName, value: string): string {
  const directory = ensureDirectory(value, name);
  try {
    app.setPath(name, directory);
    return directory;
  } catch (error) {
    throw new Error(`AgentRecall could not register its ${name} directory at ${directory}.`, { cause: error });
  }
}

function requiredPath(candidates: Array<string | undefined>, label: AppPathName): string {
  const value = candidates.find((candidate): candidate is string => Boolean(candidate));
  if (value) return value;
  throw new Error(`AgentRecall could not resolve a stable ${label} directory from Electron or the operating system.`);
}

function platformAppDataPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "win32") return absolutePath(env.APPDATA) ?? path.join(home, "AppData", "Roaming");
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  return absolutePath(env.XDG_CONFIG_HOME) ?? path.join(home, ".config");
}

function migrateLegacyUserData(
  target: string,
  legacyProductNames: readonly string[],
  warn: BootstrapApplicationPathsOptions["warn"],
): void {
  if (existsSync(target)) return;

  const parent = path.dirname(target);
  for (const legacyProductName of legacyProductNames) {
    const legacy = path.join(parent, legacyProductName);
    if (!existsSync(legacy)) continue;
    try {
      cpSync(legacy, target, { recursive: true, errorOnExist: false });
    } catch (error) {
      warn?.(`[startup] Could not migrate existing user data from ${legacy} to ${target}; starting with the available data directory.`, error);
    }
    return;
  }
}

export function bootstrapApplicationPaths(options: BootstrapApplicationPathsOptions): ApplicationPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir;
  const tmpdir = options.tmpdir ?? os.tmpdir;
  const warn = options.warn ?? ((message, error) => console.warn(message, error));

  const home = registerApplicationPath(
    options.app,
    "home",
    requiredPath([
      electronPath(options.app, "home", warn),
      absolutePath(env.HOME),
      absolutePath(env.USERPROFILE),
      absolutePath(homedir()),
    ], "home"),
  );

  const appData = registerApplicationPath(
    options.app,
    "appData",
    electronPath(options.app, "appData", warn) ?? platformAppDataPath(platform, env, home),
  );

  const userData = absolutePath(env.AGENT_RECALL_USER_DATA_DIR)
    ?? electronPath(options.app, "userData", warn)
    ?? path.join(appData, options.productName);
  migrateLegacyUserData(userData, options.legacyProductNames ?? [], warn);
  registerApplicationPath(options.app, "userData", userData);

  const temp = registerApplicationPath(
    options.app,
    "temp",
    requiredPath([
      electronPath(options.app, "temp", warn),
      absolutePath(env.TEMP),
      absolutePath(env.TMP),
      absolutePath(tmpdir()),
      path.join(userData, "tmp"),
    ], "temp"),
  );

  return { home, appData, userData, temp };
}
