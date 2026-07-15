import type { MigrationCompressionListener, PreparedMigrationSession } from "./session-migration-compression";
import { BASE_MIGRATION_TARGETS, isMigrationTarget } from "./migration-targets";
import type { WrittenMigratedSession } from "./session-migration-writers";
import { isLocalSessionEnvironment } from "./session-environment";
import type {
  MigrationAgent,
  MigrationCompressionEvent,
  MigrationTarget,
  PortableSession,
  SessionMessage,
  SessionMigrationProgress,
  SessionMigrationRecord,
  SessionMigrationResult,
  SessionSearchResult,
  SessionSource,
} from "./types";

export const MIGRATION_TOKEN_LIMIT = 60_000;

export interface SessionMigrationDependencies {
  inspectCli: (target: MigrationTarget) => Promise<void> | void;
  prepare: (
    session: PortableSession,
    onProgress?: MigrationCompressionListener,
  ) => Promise<PreparedMigrationSession>;
  write: (
    target: MigrationTarget,
    session: PortableSession,
  ) => Promise<WrittenMigratedSession>;
  record: (record: SessionMigrationRecord) => Promise<void> | void;
  refreshIndex: (target: MigrationTarget, targetFilePath: string) => Promise<void>;
  launch: (
    target: MigrationTarget,
    sessionId: string,
    projectPath: string,
  ) => Promise<void>;
  resumeCommand: (
    target: MigrationTarget,
    sessionId: string,
    projectPath: string,
  ) => string;
  fallbackResumeCommand: (
    target: MigrationTarget,
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
  target: MigrationTarget;
  deps: SessionMigrationDependencies;
}

export function migrationAgentForSource(source: SessionSource): MigrationAgent | null {
  switch (source) {
    case "claude-cli":
    case "claude-app":
    case "claude-internal":
    case "tclaude-cli":
      return "claude";
    case "codex-cli":
    case "codex-app":
    case "codex-internal":
    case "tcodex-cli":
      return "codex";
    case "codebuddy-cli":
      return "codebuddy";
    case "codewiz-cli":
      return "codewiz";
    case "cursor-agent":
      return "cursor";
    default:
      return null;
  }
}

export function supportedMigrationTargets(source: SessionSource): MigrationAgent[];
export function supportedMigrationTargets<T extends MigrationTarget>(
  source: SessionSource,
  enabledTargets: readonly T[],
): T[];
export function supportedMigrationTargets(
  source: SessionSource,
  enabledTargets: readonly MigrationTarget[] = BASE_MIGRATION_TARGETS,
): MigrationTarget[] {
  return migrationAgentForSource(source) ? [...enabledTargets] : [];
}

export function portableSessionFrom(
  session: SessionSearchResult,
  messages: SessionMessage[],
): PortableSession {
  const sourceAgent = migrationAgentForSource(session.source);
  if (!sourceAgent) {
    throw new Error(`Session source ${session.source} cannot be migrated.`);
  }
  if (!isLocalSessionEnvironment(session)) {
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

// Map a compression event to a 0-100 percent. Total work units =
// totalChunks (chunk summaries) + 1 (final handoff). `completed` counts chunk
// summaries done (monotonic, order-independent — chunks may run concurrently),
// so done = completed; the handoff is the +1th unit and tops the bar just below
// 100% (completed = totalChunks) until the orchestrator moves to "writing".
//
// Defined here (not in session-migration-compression.ts) so session-migration
// can stay a type-only importer of that module: a runtime import would drag
// session-summarizer (and node:child_process) into the renderer bundle.
export function migrationCompressionPercent(event: MigrationCompressionEvent): number {
  const totalUnits = event.totalChunks + 1;
  return Math.max(0, Math.min(100, Math.round((event.completed / totalUnits) * 100)));
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
      percent: 0,
    });
  }

  // Lift the compressor's granular events into SessionMigrationProgress so the
  // UI can render a percentage bar during the (slow, multi-call) compression.
  const migrationOnProgress = deps.onProgress;
  const compressionListener: MigrationCompressionListener | undefined = migrationOnProgress
    ? (event) => {
        notifyProgress(migrationOnProgress, {
          sessionKey: source.sessionKey,
          target,
          stage: "compressing",
          percent: migrationCompressionPercent(event),
          compression: event,
        });
      }
    : undefined;

  const prepared = await deps.prepare(portable, compressionListener);

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
  target: MigrationTarget,
  deps: SessionMigrationDependencies,
): Promise<void> {
  const sourceAgent = migrationAgentForSource(source.source);
  if (!sourceAgent) {
    throw new Error(`Session source ${source.source} cannot be migrated.`);
  }
  if (!isLocalSessionEnvironment(source)) {
    throw new Error("Remote session migration is not supported yet.");
  }
  if (!isMigrationTarget(target)) {
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
  target: MigrationTarget,
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
