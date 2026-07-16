import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  defaultSettings,
  mergeAppSettings,
  type AppSettings,
} from "./platform";

// electron-store writes config.json inside the Electron app's userData dir.
// On macOS that is ~/Library/Application Support/<appName>. The packaged app
// sets its name to "AgentRecall"; in dev the lowercase package `name`
// is used, so we probe both to be safe.
const CONFIG_CANDIDATE_DIRS = ["AgentRecall", "agent-recall"];

export interface McpSettingsOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
}

export function resolveMcpConfigPath(options: McpSettingsOptions = {}): string | null {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;

  // An explicit override always wins, so tests and alternate installs can point
  // at a specific config without searching.
  const override = env.AGENT_RECALL_CONFIG?.trim();
  if (override) return override;

  const roots = platform === "darwin"
    ? [path.join(home, "Library", "Application Support")]
    : platform === "win32"
      ? [env.APPDATA?.trim(), path.join(home, "AppData", "Roaming")]
      : [env.XDG_CONFIG_HOME?.trim(), path.join(home, ".config")];

  for (const root of new Set(roots.filter((value): value is string => Boolean(value)))) {
    for (const dir of CONFIG_CANDIDATE_DIRS) {
      const candidate = path.join(root, dir, "config.json");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Reads the persisted app config.json (electron-store format) and normalizes it
// through `mergeAppSettings`, so partial or missing keys fall back to defaults.
// Returns null when no config file exists (the MCP server then uses defaults).
export function readMcpAppSettings(options: McpSettingsOptions = {}): AppSettings {
  const env = options.env ?? process.env;
  const configPath = resolveMcpConfigPath({ env, home: options.home, platform: options.platform });
  let raw: Record<string, unknown> = {};
  if (configPath) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // A corrupt config must not crash the MCP server; fall back to defaults.
    }
  }
  return mergeAppSettings(defaultSettings, raw);
}

// Backfills the summary API provider key from the DB. The app never persists
// `customApiKey` to config.json (it goes to `api_provider_keys`), so a custom
// summary provider looks "incomplete" until we reattach the key here.
export function hydrateMcpSummaryApiKey(
  settings: AppSettings,
  getApiProviderKey: (target: "codex" | "claude" | "summary", providerId: string) => string,
): AppSettings {
  if (settings.summaryApiConfig.activeProvider !== "custom") return settings;
  const customApiKey = getApiProviderKey("summary", settings.summaryApiConfig.customProviderId);
  if (!customApiKey) return settings;
  return {
    ...settings,
    summaryApiConfig: { ...settings.summaryApiConfig, customApiKey },
  };
}
