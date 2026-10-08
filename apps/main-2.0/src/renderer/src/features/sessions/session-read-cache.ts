import type { SessionSearchApi } from "../../../../preload";
import type { SessionSearchResult, SessionTurnDetail, SessionTurnSummary } from "../../../../core/types";

// Estimate retained memory without serializing large tool outputs. Stop walking
// as soon as the budget is exceeded; oversized values are returned, never truncated.
function retainedSize(value: unknown, budget: number): number {
  let bytes = 0;
  const visit = (item: unknown): void => {
    if (bytes > budget) return;
    if (typeof item === "string") bytes += item.length * 2 + 16;
    else if (item && typeof item === "object") {
      bytes += 64;
      for (const key in item) {
        bytes += key.length * 2 + 16;
        visit((item as Record<string, unknown>)[key]);
        if (bytes > budget) break;
      }
    } else bytes += 8;
  };
  visit(value);
  return bytes;
}

/** Renderer-owned LRU with a retention budget and invalidation-safe request sharing. */
export class SessionReadCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number; expires: number }>();
  private readonly pending = new Map<string, Promise<T>>();
  private bytes = 0;
  private generation = 0;
  constructor(private readonly limit: number, private readonly budget: number, private readonly ttl: number) {}

  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.expires <= Date.now()) { this.bytes -= entry.bytes; return; }
    this.entries.set(key, entry);
    return entry.value;
  }

  read(key: string, loader: () => Promise<T>, refresh = false): Promise<T> {
    const cached = this.peek(key);
    if (!refresh && cached !== undefined) return Promise.resolve(cached);
    const active = this.pending.get(key);
    if (active) return active;
    const generation = this.generation;
    const request = Promise.resolve().then(loader).then(value => {
      if (generation !== this.generation) return value;
      const previous = this.entries.get(key);
      if (previous) { this.entries.delete(key); this.bytes -= previous.bytes; }
      const bytes = retainedSize(value, this.budget);
      if (bytes <= this.budget && value !== null) {
        this.entries.set(key, { value, bytes, expires: Date.now() + this.ttl });
        this.bytes += bytes;
        while (this.entries.size > this.limit || this.bytes > this.budget) {
          const oldest = this.entries.keys().next().value!;
          this.bytes -= this.entries.get(oldest)!.bytes;
          this.entries.delete(oldest);
        }
      }
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  get revision(): number { return this.generation; }

  clear(): void {
    this.generation++;
    this.entries.clear(); this.pending.clear(); this.bytes = 0;
  }
}

export interface SessionSnapshot { session: SessionSearchResult; turns: SessionTurnSummary[] }
const caches = new WeakMap<SessionSearchApi, ReturnType<typeof createCaches>>();
function createCaches() {
  return {
    details: new SessionReadCache<SessionSnapshot | null>(20, 8 * 1024 * 1024, 60_000),
    turns: new SessionReadCache<SessionTurnDetail | null>(128, 32 * 1024 * 1024, 60_000),
    clear() {
      this.details.clear(); this.turns.clear();
    },
  };
}
export function sessionReadCache(api: SessionSearchApi) {
  let cache = caches.get(api);
  if (!cache) { cache = createCaches(); caches.set(api, cache); }
  return cache;
}
