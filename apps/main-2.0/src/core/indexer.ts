import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  loadClaudeCliSessionRows,
  loadCodeBuddyCliSessionFile,
  loadCodeWizSessions,
  loadCodexSessionRows,
  loadCursorTranscriptFile,
  loadDefaultSessions,
  loadDefaultSessionsAsyncIterator,
  parseJsonlText,
  type SessionLoadOptions,
} from "./session-loader";
import { migrationTargetDescriptor } from "./migration-targets";
import type { SessionStore } from "./session-store";
import type { LoadedSession, MigrationTarget, SessionEnvironment } from "./types";

export interface IndexStatus {
  running: boolean;
  indexed: number;
  skipped: number;
  total: number;
  lastIndexedAt: number | null;
  error: string | null;
}

export async function syncDefaultSessions(
  store: SessionStore,
  loadOptions: SessionLoadOptions = {},
): Promise<IndexStatus> {
  const loaded = loadDefaultSessions(loadOptions);
  let indexed = 0;
  for (const item of loaded) {
    await store.upsertIndexedSession(item.session, item.messages, item.tokenEvents, item.traceEvents);
    indexed++;
  }
  return {
    running: false,
    indexed,
    skipped: 0,
    total: loaded.length,
    lastIndexedAt: Date.now(),
    error: null,
  };
}

export interface BatchIndexOptions {
  batchSize?: number;
  timeBudgetMs?: number;
  loadOptions?: SessionLoadOptions;
  forceReindex?: (item: LoadedSession) => boolean;
  onProgress?: (status: IndexStatus) => void;
  onEnvironmentsChanged?: () => void;
  yieldToEventLoop?: () => Promise<void>;
  now?: () => number;
}

function indexFailureMessage(failed: number): string | null {
  if (failed === 0) return null;
  return `${failed} session${failed === 1 ? "" : "s"} could not be indexed; the remaining sessions were processed.`;
}

export async function syncLoadedSessionsInBatches(
  store: SessionStore,
  loaded: Iterable<LoadedSession> | AsyncIterable<LoadedSession>,
  options: BatchIndexOptions = {},
): Promise<IndexStatus> {
  const batchSize = Math.max(1, options.batchSize ?? 3);
  const timeBudgetMs = Math.max(1, options.timeBudgetMs ?? Number.POSITIVE_INFINITY);
  const yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const now = options.now ?? (() => performance.now());
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let total = 0;
  let pendingInBatch = 0;
  let sliceStartedAt = now();
  let cursorSessionKeysByIdentity: Map<string, Set<string>> | null = null;
  const environments = await store.listEnvironments();
  const sshEnvironmentByHostAlias = new Map(
    environments
      .filter((environment) => environment.kind === "ssh" && environment.hostAlias)
      .map((environment) => [environment.hostAlias!, environment]),
  );

  for await (const loadedItem of loaded) {
    const item = await resolveExecutionEnvironment(
      store,
      loadedItem,
      sshEnvironmentByHostAlias,
      options.onEnvironmentsChanged,
    );
    try {
      let sessionKeyMigrated = false;
      if (item.session.source === "cursor-agent") {
        if (!cursorSessionKeysByIdentity) {
          cursorSessionKeysByIdentity = new Map();
          for (const identity of await store.listSessionIdentitiesBySource("cursor-agent")) {
            const key = `${identity.storageEnvironmentId}\u0000${identity.rawId}`;
            const sessionKeys = cursorSessionKeysByIdentity.get(key) ?? new Set<string>();
            sessionKeys.add(identity.sessionKey);
            cursorSessionKeysByIdentity.set(key, sessionKeys);
          }
        }
        const storageEnvironmentId =
          item.session.storageEnvironmentId ?? item.session.environmentId ?? "local";
        const identityKey = `${storageEnvironmentId}\u0000${item.session.rawId}`;
        for (const previousKey of cursorSessionKeysByIdentity.get(identityKey) ?? []) {
          if (previousKey === item.session.sessionKey) continue;
          sessionKeyMigrated =
            await store.migrateSessionKeyPreservingUserState(previousKey, item.session.sessionKey)
            || sessionKeyMigrated;
        }
        cursorSessionKeysByIdentity.set(identityKey, new Set([item.session.sessionKey]));
      }
      if (
        !sessionKeyMigrated
        && !options.forceReindex?.(item)
        && await store.isIndexedSessionFresh(item.session)
      ) {
        await store.touchIndexedAtIfMissing(item.session.sessionKey);
        skipped++;
      } else {
        await store.upsertIndexedSession(item.session, item.messages, item.tokenEvents, item.traceEvents);
        indexed++;
      }
    } catch {
      skipped++;
      failed++;
    }
    total++;
    pendingInBatch++;

    if (pendingInBatch >= batchSize || now() - sliceStartedAt >= timeBudgetMs) {
      pendingInBatch = 0;
      options.onProgress?.({
        running: true,
        indexed,
        skipped,
        total,
        lastIndexedAt: null,
        error: indexFailureMessage(failed),
      });
      await yieldToEventLoop();
      sliceStartedAt = now();
    }
  }

  if (pendingInBatch > 0 || indexed === 0) {
    options.onProgress?.({
      running: true,
      indexed,
      skipped,
      total,
      lastIndexedAt: null,
      error: indexFailureMessage(failed),
    });
    await yieldToEventLoop();
  }

  return {
    running: false,
    indexed,
    skipped,
    total,
    lastIndexedAt: Date.now(),
    error: indexFailureMessage(failed),
  };
}

