import type { MigrationCompressionListener, PreparedMigrationSession } from "./session-migration-compression";
import { BASE_MIGRATION_TARGETS, isMigrationTarget } from "./migration-targets";
import type { WrittenMigratedSession } from "./session-migration-writers";
import { isLocalSessionEnvironment } from "./session-environment";
import { sessionSourceDescriptor } from "./session-sources";
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

export const MIGRATION_TOKEN_LIMIT = 100_000;

export interface SessionMigrationDependencies {
  inspectCli: (target: MigrationTarget) => Promise<void> | void;
  prepare: (
    session: PortableSession,
    onProgress?: MigrationCompressionListener,
  ) => Promise<PreparedMigrationSession>;
  write: (
    target: MigrationTarget,
    session: PortableSession,
    targetSessionId?: string,
  ) => Promise<WrittenMigratedSession>;
  record: (record: SessionMigrationRecord) => Promise<void> | void;
  refreshIndex: (target: MigrationTarget, targetFilePath: string, targetSessionId: string) => Promise<void>;
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
  targetSessionIdFactory?: () => string;
  now: () => number;
  projectPathExists: (projectPath: string) => Promise<boolean> | boolean;
  projectPathIsDirectory: (projectPath: string) => Promise<boolean> | boolean;
}

export interface MigrateSessionOptions {
  source: SessionSearchResult;
  messages: SessionMessage[];
  target: MigrationTarget;
  targetProjectPath?: string;
  completeTokenLimit?: number;
  turnSourceMessageIndexes?: readonly number[];
  subagents?: PortableSession[];
  deps: SessionMigrationDependencies;
}

export function migrationAgentForSource(source: SessionSource): MigrationAgent | null {
  return sessionSourceDescriptor(source).migrationAgent;
}

export function sshMigrationTarget(source: SessionSource): "claude" | "codex" | null {
  if (source === "claude-cli") return "codex";
  if (source === "codex-cli") return "claude";
  return null;
}

export function supportedMigrationTargets(source: SessionSource): MigrationTarget[];
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
  options: {
    turnSourceMessageIndexes?: readonly number[];
    allowSsh?: boolean;
  } = {},
): PortableSession {
  const sourceAgent = migrationAgentForSource(session.source);
  if (!sourceAgent) {
    throw new Error(`Session source ${session.source} cannot be migrated.`);
  }
  const allowedSsh = options.allowSsh === true && session.environmentKind === "ssh";
  if (!isLocalSessionEnvironment(session) && session.environmentKind !== "wsl" && !allowedSsh) {
    throw new Error("SSH session migration is not supported yet.");
  }
  const portableEntries = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message, index) => ({
      sourceIndex: message.index,
      message: {
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        index,
      },
    }));
  const portableMessages = portableEntries.map((entry) => entry.message);
  const sourceTurnStarts = options.turnSourceMessageIndexes
    ? [...new Set(options.turnSourceMessageIndexes)].sort((left, right) => left - right)
    : null;
  const turnBoundaries = sourceTurnStarts
    ?.map((sourceStart, turnIndex) => {
      const nextSourceStart = sourceTurnStarts[turnIndex + 1] ?? Number.POSITIVE_INFINITY;
      return portableEntries.findIndex(
        (entry) => entry.sourceIndex >= sourceStart && entry.sourceIndex < nextSourceStart,
      );
    })
    .filter((index, position, indexes) => index >= 0 && indexes.indexOf(index) === position);

  return {
    sourceSessionKey: session.sessionKey,
    sourceSessionId: session.rawId,
    sourceAgent,
    title: session.displayTitle,
    projectPath: session.projectPath.trim() ? session.projectPath : "",
    startedAt: new Date(session.timestamp).toISOString(),
    messages: portableMessages,
    ...(turnBoundaries && turnBoundaries.length > 0 ? { turnBoundaries } : {}),
    isSubagent: session.isSubagent === true,
    parentSessionId: session.parentSessionId ?? null,
  };
}

export function migrationRootSessionForWrite(session: PortableSession): PortableSession {
  return {
    ...session,
    isSubagent: false,
    parentSessionId: null,
    subagents: [],
  };
}

