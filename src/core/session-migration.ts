import type { PreparedMigrationSession } from "./session-migration-compression";
import type { WrittenMigratedSession } from "./session-migration-writers";
import type {
  MigrationAgent,
  PortableSession,
  SessionMessage,
  SessionMigrationProgress,
  SessionMigrationRecord,
  SessionMigrationResult,
  SessionSearchResult,
  SessionSource,
} from "./types";

export const MIGRATION_TOKEN_LIMIT = 60_000;

const MIGRATION_AGENTS = ["claude", "codex", "codebuddy"] as const;

export interface SessionMigrationDependencies {
  inspectCli: (target: MigrationAgent) => Promise<void> | void;
  prepare: (session: PortableSession) => Promise<PreparedMigrationSession>;
  write: (
    target: MigrationAgent,
    session: PortableSession,
  ) => Promise<WrittenMigratedSession>;
  record: (record: SessionMigrationRecord) => Promise<void> | void;
  refreshIndex: (target: MigrationAgent, targetFilePath: string) => Promise<void>;
  launch: (
    target: MigrationAgent,
    sessionId: string,
    projectPath: string,
  ) => Promise<void>;
  resumeCommand: (
    target: MigrationAgent,
    sessionId: string,
    projectPath: string,
  ) => string;
  fallbackResumeCommand: (
    target: MigrationAgent,
    sessionId: string,
    projectPath: string,
  ) => string;
  onProgress?: (progress: SessionMigrationProgress) => void;
  idFactory: () => string;
  now: () => number;
  projectPathExists: (projectPath: string) => Promise<boolean> | boolean;
  projectPathIsDirectory: (projectPath: string) => Promise<boolean> | boolean;
}

export interface MigrateSessionOptions {
  source: SessionSearchResult;
  messages: SessionMessage[];
  target: MigrationAgent;
  deps: SessionMigrationDependencies;
}

export function migrationAgentForSource(source: SessionSource): MigrationAgent | null {
  switch (source) {
    case "claude-cli":
    case "claude-app":
    case "claude-internal":
      return "claude";
    case "codex-cli":
    case "codex-app":
    case "codex-internal":
      return "codex";
    case "codebuddy-cli":
      return "codebuddy";
    default:
      return null;
  }
}

export function supportedMigrationTargets(source: SessionSource): MigrationAgent[] {
  const sourceAgent = migrationAgentForSource(source);
  return sourceAgent ? [...MIGRATION_AGENTS] : [];
}

export function portableSessionFrom(
  session: SessionSearchResult,
  messages: SessionMessage[],
): PortableSession {
  const sourceAgent = migrationAgentForSource(session.source);
  if (!sourceAgent) {
    throw new Error(`Session source ${session.source} cannot be migrated.`);
  }
  if (session.environmentKind !== "local" || session.environmentId !== "local") {
    throw new Error("Remote session migration is not supported yet.");
  }
  if (!session.projectPath.trim()) {
    throw new Error("Session has no project path.");
  }

  const portableMessages = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message, index) => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      index,
    }));

  return {
    sourceSessionKey: session.sessionKey,
    sourceAgent,
    title: session.displayTitle,
    projectPath: session.projectPath,
    startedAt: new Date(session.timestamp).toISOString(),
    messages: portableMessages,
  };
}

export function estimatePortableSessionTokens(session: PortableSession): number {
  const characters = session.messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  return Math.ceil(characters / 4);
}

export async function migrateSession({
  source,
  messages,
  target,
  deps,
}: MigrateSessionOptions): Promise<SessionMigrationResult> {
  await validateMigrationRequest(source, target, deps);

  notifyProgress(deps.onProgress, {
    sessionKey: source.sessionKey,
    target,
    stage: "reading",
  });

  await deps.inspectCli(target);

  const portable = portableSessionFrom(source, messages);
  if (estimatePortableSessionTokens(portable) > MIGRATION_TOKEN_LIMIT) {
    notifyProgress(deps.onProgress, {
      sessionKey: source.sessionKey,
      target,
      stage: "compressing",
    });
  }

  const prepared = await deps.prepare(portable);

  notifyProgress(deps.onProgress, {
    sessionKey: source.sessionKey,
    target,
    stage: "writing",
  });
  const written = await deps.write(target, prepared.session);

  const warnings: string[] = [];
  await collectWarning(warnings, async () => {
    await deps.record({
      id: deps.idFactory(),
      sourceSessionKey: portable.sourceSessionKey,
      sourceAgent: portable.sourceAgent,
      targetAgent: target,
      targetSessionId: written.sessionId,
      targetFilePath: written.filePath,
      strategy: prepared.strategy,
      createdAt: deps.now(),
    });
  }, "Failed to record migration metadata");
  const resumeCommand = safeResumeCommand(
    deps,
    warnings,
    target,
    written.sessionId,
    prepared.session.projectPath,
  );

  notifyProgress(deps.onProgress, {
    sessionKey: source.sessionKey,
    target,
    stage: "indexing",
  });
  let indexed = true;
  try {
    await deps.refreshIndex(target, written.filePath);
  } catch (error) {
    indexed = false;
    warnings.push(formatWarning("Failed to refresh session index", error));
  }

  notifyProgress(deps.onProgress, {
    sessionKey: source.sessionKey,
    target,
    stage: "launching",
  });
  let launched = true;
  try {
    await deps.launch(target, written.sessionId, prepared.session.projectPath);
  } catch (error) {
    launched = false;
    warnings.push(formatWarning("Failed to launch target session", error));
  }

  return {
    target,
    targetSessionId: written.sessionId,
    targetFilePath: written.filePath,
    strategy: prepared.strategy,
    resumeCommand,
    indexed,
    launched,
    ...(warnings.length > 0 ? { warning: warnings.join("\n") } : {}),
  };
}

async function validateMigrationRequest(
  source: SessionSearchResult,
  target: MigrationAgent,
  deps: SessionMigrationDependencies,
): Promise<void> {
  const sourceAgent = migrationAgentForSource(source.source);
  if (!sourceAgent) {
    throw new Error(`Session source ${source.source} cannot be migrated.`);
  }
  if (source.environmentKind !== "local" || source.environmentId !== "local") {
    throw new Error("Remote session migration is not supported yet.");
  }
  if (!MIGRATION_AGENTS.includes(target)) {
    throw new Error(`Migration target ${target} is not supported.`);
  }

  const projectPath = source.projectPath;
  if (!projectPath.trim()) {
    throw new Error("Session has no project path.");
  }
  if (!(await deps.projectPathExists(projectPath))) {
    throw new Error(`Session project path does not exist: ${projectPath}`);
  }
  if (!(await deps.projectPathIsDirectory(projectPath))) {
    throw new Error(`Session project path is not a directory: ${projectPath}`);
  }
}

function notifyProgress(
  onProgress: SessionMigrationDependencies["onProgress"],
  progress: SessionMigrationProgress,
): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch {
    // Observer failures must not break migration orchestration.
  }
}

async function collectWarning(
  warnings: string[],
  action: () => Promise<void>,
  prefix: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    warnings.push(formatWarning(prefix, error));
  }
}

function formatWarning(prefix: string, error: unknown): string {
  return `${prefix}: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeResumeCommand(
  deps: SessionMigrationDependencies,
  warnings: string[],
  target: MigrationAgent,
  sessionId: string,
  projectPath: string,
): string {
  try {
    return deps.resumeCommand(target, sessionId, projectPath);
  } catch (error) {
    warnings.push(formatWarning("Failed to build resume command", error));
    return deps.fallbackResumeCommand(target, sessionId, projectPath);
  }
}
