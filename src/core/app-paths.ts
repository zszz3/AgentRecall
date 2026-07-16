import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The Electron app's userData directory differs between dev (lowercase package
// `name`) and packaged builds (`productName`), and across platforms, so the
// database path is not reliably predictable from outside Electron. The app
// therefore writes its resolved database path to a stable pointer file that
// standalone tools (the MCP server) read to find the live database.

const POINTER_DIR = ".agent-recall";
const POINTER_FILE = "db-path";

export function dbPointerPath(home: string = homedir()): string {
  return path.join(home, POINTER_DIR, POINTER_FILE);
}

export function writeDbPointer(dbPath: string, home: string = homedir()): void {
  const pointer = dbPointerPath(home);
  mkdirSync(path.dirname(pointer), { recursive: true });
  writeFileSync(pointer, `${dbPath}\n`, "utf8");
}

// Resolution order for standalone consumers: explicit env override, then the
// pointer file written by the app. Returns null when neither is available.
export function resolveDbPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  const override = env.AGENT_RECALL_DB?.trim();
  if (override) return override;
  const pointer = dbPointerPath(home);
  try {
    if (!existsSync(pointer)) return null;
    const value = readFileSync(pointer, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}
