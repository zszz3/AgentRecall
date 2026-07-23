import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  getSafeMigrationResumeCommand,
  inspectMigrationCli,
  type AppSettings,
} from "./platform";
import { assertMigrationTargetEnabled, isMigrationTarget } from "./migration-targets";
import {
  hydrateMcpSummaryApiKey,
  readMcpAppSettings,
} from "./mcp-settings";
import {
  applyMigrationLengthPolicy,
  createMigrationCompressor,
  type MigrationCompressFn,
} from "./session-migration-compression";
import { portableSessionFrom } from "./session-migration";
import { writeMigratedSession } from "./session-migration-writers";
import { indexMigratedSessionFile } from "./indexer";
import { resolveSummaryEndpointFromSettings } from "./summary-endpoint";
import type { SessionStore } from "./session-store";
import type {
  MigrationTarget,
  SessionMessage,
  SessionMigrationRecord,
  SessionMigrationResult,
  SessionSearchResult,
} from "./types";

export interface McpMigrateSessionInput {
  sessionKey: string;
  target: MigrationTarget;
}

export interface McpMigrationDeps {
  store: SessionStore;
  settings?: AppSettings;
  inspectCli?: (target: MigrationTarget, settings: AppSettings) => Promise<void> | void;
  now?: () => number;
  idFactory?: () => string;
  // Override the home directory used when writing the target session file, so
  // tests can isolate writes to a temp dir instead of the real ~/.codex etc.
  homeDir?: string;
  // Override the compression function. When omitted the facade builds one from
  // the resolved summary endpoint; tests inject a fake to exercise the
  // ai-compressed path without real HTTP/CLI calls.
  compressor?: MigrationCompressFn | null;
}

// The MCP server never opens a terminal, so `launched` is always false. The
// caller gets the exact `resumeCommand` to run themselves. This mirrors the
// desktop migration result shape so clients can treat both uniformly.
export interface McpMigrationResult {
  target: MigrationTarget;
  targetSessionId: string;
  targetFilePath: string;
  strategy: SessionMigrationResult["strategy"];
  resumeCommand: string;
  indexed: boolean;
  launched: boolean;
  warning?: string;
}

export async function loadMcpAppSettings(store: SessionStore): Promise<AppSettings> {
  const settings = readMcpAppSettings();
  if (settings.summaryApiConfig.activeProvider !== "custom") return settings;
  const apiKey = await store.getApiProviderKey(
    "summary",
    settings.summaryApiConfig.customProviderId,
  );
  return hydrateMcpSummaryApiKey(settings, () => apiKey);
}

// Loads the full source session + all messages directly from SQLite, building a
// SessionSearchResult with the fields the migration chain requires. Only local
// sessions are eligible; remote sessions are rejected before any work begins.
export async function loadMcpSourceSession(
  store: SessionStore,
  sessionKey: string,
): Promise<{ source: SessionSearchResult; messages: SessionMessage[] }> {
  const source = await store.getSession(sessionKey);
  if (!source) {
    throw new Error(`Session not found: ${sessionKey}`);
  }
  if (source.environmentKind !== "local" || source.environmentId !== "local") {
    throw new Error("Remote session migration is not supported yet.");
  }
  if (!source.projectPath.trim()) {
    throw new Error("Session has no project path.");
  }
  const messages = await store.getAllMessages(sessionKey);
  return { source, messages };
}

function pathExists(targetPath: string): boolean {
  try {
    return existsSync(targetPath);
  } catch {
    return false;
  }
}

function pathIsDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function buildResumeCommand(
  target: MigrationTarget,
  sessionId: string,
  projectPath: string,
  settings: AppSettings,
  homeDir?: string,
): string {
  return getSafeMigrationResumeCommand(target, sessionId, projectPath, settings, {
    ...(homeDir ? { homeDir } : {}),
  });
}

// Returns the temporary-session cleaner used by the MCP migration endpoint.
// When an ephemeral codex exec / claude --print run gets indexed before it
// exits, this deletes the dirty session record so it does not linger in the DB.
export function createMcpTemporarySessionCleaner(store: SessionStore): (sessionKey: string) => void {
  return (sessionKey) => {
    void store.deleteSessionRecord(sessionKey).catch(() => {
      // Best-effort: a temp session that failed to delete must not abort migration.
    });
  };
}

export async function migrateSessionForMcp(
  input: McpMigrateSessionInput,
  deps: McpMigrationDeps,
): Promise<McpMigrationResult> {
  const { store } = deps;
  const settings = deps.settings ?? await loadMcpAppSettings(store);
  if (!isMigrationTarget(input.target)) {
    throw new Error(`Migration target ${String(input.target)} is not supported.`);
  }
  const target = input.target;
  assertMigrationTargetEnabled(target, settings);

  // Load + validate before touching the CLI or any AI provider.
  const { source, messages } = await loadMcpSourceSession(store, input.sessionKey);
  const portable = portableSessionFrom(source, messages);

  if (!pathExists(portable.projectPath)) {
    throw new Error(`Session project path does not exist: ${portable.projectPath}`);
  }
  if (!pathIsDirectory(portable.projectPath)) {
    throw new Error(`Session project path is not a directory: ${portable.projectPath}`);
  }

  const inspect = deps.inspectCli ?? ((t, s) => inspectMigrationCli(t, s, undefined, {
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
  }));
  await inspect(target, settings);

  // Build the compressor: prefer the configured custom endpoint, otherwise fall
  // back to codex_exec / claude_exec. All ephemeral CLI sessions produced during
  // compression are deleted from the DB so no dirty rows survive.
  const endpoint = resolveSummaryEndpointFromSettings(settings, {
    onTemporarySession: createMcpTemporarySessionCleaner(store),
  });
  const compressor = deps.compressor !== undefined
    ? deps.compressor
    : endpoint
      ? createMigrationCompressor(endpoint, undefined, settings.compressionConcurrency)
      : null;

  const prepared = await applyMigrationLengthPolicy(portable, compressor);

  const written = await writeMigratedSession({
    target,
    session: prepared.session,
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
  });

  const warnings: string[] = [];
  const record: SessionMigrationRecord = {
    id: (deps.idFactory ?? randomUUID)(),
    sourceSessionKey: portable.sourceSessionKey,
    sourceAgent: portable.sourceAgent,
    targetAgent: target,
    targetSessionId: written.sessionId,
    targetFilePath: written.filePath,
    strategy: prepared.strategy,
    createdAt: (deps.now ?? Date.now)(),
  };
  try {
    await store.recordSessionMigration(record);
  } catch (error) {
    warnings.push(`Failed to record migration metadata: ${error instanceof Error ? error.message : String(error)}`);
  }

  let indexed = true;
  try {
    await indexMigratedSessionFile(store, target, written.filePath, written.sessionId);
  } catch (error) {
    indexed = false;
    warnings.push(`Failed to index migrated session: ${error instanceof Error ? error.message : String(error)}`);
  }

  const resumeCommand = buildResumeCommand(
    target,
    written.sessionId,
    prepared.session.projectPath,
    settings,
    deps.homeDir,
  );

  return {
    target,
    targetSessionId: written.sessionId,
    targetFilePath: written.filePath,
    strategy: prepared.strategy,
    resumeCommand,
    indexed,
    launched: false,
    ...(warnings.length > 0 ? { warning: warnings.join("\n") } : {}),
  };
}