export function collectMigrationDescendants(
  source: SessionSearchResult,
  candidates: readonly SessionSearchResult[],
): SessionSearchResult[] {
  const childrenByParentId = new Map<string, SessionSearchResult[]>();
  for (const candidate of candidates) {
    if (
      candidate.isSubagent !== true
      || candidate.source !== source.source
      || candidate.environmentId !== source.environmentId
      || !candidate.parentSessionId
    ) continue;
    const children = childrenByParentId.get(candidate.parentSessionId) ?? [];
    children.push(candidate);
    childrenByParentId.set(candidate.parentSessionId, children);
  }

  const descendants: SessionSearchResult[] = [];
  const pendingParentIds = [source.rawId];
  const visitedSessionKeys = new Set<string>();
  let pendingParentIndex = 0;
  while (pendingParentIndex < pendingParentIds.length) {
    const parentId = pendingParentIds[pendingParentIndex++];
    const children = (childrenByParentId.get(parentId) ?? [])
      .sort((left, right) => left.timestamp - right.timestamp || left.sessionKey.localeCompare(right.sessionKey));
    for (const child of children) {
      if (visitedSessionKeys.has(child.sessionKey)) continue;
      visitedSessionKeys.add(child.sessionKey);
      descendants.push(child);
      pendingParentIds.push(child.rawId);
    }
  }
  return descendants;
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
  targetProjectPath,
  completeTokenLimit = MIGRATION_TOKEN_LIMIT,
  turnSourceMessageIndexes,
  subagents = [],
  deps,
}: MigrateSessionOptions): Promise<SessionMigrationResult> {
  const migrationSource = targetProjectPath === undefined
    ? source
    : { ...source, projectPath: targetProjectPath.trim() };
  await validateMigrationRequest(migrationSource, target, deps);

  notifyProgress(deps.onProgress, {
    sessionKey: source.sessionKey,
    target,
    stage: "reading",
  });

  await deps.inspectCli(target);

  const portable = portableSessionFrom(migrationSource, messages, { turnSourceMessageIndexes });
  if (subagents.length > 0) portable.subagents = subagents;
  const rootSourceId = portableSourceId(portable);
  const flattenedSubagents = flattenPortableSubagents(subagents);
  const codexSubagentNormalization = target === "codex"
    ? normalizeCursorCodexSubagents(flattenedSubagents, rootSourceId)
    : { subagents: flattenedSubagents, sourceAliases: new Map<string, string>() };
  const portableSubagents = codexSubagentNormalization.subagents;
  const codexLinkage = target === "codex" && portableSubagents.length > 0 && deps.targetSessionIdFactory
    ? buildCodexMigrationLinkage(
        portable,
        portableSubagents,
        codexSubagentNormalization.sourceAliases,
        deps.targetSessionIdFactory,
      )
    : null;
  const migrationPortable = target === "codex"
    ? withoutSubagentSystemNotifications(portable, portableSubagents.length > 0)
    : portable;
  if (estimatePortableSessionTokens(migrationPortable) > completeTokenLimit) {
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

  const prepared = await deps.prepare(migrationPortable, compressionListener);

  notifyProgress(deps.onProgress, {
    sessionKey: source.sessionKey,
    target,
    stage: "writing",
  });
  const mainWriteSession = codexLinkage
    ? codexSessionForWrite(prepared.session, rootSourceId, null, codexLinkage)
    : migrationRootSessionForWrite(prepared.session);
  const reservedMainTargetId = codexLinkage?.targetIdBySourceId.get(rootSourceId);
  const written = reservedMainTargetId
    ? await deps.write(target, mainWriteSession, reservedMainTargetId)
    : await deps.write(target, mainWriteSession);
  if (codexLinkage && written.sessionId !== codexLinkage.targetIdBySourceId.get(rootSourceId)) {
    throw new Error("Codex migration writer did not preserve the reserved parent session id.");
  }

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
  let indexed = true;
  let restoredSubagentCount = 0;
  const writtenTargetIdsBySourceId = new Map<string, string>([[rootSourceId, written.sessionId]]);
  for (const subagent of portableSubagents) {
    const subagentSourceId = portableSourceId(subagent);
    const sourceParentId = subagent.parentSessionId?.trim() || rootSourceId;
    const targetParentId = writtenTargetIdsBySourceId.get(sourceParentId);
    if (!targetParentId) {
      warnings.push(`Skipped subagent ${subagent.title || subagentSourceId} because its migrated parent was unavailable.`);
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
        projectPath: prepared.session.projectPath,
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
      writtenTargetIdsBySourceId.set(subagentSourceId, writtenSubagent.sessionId);
      restoredSubagentCount += 1;
      await collectWarning(warnings, async () => {
        await deps.record({
          id: deps.idFactory(),
          sourceSessionKey: subagent.sourceSessionKey,
          sourceAgent: subagent.sourceAgent,
          targetAgent: target,
          targetSessionId: writtenSubagent.sessionId,
          targetFilePath: writtenSubagent.filePath,
          strategy: preparedSubagent.strategy,
          createdAt: deps.now(),
        });
      }, `Failed to record migrated subagent ${subagent.title || subagentSourceId}`);
      try {
        await deps.refreshIndex(target, writtenSubagent.filePath, writtenSubagent.sessionId);
      } catch (error) {
        indexed = false;
        warnings.push(formatWarning(`Failed to refresh migrated subagent ${subagent.title || subagentSourceId}`, error));
      }
    } catch (error) {
      warnings.push(formatWarning(`Failed to migrate subagent ${subagent.title || subagentSourceId}`, error));
    }
  }
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
  try {
    await deps.refreshIndex(target, written.filePath, written.sessionId);
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
    ...(restoredSubagentCount > 0 ? { restoredSubagentCount } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join("\n") } : {}),
  };
}

