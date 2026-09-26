import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { WorkspaceError } from "@agentrecall/workspace-core";
import type { TeamSessionPage, TeamSharedSession } from "../../shared/team-sessions";

const execute = promisify(execFile);
const TAG = "agentrecall-sessions-v1";
const MARKER = "AgentRecall team sessions schema=1";
export const MAX_TEAM_SESSION_BYTES = 64 * 1024 * 1024;
const repoSchema = z.object({ private: z.boolean(), default_branch: z.string().min(1), permissions: z.object({ push: z.boolean().optional(), admin: z.boolean().optional() }).optional() });
const assetSchema = z.object({ id: z.number().int().positive(), name: z.string().max(256), label: z.string().max(2048).nullable(), state: z.string(), size: z.number().int().nonnegative(), digest: z.string().nullable().optional(), created_at: z.string(), uploader: z.object({ id: z.number().int().positive(), login: z.string().max(100) }) });
const releaseSchema = z.object({ id: z.number().int().positive(), body: z.string().nullable() });
type Asset = z.infer<typeof assetSchema>;
class GitHubFailure extends WorkspaceError { constructor(readonly status: number) { super("TEAM_GITHUB_ACCESS", `GitHub 请求失败（HTTP ${status}），请检查登录状态与仓库访问权限。`); } }

