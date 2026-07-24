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
  loadDefaultSessionsIterator,
  parseJsonlText,
  type SessionLoadOptions,
} from "./session-loader";
import { migrationTargetDescriptor } from "./migration-targets";
import type { SessionStore } from "./session-store";
import type { LoadedSession, MigrationTarget } from "./types";

export interface IndexStatus {
  running: boolean;
  indexed: number;
  skipped: number;
  total: number;
  lastIndexedAt: number | null;
  error: string | null;
}

export function syncDefaultSessions(store: SessionStore, loadOptions: SessionLoadOptions = {}): IndexStatus {
  const loaded = loadDefaultSessions(loadOptions);
  let indexed = 0;
  for (const item of loaded) {
    store.upsertIndexedSession(item.session, item.messages, item.tokenEvents, item.traceEvents);
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
  onProgress?: (status: IndexStatus) => void;
  onEnvironmentsChanged?: () => void;
  yieldToEventLoop?: () => Promise<void>;
  now?: () => number;
}

export async function syncLoadedSessionsInBatches(
  store: SessionStore,
  loaded: Iterable<LoadedSession>,
  options: BatchIndexOptions = {},
): Promise<IndexStatus> {
  const batchSize = Math.max(1, options.batchSize ?? 3);
  const timeBudgetMs = Math.max(1, options.timeBudgetMs ?? Number.POSITIVE_INFINITY);
  const yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const now = options.now ?? (() => performance.now());
  let indexed = 0;
  let skipped = 0;
  let total = 0;
  let pendingInBatch = 0;
  let sliceStartedAt = now();
  const sshEnvironmentByHostAlias = new Map(
    store
      .listEnvironments()
      .filter((environment) => environment.kind === "ssh" && environment.hostAlias)
      .map((environment) => [environment.hostAlias!, environment]),
  );

  for (const loadedItem of loaded) {
    const item = resolveExecutionEnvironment(
      store,
      loadedItem,
      sshEnvironmentByHostAlias,
      options.onEnvironmentsChanged,
    );
    if (store.isIndexedSessionFresh(item.session)) {
      store.touchIndexedAtIfMissing(item.session.sessionKey);
      skipped++;
    } else {
      store.upsertIndexedSession(item.session, item.messages, item.tokenEvents, item.traceEvents);
      indexed++;
    }
    total++;
    pendingInBatch++;

    if (pendingInBatch >= batchSize || now() - sliceStartedAt >= timeBudgetMs) {
      pendingInBatch = 0;
      options.onProgress?.({ running: true, indexed, skipped, total, lastIndexedAt: null, error: null });
      await yieldToEventLoop();
      sliceStartedAt = now();
    }
  }

  if (pendingInBatch > 0 || indexed === 0) {
    options.onProgress?.({ running: true, indexed, skipped, total, lastIndexedAt: null, error: null });
    await yieldToEventLoop();
  }

  return {
    running: false,
    indexed,
    skipped,
    total,
    lastIndexedAt: Date.now(),
    error: null,
  };
}

function resolveExecutionEnvironment(
  store: SessionStore,
  item: LoadedSession,
  sshEnvironmentByHostAlias: Map<string, ReturnType<SessionStore["listEnvironments"]>[number]>,
  onEnvironmentsChanged?: () => void,
): LoadedSession {
  const hint = item.executionEnvironmentHint;
  if (!hint) return item;

  let environment = sshEnvironmentByHostAlias.get(hint.hostAlias);
  if (!environment) {
    environment = store.upsertEnvironment({
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

export function syncDefaultSessionsInBatches(store: SessionStore, options: BatchIndexOptions = {}): Promise<IndexStatus> {
  const indexedFiles = sessionFileSnapshots(store.listIndexedSessionFiles());
  let fileSkipped = 0;
  const loadOptions = options.loadOptions ?? {};
  const shouldSkipFile = loadOptions.shouldSkipFile;
  const onSkippedFile = loadOptions.onSkippedFile;
  const scannedFilePaths = new Set<string>();
  const rawLoaded = loadDefaultSessionsIterator({
    ...loadOptions,
    shouldSkipFile: (filePath, stat, dependencyMtimeMs = 0) => {
      scannedFilePaths.add(filePath);
      const customDecision = shouldSkipFile?.(filePath, stat, dependencyMtimeMs);
      if (customDecision !== undefined) return customDecision;
      const snapshot = findSessionFileSnapshot(indexedFiles, filePath, stat);
      return snapshot !== undefined && snapshot.indexedAt > 0 && dependencyMtimeMs <= snapshot.indexedAt;
    },
    onSkippedFile: (filePath, stat) => {
      fileSkipped++;
      onSkippedFile?.(filePath, stat);
    },
  });
  const loaded = (function* () {
    for (const item of rawLoaded) {
      if (item.session.filePath) scannedFilePaths.add(item.session.filePath);
      yield item;
    }
  })();
  return syncLoadedSessionsInBatches(store, loaded, {
    ...options,
    onProgress: (status) => options.onProgress?.({ ...status, skipped: status.skipped + fileSkipped, total: status.total + fileSkipped }),
  }).then((status) => {
    // Prune sessions whose source files no longer exist in local storage. Sessions
    // stored remotely are synced independently and their paths are not local
    // filesystem paths. scannedFilePaths covers file-based and DB-backed sources.
    for (const staleKey of store.listSessionKeysByFilePath("local", scannedFilePaths)) {
      store.deleteSessionRecord(staleKey);
    }
    return { ...status, skipped: status.skipped + fileSkipped, total: status.total + fileSkipped };
  });
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

export function indexMigratedSessionFile(
  store: SessionStore,
  target: MigrationTarget,
  filePath: string,
  sessionId?: string,
): IndexStatus {
  const loaded = loadMigratedSessionFile(target, filePath, sessionId);
  if (!loaded) {
    throw new Error(`Migrated ${target} session could not be loaded from ${filePath}.`);
  }
  store.upsertIndexedSession(loaded.session, loaded.messages, loaded.tokenEvents, loaded.traceEvents);
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