async function resolveExecutionEnvironment(
  store: SessionStore,
  item: LoadedSession,
  sshEnvironmentByHostAlias: Map<string, SessionEnvironment>,
  onEnvironmentsChanged?: () => void,
): Promise<LoadedSession> {
  const hint = item.executionEnvironmentHint;
  if (!hint) return item;

  let environment = sshEnvironmentByHostAlias.get(hint.hostAlias);
  if (!environment) {
    environment = await store.upsertEnvironment({
      kind: "ssh",
      label: hint.label,
      hostAlias: hint.hostAlias,
      enabled: false,
    });
    sshEnvironmentByHostAlias.set(hint.hostAlias, environment);
    onEnvironmentsChanged?.();
  }

  return {
    ...item,
    session: {
      ...item.session,
      environmentId: environment.id,
      environmentKind: environment.kind,
      environmentLabel: environment.label,
      storageEnvironmentId: item.session.storageEnvironmentId ?? "local",
    },
  };
}

export async function syncDefaultSessionsInBatches(
  store: SessionStore,
  options: BatchIndexOptions = {},
): Promise<IndexStatus> {
  const storedFiles = await store.listIndexedSessionFiles();
  const indexedFiles = sessionFileSnapshots(storedFiles);
  const incrementalCodexFiles = new Map<string, { offset: number; sessionKey: string }>();
  for (const file of storedFiles) {
    if (file.source !== "codex-cli" && file.source !== "codex-app" && file.source !== "tcodex-cli") continue;
    incrementalCodexFiles.set(file.filePath, {
      offset: file.fileSize,
      sessionKey: file.sessionKey,
    });
  }
  const dependencyChangedFiles = new Set<string>();
  let fileSkipped = 0;
  const loadOptions = options.loadOptions ?? {};
  const shouldSkipFile = loadOptions.shouldSkipFile;
  const onSkippedFile = loadOptions.onSkippedFile;
  const scannedFilePaths = new Set<string>();
  const scannedSessionKeys = new Set<string>();
  const rawLoaded = loadDefaultSessionsAsyncIterator({
    ...loadOptions,
    loadIncrementalCodexSession: async (filePath) => {
      const previous = incrementalCodexFiles.get(filePath);
      if (!previous) return undefined;
      const session = await store.getSession(previous.sessionKey);
      if (!session) return undefined;
      const messages = await store.getAllMessages(previous.sessionKey);
      const tokenEvents = await store.getTokenEvents(previous.sessionKey);
      const traceEvents = await store.getTraceEvents(previous.sessionKey);
      return {
        offset: previous.offset,
        loaded: {
          session,
          messages,
          tokenEvents,
          traceEvents,
        },
      };
    },
    shouldSkipFile: (filePath, stat, dependencyMtimeMs = 0) => {
      scannedFilePaths.add(filePath);
      const customDecision = shouldSkipFile?.(filePath, stat, dependencyMtimeMs);
      if (customDecision !== undefined) return customDecision;
      const snapshot = findSessionFileSnapshot(indexedFiles, filePath, stat);
      if (snapshot !== undefined && dependencyMtimeMs > snapshot.indexedAt) {
        dependencyChangedFiles.add(filePath);
        incrementalCodexFiles.delete(filePath);
      }
      return snapshot !== undefined && snapshot.indexedAt > 0 && dependencyMtimeMs <= snapshot.indexedAt;
    },
    onSkippedFile: (filePath, stat) => {
      fileSkipped++;
      onSkippedFile?.(filePath, stat);
    },
  });
  const loaded = (async function* () {
    for await (const item of rawLoaded) {
      if (item.session.filePath) scannedFilePaths.add(item.session.filePath);
      scannedSessionKeys.add(item.session.sessionKey);
      yield item;
    }
  })();
  const status = await syncLoadedSessionsInBatches(store, loaded, {
    ...options,
    forceReindex: (item) =>
      dependencyChangedFiles.has(item.session.filePath) || options.forceReindex?.(item) === true,
    onProgress: (status) => options.onProgress?.({ ...status, skipped: status.skipped + fileSkipped, total: status.total + fileSkipped }),
  });
  // Prune sessions whose source files no longer exist in local storage. Cursor
  // is the exception: its shared database can forget one conversation while our
  // parsed message cache remains the only readable copy.
  for (const staleKey of await store.listSessionKeysByFilePath("local", scannedFilePaths, scannedSessionKeys)) {
    const staleSession = await store.getSession(staleKey);
    if (
      loadOptions.includeCursorAgent
      && staleSession?.source === "cursor-agent"
      && staleSession.messageCount > 0
    ) {
      await store.setSessionSourceAvailable(staleKey, false);
    } else {
      await store.deleteSessionRecord(staleKey);
    }
  }
  return { ...status, skipped: status.skipped + fileSkipped, total: status.total + fileSkipped };
}

