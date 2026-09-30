import { TURN_DERIVATION_VERSION } from "../../core/turns/derive-turns";
import { TEAM_SESSION_CACHE_VERSION, type PostgresTeamSessionRepository } from "../../core/postgres/team-session-repository";
import { encodeSessionBlocks, decodeSessionBlocks, sessionBlockManifestSchema, type SessionBlockBundle } from "./team-session-blocks";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { WorkspaceError } from "@agentrecall/workspace-core";
import type { SessionStore } from "../../core/session-store";
import type { SessionSearchResult } from "../../core/types";
import { MAX_SHARED_TURNS, teamTurnSelectionSchema } from "../../shared/team-sessions";
import type { TeamSessionContent, TeamSessionPreview } from "../../shared/team-sessions";
import { TeamSessionGitHub, MAX_TEAM_SESSION_BYTES } from "./team-session-github";

const compress = promisify(gzip), decompress = promisify(gunzip);
const SOURCE_LIMIT = 16 * 1024 * 1024;
// Null is an internal read projection only. content() requires a matching
// deferred-file descriptor; complete downloads and legacy packets reject it.
const fileSchema = z.object({ name: z.string().max(1024), kind: z.string().max(100), attachmentId: z.string().optional(), data: z.string().nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const attachmentSchema = z.object({ id: z.string(), fileName: z.string(), mimeType: z.string(), sizeBytes: z.number().optional(), previewKind: z.enum(["image", "pdf", "text", "file"]), status: z.enum(["available", "unsafe", "missing", "too_large"]), source: z.object({ kind: z.enum(["inline", "path"]), value: z.string() }).optional(), remoteObjectKey: z.string().optional(), sha256: z.string().optional() }).passthrough();
const messageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string(), timestamp: z.string(), index: z.number(), sourceTurnId: z.string().nullable().optional(), phase: z.enum(["commentary", "final_answer"]).nullable().optional(), attachments: z.array(attachmentSchema).optional() }).passthrough();
const traceSchema = z.object({ index: z.number(), kind: z.string(), source: z.string(), title: z.string(), detail: z.string(), timestamp: z.string() }).passthrough();
const detailSchema = z.object({ schemaVersion: z.literal(2), exportedAt: z.number(), session: z.object({ sessionKey: z.string(), originalTitle: z.string(), displayTitle: z.string(), source: z.string() }).passthrough(), messages: z.array(messageSchema).max(100_000), traceEvents: z.array(traceSchema).max(100_000) }).strict();
const recordsSchema = z.array(z.object({ detail: detailSchema, files: z.array(fileSchema).max(512), missingAttachments: z.array(z.string()).max(512) }).strict()).min(1).max(128);
const packetV1Schema = z.object({ schemaVersion: z.literal(1), repository: z.string(), projectRepository: z.string(), rootSessionKey: z.string(), records: recordsSchema }).strict();
const packetV2Schema = z.object({ schemaVersion: z.literal(2), repository: z.string(), projectIdentity: z.string(), rootSessionKey: z.string(), records: recordsSchema }).strict();
const turnSchema = z.object({
  id: z.string().min(1).max(1024), turnIndex: z.number().int().nonnegative(),
  sourceMessageIndex: z.number().int().nullable(), sourceTurnId: z.string().nullable().optional(),
  synthetic: z.boolean(), agentTriggered: z.boolean().optional(), subagentExecutionStart: z.boolean().optional(),
  status: z.enum(["running", "completed", "failed", "aborted"]), startedAt: z.string().nullable(), endedAt: z.string().nullable(),
  durationMs: z.number().nullable().optional(), timeToFirstTokenMs: z.number().nullable().optional(), abortReason: z.string().nullable().optional(),
  userPreview: z.string(), assistantPreview: z.string(), inputTokens: z.number(), outputTokens: z.number(),
  cachedInputTokens: z.number(), cacheCreationInputTokens: z.number().optional(), reasoningOutputTokens: z.number(), totalTokens: z.number(),
  errorCount: z.number(), toolNames: z.array(z.string()), messageCount: z.number(), spanCount: z.number(),
  messages: z.array(messageSchema.omit({ index: true }).extend({ messageIndex: z.number().int(), sourceMessageIndex: z.number().int().nullable() })).max(100_000),
  spans: z.array(z.object({
    id: z.string(), parentSpanId: z.string().nullable(), spanIndex: z.number().int(), kind: z.enum(["tool", "event"]), name: z.string(),
    status: z.enum(["running", "completed", "failed", "aborted", "unknown"]), startedAt: z.string().nullable(), endedAt: z.string().nullable(), callId: z.string().nullable(),
    input: z.record(z.string(), z.unknown()).nullable(), output: z.record(z.string(), z.unknown()).nullable(), error: z.string().nullable(), attributes: z.record(z.string(), z.unknown()),
  }).strict()).max(100_000),
}).strict();
// Version 3 is an explicitly partial export. Legacy packets remain full-session snapshots.
const packetV3Schema = packetV2Schema.extend({ schemaVersion: z.literal(3), selectedTurns: z.array(turnSchema).min(1).max(MAX_SHARED_TURNS), records: recordsSchema.length(1) })
  .refine((packet) => new Set(packet.selectedTurns.map((turn) => turn.id)).size === packet.selectedTurns.length
    && new Set(packet.selectedTurns.map((turn) => turn.turnIndex)).size === packet.selectedTurns.length
    && packet.records.every((record) => record.detail.messages.length === 0 && record.detail.traceEvents.length === 0 && record.files.every((file) => file.kind === "attachment")), "轮次分享包含无效范围");
