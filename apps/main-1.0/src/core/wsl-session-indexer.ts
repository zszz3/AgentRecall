import type { RemoteSessionFilePayload } from "./remote-session-loader";
import type { SessionStore } from "./session-store";
import type { LoadedSession, SessionEnvironment, SessionSearchResult } from "./types";

export interface WslSessionIndexerOptions {
  store: SessionStore;
  fetchSessionFile: (environment: SessionEnvironment, session: SessionSearchResult) => Promise<RemoteSessionFilePayload>;
  loadSession: (environment: SessionEnvironment, payload: RemoteSessionFilePayload, summary: SessionSearchResult) => LoadedSession | null;
  concurrency?: number;
  onComplete?: (environment: SessionEnvironment, result: WslSessionIndexResult) => void;
  onSessionError?: (session: SessionSearchResult, error: unknown) => void;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

export interface WslSessionIndexResult {
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
}

interface ActiveIndexRun {
  promise: Promise<void>;
}

interface FailedSessionVersion {
  fileMtimeMs: number;
  fileSize: number;
}

function isRetryableWslIndexError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return /(?:EPIPE|ECONNRESET|ETIMEDOUT|EBUSY|SQLITE_BUSY|WSL .*not running|distribution .*not running|temporarily unavailable|connection.*closed|timed out|database is locked)/iu.test(`${code} ${message}`);
}

const DEFAULT_CONCURRENCY = 2;

export class WslSessionIndexer {
  private readonly store: SessionStore;
  private readonly fetchSessionFile: WslSessionIndexerOptions["fetchSessionFile"];
  private readonly loadSession: WslSessionIndexerOptions["loadSession"];
  private readonly concurrency: number;
  private readonly onComplete: (environment: SessionEnvironment, result: WslSessionIndexResult) => void;
  private readonly onSessionError: (session: SessionSearchResult, error: unknown) => void;
  private readonly retryDelaysMs: readonly number[];
  private readonly wait: (delayMs: number) => Promise<void>;
  private readonly activeRuns = new Map<string, ActiveIndexRun>();
  private readonly pendingRuns = new Set<string>();
  private readonly failedVersions = new Map<string, FailedSessionVersion>();

  constructor(options: WslSessionIndexerOptions) {
    this.store = options.store;
    this.fetchSessionFile = options.fetchSessionFile;
    this.loadSession = options.loadSession;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
    this.onComplete = options.onComplete ?? (() => undefined);
    this.onSessionError = options.onSessionError ?? (() => undefined);
    this.retryDelaysMs = options.retryDelaysMs ?? [100, 500];
    this.wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  request(environment: SessionEnvironment): Promise<void> {
    if (environment.kind !== "wsl") return Promise.resolve();
    const active = this.activeRuns.get(environment.id);
    if (active) {
      this.pendingRuns.add(environment.id);
      return active.promise;
    }

    const promise = this.runUntilIdle(environment).finally(() => {
      if (this.activeRuns.get(environment.id)?.promise === promise) this.activeRuns.delete(environment.id);
    });
    this.activeRuns.set(environment.id, { promise });
    return promise;
  }

  private async runUntilIdle(initialEnvironment: SessionEnvironment): Promise<void> {
    let environment = initialEnvironment;
    do {
      this.pendingRuns.delete(environment.id);
      await this.runPass(environment);
      const latest = this.store.getEnvironment(environment.id);
      if (latest?.kind === "wsl") environment = latest;
    } while (this.pendingRuns.has(environment.id));
  }

  private async runPass(environment: SessionEnvironment): Promise<void> {
    const sessions = this.listSessions(environment.id);
    const candidates = sessions.filter(
      (session) =>
        !this.store.isSessionContentFresh(session.sessionKey, session.fileMtimeMs, session.fileSize) &&
        !this.hasFailedVersion(session),
    );
    let next = 0;
    let indexed = 0;
    let failed = 0;

    const worker = async (): Promise<void> => {
      while (next < candidates.length) {
        const session = candidates[next++];
        let stage: "fetch" | "parse" | "store" = "fetch";
        let attempt = 0;
        while (true) {
          try {
            const payload = await this.fetchSessionFile(environment, session);
            stage = "parse";
            const loaded = this.loadSession(environment, payload, session);
            if (!loaded) throw new Error("WSL session file could not be parsed.");
            stage = "store";
            this.store.upsertIndexedSession(
              loaded.session,
              loaded.messages,
              loaded.tokenEvents,
              loaded.traceEvents,
              loaded.codexIncrementalState,
            );
            this.failedVersions.delete(session.sessionKey);
            indexed += 1;
            break;
          } catch (error) {
            const retryable = isRetryableWslIndexError(error) && stage !== "parse";
            const delay = this.retryDelaysMs[attempt];
            if (retryable && delay !== undefined) {
              attempt += 1;
              await this.wait(delay);
              stage = "fetch";
              continue;
            }
            if (!retryable) {
              this.failedVersions.set(session.sessionKey, { fileMtimeMs: session.fileMtimeMs, fileSize: session.fileSize });
            } else {
              this.failedVersions.delete(session.sessionKey);
            }
            failed += 1;
            this.onSessionError(session, new Error(`WSL ${stage} failed after ${attempt + 1} attempt(s): ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
            break;
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, candidates.length) }, worker));
    this.onComplete(environment, {
      total: sessions.length,
      indexed,
      skipped: sessions.length - candidates.length,
      failed,
    });
  }

  private hasFailedVersion(session: SessionSearchResult): boolean {
    const failed = this.failedVersions.get(session.sessionKey);
    return failed !== undefined && failed.fileMtimeMs === session.fileMtimeMs && failed.fileSize === session.fileSize;
  }

  private listSessions(environmentId: string): SessionSearchResult[] {
    const sessions = new Map<string, SessionSearchResult>();
    for (const visibility of ["default", "hidden"] as const) {
      for (const session of this.store.searchSessions({
        environmentId,
        visibility,
        excludeSubagents: false,
        limit: 100_000,
      })) {
        sessions.set(session.sessionKey, session);
      }
    }
    return [...sessions.values()];
  }
}
