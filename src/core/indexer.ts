import * as fs from "node:fs";
import * as path from "node:path";
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
  loadOptions?: SessionLoadOptions;
  onProgress?: (status: IndexStatus) => void;
  yieldToEventLoop?: () => Promise<void>;
}

export async function syncLoadedSessionsInBatches(
  store: SessionStore,
  loaded: Iterable<LoadedSession>,
  options: BatchIndexOptions = {},
): Promise<IndexStatus> {
  const batchSize = Math.max(1, options.batchSize ?? 3);
  const yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  let indexed = 0;
  let skipped = 0;
  let total = 0;
  let pendingInBatch = 0;

  for (const item of loaded) {
    if (store.isIndexedSessionFresh(item.session)) {
      store.touchIndexedAtIfMissing(item.session.sessionKey);
      skipped++;
    } else {
      store.upsertIndexedSession(item.session, item.messages, item.tokenEvents, item.traceEvents);
      indexed++;
    }
    total++;
    pendingInBatch++;

    if (pendingInBatch >= batchSize) {
      pendingInBatch = 0;
      options.onProgress?.({ running: true, indexed, skipped, total, lastIndexedAt: null, error: null });
      await yieldToEventLoop();
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
    // Prune sessions whose source files no longer exist on disk. Only applies to
    // the local environment — remote sessions are synced independently and their
    // file paths are not local filesystem paths. scannedFilePaths is collected
    // from shouldSkipFile (file-based sources) and from yielded LoadedSessions
    // (DB-backed sources like Hermes/OpenCode whose file_path is the DB path).
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
): IndexStatus {
  const loaded = loadMigratedSessionFile(target, filePath);
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

function loadMigratedSessionFile(target: MigrationTarget, filePath: string): LoadedSession | null {
  if (target === "cursor") return loadCursorTranscriptFile(filePath);

  const descriptor = migrationTargetDescriptor(target);
  if (descriptor.family === "codebuddy") return loadCodeBuddyCliSessionFile(filePath);
  if (descriptor.family === "codewiz") return loadCodeWizSessions(path.dirname(filePath))[0] ?? null;

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
