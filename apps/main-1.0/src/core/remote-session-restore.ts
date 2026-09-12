import type { MigrationCompressionListener, PreparedMigrationSession } from "./session-migration-compression";
import {
  buildCodexMigrationLinkage,
  codexSessionForWrite,
  estimatePortableSessionTokens,
  flattenPortableSubagents,
  migrationCompressionPercent,
  MIGRATION_TOKEN_LIMIT,
  normalizeCursorCodexSubagents,
  portableSourceId,
  withoutSubagentSystemNotifications,
} from "./session-migration";
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
  write: (target: MigrationAgent, session: PortableSession, targetSessionId?: string) => Promise<WrittenMigratedSession>;
  record: (record: SessionMigrationRecord) => Promise<void> | void;
  refreshIndex: (target: MigrationAgent, targetFilePath: string, targetSessionId: string) => Promise<void>;
  launch: (target: MigrationAgent, sessionId: string, projectPath: string) => Promise<void>;
  resumeCommand: (target: MigrationAgent, sessionId: string, projectPath: string) => string;
  fallbackResumeCommand: (target: MigrationAgent, sessionId: string, projectPath: string) => string;
  onProgress?: (progress: SessionMigrationProgress) => void;
  idFactory: () => string;
  targetSessionIdFactory?: () => string;
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

export class RemoteSessionRestoreError extends Error {
  constructor(
    message: string,
    readonly operationId: string,
    readonly stage: SessionMigrationProgress["stage"],
    readonly target: MigrationAgent,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RemoteSessionRestoreError";
  }
}

const RESTORE_TARGETS: MigrationAgent[] = ["claude", "codex", "codebuddy", "codewiz", "cursor"];