export interface CodexMigrationLinkage {
  targetIdBySourceId: Map<string, string>;
  depthBySourceId: Map<string, number>;
  pathBySourceId: Map<string, string>;
  childrenByParentSourceId: Map<string, PortableSession[]>;
}

export function buildCodexMigrationLinkage(
  root: PortableSession,
  subagents: PortableSession[],
  sourceAliases: Map<string, string>,
  createTargetSessionId: () => string,
): CodexMigrationLinkage {
  const rootSourceId = portableSourceId(root);
  const targetIdBySourceId = new Map<string, string>([[rootSourceId, createTargetSessionId()]]);
  const depthBySourceId = new Map<string, number>([[rootSourceId, 0]]);
  const pathBySourceId = new Map<string, string>([[rootSourceId, "/root"]]);
  const childrenByParentSourceId = new Map<string, PortableSession[]>();
  for (const subagent of subagents) {
    const sourceId = portableSourceId(subagent);
    const parentSourceId = subagent.parentSessionId?.trim() || rootSourceId;
    const siblings = childrenByParentSourceId.get(parentSourceId) ?? [];
    siblings.push(subagent);
    childrenByParentSourceId.set(parentSourceId, siblings);
    const parentDepth = depthBySourceId.get(parentSourceId) ?? 0;
    const parentPath = pathBySourceId.get(parentSourceId) ?? "/root";
    targetIdBySourceId.set(sourceId, createTargetSessionId());
    depthBySourceId.set(sourceId, parentDepth + 1);
    pathBySourceId.set(sourceId, `${parentPath}/migrated_${codexSubagentSlug(sourceId)}`);
  }
  for (const [aliasSourceId, canonicalSourceId] of sourceAliases) {
    const targetId = targetIdBySourceId.get(canonicalSourceId);
    if (targetId) targetIdBySourceId.set(aliasSourceId, targetId);
  }
  return { targetIdBySourceId, depthBySourceId, pathBySourceId, childrenByParentSourceId };
}

export function codexSessionForWrite(
  session: PortableSession,
  sourceId: string,
  targetParentId: string | null,
  linkage: CodexMigrationLinkage,
): PortableSession {
  const targetSessionId = linkage.targetIdBySourceId.get(sourceId);
  if (!targetSessionId) throw new Error(`Missing reserved Codex session id for ${sourceId}.`);
  const targetIdByLowercaseSourceId = new Map(
    [...linkage.targetIdBySourceId].map(([sourceSessionId, targetId]) => [sourceSessionId.toLowerCase(), targetId]),
  );
  const messages = session.messages.map((message) => {
    const content = message.content.replace(/\]\(([^)\s]+)\)/g, (match, sourceSessionId: string) => {
      const targetId = linkage.targetIdBySourceId.get(sourceSessionId)
        ?? targetIdByLowercaseSourceId.get(sourceSessionId.toLowerCase());
      return targetId ? `](${targetId})` : match;
    });
    return content === message.content ? message : { ...message, content };
  });
  const directSubagents = (linkage.childrenByParentSourceId.get(sourceId) ?? [])
    .map((candidate) => {
      const childSourceId = portableSourceId(candidate);
      return {
        ...candidate,
        sourceSessionId: linkage.targetIdBySourceId.get(childSourceId),
        parentSessionId: targetSessionId,
        messages: [],
        subagents: [],
        subagentDepth: linkage.depthBySourceId.get(childSourceId),
        subagentPath: linkage.pathBySourceId.get(childSourceId),
      };
    });
  return {
    ...session,
    messages,
    ...(targetParentId
      ? {
          isSubagent: true,
          parentSessionId: targetParentId,
          subagentDepth: linkage.depthBySourceId.get(sourceId),
          subagentPath: linkage.pathBySourceId.get(sourceId),
        }
      : { isSubagent: false, parentSessionId: null }),
    subagents: directSubagents,
  };
}

