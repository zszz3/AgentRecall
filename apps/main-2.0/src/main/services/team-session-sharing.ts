import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { WorkspaceError } from "@agentrecall/workspace-core";
import type { SessionStore } from "../../core/session-store";
import type { SessionSearchResult } from "../../core/types";
import type { TeamSessionContent, TeamSessionPreview } from "../../shared/team-sessions";
import { TeamSessionGitHub, MAX_TEAM_SESSION_BYTES } from "./team-session-github";

const compress = promisify(gzip), decompress = promisify(gunzip);
const SOURCE_LIMIT = 16 * 1024 * 1024;
const fileSchema = z.object({ name: z.string().max(1024), kind: z.string().max(100), data: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const attachmentSchema = z.object({ id: z.string(), fileName: z.string(), mimeType: z.string(), sizeBytes: z.number().optional(), previewKind: z.enum(["image", "pdf", "text", "file"]), status: z.enum(["available", "unsafe", "missing", "too_large"]), source: z.object({ kind: z.enum(["inline", "path"]), value: z.string() }).optional(), remoteObjectKey: z.string().optional(), sha256: z.string().optional() }).passthrough();
const messageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string(), timestamp: z.string(), index: z.number(), sourceTurnId: z.string().nullable().optional(), phase: z.enum(["commentary", "final_answer"]).nullable().optional(), attachments: z.array(attachmentSchema).optional() }).passthrough();
const traceSchema = z.object({ index: z.number(), kind: z.string(), source: z.string(), title: z.string(), detail: z.string(), timestamp: z.string() }).passthrough();
const detailSchema = z.object({ schemaVersion: z.literal(2), exportedAt: z.number(), session: z.object({ sessionKey: z.string(), originalTitle: z.string(), displayTitle: z.string(), source: z.string() }).passthrough(), messages: z.array(messageSchema).max(100_000), traceEvents: z.array(traceSchema).max(100_000) }).strict();
const packetSchema = z.object({ schemaVersion: z.literal(1), repository: z.string(), projectRepository: z.string(), rootSessionKey: z.string(), records: z.array(z.object({ detail: detailSchema, files: z.array(fileSchema).max(512), missingAttachments: z.array(z.string()).max(512) }).strict()).min(1).max(128) }).strict();
type Packet = z.infer<typeof packetSchema>;
export interface TeamSessionContext { repository: string; projectRepository: string; projectId: string; root: string; }
type Store = Pick<SessionStore, "getSession" | "searchSessions" | "getAllMessages" | "getTraceEvents" | "getSessionSourceArtifacts" | "getAttachmentFile">;
interface Dependencies {
  store: Store;
  ensureDetails(sessionKey: string): Promise<void>;
  confirm(owner: number, message: string): Promise<boolean>;
  save(owner: number, bytes: Uint8Array, suggestedName: string): Promise<boolean>;
}
interface Pending { owner: number; context: TeamSessionContext; data: Buffer; content: TeamSessionContent; expiresAt: number; timer: ReturnType<typeof setTimeout>; }
export class TeamSessionSharing {
  private readonly previews = new Map<string, Pending>();
  constructor(private readonly dependencies: Dependencies, private readonly remote = new TeamSessionGitHub()) {}
  cancel(owner: number): void { for (const [key, item] of this.previews) if (item.owner === owner) { clearTimeout(item.timer); this.previews.delete(key); } }
  close(): void { for (const item of this.previews.values()) clearTimeout(item.timer); this.previews.clear(); }
  private project(context: TeamSessionContext): string { return createHash("sha256").update(context.projectRepository).digest("hex").slice(0, 32); }
  private cancelled(signal: AbortSignal): void { if (signal.aborted) throw new WorkspaceError("CANCELLED", "团队会话操作已取消。"); }
  private content(packet: Packet, bytes: number): TeamSessionContent {
    const seen = new Set<string>();
    const details = packet.records.map((record) => {
      if (seen.has(record.detail.session.sessionKey)) throw new WorkspaceError("TEAM_SESSION_INVALID", "分享包包含重复会话。");
      seen.add(record.detail.session.sessionKey);
      const detail = record.detail;
      for (const file of record.files) {
        const data = Buffer.from(file.data, "base64");
        if (data.toString("base64") !== file.data || data.length > SOURCE_LIMIT || createHash("sha256").update(data).digest("hex") !== file.sha256) throw new WorkspaceError("TEAM_SESSION_INVALID", "分享包文件校验失败。");
      }
      return detail;
    });
    const root = details.find((detail) => detail.session.sessionKey === packet.rootSessionKey);
    if (!root) throw new WorkspaceError("TEAM_SESSION_INVALID", "分享包缺少主会话。");
    return { root, children: details.filter((detail) => detail !== root), bytes,
      files: packet.records.flatMap((record) => record.files.map((file) => ({ name: file.name, kind: file.kind, bytes: Buffer.byteLength(file.data, "base64") }))),
      missingAttachments: packet.records.flatMap((record) => record.missingAttachments),
    };
  }
  private async decode(context: TeamSessionContext, data: Buffer): Promise<TeamSessionContent> {
    try {
      if (data.length > MAX_TEAM_SESSION_BYTES) throw new Error("Too large");
      const json = await decompress(data, { maxOutputLength: MAX_TEAM_SESSION_BYTES });
      const packet = packetSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)));
      if (packet.repository !== context.repository || packet.projectRepository !== context.projectRepository) throw new WorkspaceError("TEAM_SESSION_PROJECT_MISMATCH", "分享包的团队或项目与当前选择不一致。");
      return this.content(packet, data.length);
    } catch (error) { if (error instanceof WorkspaceError) throw error; throw new WorkspaceError("TEAM_SESSION_INVALID", "会话包格式或版本无效，或解压后超过 64 MiB。"); }
  }
  async prepare(owner: number, context: TeamSessionContext, sessionKey: string, signal: AbortSignal): Promise<TeamSessionPreview> {
    await this.remote.check(context.repository, signal);
    const store = this.dependencies.store;
    const session = await store.getSession(sessionKey);
    if (!session) throw new WorkspaceError("SESSION_NOT_FOUND", "找不到所选会话。");
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
      if (!stat.isFile() || stat.size > SOURCE_LIMIT) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "会话源文件超过 16 MiB 或不是普通文件，未上传，不会截断。");
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
    const packet = { schemaVersion: 1 as const, repository: context.repository, projectRepository: context.projectRepository, rootSessionKey: sessionKey, records };
    const json = Buffer.from(JSON.stringify(packet));
    if (json.length > MAX_TEAM_SESSION_BYTES) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "含附件及元数据的完整会话包超过 64 MiB，未上传。");
    const data = await compress(json); this.cancelled(signal);
    const content = await this.decode(context, data);
    this.cancelled(signal);
    const expiresAt = Date.now() + 10 * 60_000;
    for (const [key, value] of this.previews) if (value.expiresAt <= Date.now() || value.owner === owner) { clearTimeout(value.timer); this.previews.delete(key); }
    if (this.previews.size >= 8) throw new WorkspaceError("TEAM_BUSY", "其他窗口有待处理的会话预览，请关闭后重试。");
    const token = randomUUID();
    const timer = setTimeout(() => this.previews.delete(token), expiresAt - Date.now()); timer.unref();
    this.previews.set(token, { owner, context, data, content, expiresAt, timer });
    return { ...content, token, repository: context.repository, projectRepository: context.projectRepository, expiresAt };
  }
  async publish(owner: number, context: TeamSessionContext, token: string, signal: AbortSignal, assertContext: () => Promise<void>) {
    const pending = this.previews.get(token);
    if (!pending || pending.owner !== owner || pending.expiresAt <= Date.now() || JSON.stringify(pending.context) !== JSON.stringify(context)) throw new WorkspaceError("TEAM_PREVIEW_EXPIRED", "分享预览已过期或目标已改变，请重新预览。");
    if (!await this.dependencies.confirm(owner, `将「${(pending.content.root.session.displayTitle || pending.content.root.session.originalTitle || "未命名会话")}」的完整快照分享到私有仓库 ${context.repository}？\n项目：${context.projectRepository}\n包括 ${pending.content.children.length} 个子会话、${pending.content.files.length} 个文件，共 ${pending.data.length} 字节。\n不可读取的附件：${pending.content.missingAttachments.length}。本地原会话保留；仓库成员可下载。`)) return null;
    this.cancelled(signal); await assertContext();
    if (pending.expiresAt <= Date.now() || this.previews.get(token) !== pending) throw new WorkspaceError("TEAM_PREVIEW_EXPIRED", "分享预览已过期，请重新预览。");
    const result = await this.remote.upload(context.repository, this.project(context), (pending.content.root.session.displayTitle || pending.content.root.session.originalTitle || "未命名会话"), pending.data, signal);
    clearTimeout(pending.timer); this.previews.delete(token); return result;
  }
  list(context: TeamSessionContext, page: number, signal: AbortSignal) { return this.remote.list(context.repository, this.project(context), page, signal); }
  async detail(context: TeamSessionContext, id: number, signal: AbortSignal) {
    const content = await this.decode(context, await this.remote.download(context.repository, this.project(context), id, signal));
    this.cancelled(signal);
    return content;
  }
  async download(owner: number, context: TeamSessionContext, id: number, signal: AbortSignal) {
    const data = await this.remote.download(context.repository, this.project(context), id, signal);
    await this.decode(context, data); this.cancelled(signal);
    return this.dependencies.save(owner, data, `session-${id}.agentrecall-session.json.gz`);
  }
  async withdraw(owner: number, context: TeamSessionContext, id: number, signal: AbortSignal, assertContext: () => Promise<void>) {
    if (!await this.dependencies.confirm(owner, "撤回这条团队会话分享？本地原会话保留。已下载到成员设备的外部副本无法远程删除。")) return false;
    this.cancelled(signal); await assertContext(); await this.remote.withdraw(context.repository, this.project(context), id, signal); return true;
  }
}