async function currentToken(signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execute("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 10_000, maxBuffer: 16_384, windowsHide: true, signal });
    const token = stdout.trim(); if (!token || /[\r\n]/.test(token)) throw new Error("Invalid token"); return token;
  } catch { throw new WorkspaceError("TEAM_GITHUB_LOGIN", "请先安装 GitHub CLI 并运行 gh auth login，团队会话会使用该身份访问私有仓库。"); }
}
export class TeamSessionGitHub {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly tokenProvider: (signal?: AbortSignal) => Promise<string> = currentToken) {}
  private repoPath(repository: string): string {
    if (!/^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new WorkspaceError("INVALID_REPOSITORY", "团队仓库地址无效。");
    return repository.slice("https://github.com/".length);
  }
  private async bytes(response: Response, maximum: number): Promise<Buffer> {
    if (Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "共享数据超过大小限制。"); }
    const reader = response.body?.getReader(); if (!reader) return Buffer.alloc(0);
    const chunks: Buffer[] = []; let size = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maximum) { await reader.cancel(); throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "共享数据超过大小限制。"); } chunks.push(Buffer.from(value)); } }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  }
  private async request(token: string, endpoint: string, signal?: AbortSignal, options: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(endpoint, { ...options, redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2026-03-10", ...options.headers } });
    if (!response.ok && response.status !== 302) { await response.body?.cancel(); throw new GitHubFailure(response.status); }
    return response;
  }
  private async json(token: string, endpoint: string, signal?: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.request(token, endpoint, signal, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 302) { await response.body?.cancel(); throw new WorkspaceError("TEAM_GITHUB_REDIRECT", "仓库地址发生跳转，请重新确认团队连接。"); }
    return JSON.parse((await this.bytes(response, 1024 * 1024)).toString("utf8"));
  }
  private async access(repository: string, write: boolean, signal?: AbortSignal) {
    const path = this.repoPath(repository), token = await this.tokenProvider(signal);
    const repo = repoSchema.parse(await this.json(token, `https://api.github.com/repos/${path}`, signal));
    if (!repo.private) throw new WorkspaceError("TEAM_PRIVATE_REPOSITORY_REQUIRED", "完整会话只允许分享到私有团队仓库。当前仓库公开，Skills 和文档仍可使用；本次未上传任何会话。");
    if (write && !repo.permissions?.push) throw new WorkspaceError("TEAM_SESSION_FORBIDDEN", "当前 GitHub 身份没有这个团队仓库的写权限。");
    return { path, token, repo };
  }
  private async release(path: string, token: string, signal?: AbortSignal) {
    try {
      const release = releaseSchema.parse(await this.json(token, `https://api.github.com/repos/${path}/releases/tags/${TAG}`, signal));
      if (release.body !== MARKER) throw new WorkspaceError("TEAM_SESSION_STORAGE_CONFLICT", "仓库中存在同名的非受管存储，请联系团队维护者处理。");
      return release;
    } catch (error) { if (error instanceof GitHubFailure && error.status === 404) return null; throw error; }
  }
  private async actor(token: string, signal?: AbortSignal) { return z.object({ id: z.number().int().positive() }).parse(await this.json(token, "https://api.github.com/user", signal)).id; }
  private item(asset: Asset, actor: number, admin: boolean): TeamSharedSession {
    const match = /^ar1_([a-f0-9]{32})_([a-f0-9]{64})\.json\.gz$/.exec(asset.name);
    if (!match || asset.state !== "uploaded" || asset.size > MAX_TEAM_SESSION_BYTES) throw new WorkspaceError("TEAM_SESSION_INVALID", "共享会话对象格式无效或尚未完成上传。");
    return { id: asset.id, title: asset.label || "共享会话", author: asset.uploader.login, createdAt: asset.created_at, bytes: asset.size, digest: match[2]!, canWithdraw: asset.uploader.id === actor || admin };
  }
  async check(repository: string, signal?: AbortSignal): Promise<void> { await this.access(repository, true, signal); }
  async list(repository: string, project: string, page = 1, signal?: AbortSignal): Promise<TeamSessionPage> {
    const { path, token, repo } = await this.access(repository, false, signal);
    const release = await this.release(path, token, signal); if (!release) return { items: [], page, hasMore: false };
    const [actor, assets] = await Promise.all([this.actor(token, signal), this.json(token, `https://api.github.com/repos/${path}/releases/${release.id}/assets?per_page=100&page=${page}`, signal)]);
    const all = z.array(assetSchema).max(100).parse(assets);
    return { items: all.filter((asset) => asset.name.startsWith(`ar1_${project}_`) && asset.state === "uploaded").map((asset) => this.item(asset, actor, repo.permissions?.admin === true)), page, hasMore: all.length === 100 };
  }
  private async binary(path: string, token: string, asset: Asset, signal?: AbortSignal): Promise<Buffer> {
    let response = await this.request(token, `https://api.github.com/repos/${path}/releases/assets/${asset.id}`, signal, { headers: { Accept: "application/octet-stream" } });
    if (response.status === 302) {
      const location = new URL(response.headers.get("location") ?? "");
      await response.body?.cancel();
      if (location.protocol !== "https:" || !location.hostname.endsWith(".githubusercontent.com") || location.username || location.password || location.port) throw new WorkspaceError("TEAM_SESSION_INVALID", "下载地址不属于 GitHub 附件服务。");
      // A signed download URL is a separate audience: never forward the GitHub token.
      response = await this.fetcher(location, { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
      if (!response.ok) { await response.body?.cancel(); throw new GitHubFailure(response.status); }
    }
    const data = await this.bytes(response, MAX_TEAM_SESSION_BYTES);
    const expected = this.item(asset, 0, false).digest;
    if (data.length !== asset.size || createHash("sha256").update(data).digest("hex") !== expected) throw new WorkspaceError("TEAM_SESSION_INVALID", "共享会话的大小或校验值不一致。");
    return data;
  }
  private async managedAsset(path: string, token: string, project: string, id: number, signal?: AbortSignal): Promise<Asset> {
    const release = await this.release(path, token, signal);
    if (release) for (let page = 1; page <= 100; page++) {
      const all = z.array(assetSchema).max(100).parse(await this.json(token, `https://api.github.com/repos/${path}/releases/${release.id}/assets?per_page=100&page=${page}`, signal));
      const asset = all.find((entry) => entry.id === id);
      if (asset) {
        if (!asset.name.startsWith(`ar1_${project}_`)) throw new WorkspaceError("TEAM_SESSION_PROJECT_MISMATCH", "该会话不属于当前项目。");
        this.item(asset, 0, false);
        return asset;
      }
      if (all.length < 100) break;
    }
    throw new WorkspaceError("TEAM_SESSION_NOT_FOUND", "未找到这条受管分享，请刷新列表后重试。");
  }
  async download(repository: string, project: string, id: number, signal?: AbortSignal): Promise<Buffer> {
    const { path, token } = await this.access(repository, false, signal);
    const asset = await this.managedAsset(path, token, project, id, signal);
    return this.binary(path, token, asset, signal);
  }
  async upload(repository: string, project: string, title: string, data: Buffer, signal?: AbortSignal): Promise<TeamSharedSession> {
    if (data.length > MAX_TEAM_SESSION_BYTES) throw new WorkspaceError("TEAM_SESSION_TOO_LARGE", "完整分享包超过 64 MiB，未上传，不会自动截断。");
    const { path, token, repo } = await this.access(repository, true, signal);
    let release = await this.release(path, token, signal);
    if (!release) {
      try { release = releaseSchema.parse(await this.json(token, `https://api.github.com/repos/${path}/releases`, signal, { tag_name: TAG, target_commitish: repo.default_branch, name: "AgentRecall shared sessions", body: MARKER, draft: false, prerelease: true, make_latest: "false" })); }
      catch (error) { if (!(error instanceof GitHubFailure) || error.status !== 422) throw error; release = await this.release(path, token, signal); if (!release) throw error; }
    }
    const name = `ar1_${project}_${createHash("sha256").update(data).digest("hex")}.json.gz`;
    const actor = await this.actor(token, signal);
    try {
      // Recheck immediately before the content write; opening a preview never uploads.
      const fresh = repoSchema.parse(await this.json(token, `https://api.github.com/repos/${path}`, signal));
      if (!fresh.private) throw new WorkspaceError("TEAM_PRIVATE_REPOSITORY_REQUIRED", "仓库已改为公开，本次上传取消。");
      const response = await this.request(token, `https://uploads.github.com/repos/${path}/releases/${release.id}/assets?name=${encodeURIComponent(name)}&label=${encodeURIComponent(title.slice(0, 120))}`, signal, { method: "POST", headers: { "Content-Type": "application/gzip" }, body: new Uint8Array(data) });
      const asset = assetSchema.parse(JSON.parse((await this.bytes(response, 1024 * 1024)).toString("utf8")));
      if (asset.name !== name || asset.size !== data.length) throw new Error("Upload receipt mismatch");
      return this.item(asset, actor, repo.permissions?.admin === true);
    } catch (error) {
      if (error instanceof WorkspaceError && !(error instanceof GitHubFailure)) throw error;
      if (error instanceof GitHubFailure && error.status === 422) {
        for (let page = 1; page <= 20; page++) {
          const all = z.array(assetSchema).parse(await this.json(token, `https://api.github.com/repos/${path}/releases/${release.id}/assets?per_page=100&page=${page}`, signal));
          const existing = all.find((asset) => asset.name === name);
          if (existing) { await this.binary(path, token, existing, signal); return this.item(existing, actor, repo.permissions?.admin === true); }
          if (all.length < 100) break;
        }
      }
      throw new WorkspaceError("TEAM_SHARE_UNCONFIRMED", "上传结果未确认。保留当前预览并重试会复用同一会话包，不会覆盖已有分享。");
    }
  }
  async withdraw(repository: string, project: string, id: number, signal?: AbortSignal): Promise<void> {
    const { path, token, repo } = await this.access(repository, true, signal);
    const asset = await this.managedAsset(path, token, project, id, signal);
    const current = this.item(asset, await this.actor(token, signal), repo.permissions?.admin === true);
    if (!current.canWithdraw) throw new WorkspaceError("TEAM_SESSION_FORBIDDEN", "只能撤回自己分享的会话，或由仓库管理员处理。");
    const response = await this.request(token, `https://api.github.com/repos/${path}/releases/assets/${id}`, signal, { method: "DELETE" });
    await response.body?.cancel();
    if (response.status !== 204) throw new WorkspaceError("TEAM_WITHDRAW_UNCONFIRMED", "撤回结果未确认，请刷新列表后重试。");
  }
}
