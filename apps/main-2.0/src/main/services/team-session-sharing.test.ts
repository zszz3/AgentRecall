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
    getSessionSourceArtifacts: vi.fn(async () => [{ kind: "session-file" as const, mimeType: "application/json", fileName: "synthetic.jsonl", bytes: Buffer.from('{"raw":"完整源文件"}\n') }]),
    getAttachmentFile: vi.fn(async () => null),
  };
  const remote = new TeamSessionGitHub(vi.fn(), async () => "fixture");
  vi.spyOn(remote, "check").mockResolvedValue();
  const upload = vi.spyOn(remote, "upload").mockResolvedValue({ id: 17, title: "Example", author: "fixture", createdAt: "2026-09-26", bytes: 1, digest: "a".repeat(64), canWithdraw: true });
  const confirm = vi.fn(async () => true), save = vi.fn(async () => true);
  const service = new TeamSessionSharing({ store, confirm, save, ensureDetails: async () => undefined }, remote); services.push(service);
  const context = { repository: "https://github.com/example/private", projectRepository: "https://github.com/example/business", projectId: "business", root };
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
    expect(f.confirm).toHaveBeenCalledOnce(); expect(assertContext).toHaveBeenCalledOnce();
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
    const packet = JSON.parse(gunzipSync(data).toString()); packet.records[0].files[0].data = Buffer.from("tampered").toString("base64"); download.mockResolvedValue(gzipSync(JSON.stringify(packet)));
    await expect(f.service.detail(f.context, 17, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_INVALID" });
    download.mockResolvedValue(data);
    await expect(f.service.detail({ ...f.context, projectRepository: "https://github.com/other/code" }, 17, f.signal)).rejects.toMatchObject({ code: "TEAM_SESSION_PROJECT_MISMATCH" });
    expect(f.save).toHaveBeenCalledOnce();
  });
});


it("accepts empty content and the exact complete packet limit, rejecting wrapper and multi-record overflow", async () => {
  const f = await fixture();
  const packet = { schemaVersion: 1, repository: f.context.repository, projectRepository: f.context.projectRepository, rootSessionKey: f.session.sessionKey, records: [{ detail: { schemaVersion: 2, exportedAt: 1, session: f.session, messages: [{ index: 0, role: "user", content: "", timestamp: "1" }], traceEvents: [] }, files: [], missingAttachments: [] }] };
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