const packetSchema = z.union([packetV1Schema, packetV2Schema, packetV3Schema]).transform((packet) => packet.schemaVersion === 1
  ? { schemaVersion: 2 as const, repository: packet.repository, projectIdentity: packet.projectRepository, rootSessionKey: packet.rootSessionKey, records: packet.records }
  : packet);
type Packet = z.infer<typeof packetSchema>;
export interface TeamSessionContext { repository: string; projectIdentity: string; projectId: string; root: string | null; projectName?: string; teamWide?: boolean; }
type Store = Pick<SessionStore, "getSession" | "searchSessions" | "getAllMessages" | "getTraceEvents" | "getSessionSourceArtifacts" | "getAttachmentFile" | "getSessionTurn">;
interface Dependencies {
  store: Store;
  cache?: PostgresTeamSessionRepository;
  ensureDetails(sessionKey: string): Promise<void>;
  confirm(owner: number, message: string): Promise<boolean>;
  save(owner: number, bytes: Uint8Array, suggestedName: string): Promise<boolean>;
}
interface Pending { owner: number; context: TeamSessionContext; data: Buffer; bundle: SessionBlockBundle; content: TeamSessionContent; expiresAt: number; timer: ReturnType<typeof setTimeout>; }
export class TeamSessionSharing {
  private readonly previews = new Map<string, Pending>();
  constructor(private readonly dependencies: Dependencies, private readonly remote = new TeamSessionGitHub()) {}
  cancel(owner: number): void { for (const [key, item] of this.previews) if (item.owner === owner) { clearTimeout(item.timer); this.previews.delete(key); } }
  discard(owner: number, token: string): void { const item = this.previews.get(token); if (item?.owner === owner) { clearTimeout(item.timer); this.previews.delete(token); } }
  close(): void { for (const item of this.previews.values()) clearTimeout(item.timer); this.previews.clear(); }
  private project(context: TeamSessionContext): string { return createHash("sha256").update(context.projectIdentity).digest("hex").slice(0, 32); }
  private cancelled(signal: AbortSignal): void { if (signal.aborted) throw new WorkspaceError("CANCELLED", "团队会话操作已取消。"); }
  private content(packet: Packet, bytes: number, deferredFiles = new Map<string, number>()): TeamSessionContent {
    const seen = new Set<string>();
    const details = packet.records.map((record, recordIndex) => {
      if (seen.has(record.detail.session.sessionKey)) throw new WorkspaceError("TEAM_SESSION_INVALID", "分享包包含重复会话。");
      seen.add(record.detail.session.sessionKey);
      const detail = record.detail;
      for (const [fileIndex, file] of record.files.entries()) {
        if (file.data === null) {
          const size = deferredFiles.get(`${recordIndex}:${fileIndex}`);
          if (size === undefined || size > SOURCE_LIMIT) throw new WorkspaceError("TEAM_SESSION_INVALID", "会话文件引用无效。");
          continue;
        }
        const data = Buffer.from(file.data, "base64");
        if (data.toString("base64") !== file.data || data.length > SOURCE_LIMIT || createHash("sha256").update(data).digest("hex") !== file.sha256) throw new WorkspaceError("TEAM_SESSION_INVALID", "分享包文件校验失败。");
      }
      return detail;
    });
    const root = details.find((detail) => detail.session.sessionKey === packet.rootSessionKey);
    if (!root) throw new WorkspaceError("TEAM_SESSION_INVALID", "分享包缺少主会话。");
    return { root, ...(packet.schemaVersion === 3 ? { selectedTurns: packet.selectedTurns } : {}), children: details.filter((detail) => detail !== root), bytes,
      files: packet.records.flatMap((record, recordIndex) => record.files.map((file, fileIndex) => ({ name: file.name, kind: file.kind, bytes: file.data === null ? deferredFiles.get(`${recordIndex}:${fileIndex}`)! : Buffer.byteLength(file.data, "base64"), ...(file.attachmentId ? { attachmentId: file.attachmentId } : {}) }))),
      missingAttachments: packet.records.flatMap((record) => record.missingAttachments),
    };
  }
  private async decode(context: TeamSessionContext, data: Buffer, signal: AbortSignal, reading = false): Promise<{ packet: Packet; content: TeamSessionContent; blocked: boolean }> {
    try {
      if (data.length > MAX_TEAM_SESSION_BYTES) throw new Error("Too large");
      const json = await decompress(data, { maxOutputLength: MAX_TEAM_SESSION_BYTES });
      let bytes = data.length;
      let blocked = false;
      let claimedSource: { agent: string; sessionKey: string } | undefined;
      const deferredFiles = new Map<string, number>();
      let decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json));
      if (decoded && typeof decoded === "object" && "schemaVersion" in decoded && decoded.schemaVersion === 4) {
        if (!("repository" in decoded) || decoded.repository !== context.repository) throw new WorkspaceError("TEAM_SESSION_PROJECT_MISMATCH", "会话清单不属于当前团队。");
        blocked = true;
        const manifest = sessionBlockManifestSchema.parse(decoded);
        claimedSource = manifest.source;
        const refs = new Map([...manifest.body, ...manifest.strings.flatMap(entry => entry.value.blocks)].map(ref => [ref.hash, ref.storedBytes]));
        bytes += [...refs.values()].reduce((sum, size) => sum + size, 0);
        decoded = await decodeSessionBlocks(manifest, await this.remote.blockReader(context.repository, signal), signal, reading ? entry => {
          const [records, recordIndex, files, fileIndex, field] = entry.path;
          if (entry.path.length !== 5 || records !== "records" || typeof recordIndex !== "number" || files !== "files" || typeof fileIndex !== "number" || field !== "data" || entry.value.encoding !== "base64" || entry.prefix !== "") return false;
          deferredFiles.set(`${recordIndex}:${fileIndex}`, entry.value.bytes);
          return true;
        } : undefined);

      }
      const packet = packetSchema.parse(decoded);
      if (claimedSource && (packet.rootSessionKey !== claimedSource.sessionKey || packet.records.find(record => record.detail.session.sessionKey === packet.rootSessionKey)?.detail.session.source !== claimedSource.agent)) throw new WorkspaceError("TEAM_SESSION_INVALID", "会话来源与清单不一致。");
      if (packet.repository !== context.repository || !context.teamWide && packet.projectIdentity !== context.projectIdentity) throw new WorkspaceError("TEAM_SESSION_PROJECT_MISMATCH", "分享包的团队或项目与当前选择不一致。");
      return { packet, content: this.content(packet, bytes, deferredFiles), blocked };
    } catch (error) { this.cancelled(signal); if (error instanceof WorkspaceError) throw error; throw new WorkspaceError("TEAM_SESSION_INVALID", "会话包格式或版本无效，或解压后超过 64 MiB。"); }
  }
  async inspectSession(sessionKey: string, signal: AbortSignal) {
    this.cancelled(signal);
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session || session.environmentKind !== "local" || session.sourceAvailable === false) throw new WorkspaceError("TEAM_SESSION_SOURCE_REQUIRED", "请选择原始文件可读取的本机会话。");
    const stat = await fs.stat(session.filePath);
    this.cancelled(signal);
    if (!stat.isFile() || stat.size > SOURCE_LIMIT) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "会话源文件超过 16 MiB，请改为选择需要分享的 Turn。");
    return { title: session.displayTitle || session.originalTitle, sourceBytes: stat.size };
  }
  async inspectTurn(sessionKey: string, turnId: string, signal: AbortSignal): Promise<TeamSessionContent> {
    this.cancelled(signal);
    const session = await this.dependencies.store.getSession(sessionKey);
    if (!session || session.environmentKind !== "local") throw new WorkspaceError("TEAM_SESSION_SOURCE_REQUIRED", "请选择本机会话中的轮次。");
    await this.dependencies.ensureDetails(sessionKey);
    this.cancelled(signal);
    const turn = await this.dependencies.store.getSessionTurn(sessionKey, turnId);
    if (!turn || turn.id !== turnId) throw new WorkspaceError("TEAM_TURN_SELECTION_INVALID", "所选轮次已变化，请重新选择。");
    const selected = turnSchema.parse(turn);
    const attachments = [...new Map(selected.messages.flatMap(message => message.attachments ?? []).map(file => [file.id, file])).values()];
    this.cancelled(signal);
    return { root: { schemaVersion: 2, exportedAt: Date.now(), session: { sessionKey, originalTitle: session.originalTitle, displayTitle: session.displayTitle, source: session.source }, messages: [], traceEvents: [] }, selectedTurns: [selected], children: [], bytes: Buffer.byteLength(JSON.stringify(selected)),
      files: attachments.filter(file => file.status === "available").map(file => ({ name: file.fileName, kind: "attachment", attachmentId: file.id, bytes: file.sizeBytes ?? 0 })), missingAttachments: attachments.filter(file => file.status !== "available").map(file => file.fileName) };
  }
  async prepare(owner: number, context: TeamSessionContext, sessionKey: string, signal: AbortSignal, turnIds?: string[], retainOtherPreviews = false): Promise<TeamSessionPreview> {
    const selection = turnIds === undefined ? undefined : teamTurnSelectionSchema.safeParse(turnIds);
    if (selection && !selection.success) throw new WorkspaceError("TEAM_TURN_SELECTION_INVALID", `请选择 1–${MAX_SHARED_TURNS} 个不同轮次。`);
    this.cancelled(signal);
    await this.remote.check(context.repository, signal);
    const store = this.dependencies.store;
    const session = await store.getSession(sessionKey);
    if (!session) throw new WorkspaceError("SESSION_NOT_FOUND", "找不到所选会话。");
    if (selection?.success) {
      if (session.environmentKind !== "local") throw new WorkspaceError("TEAM_SESSION_SOURCE_REQUIRED", "目前只支持分享本机会话中的轮次。");
      await this.dependencies.ensureDetails(sessionKey);
      const selectedTurns: z.infer<typeof turnSchema>[] = [];
      let retained = 0;
      const files: Packet["records"][number]["files"] = [], missingAttachments: string[] = [];
      const attachmentIds = new Set<string>();
      for (const turnId of selection.data) {
        this.cancelled(signal);
        const turn = await store.getSessionTurn(sessionKey, turnId);
        if (!turn || turn.id !== turnId) throw new WorkspaceError("TEAM_TURN_SELECTION_INVALID", "所选轮次已变化或不属于这条会话，请重新选择。");
        const parsed = turnSchema.parse(turn);
        retained += Buffer.byteLength(JSON.stringify(parsed));
        if (retained > MAX_TEAM_SESSION_BYTES) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "所选轮次超过 64 MiB，请减少选择。");
        selectedTurns.push(parsed);
        for (const message of parsed.messages) for (const attachment of message.attachments ?? []) {
          if (attachmentIds.has(attachment.id)) continue;
          attachmentIds.add(attachment.id);
          if (attachmentIds.size > 512) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "所选轮次的附件超过 512 个，请减少选择。");
          this.cancelled(signal);
          const file = attachment.status === "available" ? await store.getAttachmentFile(sessionKey, attachment.id) : null;
          if (!file) { missingAttachments.push(attachment.fileName); continue; }
          const handle = await fs.open(file.cachePath, "r");
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > SOURCE_LIMIT) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "附件超过 16 MiB 或不是普通文件，未上传。");
            const bytes = Buffer.alloc(Math.min(stat.size + 1, SOURCE_LIMIT + 1));
            let length = 0;
            while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
            if (length !== stat.size) throw new WorkspaceError("TEAM_SESSION_SOURCE_CHANGED", "附件在预览时发生变化，请重新预览。");
            const data = bytes.subarray(0, length);
            retained += Math.ceil(data.length / 3) * 4;
            if (retained > MAX_TEAM_SESSION_BYTES) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "含附件的轮次分享超过 64 MiB，请减少选择。");
            files.push({ name: attachment.fileName, kind: "attachment", attachmentId: attachment.id, data: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex") });
          } finally { await handle.close(); }
        }
      }
      selectedTurns.sort((a, b) => a.turnIndex - b.turnIndex);
      // Do not copy aggregate summaries, raw sources, or child sessions into a partial export.
      const detail = { schemaVersion: 2 as const, exportedAt: Date.now(), session: {
        sessionKey, originalTitle: session.originalTitle, displayTitle: session.displayTitle, source: session.source,
      }, messages: [], traceEvents: [] };
      return this.remember(owner, context, { schemaVersion: 3, repository: context.repository, projectIdentity: context.projectIdentity,
        rootSessionKey: sessionKey, selectedTurns, records: [{ detail, files, missingAttachments }] }, signal, retainOtherPreviews);
    }
    const all = await store.searchSessions({ limit: 100_000, excludeSubagents: false });
    if (all.length >= 100_000) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "会话索引过大，无法确认完整子会话范围，本次未分享。");
    const selected: SessionSearchResult[] = [session], visited = new Set([session.sessionKey]);
    for (let index = 0; index < selected.length; index++) {
      for (const child of all) if (child.isSubagent && child.parentSessionId === selected[index]!.rawId && child.source === session.source && child.environmentId === session.environmentId && !visited.has(child.sessionKey)) {
        selected.push(child); visited.add(child.sessionKey);
        if (selected.length > 128) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "子会话超过 128 个，未上传，不会自动截断。");
      }
    }
    const records: Packet["records"] = []; let retained = 0;
    for (const candidate of selected) {
      this.cancelled(signal);
      if (candidate.environmentKind !== "local" || candidate.sourceAvailable === false) throw new WorkspaceError("TEAM_SESSION_SOURCE_REQUIRED", "首版只分享原始文件仍可读取的本机会话；远程或仅缓存的会话请先导出核对。");
      const stat = await fs.stat(candidate.filePath);
      if (!stat.isFile() || stat.size > SOURCE_LIMIT) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "会话源文件超过 16 MiB 或不是普通文件，请改为选择需要分享的 Turn。");
      await this.dependencies.ensureDetails(candidate.sessionKey);
      const [fresh, messages, traceEvents, artifacts] = await Promise.all([store.getSession(candidate.sessionKey), store.getAllMessages(candidate.sessionKey), store.getTraceEvents(candidate.sessionKey), store.getSessionSourceArtifacts(candidate.sessionKey)]);
      if (!fresh || !artifacts.length) throw new WorkspaceError("TEAM_SESSION_SOURCE_REQUIRED", "无法取得完整原始会话文件，本次未分享。");
      const files: Packet["records"][number]["files"] = [];
      const append = (name: string, kind: string, bytes: Uint8Array) => {
        if (bytes.byteLength > SOURCE_LIMIT) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "单个会话文件或附件超过 16 MiB，未上传。");
        retained += bytes.byteLength * 4 / 3;
        if (retained > MAX_TEAM_SESSION_BYTES) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "完整会话包超过 64 MiB，未上传。");
        files.push({ name, kind, data: Buffer.from(bytes).toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
      };
      for (const artifact of artifacts) append(artifact.fileName, artifact.kind, artifact.bytes);
      const missingAttachments: string[] = [];
      for (const message of messages) for (const attachment of message.attachments ?? []) {
        this.cancelled(signal);
        const file = attachment.status === "available" ? await store.getAttachmentFile(candidate.sessionKey, attachment.id) : null;
        if (!file) { missingAttachments.push(attachment.fileName); continue; }
        const handle = await fs.open(file.cachePath, "r");
        try { if ((await handle.stat()).size > SOURCE_LIMIT) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "附件超过 16 MiB，未上传。"); const bytes = Buffer.alloc(SOURCE_LIMIT + 1); let length = 0; while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; } append(attachment.fileName, "attachment", bytes.subarray(0, length)); }
        finally { await handle.close(); }
      }
      const detail = { schemaVersion: 2 as const, exportedAt: Date.now(), session: { ...fresh }, messages: messages.map((message) => ({ ...message, attachments: message.attachments?.map((attachment) => ({ ...attachment })) })), traceEvents: traceEvents.map((event) => ({ ...event })) };
      retained += Buffer.byteLength(JSON.stringify(detail));
      if (retained > MAX_TEAM_SESSION_BYTES) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "完整会话包超过 64 MiB，未上传。");
      records.push({ detail, files, missingAttachments });
    }
    const packet = { schemaVersion: 2 as const, repository: context.repository, projectIdentity: context.projectIdentity, rootSessionKey: sessionKey, records };
    return this.remember(owner, context, packet, signal, retainOtherPreviews);
  }
  private async remember(owner: number, context: TeamSessionContext, packet: Packet, signal: AbortSignal, retainOtherPreviews = false): Promise<TeamSessionPreview> {
    const json = Buffer.from(JSON.stringify(packet));
    if (json.length > MAX_TEAM_SESSION_BYTES) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "含附件及元数据的完整会话包超过 64 MiB，未上传。");
    const root = packet.records.find(record => record.detail.session.sessionKey === packet.rootSessionKey)!;
    const bundle = await encodeSessionBlocks(packet, { agent: root.detail.session.source, sessionKey: packet.rootSessionKey }, context.repository, signal);
    const data = await compress(Buffer.from(JSON.stringify(bundle.manifest))); this.cancelled(signal);
    const content = this.content(packet, data.length + [...bundle.blocks.values()].reduce((sum, bytes) => sum + bytes.length, 0));
    this.cancelled(signal);
    const expiresAt = Date.now() + 10 * 60_000;
    for (const [key, value] of this.previews) if (value.expiresAt <= Date.now() || !retainOtherPreviews && value.owner === owner) { clearTimeout(value.timer); this.previews.delete(key); }
    if (this.previews.size >= 8) throw new WorkspaceError("TEAM_BUSY", "其他窗口有待处理的会话预览，请关闭后重试。");
    const token = randomUUID();
    const timer = setTimeout(() => this.previews.delete(token), expiresAt - Date.now()); timer.unref();
    this.previews.set(token, { owner, context, data, bundle, content, expiresAt, timer });
    return { ...content, token, repository: context.repository, projectIdentity: context.projectIdentity, expiresAt };
  }
  async publish(owner: number, context: TeamSessionContext, token: string, signal: AbortSignal, assertContext: () => Promise<void>, confirm = this.dependencies.confirm) {
    const pending = this.previews.get(token);
    if (!pending || pending.owner !== owner || pending.expiresAt <= Date.now() || JSON.stringify(pending.context) !== JSON.stringify(context)) throw new WorkspaceError("TEAM_PREVIEW_EXPIRED", "分享预览已过期或目标已改变，请重新预览。");
    if (!await confirm(owner, `将「${(pending.content.root.session.displayTitle || pending.content.root.session.originalTitle || "未命名会话")}」的${pending.content.selectedTurns ? `${pending.content.selectedTurns.length} 个所选轮次` : "完整快照"}分享到团队仓库 ${context.repository}？\n分享范围：${context.projectName ?? context.projectIdentity}\n包括 ${pending.content.children.length} 个子会话、${pending.content.files.length} 个文件，共 ${pending.content.bytes} 字节。\n不可读取的附件：${pending.content.missingAttachments.length}。本地原会话保留。公开仓库中的分享可被任何人访问和下载；私有仓库按仓库权限访问。`)) return null;
    this.cancelled(signal); await assertContext();
    if (pending.expiresAt <= Date.now() || this.previews.get(token) !== pending) throw new WorkspaceError("TEAM_PREVIEW_EXPIRED", "分享预览已过期，请重新预览。");
    const title = pending.content.root.session.displayTitle || pending.content.root.session.originalTitle || "未命名会话";
    const result = await this.remote.uploadBlocks(context.repository, this.project(context), pending.content.selectedTurns ? `${title} · ${pending.content.selectedTurns.length} 个轮次` : title, pending.data, pending.bundle, signal);
    clearTimeout(pending.timer); this.previews.delete(token); return result;
  }
  list(context: TeamSessionContext, page: number, signal: AbortSignal) { return this.remote.list(context.repository, context.teamWide ? null : this.project(context), page, signal); }
  private cacheKey(context: TeamSessionContext, id: number, digest: string): string {
    return createHash("sha256").update(JSON.stringify([TEAM_SESSION_CACHE_VERSION, TURN_DERIVATION_VERSION, context.repository, context.teamWide ? null : context.projectIdentity, id, digest])).digest("hex");
  }
  private cache() {
    if (!this.dependencies.cache) throw new WorkspaceError("TEAM_SESSION_UNAVAILABLE", "会话缓存不可用，请重启应用。");
    return this.dependencies.cache;
  }
  cached(context: TeamSessionContext, id: number, digest: string) {
    return this.cache().get(this.cacheKey(context, id, digest));
  }
  async cachedIds(context: TeamSessionContext, items: Array<{ id: number; digest: string }>) {
    const keys = items.map(item => this.cacheKey(context, item.id, item.digest));
    const cached = await this.cache().sources(keys);
    return items.flatMap((item, index) => cached.has(keys[index]) ? [{ ...item, source: cached.get(keys[index]) ?? undefined }] : []);
  }
  async open(context: TeamSessionContext, id: number, digest: string, signal: AbortSignal, onIndexing?: () => void) {
    const cache = this.cache(), key = this.cacheKey(context, id, digest);
    const existing = await cache.get(key);
    this.cancelled(signal);
    if (existing) return existing;
    const content = await this.detail(context, id, signal, digest);
    onIndexing?.();
    return cache.import(key, content, signal, { repository: context.repository, assetId: id, digest });
  }
  async turns(context: TeamSessionContext, id: number, digest: string, record: number, offset: number) {
    return this.cache().turns(this.cacheKey(context, id, digest), record, offset);
  }
  async turn(context: TeamSessionContext, id: number, digest: string, record: number, turnId: string) {
    return this.cache().turn(this.cacheKey(context, id, digest), record, turnId);
  }
  async detail(context: TeamSessionContext, id: number, signal: AbortSignal, expectedDigest?: string) {
    const data = await this.remote.download(context.repository, context.teamWide ? null : this.project(context), id, signal);
    if (expectedDigest && createHash("sha256").update(data).digest("hex") !== expectedDigest) throw new WorkspaceError("TEAM_SESSION_CHANGED", "分享已改变，请刷新会话列表后重试。");
    const content = await this.decode(context, data, signal, true);
    this.cancelled(signal);
    return content.content;
  }
  async download(owner: number, context: TeamSessionContext, id: number, signal: AbortSignal) {
    const data = await this.remote.download(context.repository, context.teamWide ? null : this.project(context), id, signal);
    const decoded = await this.decode(context, data, signal);
    const portable = decoded.blocked ? await compress(Buffer.from(JSON.stringify(decoded.packet))) : data;
    this.cancelled(signal);
    return this.dependencies.save(owner, portable, `session-${id}.agentrecall-session.json.gz`);
  }
  async withdraw(owner: number, context: TeamSessionContext, id: number, signal: AbortSignal, assertContext: () => Promise<void>) {
    if (!await this.dependencies.confirm(owner, "撤回这条团队会话分享？本地原会话保留。其他分享可能复用的内容块仍保留在团队仓库；已下载到成员设备的外部副本无法远程删除。")) return false;
    this.cancelled(signal); await assertContext(); await this.remote.withdraw(context.repository, context.teamWide ? null : this.project(context), id, signal); return true;
  }
}