interface SessionFileSnapshot {
  fileMtimeMs: number;
  fileSize: number;
  indexedAt: number;
}

function sessionFileSnapshots(files: Array<{ filePath: string; fileMtimeMs: number; fileSize: number; indexedAt: number }>): Map<string, SessionFileSnapshot[]> {
  const snapshots = new Map<string, SessionFileSnapshot[]>();
  for (const file of files) {
    const bucket = snapshots.get(file.filePath) ?? [];
    bucket.push({ fileMtimeMs: file.fileMtimeMs, fileSize: file.fileSize, indexedAt: file.indexedAt });
    snapshots.set(file.filePath, bucket);
  }
  return snapshots;
}

function findSessionFileSnapshot(
  snapshots: Map<string, SessionFileSnapshot[]>,
  filePath: string,
  stat: { mtimeMs: number; size: number },
): SessionFileSnapshot | undefined {
  return snapshots.get(filePath)?.find((snapshot) => snapshot.fileSize === stat.size && Math.abs(snapshot.fileMtimeMs - stat.mtimeMs) < 1);
}

export async function indexMigratedSessionFile(
  store: SessionStore,
  target: MigrationTarget,
  filePath: string,
  sessionId?: string,
): Promise<IndexStatus> {
  const loaded = loadMigratedSessionFile(target, filePath, sessionId);
  if (!loaded) {
    throw new Error(`Migrated ${target} session could not be loaded from ${filePath}.`);
  }
  await store.upsertIndexedSession(loaded.session, loaded.messages, loaded.tokenEvents, loaded.traceEvents);
  return {
    running: false,
    indexed: 1,
    skipped: 0,
    total: 1,
    lastIndexedAt: Date.now(),
    error: null,
  };
}

function loadMigratedSessionFile(target: MigrationTarget, filePath: string, sessionId?: string): LoadedSession | null {
  if (target === "cursor") return loadCursorTranscriptFile(filePath);

  const descriptor = migrationTargetDescriptor(target);
  if (descriptor.family === "codebuddy") return loadCodeBuddyCliSessionFile(filePath);
  if (descriptor.family === "codewiz") {
    const sessions = loadCodeWizSessions(path.dirname(filePath));
    return sessions.find((item) => item.session.rawId === sessionId) ?? sessions[0] ?? null;
  }

  let rows: unknown[];
  try {
    rows = parseJsonlText(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (descriptor.family === "codex") {
    return loadCodexSessionRows(filePath, rows, { sourceOverride: descriptor.source });
  }
  return loadClaudeCliSessionRows(filePath, rows, { source: descriptor.source });
}
