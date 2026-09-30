import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TeamSessionGitHub, MAX_TEAM_SESSION_BYTES } from "./team-session-github";

const repository = "https://github.com/example/team", project = "a".repeat(32);
const data = Buffer.from("synthetic gzip bytes");
const asset = (overrides = {}) => ({ id: 17, name: `ar1_${project}_${createHash("sha256").update(data).digest("hex")}.json.gz`, label: "Shared example", state: "uploaded", size: data.length, created_at: "2026-09-26T00:00:00Z", uploader: { id: 1, login: "author" }, ...overrides });
const repo = { private: true, default_branch: "main", permissions: { push: true, admin: false } };
const release = { id: 9, body: "AgentRecall team sessions schema=1" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function harness(override: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input), response = override(url, init);
    if (response) return response;
    if (url.endsWith("/repos/example/team")) return json(repo);
    if (url.includes("/releases/tags/")) return json(release);
    if (url.endsWith("/user")) return json({ id: 1 });
    if (url.includes("/releases/9/assets?per_page=")) return json([asset()]);
    if (url.endsWith("/releases/assets/17")) return init?.method === "DELETE" ? new Response(null, { status: 204 }) : new Response(data);
    if (url.startsWith("https://uploads.github.com/")) return json(asset(), 201);
    throw new Error("Unexpected fixture request " + url);
  });
  return { remote: new TeamSessionGitHub(fetcher, async () => "synthetic-test-token"), fetcher };
}
describe("GitHub team session storage", () => {
  it.each([true, false])("supports sharing, reading and withdrawing with repository private=%s", async (isPrivate) => {
    const { remote } = harness((url) => url.endsWith("/repos/example/team") ? json({ ...repo, private: isPrivate }) : undefined);
    await remote.check(repository);
    expect(await remote.upload(repository, project, "Example", data)).toMatchObject({ id: 17 });
    expect((await remote.list(repository, project)).items).toEqual([expect.objectContaining({ id: 17, canWithdraw: true })]);
    expect(await remote.download(repository, project, 17)).toEqual(data);
    await remote.withdraw(repository, project, 17);
  });
  it.each([true, false])("requires write permission even when repository private=%s", async (isPrivate) => {
    const { remote, fetcher } = harness((url) => url.endsWith("/repos/example/team") ? json({ ...repo, private: isPrivate, permissions: { push: false } }) : undefined);
    expect((await remote.list(repository, project)).items).toHaveLength(1);
    await expect(remote.check(repository)).rejects.toMatchObject({ code: "TEAM_SESSION_FORBIDDEN" });
    await expect(remote.upload(repository, project, "Example", data)).rejects.toMatchObject({ code: "TEAM_SESSION_FORBIDDEN" });
    await expect(remote.withdraw(repository, project, 17)).rejects.toMatchObject({ code: "TEAM_SESSION_FORBIDDEN" });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST" || init?.method === "DELETE")).toBe(false);
  });
  it("lists only the current project and enforces uploader ownership when withdrawing", async () => {
    const { remote, fetcher } = harness((url) => url.includes("?per_page=") ? json([asset({ uploader: { id: 2, login: "other" } }), asset({ id: 18, name: asset().name.replace(project, "b".repeat(32)) })]) : undefined);
    expect((await remote.list(repository, project)).items).toEqual([expect.objectContaining({ id: 17, canWithdraw: false })]);
    await expect(remote.withdraw(repository, project, 17)).rejects.toMatchObject({ code: "TEAM_SESSION_FORBIDDEN" });
    await expect(remote.download(repository, project, 18)).rejects.toMatchObject({ code: "TEAM_SESSION_PROJECT_MISMATCH" });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it("never deletes arbitrary release assets outside the managed release", async () => {
    const { remote, fetcher } = harness();
    await expect(remote.withdraw(repository, project, 999)).rejects.toMatchObject({ code: "TEAM_SESSION_NOT_FOUND" });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await remote.withdraw(repository, project, 17);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it("does not forward credentials to signed downloads and verifies full bytes", async () => {
    const { remote, fetcher } = harness((url) => url.endsWith("/releases/assets/17") ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/signed" } }) : url.includes("/signed") ? new Response(data) : undefined);
    expect(await remote.download(repository, project, 17)).toEqual(data);
    const signed = fetcher.mock.calls.find(([input]) => String(input).includes("/signed"))!;
    expect(signed[1]?.headers).toBeUndefined();
    const invalid = harness((url) => url.endsWith("/releases/assets/17") ? new Response("different bytes") : undefined);
    await expect(invalid.remote.download(repository, project, 17)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
  });
  it("rejects downloads redirected outside GitHub", async () => {
    const { remote, fetcher } = harness((url) => url.endsWith("/releases/assets/17") ? new Response(null, { status: 302, headers: { location: "https://example.invalid/stolen" } }) : undefined);
    await expect(remote.download(repository, project, 17)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("stolen"))).toBe(false);
  });
  it("reuses an identical verified asset after an uncertain upload retry", async () => {
    const { remote, fetcher } = harness((url) => url.startsWith("https://uploads.") ? json({}, 422) : undefined);
    expect(await remote.upload(repository, project, "Example", data)).toMatchObject({ id: 17 });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith("https://uploads."))).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/releases/assets/17"))).toBe(true);
  });
  it("allows visibility changes and rejects oversized values before network access", async () => {
    let count = 0;
    const { remote, fetcher } = harness((url) => url.endsWith("/repos/example/team") ? json({ ...repo, private: ++count === 1 }) : undefined);
    expect(await remote.upload(repository, project, "Example", data)).toMatchObject({ id: 17 });
    expect(count).toBe(2);
    fetcher.mockClear();
    await expect(remote.upload(repository, project, "Example", Buffer.alloc(MAX_TEAM_SESSION_BYTES + 1))).rejects.toMatchObject({ code: "TEAM_SESSION_TOO_LARGE" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("treats a redirected delete as unconfirmed", async () => {
    const { remote } = harness((_url, init) => init?.method === "DELETE" ? new Response(null, { status: 302 }) : undefined);
    await expect(remote.withdraw(repository, project, 17)).rejects.toMatchObject({ code: "TEAM_WITHDRAW_UNCONFIRMED" });
  });
});

it("team view includes legacy project assets but still restricts objects to its managed release", async () => {
  const { remote } = harness((url) => url.includes("?per_page=") ? json([asset(), asset({ id: 18, name: asset().name.replace(project, "b".repeat(32)) })]) : undefined);
  expect((await remote.list(repository, null)).items.map((item) => item.id)).toEqual([17, 18]);
  expect(await remote.download(repository, null, 17)).toEqual(data);
  await expect(remote.download(repository, null, 999)).rejects.toMatchObject({ code: "TEAM_SESSION_NOT_FOUND" });
});

it("rechecks write permission immediately before uploading content", async () => {
  let reads = 0;
  const { remote, fetcher } = harness((url) => url.endsWith("/repos/example/team") ? json({ ...repo, private: false, permissions: { push: ++reads === 1 } }) : undefined);
  await expect(remote.upload(repository, project, "Example", data)).rejects.toMatchObject({ code: "TEAM_SESSION_FORBIDDEN" });
  expect(fetcher.mock.calls.some(([url]) => String(url).startsWith("https://uploads."))).toBe(false);
});

it("publishes independent manifests for members while reusing verified blocks and leaves blocks on withdrawal", async () => {
  const { encodeSessionBlocks } = await import("./team-session-blocks");
  const { gzipSync } = await import("node:zlib");
  const signal = new AbortController().signal;
  const bundle = await encodeSessionBlocks({ text: "shared".repeat(10000) }, { agent: "codex", sessionKey: "same" }, repository, signal);
  const stored = new Map<number, { meta: ReturnType<typeof asset>; data: Buffer }>();
  let actor = 1, next = 30;
  let failBlockOnce = true;
  const uploads: string[] = [];
  const { remote } = harness((url, init) => {
    if (url.endsWith("/user")) return json({ id: actor });
    if (url.endsWith("/releases/tags/agentrecall-session-blocks-v1")) return json({ id: 2, body: "AgentRecall team session blocks schema=1" });
    if (url.includes("/assets?per_page=")) return json([...stored.values()].filter(item => item.meta.name.startsWith("arb1_") === url.includes("/releases/2/")).map(item => item.meta));
    if (url.startsWith("https://uploads.")) {
      const name = new URL(url).searchParams.get("name")!;
      if ([...stored.values()].some(item => item.meta.name === name)) return json({}, 422);
      if (name.startsWith("arb1_") && stored.size === 1 && failBlockOnce) { failBlockOnce = false; return json({}, 503); }
      const bytes = Buffer.from(init!.body as Uint8Array), id = next++;
      const meta = asset({ id, name, size: bytes.length, uploader: { id: actor, login: `member-${actor}` } });
      stored.set(id, { meta, data: bytes }); uploads.push(name); return json(meta, 201);
    }
    const match = /\/releases\/assets\/(\d+)$/.exec(url);
    if (match) {
      const item = stored.get(Number(match[1]));
      if (init?.method === "DELETE") { stored.delete(Number(match[1])); return new Response(null, { status: 204 }); }
      return item ? new Response(new Uint8Array(item.data)) : json({}, 404);
    }
    return undefined;
  });
  const bytes = gzipSync(JSON.stringify(bundle.manifest));
  await expect(remote.uploadBlocks(repository, project, "Example", bytes, bundle, signal)).rejects.toMatchObject({ code: "TEAM_GITHUB_ACCESS" });
  expect([...stored.values()].every(item => item.meta.name.startsWith("arb1_"))).toBe(true);
  const first = await remote.uploadBlocks(repository, project, "Example", bytes, bundle, signal);
  expect((await remote.uploadBlocks(repository, project, "Example", bytes, bundle, signal)).id).toBe(first.id);
  actor = 2;
  const second = await remote.uploadBlocks(repository, project, "Example", bytes, bundle, signal);
  expect(first.id).not.toBe(second.id); expect(first.author).toBe("member-1"); expect(second.author).toBe("member-2");
  expect(uploads.filter(name => name.startsWith("arb1_"))).toHaveLength(bundle.blocks.size);
  expect((await remote.list(repository, project)).items).toHaveLength(2);
  await expect(remote.withdraw(repository, project, first.id)).rejects.toMatchObject({ code: "TEAM_SESSION_FORBIDDEN" });
  await remote.withdraw(repository, project, second.id);
  expect([...stored.values()].filter(item => item.meta.name.startsWith("arb1_"))).toHaveLength(bundle.blocks.size);
});
