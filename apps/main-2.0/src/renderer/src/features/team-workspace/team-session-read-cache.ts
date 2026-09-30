import type { TeamWorkspaceApi } from "../../../../preload/team-workspace";
import type { TeamReply, TeamRequest } from "../../../../shared/ipc/team-workspace";

type ReadRequest = Extract<TeamRequest, { action: "session-list" | "session-open" | "session-turns" }>;
const caches = new WeakMap<TeamWorkspaceApi, TeamSessionReadCache>();
/** Window-lifetime, bounded cache. Immutable reads include the share digest; lists refresh in the background. */
export class TeamSessionReadCache {
  private readonly entries = new Map<string, { reply: TeamReply; bytes: number }>();
  private readonly pending = new Map<string, Promise<TeamReply>>();
  private bytes = 0;
  constructor(private readonly api: TeamWorkspaceApi) {}
  peek(request: ReadRequest): TeamReply | undefined {
    const key = JSON.stringify(request), entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.reply;
  }
  remember(request: ReadRequest, reply: TeamReply): void {
    if (!reply.ok) return;
    const key = JSON.stringify(request);
    const bytes = new TextEncoder().encode(JSON.stringify(reply)).byteLength;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    if (bytes > 2 * 1024 * 1024) return;
    this.entries.set(key, { reply, bytes }); this.bytes += bytes;
    while (this.entries.size > 32 || this.bytes > 2 * 1024 * 1024) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
  }
  read(request: ReadRequest): Promise<TeamReply> {
    const cached = this.peek(request);
    if (cached) return Promise.resolve(cached);
    const key = JSON.stringify(request), existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.api.request(request).then(reply => { this.remember(request, reply); return reply; }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
export function teamSessionReadCache(api: TeamWorkspaceApi): TeamSessionReadCache {
  let cache = caches.get(api);
  if (!cache) { cache = new TeamSessionReadCache(api); caches.set(api, cache); }
  return cache;
}
