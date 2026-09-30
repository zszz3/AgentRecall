import { randomUUID } from "node:crypto";
import { WorkspaceService, TeamAssetService, WorkspaceError, type AssetChange, type ConfigurationPreview } from "@agentrecall/workspace-core";
import type { TeamPushItem, TeamPushPreview, TeamPushResult } from "../../shared/team-push";
import type { TeamSessionPreview } from "../../shared/team-sessions";
import { readTeamLocalPush } from "./team-local-assets";
import type { TeamSessionContext, TeamSessionSharing } from "./team-session-sharing";

type Scope = { teamId: string; repository: string };
type SingleChange = Exclude<AssetChange, { kind: "batch" }>;
type Pending = { owner: number; team: string; scope: Scope; expiresAt: number; preview: TeamPushPreview; change?: AssetChange; assetPreview?: ConfigurationPreview; assetKeys: string[]; sessions: Array<{ keys: string[]; preview: TeamSessionPreview; context: TeamSessionContext }>; timer: ReturnType<typeof setTimeout> };
const LIMIT = 16 * 1024 * 1024;
export class TeamPushService {
  private readonly plans = new Map<string, Pending>();
  constructor(private readonly directory: string, private readonly confirm: (owner: number, message: string) => Promise<boolean>, private readonly sharing?: TeamSessionSharing) {}
  discard(owner: number, token: string) { const plan = this.plans.get(token); if (plan?.owner === owner) { clearTimeout(plan.timer); for (const session of plan.sessions) this.sharing?.discard(owner, session.preview.token); this.plans.delete(token); } }
  cancel(owner: number) { for (const [token, plan] of this.plans) if (plan.owner === owner) this.discard(owner, token); }
  close() { for (const [token, plan] of this.plans) this.discard(plan.owner, token); }
  async inspect(scope: Scope, revision: string | undefined, item: TeamPushItem, signal: AbortSignal) {
    const workspace = new WorkspaceService(this.directory), current = await workspace.teamContext(scope.teamId);
    if (current.team.repository !== scope.repository) throw new WorkspaceError("TEAM_CHANGED", "团队已改变，请重新选择。");
    let result: TeamPushPreview["items"][number];
    if (item.kind === "session") {
      if (!this.sharing) throw new WorkspaceError("TEAM_SESSION_UNAVAILABLE", "会话读取服务不可用。");
      const summary = await this.sharing.inspectSession(item.sessionKey, signal);
      result = { key: item.key, name: summary.title, status: "added", files: [{ path: "会话分享范围", before: null, after: `完整会话快照：包含消息、工具记录、源文件、可读取附件及子会话。\n主源文件：${summary.sourceBytes} 字节。\nPush 准备时核对完整分享包大小；上限 64 MiB，超限请改选 Turn。` }] };
    } else if (item.kind === "turn") {
      if (!this.sharing) throw new WorkspaceError("TEAM_SESSION_UNAVAILABLE", "会话读取服务不可用。");
      const session = await this.sharing.inspectTurn(item.sessionKey, item.turnId, signal), turn = session.selectedTurns![0]!;
      result = { key: item.key, name: `${session.root.session.displayTitle} · 第 ${turn.turnIndex + 1} 轮`, status: "added", files: [{ path: `Turn ${turn.turnIndex + 1}`, before: null, after: JSON.stringify(turn, null, 2) }], session };
    } else {
      if (!revision) throw new WorkspaceError("ASSET_REVISION_REQUIRED", "请先 Pull 获取团队版本。");
      const assets = new TeamAssetService(workspace, undefined, scope);
      let change: SingleChange;
      if (item.kind === "configuration") change = item.change;
      else {
        const connection = await workspace.teamContext(scope.teamId, item.connectionId, item.directory);
        const source = await readTeamLocalPush(connection.directory!.path, item.resource, item.file, signal);
        change = source.kind === "skills" ? { kind: "skills", operation: "update", value: { id: item.id, name: item.name, files: source.files! } }
          : { kind: "documents", operation: "update", value: { id: item.id, name: item.name, target: item.destination ?? `docs/team/${item.id}.md`, content: source.content! } };
      }
      result = { ...await assets.inspectConfiguration(this.directory, revision, change, signal), key: item.key };
    }
    if (signal.aborted) throw new WorkspaceError("CANCELLED", "读取已取消。");
    const latest = await workspace.teamContext(scope.teamId);
    if (JSON.stringify(latest.team) !== JSON.stringify(current.team)) throw new WorkspaceError("TEAM_CHANGED", "团队已改变，请重新选择。");
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes + 1024 > LIMIT) throw new WorkspaceError("ASSETS_TOO_LARGE", "此项 Diff 过大，请减少内容。");
    return { item: result, bytes };
  }
  async preview(owner: number, scope: Scope, revision: string | undefined, items: TeamPushItem[], signal: AbortSignal): Promise<TeamPushPreview> {
    this.cancel(owner);
    if (this.plans.size >= 8) throw new WorkspaceError("TEAM_BUSY", "其他窗口有待推送清单，请关闭后重试。");
    const workspace = new WorkspaceService(this.directory), current = await workspace.teamContext(scope.teamId);
    if (current.team.repository !== scope.repository) throw new WorkspaceError("TEAM_CHANGED", "团队已改变，请重新选择。");
    const team = JSON.stringify(current.team), assets = new TeamAssetService(workspace, undefined, scope);
    const changes: SingleChange[] = [], identities = new Map<string, string>(), groups = new Map<string, Array<Extract<TeamPushItem, { kind: "turn" | "session" }>>>();
    const result: TeamPushPreview["items"] = [], sessions: Pending["sessions"] = [];
    let retained = 0;
    const catalog = items.some(item => item.kind === "resource" || item.kind === "configuration") ? await assets.list(this.directory) : null;
    try {
      for (const item of items) {
        if (signal.aborted) throw new WorkspaceError("CANCELLED", "预览已取消。");
        if (item.kind === "turn" || item.kind === "session") { const group = groups.get(item.sessionKey) ?? []; if (group.some(other => other.kind === "session" || item.kind === "session" || other.turnId === item.turnId)) throw new WorkspaceError("INVALID_ARGUMENTS", "同一会话请只选择完整快照或所需 Turn，不要重复选择。"); group.push(item); groups.set(item.sessionKey, group); continue; }
        let change: SingleChange;
        if (item.kind === "configuration") change = structuredClone(item.change);
        else {
          const connection = await workspace.teamContext(scope.teamId, item.connectionId, item.directory);
          const source = await readTeamLocalPush(connection.directory!.path, item.resource, item.file, signal);
          const exists = item.resource === "skills" ? catalog?.skills.some(entry => entry.id === item.id) : catalog?.documents.some(entry => entry.id === item.id);
          const operation = exists ? "update" : "create";
          change = source.kind === "skills" ? { kind: "skills", operation, value: { id: item.id, name: item.name, files: source.files! } } : { kind: "documents", operation, value: { id: item.id, name: item.name, target: item.destination ?? `docs/team/${item.id}.md`, content: source.content! } };
        }
        const identity = `${change.kind}:${change.kind === "environment" ? change.value.name : change.value.id}`;
        if (identities.has(identity)) throw new WorkspaceError("DUPLICATE_PUSH_RESOURCE", "多个来源对应同一团队资源，请只选择一个来源。");
        identities.set(identity, item.key); changes.push(change);
        retained += Buffer.byteLength(JSON.stringify(change));
        if (retained > 4 * 1024 * 1024) throw new WorkspaceError("ASSETS_TOO_LARGE", "所选资源过大，请减少选择后重试。");
      }
      let change: AssetChange | undefined, assetPreview: ConfigurationPreview | undefined;
      if (changes.length) {
        if (!revision) throw new WorkspaceError("ASSET_REVISION_REQUIRED", "请先 Pull 获取团队资源版本。");
        change = changes.length === 1 ? changes[0]! : { kind: "batch", operation: "update", value: { name: `${changes.length} 项团队资源`, changes } };
        try { assetPreview = await assets.previewConfiguration(this.directory, revision, change, undefined, signal); }
        catch (error) { if (!(error instanceof WorkspaceError) || error.code !== "NO_CONFIGURATION_CHANGE") throw error; }
        for (const [identity, key] of identities) {
          const preview = assetPreview?.items?.find(item => item.key === identity);
          result.push({ key, name: preview?.name ?? changes.find(item => `${item.kind}:${item.kind === "environment" ? item.value.name : item.value.id}` === identity)!.value.name, status: preview?.status ?? "unchanged", files: preview?.files ?? [] });
        }
      }
      if (groups.size > 8) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "一次最多选择 8 条会话中的轮次。");
      for (const [sessionKey, entries] of groups) {
        if (!this.sharing) throw new WorkspaceError("TEAM_SESSION_UNAVAILABLE", "会话分享服务不可用，请重启应用。");
        const context: TeamSessionContext = { repository: scope.repository, projectIdentity: "team:shared", teamWide: true, projectId: "", root: null, projectName: current.team.name };
        const preview = await this.sharing.prepare(owner, context, sessionKey, signal, entries[0]!.kind === "session" ? undefined : entries.map(item => { if (item.kind !== "turn") throw new WorkspaceError("INVALID_ARGUMENTS", "分享选择无效。"); return item.turnId; }), true);
        sessions.push({ keys: entries.map(item => item.key), preview, context });
        for (const entry of entries) {
          if (entry.kind === "session") {
            const summary = [`压缩后：${(preview.bytes / 1024 / 1024).toFixed(2)} MiB`, `子会话：${preview.children.length} 个`, `包含文件：${preview.files.length} 个`, ...preview.files.map(file => `  ${file.name} · ${(file.bytes / 1024).toFixed(1)} KiB`), `无法读取的附件：${preview.missingAttachments.length} 个`, ...preview.missingAttachments.map(name => `  ${name}`)].join("\n");
            result.push({ key: entry.key, name: preview.root.session.displayTitle || preview.root.session.originalTitle, status: "added", files: [{ path: "完整会话快照", before: null, after: summary }] });
            continue;
          }
          const turn = preview.selectedTurns!.find(turn => turn.id === entry.turnId)!;
          const attachments = turn.messages.flatMap(message => message.attachments ?? []);
          const ids = new Set(attachments.map(attachment => attachment.id)), names = new Set(attachments.map(attachment => attachment.fileName));
          const content = { root: preview.root, children: [], files: preview.files.filter(file => file.attachmentId ? ids.has(file.attachmentId) : names.has(file.name)), missingAttachments: preview.missingAttachments.filter(name => names.has(name)), bytes: preview.bytes, selectedTurns: [turn] };
          result.push({ key: entry.key, name: `${preview.root.session.displayTitle} · 第 ${turn.turnIndex + 1} 轮`, status: "added", files: [{ path: `Turn ${turn.turnIndex + 1}`, before: null, after: JSON.stringify(turn, null, 2) }], session: content });
        }
        if (Buffer.byteLength(JSON.stringify(result)) > LIMIT) throw new WorkspaceError("ASSETS_TOO_LARGE", "所选 Diff 过大，请减少轮次。");
      }
      const latest = await workspace.teamContext(scope.teamId);
      if (team !== JSON.stringify(latest.team)) throw new WorkspaceError("TEAM_CHANGED", "团队设置已改变，请重新预览。");
      if (signal.aborted) throw new WorkspaceError("CANCELLED", "预览已取消。");
      const token = randomUUID(), expiresAt = Math.min(Date.now() + 10 * 60_000, ...sessions.map(item => item.preview.expiresAt));
      if (expiresAt <= Date.now()) throw new WorkspaceError("PUSH_PREVIEW_EXPIRED", "预览已过期，请减少选择后重新预览。");
      const preview = { token, expiresAt, repository: scope.repository, items: items.map(item => result.find(value => value.key === item.key)!) };
      if (Buffer.byteLength(JSON.stringify({ ok: true, data: { kind: "push-preview", value: preview } })) > LIMIT) throw new WorkspaceError("ASSETS_TOO_LARGE", "完整 Diff 预览超过 16 MiB，请减少选择。");
      const timer = setTimeout(() => this.discard(owner, token), expiresAt - Date.now()); timer.unref();
      this.plans.set(token, { owner, team, scope, expiresAt, preview, change, assetPreview, assetKeys: [...identities.values()], sessions, timer });
      return preview;
    } catch (error) { for (const session of sessions) this.sharing?.discard(owner, session.preview.token); throw error; }
  }
  async publish(owner: number, scope: Scope, token: string, signal: AbortSignal): Promise<TeamPushResult> {
    const plan = this.plans.get(token);
    const assertCurrent = async () => {
      if (signal.aborted) throw new WorkspaceError("CANCELLED", "推送已取消。");
      if (!plan || plan.owner !== owner || plan.expiresAt <= Date.now() || this.plans.get(token) !== plan || JSON.stringify(plan.scope) !== JSON.stringify(scope)) throw new WorkspaceError("PUSH_PREVIEW_EXPIRED", "Diff 预览已过期，请重新预览。");
      const current = await new WorkspaceService(this.directory).teamContext(scope.teamId);
      if (JSON.stringify(current.team) !== plan.team) throw new WorkspaceError("TEAM_CHANGED", "团队已改变，请重新预览。");
    };
    await assertCurrent();
    if (!plan) throw new WorkspaceError("PUSH_PREVIEW_EXPIRED", "请重新预览。");
    const changed = plan.preview.items.filter(item => item.status !== "unchanged");
    if (changed.length && !await this.confirm(owner, `将所选 ${changed.length} 项推送到 ${scope.repository}？\n${changed.map(item => item.name).join("\n")}\n只上传已预览的内容。公开仓库中的内容可被任何人访问；私有仓库按仓库权限访问。`)) return { items: plan.preview.items.map(item => ({ key: item.key, status: "cancelled" })) };
    await assertCurrent();
    const result: TeamPushResult = { items: plan.preview.items.filter(item => item.status === "unchanged").map(item => ({ key: item.key, status: "unchanged" })) };
    try {
      if (plan.assetPreview && plan.change) {
        const assets = new TeamAssetService(new WorkspaceService(this.directory), undefined, scope);
        const keys = plan.assetKeys.filter(key => !result.items.some(item => item.key === key));
        try {
          await assertCurrent();
          const outcome = await assets.publishConfiguration(this.directory, plan.assetPreview, plan.change, undefined, signal);
          result.items.push(...keys.map(key => ({ key, status: "published" as const, ...(!outcome.cacheUpdated ? { message: "已推送，请 Pull 刷新本地缓存。" } : {}) })));
        } catch (error) {
          const committed = error instanceof WorkspaceError && error.details?.published === true;
          result.items.push(...keys.map(key => ({ key, status: committed ? "published" as const : signal.aborted ? "cancelled" as const : "failed" as const, message: committed ? "已推送，临时文件需清理；请 Pull 核对。" : error instanceof WorkspaceError ? error.message : "推送未确认，请 Pull 核对后重试。" })));
        }
      }
      for (const session of plan.sessions) {
        try {
          await assertCurrent();
          // The owning batch confirmation above authorizes only these retained, window-bound snapshots.
          const published = await this.sharing!.publish(owner, session.context, session.preview.token, signal, assertCurrent, async requester => requester === owner);
          result.items.push(...session.keys.map(key => ({ key, status: "published" as const,
            ...(published?.localReady === false ? { message: "会话已上传，本地整理未完成；请 Pull 恢复，无需重新上传。" } : {}) })));
        } catch (error) { result.items.push(...session.keys.map(key => ({ key, status: signal.aborted ? "cancelled" as const : "failed" as const, message: error instanceof WorkspaceError ? error.message : "会话推送未确认，请核对团队列表。" }))); }
      }
      return result;
    } finally { this.discard(owner, token); }
  }
}
