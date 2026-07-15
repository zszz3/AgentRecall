import type { MigrationCompressionListener, PreparedMigrationSession } from "./session-migration-compression";
import { estimatePortableSessionTokens, migrationCompressionPercent, MIGRATION_TOKEN_LIMIT } from "./session-migration";
import type { WrittenMigratedSession } from "./session-migration-writers";
import type {
  MigrationAgent,
  PortableSession,
  SessionMigrationProgress,
  SessionMigrationRecord,
  SessionMigrationResult,
} from "./types";

export interface RemoteSessionRestoreDependencies {
  inspectCli: (target: MigrationAgent) => Promise<void> | void;
  prepare: (
    session: PortableSession,
    onProgress?: MigrationCompressionListener,
  ) => Promise<PreparedMigrationSession>;
  write: (target: MigrationAgent, session: PortableSession) => Promise<WrittenMigratedSession>;
  record: (record: SessionMigrationRecord) => Promise<void> | void;
  refreshIndex: (target: MigrationAgent, targetFilePath: string) => Promise<void>;
  launch: (target: MigrationAgent, sessionId: string, projectPath: string) => Promise<void>;
  resumeCommand: (target: MigrationAgent, sessionId: string, projectPath: string) => string;
  fallbackResumeCommand: (target: MigrationAgent, sessionId: string, projectPath: string) => string;
  onProgress?: (progress: SessionMigrationProgress) => void;
  idFactory: () => string;
  now: () => number;
  projectPathExists: (projectPath: string) => Promise<boolean> | boolean;
  projectPathIsDirectory: (projectPath: string) => Promise<boolean> | boolean;
}

export interface RestoreRemoteSessionOptions {
  remoteId: string;
  portable: PortableSession;
  target: MigrationAgent;
  localProjectPath: string;
  deps: RemoteSessionRestoreDependencies;
}

const RESTORE_TARGETS: MigrationAgent[] = ["claude", "codex", "codebuddy", "codewiz", "cursor"];

export async function restoreRemotePortableSession({
  remoteId,
  portable,
  target,
  localProjectPath,
  deps,
}: RestoreRemoteSessionOptions): Promise<SessionMigrationResult> {
  await validateRestoreRequest(portable, target, localProjectPath, deps);

  notifyProgress(deps.onProgress, {
    sessionKey: remoteId,
    target,
    stage: "reading",
  });

  await deps.inspectCli(target);

  const localPortable: PortableSession = {
    ...portable,
    projectPath: localProjectPath,
  };

  if (estimatePortableSessionTokens(localPortable) > MIGRATION_TOKEN_LIMIT) {
    notifyProgress(deps.onProgress, {
      sessionKey: remoteId,
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
          sessionKey: remoteId,
          target,
          stage: "compressing",
          percent: migrationCompressionPercent(event),
          compression: event,
        });
      }
    : undefined;

  const prepared = await deps.prepare(localPortable, compressionListener);

  notifyProgress(deps.onProgress, {
    sessionKey: remoteId,
    target,
    stage: "writing",
  });
  const written = await deps.write(target, prepared.session);

  const warnings: string[] = [];
  await collectWarning(warnings, async () => {
    await deps.record({
      id: deps.idFactory(),
      sourceSessionKey: `remote:${remoteId}`,
      sourceAgent: portable.sourceAgent,
      targetAgent: target,
      targetSessionId: written.sessionId,
      targetFilePath: written.filePath,
      strategy: prepared.strategy,
      createdAt: deps.now(),
    });
  }, "Failed to record remote restore metadata");

  const resumeCommand = safeResumeCommand(deps, warnings, target, written.sessionId, prepared.session.projectPath);

  notifyProgress(deps.onProgress, {
    sessionKey: remoteId,
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
    sessionKey: remoteId,
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

async function validateRestoreRequest(
  portable: PortableSession,
  target: MigrationAgent,
  localProjectPath: string,
  deps: RemoteSessionRestoreDependencies,
): Promise<void> {
  if (!RESTORE_TARGETS.includes(target)) {
    throw new Error(`Migration target ${target} is not supported.`);
  }
  if (!localProjectPath.trim()) {
    throw new Error("Choose a local project path before restoring.");
  }
  if (!(await deps.projectPathExists(localProjectPath))) {
    throw new Error(`Local project path does not exist: ${localProjectPath}`);
  }
  if (!(await deps.projectPathIsDirectory(localProjectPath))) {
    throw new Error(`Local project path is not a directory: ${localProjectPath}`);
  }
  if (!portable.messages.some((message) => message.role === "user" || message.role === "assistant")) {
    throw new Error("Remote session has no readable user/assistant messages to restore.");
  }
}

function notifyProgress(onProgress: RemoteSessionRestoreDependencies["onProgress"], progress: SessionMigrationProgress): void {
  try {
    onProgress?.(progress);
  } catch {
    // Observer failures must not break restore.
  }
}

async function collectWarning(warnings: string[], action: () => Promise<void>, prefix: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    warnings.push(formatWarning(prefix, error));
  }
}

function safeResumeCommand(
  deps: RemoteSessionRestoreDependencies,
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

function formatWarning(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