export function withoutSubagentSystemNotifications(
  session: PortableSession,
  hasSubagents: boolean,
): PortableSession {
  if (!hasSubagents) return session;
  const retained = session.messages
    .map((message, sourceIndex) => ({ message, sourceIndex }))
    .filter(({ message }) => !(
      message.role === "user"
      && message.content.includes("<system_notification>")
      && /\bkind:\s*subagent\b/i.test(message.content)
    ));
  if (retained.length === session.messages.length) return session;
  const boundaries = session.turnBoundaries?.map((boundary, boundaryIndex, sourceBoundaries) => {
    const nextBoundary = sourceBoundaries[boundaryIndex + 1] ?? Number.POSITIVE_INFINITY;
    return retained.findIndex((entry) => entry.sourceIndex >= boundary && entry.sourceIndex < nextBoundary);
  }).filter((index, position, indexes) => index >= 0 && indexes.indexOf(index) === position);
  return {
    ...session,
    messages: retained.map(({ message }, index) => ({ ...message, index })),
    ...(boundaries && boundaries.length > 0 ? { turnBoundaries: boundaries } : { turnBoundaries: undefined }),
  };
}

export function flattenPortableSubagents(subagents: PortableSession[]): PortableSession[] {
  const flattened: PortableSession[] = [];
  const pending = [...subagents];
  const visited = new Set<string>();
  let pendingIndex = 0;
  while (pendingIndex < pending.length) {
    const subagent = pending[pendingIndex++];
    if (visited.has(subagent.sourceSessionKey)) continue;
    visited.add(subagent.sourceSessionKey);
    flattened.push(subagent);
    pending.push(...(subagent.subagents ?? []));
  }
  return flattened;
}

export function portableSourceId(session: PortableSession): string {
  return session.sourceSessionId || session.sourceSessionKey.split(":").at(-1) || session.sourceSessionKey;
}

export function normalizeCursorCodexSubagents(
  subagents: PortableSession[],
  rootSourceId: string,
): { subagents: PortableSession[]; sourceAliases: Map<string, string> } {
  const duplicates = new Map<string, { transcript: PortableSession[]; task: PortableSession[] }>();
  for (const subagent of subagents) {
    if (subagent.sourceAgent !== "cursor") continue;
    const startedAt = Date.parse(subagent.startedAt);
    const normalizedTitle = subagent.title.trim().toLowerCase();
    if (!Number.isFinite(startedAt) || !normalizedTitle) continue;
    const key = `${startedAt}:${normalizedTitle}`;
    const group = duplicates.get(key) ?? { transcript: [], task: [] };
    const sourceId = portableSourceId(subagent);
    (sourceId.toLowerCase().startsWith("task-") ? group.task : group.transcript).push(subagent);
    duplicates.set(key, group);
  }

  const sourceAliases = new Map<string, string>();
  const replacements = new Map<string, PortableSession>();
  for (const group of duplicates.values()) {
    if (group.transcript.length !== 1 || group.task.length !== 1) continue;
    const transcript = group.transcript[0];
    const task = group.task[0];
    const transcriptId = portableSourceId(transcript);
    const taskId = portableSourceId(task);
    sourceAliases.set(taskId, transcriptId);
    replacements.set(transcriptId, {
      ...transcript,
      title: task.title || transcript.title,
      parentSessionId: task.parentSessionId?.trim() || transcript.parentSessionId,
    });
  }

  const retained = subagents
    .filter((subagent) => !sourceAliases.has(portableSourceId(subagent)))
    .map((subagent) => {
      const sourceId = portableSourceId(subagent);
      const replacement = replacements.get(sourceId) ?? subagent;
      const parentId = replacement.parentSessionId?.trim();
      return parentId && sourceAliases.has(parentId)
        ? { ...replacement, parentSessionId: sourceAliases.get(parentId)! }
        : replacement;
    });

  const ordered: PortableSession[] = [];
  const availableParentIds = new Set([rootSourceId]);
  const pending = [...retained];
  while (pending.length > 0) {
    const nextIndex = pending.findIndex((subagent) =>
      availableParentIds.has(subagent.parentSessionId?.trim() || rootSourceId));
    if (nextIndex < 0) break;
    const [next] = pending.splice(nextIndex, 1);
    ordered.push(next);
    availableParentIds.add(portableSourceId(next));
  }
  return { subagents: [...ordered, ...pending], sourceAliases };
}

function codexSubagentSlug(sourceId: string): string {
  return sourceId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "subagent";
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
  if (!isLocalSessionEnvironment(source) && source.environmentKind !== "wsl") {
    throw new Error("SSH session migration is not supported yet.");
  }
  if (!isMigrationTarget(target)) {
    throw new Error(`Migration target ${target} is not supported.`);
  }

  const projectPath = source.projectPath;
  if (!projectPath.trim()) {
    return;
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