export async function restoreRemotePortableSession({
  remoteId,
  portable,
  target,
  localProjectPath,
  deps,
}: RestoreRemoteSessionOptions): Promise<SessionMigrationResult> {
  const restoredProjectPath = localProjectPath.trim();
  const operationId = deps.idFactory();
  const completedStages: SessionMigrationProgress["stage"][] = [];
  await validateRestoreRequest(portable, target, restoredProjectPath, deps);

  notifyProgress(deps.onProgress, {
    sessionKey: remoteId,
    target,
    stage: "reading",
  });

  await runRestoreStage(operationId, target, "reading", () => deps.inspectCli(target));
  completedStages.push("reading");

  const localPortable: PortableSession = {
    ...portable,
    projectPath: restoredProjectPath,
  };
  const rootSourceId = portableSourceId(localPortable);
  const flattenedSubagents = flattenPortableSubagents(localPortable.subagents ?? []);
  const codexSubagentNormalization = target === "codex"
    ? normalizeCursorCodexSubagents(flattenedSubagents, rootSourceId)
    : { subagents: flattenedSubagents, sourceAliases: new Map<string, string>() };
  const portableSubagents = codexSubagentNormalization.subagents;
  const codexLinkage = target === "codex" && portableSubagents.length > 0 && deps.targetSessionIdFactory
    ? buildCodexMigrationLinkage(
        localPortable,
        portableSubagents,
        codexSubagentNormalization.sourceAliases,
        deps.targetSessionIdFactory,
      )
    : null;
  const migrationPortable = target === "codex"
    ? withoutSubagentSystemNotifications(localPortable, portableSubagents.length > 0)
    : localPortable;

  if (estimatePortableSessionTokens(migrationPortable) > MIGRATION_TOKEN_LIMIT) {
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

  const compressed = estimatePortableSessionTokens(migrationPortable) > MIGRATION_TOKEN_LIMIT;
  const prepared = await runRestoreStage(operationId, target, "compressing", () => deps.prepare(migrationPortable, compressionListener));
  if (compressed) completedStages.push("compressing");

  notifyProgress(deps.onProgress, {
    sessionKey: remoteId,
    target,
    stage: "writing",
  });
  const mainWriteSession = codexLinkage
    ? codexSessionForWrite(prepared.session, rootSourceId, null, codexLinkage)
    : { ...prepared.session, subagents: [] };
  const reservedMainTargetId = codexLinkage?.targetIdBySourceId.get(rootSourceId);
  const written = await runRestoreStage(operationId, target, "writing", () => reservedMainTargetId
    ? deps.write(target, mainWriteSession, reservedMainTargetId)
    : deps.write(target, mainWriteSession));
  completedStages.push("writing");
  if (reservedMainTargetId && written.sessionId !== reservedMainTargetId) {
    throw new Error("Codex migration writer did not preserve the reserved parent session id.");
  }

  const warnings: string[] = [];
  let indexed = true;
  let restoredSubagentCount = 0;
  const targetIdsBySourceId = new Map<string, string>();
  targetIdsBySourceId.set(rootSourceId, written.sessionId);

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

  for (const subagent of portableSubagents) {
    const subagentSourceId = portableSourceId(subagent);
    const sourceParentId = subagent.parentSessionId?.trim() || rootSourceId;
    const targetParentId = targetIdsBySourceId.get(sourceParentId);
    if (!targetParentId) {
      warnings.push(`Skipped subagent ${subagent.title || portableSourceId(subagent)} because its restored parent was unavailable.`);
      continue;
    }
    try {
      const hasDirectChildren = target === "codex" && (
        (codexLinkage?.childrenByParentSourceId.get(subagentSourceId)?.length ?? 0) > 0
        || (!codexLinkage && portableSubagents.some((candidate) =>
          (candidate.parentSessionId?.trim() || rootSourceId) === subagentSourceId))
      );
      const preparedSubagent = await deps.prepare({
        ...(target === "codex"
          ? withoutSubagentSystemNotifications(subagent, hasDirectChildren)
          : subagent),
        projectPath: restoredProjectPath,
        isSubagent: true,
        parentSessionId: targetParentId,
      });
      const subagentWriteSession = codexLinkage
        ? codexSessionForWrite(preparedSubagent.session, subagentSourceId, targetParentId, codexLinkage)
        : { ...preparedSubagent.session, subagents: [] };
      const reservedTargetId = codexLinkage?.targetIdBySourceId.get(subagentSourceId);
      const writtenSubagent = reservedTargetId
        ? await deps.write(target, subagentWriteSession, reservedTargetId)
        : await deps.write(target, subagentWriteSession);
      if (reservedTargetId && writtenSubagent.sessionId !== reservedTargetId) {
        throw new Error("Codex migration writer did not preserve a reserved subagent session id.");
      }
      targetIdsBySourceId.set(subagentSourceId, writtenSubagent.sessionId);
      restoredSubagentCount += 1;
      await collectWarning(warnings, async () => {
        await deps.record({
          id: deps.idFactory(),
          sourceSessionKey: `remote:${remoteId}:subagent:${subagent.sourceSessionKey}`,
          sourceAgent: subagent.sourceAgent,
          targetAgent: target,
          targetSessionId: writtenSubagent.sessionId,
          targetFilePath: writtenSubagent.filePath,
          strategy: preparedSubagent.strategy,
          createdAt: deps.now(),
        });
      }, `Failed to record restored subagent ${subagent.title || portableSourceId(subagent)}`);
      try {
        await deps.refreshIndex(target, writtenSubagent.filePath, writtenSubagent.sessionId);
      } catch (error) {
        indexed = false;
        warnings.push(formatWarning(`Failed to refresh restored subagent ${subagent.title || portableSourceId(subagent)}`, error));
      }
    } catch (error) {
      warnings.push(formatWarning(`Failed to restore subagent ${subagent.title || portableSourceId(subagent)}`, error));
    }
  }

  const resumeCommand = safeResumeCommand(deps, warnings, target, written.sessionId, prepared.session.projectPath);

  notifyProgress(deps.onProgress, {
    sessionKey: remoteId,
    target,
    stage: "indexing",
  });
  try {
    await deps.refreshIndex(target, written.filePath, written.sessionId);
    completedStages.push("indexing");
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
    completedStages.push("launching");
  } catch (error) {
    launched = false;
    warnings.push(formatWarning("Failed to launch target session", error));
  }

  return {
    operationId,
    target,
    targetSessionId: written.sessionId,
    targetFilePath: written.filePath,
    strategy: prepared.strategy,
    resumeCommand,
    indexed,
    launched,
    ...(restoredSubagentCount > 0 ? { restoredSubagentCount } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join("\n") } : {}),
    completedStages,
    partial: !indexed || !launched || warnings.length > 0,
  };
}

async function runRestoreStage<T>(
  operationId: string,
  target: MigrationAgent,
  stage: SessionMigrationProgress["stage"],
  action: () => Promise<T> | T,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RemoteSessionRestoreError) throw error;
    throw new RemoteSessionRestoreError(
      `Remote session restore ${stage} stage failed (operation ${operationId}): ${error instanceof Error ? error.message : String(error)}`,
      operationId,
      stage,
      target,
      { cause: error },
    );
  }
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
  if (localProjectPath) {
    if (!(await deps.projectPathExists(localProjectPath))) {
      throw new Error(`Local project path does not exist: ${localProjectPath}`);
    }
    if (!(await deps.projectPathIsDirectory(localProjectPath))) {
      throw new Error(`Local project path is not a directory: ${localProjectPath}`);
    }
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
