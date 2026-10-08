import { expect, it, vi } from "vitest";
import type { TeamReply, TeamRequest } from "../../../../shared/ipc/team-workspace";
import { TeamSessionReadCache } from "./team-session-read-cache";
const request = { action: "session-open" as const, scope: { teamId: "example", repository: "https://github.com/example/assets" }, id: 1, digest: "a".repeat(64) };
const reply: TeamReply = { ok: true, data: { kind: "session-open", value: { partial: false, records: [], files: [], missingAttachments: [], bytes: 0 } } };
it("deduplicates pending reads and isolates immutable snapshots by scope and digest", async () => {
  let finish!: (reply: TeamReply) => void;
  const run = vi.fn((_input: TeamRequest) => new Promise<TeamReply>(resolve => { finish = resolve; }));
  const cache = new TeamSessionReadCache({ request: run });
  const first = cache.read(request), second = cache.read(request);
  expect(run).toHaveBeenCalledTimes(1); finish(reply); await Promise.all([first, second]);
  expect(await cache.read(request)).toEqual(reply); expect(run).toHaveBeenCalledTimes(1);
  expect(cache.peek({ ...request, digest: "b".repeat(64) })).toBeUndefined();
  expect(cache.peek({ ...request, scope: { ...request.scope, teamId: "another" } })).toBeUndefined();
});
it("keeps failures retryable and bounds retained replies including multibyte content", async () => {
  const run = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: "FAIL", message: "Retry" } }).mockResolvedValue(reply);
  const cache = new TeamSessionReadCache({ request: run });
  await cache.read(request); expect(cache.peek(request)).toBeUndefined();
  await cache.read(request); expect(run).toHaveBeenCalledTimes(2);
  for (let id = 2; id <= 34; id++) cache.remember({ ...request, id }, reply);
  expect(cache.peek(request)).toBeUndefined();
  cache.remember(request, { ok:true,data:{kind:"session-open",value:{partial:false,records:[],missingAttachments:[],bytes:0,files:[{name:"中".repeat(800000),bytes:0,kind:"test"}]}} });
  expect(cache.peek(request)).toBeUndefined();
});
