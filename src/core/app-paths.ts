import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The Electron app's userData directory differs between dev (lowercase package
// `name`) and packaged builds (`productName`), and across platforms, so the
// database endpoint is not reliably predictable from outside Electron. The app
// therefore writes its resolved PostgreSQL URL to a private pointer file that
// standalone tools (the MCP server) read to find the live database.

const POINTER_DIR = ".agent-recall";
const POINTER_FILE = "database-url";

export function databaseUrlPointerPath(home: string = homedir()): string {
  return path.join(home, POINTER_DIR, POINTER_FILE);
}

export function writeDatabaseUrlPointer(connectionUrl: string, home: string = homedir()): void {
  const pointer = databaseUrlPointerPath(home);
  mkdirSync(path.dirname(pointer), { recursive: true, mode: 0o700 });
  writeFileSync(pointer, `${connectionUrl}\n`, { encoding: "utf8", mode: 0o600 });
}

// Resolution order for standalone consumers: explicit env override, then the
// pointer file written by the app. Returns null when neither is available.
export function resolveDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  const override = env.AGENT_RECALL_DATABASE_URL?.trim();
  if (override) return override;
  const pointer = databaseUrlPointerPath(home);
  try {
    if (!existsSync(pointer)) return null;
    const value = readFileSync(pointer, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

// Kept temporarily for packaged consumers compiled against the previous API.
export const dbPointerPath = databaseUrlPointerPath;
export const writeDbPointer = writeDatabaseUrlPointer;
export const resolveDbPath = resolveDatabaseUrl;
