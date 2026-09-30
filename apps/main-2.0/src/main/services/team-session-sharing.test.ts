import { createHash } from "node:crypto";
import { PostgresDatabase } from "../../core/postgres/database";
import { PostgresTeamSessionRepository } from "../../core/postgres/team-session-repository";
import { POSTGRES_MIGRATIONS } from "../../core/postgres/schema";
import { PGliteTestPool } from "../../core/postgres/test-pglite";
import { decodeSessionBlocks } from "./team-session-blocks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchResult, SessionMessage, SessionTraceEvent } from "../../core/types";
import { TeamSessionGitHub, MAX_TEAM_SESSION_BYTES } from "./team-session-github";
import { TeamSessionSharing } from "./team-session-sharing";

let root: string;
const services: TeamSessionSharing[] = [];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "team-session-")); vi.stubEnv("HOME", root); vi.stubEnv("USERPROFILE", root); });
afterEach(async () => { services.splice(0).forEach((service) => service.close()); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const filePath = path.join(root, "synthetic.jsonl"); await fs.writeFile(filePath, '{"raw":"完整源文件"}\n');
  const session: SessionSearchResult = {
    sessionKey: "codex:main", rawId: "main", source: "codex-cli", projectPath: root, filePath,
    originalTitle: "Example", displayTitle: "Example", firstQuestion: "Question", timestamp: 1, fileMtimeMs: 1, fileSize: 1,
    prUrl: null, prNumber: null, environmentKind: "local", environmentId: "local", environmentLabel: "Local", tokenUsage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3 },
    customTitle: null, favorited: false, hidden: false, tags: [], matchSnippet: null, lastOpenedAt: null, lastResumedAt: null, lastActivityAt: 1, messageCount: 1, aiSummary: null, aiSummaryStale: false,
  };
  const child = { ...session, sessionKey: "codex:child", rawId: "child", isSubagent: true, parentSessionId: "main" };
  const messages: SessionMessage[] = [{ index: 0, role: "user", content: "完整会话", timestamp: "2026-09-26", attachments: [{ id: "missing", fileName: "lost.png", status: "missing", previewKind: "image", mimeType: "image/png" }] }];
  const traceEvents: SessionTraceEvent[] = [{ index: 0, kind: "tool_call", source: "codex", title: "read", detail: "full details", timestamp: "2026-09-26", attributes: { large: "x".repeat(300_000) } }];
  const store = {
    getSession: vi.fn(async (key: string) => key === session.sessionKey ? session : child), searchSessions: vi.fn(async () => [session, child]),
    getAllMessages: vi.fn(async () => messages), getTraceEvents: vi.fn(async () => traceEvents),
    getSessionTurn: vi.fn(), getSessionSourceArtifacts: vi.fn(async () => [{ kind: "session-file" as const, mimeType: "application/json", fileName: "synthetic.jsonl", bytes: Buffer.from('{"raw":"完整源文件"}\n') }]),
    getAttachmentFile: vi.fn<import("../../core/session-store").SessionStore["getAttachmentFile"]>().mockResolvedValue(null),
  };
  const remote = new TeamSessionGitHub(vi.fn(), async () => "fixture");
  vi.spyOn(remote, "check").mockResolvedValue();
  const upload = vi.spyOn(remote, "upload").mockResolvedValue({ id: 17, title: "Example", author: "fixture", createdAt: "2026-09-26", bytes: 1, digest: "a".repeat(64), canWithdraw: true });
  vi.spyOn(remote, "uploadBlocks").mockImplementation(async (repository, project, title, _data, bundle, signal) => {
    const packet = await decodeSessionBlocks(bundle.manifest, async hash => bundle.blocks.get(hash)!, signal);
    return remote.upload(repository, project, title, gzipSync(JSON.stringify(packet)), signal);
  });
  const confirm = vi.fn(async () => true), save = vi.fn<(owner: number, bytes: Uint8Array, suggestedName: string) => Promise<boolean>>(async () => true);
  const service = new TeamSessionSharing({ store, confirm, save, ensureDetails: async () => undefined }, remote); services.push(service);
  const context = { repository: "https://github.com/example/private", projectIdentity: "https://github.com/example/business", projectId: "business", root };
  return { service, remote, upload, confirm, save, store, context, session, messages, traceEvents, signal: new AbortController().signal };
}
describe("complete team session snapshots", () => {
  it("previews without uploading and preserves children, full tool attributes and source bytes", async () => {
    const f = await fixture(), preview = await f.service.prepare(1, f.context, f.session.sessionKey, f.signal);
    expect(f.upload).not.toHaveBeenCalled(); expect(preview.children).toHaveLength(1);
    expect(preview.root.traceEvents[0]!.attributes).toEqual(f.traceEvents[0]!.attributes);
    expect(preview.missingAttachments).toEqual(["lost.png", "lost.png"]);
    const assertContext = vi.fn(async () => undefined);
    await f.service.publish(1, f.context, preview.token, f.signal, assertContext);
    expect(f.confirm).toHaveBeenCalledWith(1, expect.stringContaining("公开仓库中的分享可被任何人访问和下载")); expect(assertContext).toHaveBeenCalledOnce();
    const packet = JSON.parse(gunzipSync(f.upload.mock.calls[0]![3]).toString());
    expect(packet.records).toHaveLength(2);
    expect(Buffer.from(packet.records[0].files[0].data, "base64").toString()).toContain("完整源文件");
    expect(packet.records[0].detail.traceEvents).toEqual(f.traceEvents);
    await expect(f.service.publish(1, f.context, preview.token, f.signal, assertContext)).rejects.toMatchObject({ code: "TEAM_PREVIEW_EXPIRED" });
    expect(await fs.readFile(f.session.filePath, "utf8")).toContain("完整源文件");
  });
  it("pins preview to its window and destination, preserves cancelled previews and revalidates after confirmation", async () => {
    const f = await fixture(), preview = await f.service.prepare(1, f.context, f.session.sessionKey, f.signal);
    await expect(f.service.publish(2, f.context, preview.token, f.signal, async () => undefined)).rejects.toMatchObject({ code: "TEAM_PREVIEW_EXPIRED" });
    await expect(f.service.publish(1, { ...f.context, projectId: "other" }, preview.token, f.signal, async () => undefined)).rejects.toMatchObject({ code: "TEAM_PREVIEW_EXPIRED" });
    f.confirm.mockResolvedValue(false);
    expect(await f.service.publish(1, f.context, preview.token, f.signal, async () => undefined)).toBeNull();
    f.confirm.mockResolvedValue(true);
    await expect(f.service.publish(1, f.context, preview.token, f.signal, async () => { throw new Error("binding changed"); })).rejects.toThrow("binding changed");
    expect(f.upload).not.toHaveBeenCalled(); f.service.cancel(1);
    await expect(f.service.publish(1, f.context, preview.token, f.signal, async () => undefined)).rejects.toMatchObject({ code: "TEAM_PREVIEW_EXPIRED" });
  });
  it("rejects remote sources and cancelled preparation instead of exporting partial data", async () => {
    const f = await fixture(); f.session.environmentKind = "ssh";
    await expect(f.service.prepare(1, f.context, f.session.sessionKey, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_SOURCE_REQUIRED" });
    expect(f.store.getSessionSourceArtifacts).not.toHaveBeenCalled(); f.session.environmentKind = "local";
    const abort = new AbortController(); abort.abort();
    await expect(f.service.prepare(1, f.context, f.session.sessionKey, abort.signal)).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("bounds complete packets including multibyte text and metadata without truncation", async () => {
    const f = await fixture(); f.store.searchSessions.mockResolvedValue([f.session]);
    f.messages[0]!.content = "汉".repeat(Math.floor(MAX_TEAM_SESSION_BYTES / 3));
    await expect(f.service.prepare(1, f.context, f.session.sessionKey, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_TOO_LARGE" });
    expect(f.upload).not.toHaveBeenCalled();
  });
  it("verifies downloaded structure, project identity and source digests before saving", async () => {
    const f = await fixture(), preview = await f.service.prepare(1, f.context, f.session.sessionKey, f.signal);
    await f.service.publish(1, f.context, preview.token, f.signal, async () => undefined);
    const data = f.upload.mock.calls[0]![3], download = vi.spyOn(f.remote, "download").mockResolvedValue(data);
    await f.service.download(1, f.context, 17, f.signal);
    expect(f.save).toHaveBeenCalledWith(1, data, "session-17.agentrecall-session.json.gz");
    const oldPacket = JSON.parse(gunzipSync(data).toString());
    oldPacket.schemaVersion = 1; oldPacket.projectRepository = oldPacket.projectIdentity; delete oldPacket.projectIdentity;
    download.mockResolvedValue(gzipSync(JSON.stringify(oldPacket)));
    expect((await f.service.detail(f.context, 17, f.signal)).root.session.sessionKey).toBe(f.session.sessionKey);
    const packet = JSON.parse(gunzipSync(data).toString()); packet.records[0].files[0].data = Buffer.from("tampered").toString("base64"); download.mockResolvedValue(gzipSync(JSON.stringify(packet)));
    await expect(f.service.detail(f.context, 17, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
    download.mockResolvedValue(data);
    await expect(f.service.detail({ ...f.context, projectIdentity: "https://github.com/other/code" }, 17, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_PROJECT_MISMATCH" });
    expect((await f.service.detail({ ...f.context, teamWide: true, projectIdentity: "team:shared" }, 17, f.signal)).root.session.sessionKey).toBe(f.session.sessionKey);
    await expect(f.service.detail({ ...f.context, teamWide: true, repository: "https://github.com/other/team" }, 17, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_PROJECT_MISMATCH" });
    expect(f.save).toHaveBeenCalledOnce();
  });
});


it("accepts empty content and the exact complete packet limit, rejecting wrapper and multi-record overflow", async () => {
  const f = await fixture();
  const packet = { schemaVersion: 2, repository: f.context.repository, projectIdentity: f.context.projectIdentity, rootSessionKey: f.session.sessionKey, records: [{ detail: { schemaVersion: 2, exportedAt: 1, session: f.session, messages: [{ index: 0, role: "user", content: "", timestamp: "1" }], traceEvents: [] }, files: [], missingAttachments: [] }] };
  const download = vi.spyOn(f.remote, "download").mockResolvedValue(gzipSync(JSON.stringify(packet)));
  expect((await f.service.detail(f.context, 17, f.signal)).root.messages[0]!.content).toBe("");
  const available = MAX_TEAM_SESSION_BYTES - Buffer.byteLength(JSON.stringify(packet));
  packet.records[0]!.detail.messages[0]!.content = "汉".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
  let json = JSON.stringify(packet); expect(Buffer.byteLength(json)).toBe(MAX_TEAM_SESSION_BYTES);
  download.mockResolvedValue(gzipSync(json));
  expect((await f.service.detail(f.context, 17, f.signal)).root.messages[0]!.content).toBe(packet.records[0]!.detail.messages[0]!.content);
  packet.records[0]!.detail.messages[0]!.content += "x";
  download.mockResolvedValue(gzipSync(JSON.stringify(packet)));
  await expect(f.service.detail(f.context, 17, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
  packet.records[0]!.detail.messages[0]!.content = "x".repeat(Math.floor(MAX_TEAM_SESSION_BYTES / 2));
  packet.records.push({ ...packet.records[0]!, detail: { ...packet.records[0]!.detail, session: { ...f.session, sessionKey: "codex:second" } } });
  json = JSON.stringify(packet); expect(Buffer.byteLength(json)).toBeGreaterThan(MAX_TEAM_SESSION_BYTES);
  download.mockResolvedValue(gzipSync(json));
  await expect(f.service.detail(f.context, 17, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
});

function selectedTurn(id: string, turnIndex: number): import("../../core/types").SessionTurnDetail {
  return { id, turnIndex, sourceMessageIndex: turnIndex * 2, synthetic: false, status: "completed", startedAt: null, endedAt: null,
    userPreview: `问题 ${id}`, assistantPreview: "回答", inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3,
    errorCount: 0, toolNames: ["read"], messageCount: 1, spanCount: 1,
    messages: [{ messageIndex: 0, sourceMessageIndex: turnIndex * 2, role: "user", content: `完整消息 ${id}`, timestamp: "", attachments: [{ id: "selected-attachment", fileName: "selected.txt", status: "available", previewKind: "text", mimeType: "text/plain" }] }],
    spans: [{ id: `span-${id}`, parentSpanId: null, spanIndex: 0, kind: "tool", name: "read", status: "completed", startedAt: null, endedAt: null, callId: `call-${id}`, input: { file: "selected.txt" }, output: { text: `完整工具输出 ${id}` }, error: null, attributes: { nested: { preserved: true } } }],
  };
}

it("exports only selected turns in source order, preserving tool payloads and only their attachments", async () => {
  const f = await fixture(); f.session.firstQuestion = "UNSELECTED_SECRET"; f.session.aiSummary = "UNSELECTED_SUMMARY";
  f.messages[0]!.content = "UNSELECTED_MESSAGE";
  const attachmentPath = path.join(root, "selected.txt"); await fs.writeFile(attachmentPath, "SELECTED_ATTACHMENT");
  f.store.getAttachmentFile.mockResolvedValue({ cachePath: attachmentPath, id: "selected-attachment", fileName: "selected.txt", mimeType: "text/plain", previewKind: "text", status: "available" });
  const first = selectedTurn("first", 1), last = selectedTurn("last", 8);
  f.store.getSessionTurn.mockImplementation(async (sessionKey: string, id: string) => sessionKey === f.session.sessionKey ? [first, last].find((turn) => turn.id === id) ?? null : null);
  const preview = await f.service.prepare(1, f.context, f.session.sessionKey, f.signal, ["last", "first"]);
  expect(preview.selectedTurns?.map((turn) => turn.id)).toEqual(["first", "last"]);
  expect(preview.files[0]?.attachmentId).toBe("selected-attachment");
  expect(preview.children).toEqual([]); expect(preview.root.messages).toEqual([]);
  expect(f.store.searchSessions).not.toHaveBeenCalled(); expect(f.store.getAllMessages).not.toHaveBeenCalled(); expect(f.store.getTraceEvents).not.toHaveBeenCalled(); expect(f.store.getSessionSourceArtifacts).not.toHaveBeenCalled();
  expect(f.store.getAttachmentFile).toHaveBeenCalledExactlyOnceWith(f.session.sessionKey, "selected-attachment");
  first.messages[0]!.content = "CHANGED_AFTER_PREVIEW";
  await f.service.publish(1, f.context, preview.token, f.signal, async () => undefined);
  expect(f.confirm).toHaveBeenCalledWith(1, expect.stringContaining("2 个所选轮次"));
  const data = f.upload.mock.calls[0]![3], text = gunzipSync(data).toString(), packet = JSON.parse(text);
  expect(text).not.toMatch(/UNSELECTED|完整源文件|codex:child|CHANGED_AFTER_PREVIEW/);
  expect(packet.records[0].files[0].attachmentId).toBe("selected-attachment");
  expect(packet.schemaVersion).toBe(3); expect(packet.selectedTurns[1].spans).toEqual(last.spans);
  expect(Buffer.from(packet.records[0].files[0].data, "base64").toString()).toBe("SELECTED_ATTACHMENT");
  const download = vi.spyOn(f.remote, "download").mockResolvedValue(data);
  expect((await f.service.detail(f.context, 17, f.signal)).selectedTurns).toEqual(preview.selectedTurns);
  packet.records[0].detail.messages.push(f.messages[0]); download.mockResolvedValue(gzipSync(JSON.stringify(packet)));
  await expect(f.service.detail(f.context, 17, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
});

it("rejects empty, duplicate, oversized and missing turn selections without falling back to full sharing", async () => {
  const f = await fixture(); f.store.getSessionTurn.mockResolvedValue(null);
  for (const ids of [[], ["one", "one"], Array.from({ length: 501 }, (_, i) => `turn-${i}`), ["foreign-turn"]]) {
    await expect(f.service.prepare(1, f.context, f.session.sessionKey, f.signal, ids)).rejects.toMatchObject({ code: "TEAM_TURN_SELECTION_INVALID" });
  }
  expect(f.upload).not.toHaveBeenCalled(); expect(f.store.getSessionSourceArtifacts).not.toHaveBeenCalled();
  expect(f.store.getSessionTurn).toHaveBeenCalledExactlyOnceWith(f.session.sessionKey, "foreign-turn");
});

it("bounds selected-turn packets including multibyte tools and metadata", async () => {
  const f = await fixture(), turn = selectedTurn("one", 0);
  turn.spans[0]!.output = { text: "汉".repeat(Math.floor(MAX_TEAM_SESSION_BYTES / 3)) };
  f.store.getSessionTurn.mockResolvedValue(turn);
  await expect(f.service.prepare(1, f.context, f.session.sessionKey, f.signal, [turn.id])).rejects.toMatchObject({ code: "TEAM_SESSION_TOO_LARGE" });
  expect(f.upload).not.toHaveBeenCalled(); expect(f.store.getAttachmentFile).not.toHaveBeenCalled();
});

it("inspects a local Turn without GitHub, attachment packaging or retained upload tokens", async () => {
  const f = await fixture(), turn = selectedTurn("one", 0);
  f.store.getSessionTurn.mockResolvedValue(turn);
  vi.mocked(f.remote.check).mockRejectedValue(new Error("offline"));
  expect((await f.service.inspectTurn(f.session.sessionKey, turn.id, f.signal)).selectedTurns).toEqual([turn]);
  expect(f.remote.check).not.toHaveBeenCalled(); expect(f.store.getAttachmentFile).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled();
  await expect(f.service.prepare(1, f.context, f.session.sessionKey, f.signal, [turn.id])).rejects.toThrow("offline");
});

it("reads block manifests, reports all compressed bytes, exports a portable snapshot and rejects changed provenance", async () => {
  const f = await fixture();
  const preview = await f.service.prepare(1, f.context, f.session.sessionKey, f.signal);
  await f.service.publish(1, f.context, preview.token, f.signal, async () => undefined);
  const call = vi.mocked(f.remote.uploadBlocks).mock.calls[0]!;
  const bundle = call[4], read = vi.spyOn(f.remote, "blockReader").mockResolvedValue(async hash => bundle.blocks.get(hash)!);
  const download = vi.spyOn(f.remote, "download").mockResolvedValue(call[3]);
  expect((await f.service.detail(f.context, 17, f.signal)).bytes).toBe(preview.bytes);
  await f.service.download(1, f.context, 17, f.signal);
  expect(JSON.parse(gunzipSync(f.save.mock.calls[0]![1]).toString())).toEqual(JSON.parse(gunzipSync(f.upload.mock.calls[0]![3]).toString()));
  expect(read).toHaveBeenCalledTimes(2);
  download.mockResolvedValue(gzipSync(JSON.stringify({ ...bundle.manifest, source: { ...bundle.manifest.source, sessionKey: "other" } })));
  await expect(f.service.detail(f.context, 17, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
});

it("reads an already published session without fetching source files, but verifies them on download", async () => {
  const f = await fixture();
  const bytes = (await import("node:crypto")).randomBytes(1024 * 1024);
  f.store.getSessionSourceArtifacts.mockResolvedValue([{kind:"session-file",mimeType:"application/json",fileName:"synthetic.jsonl",bytes}]);
  const preview = await f.service.prepare(1, f.context, f.session.sessionKey, f.signal);
  await f.service.publish(1, f.context, preview.token, f.signal, async () => undefined);
  const call = vi.mocked(f.remote.uploadBlocks).mock.calls[0]!, bundle = call[4];
  const fileBlocks = bundle.manifest.strings.filter(entry => entry.path[2] === "files").flatMap(entry => entry.value.blocks.map(block => block.hash));
  expect(fileBlocks.length).toBeGreaterThan(0);
  const read = vi.fn(async (hash: string) => bundle.blocks.get(hash)!);
  vi.spyOn(f.remote, "blockReader").mockResolvedValue(read);
  vi.spyOn(f.remote, "download").mockResolvedValue(call[3]);
  const content = await f.service.detail(f.context, 17, f.signal);
  expect(content.root.messages).toEqual(preview.root.messages);
  expect(content.files[0]!.bytes).toBe(bytes.length);
  expect(read.mock.calls.some(([hash]) => fileBlocks.includes(hash))).toBe(false);
  await f.service.download(1, f.context, 17, f.signal);
  expect(read.mock.calls.some(([hash]) => fileBlocks.includes(hash))).toBe(true);
  expect(f.save).toHaveBeenCalledOnce();
});

it("downloads once, then reopens and expands turns from PostgreSQL without the remote", async () => {
  const f = await fixture();
  const preview = await f.service.prepare(1, f.context, f.session.sessionKey, f.signal);
  await f.service.publish(1, f.context, preview.token, f.signal, async () => undefined);
  const data = f.upload.mock.calls[0]![3], digest = createHash("sha256").update(data).digest("hex");
  const download = vi.spyOn(f.remote, "download").mockResolvedValue(data);
  const db = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
  await db.initialize();
  const openService = () => {
    const service = new TeamSessionSharing({ store: f.store, confirm: f.confirm, save: f.save, ensureDetails: vi.fn(), cache: new PostgresTeamSessionRepository(db) }, f.remote);
    services.push(service); return service;
  };
  try {
    const first = openService();
    const snapshot = await first.open(f.context, 17, digest, f.signal);
    expect(snapshot.records).toHaveLength(2);
    first.close(); download.mockRejectedValue(new Error("Offline"));
    const reopened = openService();
    expect(await reopened.open(f.context, 17, digest, f.signal)).toEqual(snapshot);
    const page = await reopened.turns(f.context, 17, digest, 0, 0);
    expect(await reopened.turn(f.context, 17, digest, 0, page.turns[0].id)).toMatchObject({ messages: [{ content: "完整会话" }] });
    expect(download).toHaveBeenCalledTimes(1);
    await expect(reopened.open(f.context, 18, digest, f.signal)).rejects.toThrow("Offline");
    download.mockResolvedValue(data);
    await expect(reopened.open(f.context, 17, "b".repeat(64), f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_CHANGED" });
  } finally { await db.close(); }
});

it("only Pull reads the remote catalog; restart, listing and search remain offline", async () => {
  const f = await fixture();
  const db = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
  await db.initialize();
  try {
    const cache = new PostgresTeamSessionRepository(db);
    const sharing = new TeamSessionSharing({ store: f.store, cache, confirm: f.confirm, save: f.save, ensureDetails: async () => undefined }, f.remote);
    services.push(sharing);
    const remoteList = vi.spyOn(f.remote, "list").mockResolvedValue({ items: [{ id: 17, digest: "a".repeat(64), title: "Local catalog", author: "fixture", createdAt: "2026-09-30", bytes: 10, canWithdraw: true }], page: 1, hasMore: false });
    expect((await sharing.list(f.context, 1, f.signal)).items).toEqual([]);
    expect(remoteList).not.toHaveBeenCalled();
    await sharing.pullCatalog(f.context, f.signal);
    remoteList.mockRejectedValue(new Error("offline"));
    expect((await sharing.list(f.context, 1, f.signal)).items).toHaveLength(1);
    expect((await sharing.list(f.context, 1, f.signal, "Local", "sessions")).items).toHaveLength(1);
    expect((await sharing.list(f.context, 1, f.signal, "question", "turns")).items).toEqual([]);
    expect(remoteList).toHaveBeenCalledTimes(1);
    await expect(sharing.pullCatalog(f.context, f.signal)).rejects.toThrow("offline");
    expect((await sharing.list(f.context, 1, f.signal)).items).toHaveLength(1);
  } finally { await db.close(); }
});

it("publishes its retained snapshot to the local team catalog without downloading and preserves remote success on local failure", async () => {
  const f = await fixture();
  const db = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS }); await db.initialize();
  try {
    const cache = new PostgresTeamSessionRepository(db);
    const sharing = new TeamSessionSharing({ store: f.store, cache, confirm: f.confirm, save: f.save, ensureDetails: async () => undefined }, f.remote); services.push(sharing);
    const download = vi.spyOn(f.remote, "download");
    const preview = await sharing.prepare(1, f.context, f.session.sessionKey, f.signal);
    expect(await sharing.publish(1, f.context, preview.token, f.signal, async () => undefined)).toMatchObject({ id: 17, localReady: true });
    const team = { ...f.context, teamWide: true };
    expect((await sharing.list(team, 1, f.signal)).items).toHaveLength(1);
    expect((await sharing.list(team, 1, f.signal, "完整会话", "turns")).items.length).toBeGreaterThan(0);
    expect(await sharing.cached(team, 17, "a".repeat(64))).not.toBeNull();
    expect(download).not.toHaveBeenCalled();
    const next = await sharing.prepare(1, f.context, f.session.sessionKey, f.signal);
    vi.spyOn(cache, "import").mockRejectedValue(new Error("disk unavailable"));
    expect(await sharing.publish(1, f.context, next.token, f.signal, async () => undefined)).toMatchObject({ id: 17, localReady: false });
    await expect(sharing.publish(1, f.context, next.token, f.signal, async () => undefined)).rejects.toMatchObject({ code: "TEAM_PREVIEW_EXPIRED" });
  } finally { await db.close(); }
});
