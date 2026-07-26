import { createHash } from "node:crypto";
import { watch as watchFileSystem } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyCodexQuotaError } from "../../core/quota";
import type {
  UsageQuotaFailureKind,
  UsageQuotaSnapshot,
} from "../../core/types";

const RETRY_DELAYS_MS = [0, 300, 900] as const;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AUTH_CHANGE_DEBOUNCE_MS = 500;

export interface QuotaCacheRecord {
  schemaVersion: 1;
  identity: string;
  savedAt: number;
  snapshot: UsageQuotaSnapshot;
}

export interface QuotaServiceDependencies {
  load(options: { hideCodexQuota: boolean; hideClaudeQuota: boolean }): Promise<UsageQuotaSnapshot>;
  getSettings(): { hideCodexQuota: boolean; hideClaudeQuota: boolean };
  authPath(): string | null;
  identity(path: string | null): Promise<string | null>;
  readCache(): Promise<QuotaCacheRecord | null>;
  writeCache(record: QuotaCacheRecord): Promise<void>;
  publish(snapshot: UsageQuotaSnapshot): void;
  delay(ms: number): Promise<void>;
  now(): number;
  watch(path: string, callback: () => void): () => void;
}

interface QuotaFailure {
  kind: UsageQuotaFailureKind;
  message: string;
  snapshot?: UsageQuotaSnapshot;
}

export class QuotaService {
  private active: Promise<UsageQuotaSnapshot> | null = null;
  private stopWatching: (() => void) | null = null;
  private authChangeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dependencies: QuotaServiceDependencies) {}

  getSnapshot(force = false): Promise<UsageQuotaSnapshot> {
    if (this.active) return this.active;
    this.active = this.loadWithFallback(force).finally(() => {
      this.active = null;
    });
    return this.active;
  }

  start(): void {
    if (this.stopWatching) return;
    const authPath = this.dependencies.authPath();
    if (!authPath) return;
    this.stopWatching = this.dependencies.watch(authPath, () => {
      if (this.authChangeTimer) clearTimeout(this.authChangeTimer);
      this.authChangeTimer = setTimeout(() => {
        this.authChangeTimer = null;
        void this.getSnapshot(true);
      }, AUTH_CHANGE_DEBOUNCE_MS);
    });
  }

  stop(): void {
    if (this.authChangeTimer) clearTimeout(this.authChangeTimer);
    this.authChangeTimer = null;
    this.stopWatching?.();
    this.stopWatching = null;
  }

  private async loadWithFallback(_force: boolean): Promise<UsageQuotaSnapshot> {
    const identity = await this.dependencies.identity(this.dependencies.authPath());
    let lastFailure: QuotaFailure | null = null;

    for (const delayMs of RETRY_DELAYS_MS) {
      if (delayMs) await this.dependencies.delay(delayMs);
      try {
        const loaded = await this.dependencies.load(this.dependencies.getSettings());
        const codexFailure = loaded.providers.find(
          (card) => card.provider === "codex" && card.status === "error",
        );
        if (!codexFailure) {
          const next: UsageQuotaSnapshot = {
            ...loaded,
            freshness: "fresh",
            lastSuccessfulAt: loaded.generatedAt,
            error: undefined,
          };
          if (identity) {
            await this.dependencies.writeCache({
              schemaVersion: 1,
              identity,
              savedAt: this.dependencies.now(),
              snapshot: next,
            }).catch(() => undefined);
          }
          this.dependencies.publish(next);
          return next;
        }
        lastFailure = {
          kind: codexFailure.errorKind ?? "permanent",
          message: codexFailure.detail ?? "Codex 额度暂时不可用。",
          snapshot: loaded,
        };
      } catch (error) {
        lastFailure = {
          kind: classifyCodexQuotaError(error),
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (lastFailure.kind !== "transient") break;
    }

    const next = await this.cachedOrError(identity, lastFailure);
    this.dependencies.publish(next);
    return next;
  }

  private async cachedOrError(
    identity: string | null,
    failure: QuotaFailure | null,
  ): Promise<UsageQuotaSnapshot> {
    const cached = await this.dependencies.readCache().catch(() => null);
    if (
      identity
      && cached?.schemaVersion === 1
      && cached.identity === identity
      && this.dependencies.now() - cached.savedAt <= CACHE_MAX_AGE_MS
    ) {
      return {
        ...cached.snapshot,
        generatedAt: new Date(this.dependencies.now()).toISOString(),
        freshness: "stale",
        lastSuccessfulAt: cached.snapshot.lastSuccessfulAt
          ?? cached.snapshot.generatedAt
          ?? new Date(cached.savedAt).toISOString(),
        error: failure?.message,
      };
    }

    const generatedAt = new Date(this.dependencies.now()).toISOString();
    return {
      generatedAt,
      providers: failure?.snapshot?.providers ?? [],
      hiddenProviders: failure?.snapshot?.hiddenProviders,
      freshness: failure?.kind === "auth" ? "auth-required" : "unavailable",
      error: failure?.message,
    };
  }
}

export function codexAuthPath(
  env: Record<string, string | undefined>,
  homeDir: string,
): string {
  const codexHome = env.CODEX_HOME?.trim();
  return path.join(codexHome || path.join(homeDir, ".codex"), "auth.json");
}

export async function readCodexAuthIdentity(authFile: string | null): Promise<string | null> {
  if (!authFile) return null;
  try {
    const raw = JSON.parse(await readFile(authFile, "utf8")) as {
      tokens?: { account_id?: string; access_token?: string };
    };
    const accountId = raw.tokens?.account_id?.trim();
    const subject = accountId || jwtSubject(raw.tokens?.access_token);
    return subject ? createHash("sha256").update(subject).digest("hex") : null;
  } catch {
    return null;
  }
}

function jwtSubject(token: string | undefined): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown };
    return typeof parsed.sub === "string" && parsed.sub.trim() ? parsed.sub.trim() : null;
  } catch {
    return null;
  }
}

export function createQuotaCache(cachePath: string): Pick<QuotaServiceDependencies, "readCache" | "writeCache"> {
  return {
    async readCache() {
      try {
        return JSON.parse(await readFile(cachePath, "utf8")) as QuotaCacheRecord;
      } catch {
        return null;
      }
    },
    async writeCache(record) {
      await mkdir(path.dirname(cachePath), { recursive: true });
      const temporaryPath = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, cachePath);
    },
  };
}

export function watchQuotaAuthFile(authFile: string, callback: () => void): () => void {
  try {
    const directory = path.dirname(authFile);
    const basename = path.basename(authFile);
    const watcher = watchFileSystem(directory, { persistent: false }, (_event, filename) => {
      if (!filename || filename.toString() === basename) callback();
    });
    return () => watcher.close();
  } catch {
    return () => undefined;
  }
}
