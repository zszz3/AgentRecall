import { z } from "zod";
import { TeamAssetService, WorkspaceService } from "@agentrecall/workspace-core";
import type { TeamWorkspaceService } from "./team-workspace-service";
import type { TeamRequest } from "../../shared/ipc/team-workspace";

const scope = { scope: z.enum(["local", "team"]).default("local"), teamId: z.string().min(1).max(64).optional() };
const query = z.string().trim().min(1).max(1000);
const paging = { limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).max(200000).default(0) };
const resourceType = z.enum(["skill", "document", "instruction"]);
const resourceSearch = z.object({ ...scope, ...paging, query, type: resourceType.optional() }).strict();
const resourceRead = z.object({ ...scope, id: z.string().min(1).max(512), type: resourceType, offset: z.number().int().min(0).max(2000000).default(0),
  maxChars: z.number().int().min(1).max(32000).default(8000) }).strict();
const sessionSearch = z.object({ ...scope, query: query.default(""), limit: paging.limit,
  page: z.number().int().min(1).max(4000).default(1), source: z.string().max(100).optional(), project: z.string().max(32768).optional(),
  includeTools: z.boolean().default(false) }).strict();
const sessionRead = z.object({ sessionKey: z.string().min(1).max(4096), offset: paging.offset,
  maxMessages: z.number().int().min(1).max(200).default(40), record: z.number().int().min(0).max(127).default(0),
  turnId: z.string().min(1).max(1024).optional() }).strict();
const reference = z.tuple([z.string().min(1).max(64), z.string().max(2048), z.number().int().safe().refine(id => id !== 0), z.string().regex(/^[a-f0-9]{64}$/)]);
type Resource = { id: string; type: "skill" | "document" | "instruction"; title: string; description: string; content: string };
interface Dependencies {
  workspace: WorkspaceService;
  team: () => TeamWorkspaceService;
  localSearch: (value: unknown) => Promise<unknown>;
  localRead: (value: unknown) => Promise<unknown>;
  localSkills: () => Resource[];
}

function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new Error("结果超过 1 MiB，请缩小读取范围。");
  return value;
}

/** Separate read-only entry points reuse the existing session and team working-copy owners. */
export class KnowledgeSearchService {
  constructor(private readonly deps: Dependencies) {}

  private async team(teamId?: string) {
    if (!teamId) throw new Error("团队搜索需要 teamId；使用 agentrecall team list 查看团队。");
    const { team } = await this.deps.workspace.teamContext(teamId);
    return { teamId: team.id, repository: team.repository };
  }

  private async request(request: TeamRequest) {
    const reply = await this.deps.team().request(-1, request);
    if (!reply.ok) throw new Error(reply.error.message);
    return reply.data;
  }

  async searchSessions(input: unknown): Promise<unknown> {
    const args = sessionSearch.parse(input);
    if (args.scope === "local") {
      if (args.teamId || args.page !== 1 || args.includeTools) throw new Error("本机会话搜索不支持 teamId、page 或 includeTools。");
      return bounded(await this.deps.localSearch({ query: args.query, source: args.source, project: args.project, limit: args.limit }));
    }
    if (input && typeof input === "object" && "limit" in input && args.limit !== 50) throw new Error("团队会话每页固定 50 项，请使用 page 翻页。");
    if (args.source || args.project) throw new Error("团队会话搜索使用 teamId，不支持 source 或 project 筛选。");
    const team = await this.team(args.teamId);
    const result = await this.request({ action: "session-list", scope: team, query: args.query, page: args.page, mode: "turns", includeTools: args.includeTools });
    if (result.kind !== "session-list") throw new Error("团队会话搜索返回了错误的结果类型。");
    // Team list pages contain 50 shares. Keep its page boundary to avoid skipping results.
    return bounded({ page: result.value.page, hasMore: result.value.hasMore, pageSize: 50, items: result.value.items.map(item => ({
      sessionKey: `shared:${Buffer.from(JSON.stringify([team.teamId, team.repository, item.id, item.digest])).toString("base64url")}`,
      title: item.title, source: item.source, author: item.author, timestamp: item.createdAt, match: item.match,
    })) });
  }

  async getSession(input: unknown): Promise<unknown> {
    const args = sessionRead.parse(input);
    if (!args.sessionKey.startsWith("shared:")) {
      if (args.turnId || args.record) throw new Error("record 和 turnId 仅用于团队会话。");
      return bounded(await this.deps.localRead({ sessionKey: args.sessionKey, offset: args.offset, maxMessages: args.maxMessages }));
    }
    const [teamId, repository, id, digest] = reference.parse(JSON.parse(Buffer.from(args.sessionKey.slice(7), "base64url").toString("utf8")));
    const team = await this.team(teamId);
    if (team.repository !== repository) throw new Error("团队仓库已改变，请重新搜索。");
    const result = await this.request(args.turnId
      ? { action: "session-turn", scope: team, id, digest, record: args.record, turnId: args.turnId }
      : { action: "session-turns", scope: team, id, digest, record: args.record, offset: args.offset });
    if (result.kind !== "session-turn" && result.kind !== "session-turns") throw new Error("团队会话读取返回了错误的结果类型。");
    return bounded(result.value);
  }

  private async resources(args: { scope: "local" | "team"; teamId?: string; type?: Resource["type"] }): Promise<Resource[]> {
    if (args.scope === "local") {
      if (args.teamId) throw new Error("本机资源搜索不能指定 teamId。");
      if (args.type && args.type !== "skill") throw new Error("本机资源目前仅包含托管 Skills；文档与共享指令请指定团队范围。");
      return this.deps.localSkills();
    }
    const team = await this.team(args.teamId);
    return new TeamAssetService(this.deps.workspace, undefined, team).resourceEntries("");
  }

  async searchResources(input: unknown) {
    const args = resourceSearch.parse(input);
    const terms = args.query.toLocaleLowerCase().split(/\s+/u);
    const matches = (await this.resources(args)).filter(item => (!args.type || item.type === args.type)
      && terms.every(term => `${item.title}\n${item.description}\n${item.content}`.toLocaleLowerCase().includes(term)));
    const items = matches.slice(args.offset, args.offset + args.limit).map(item => {
      const start = Math.max(0, item.content.toLocaleLowerCase().indexOf(terms[0]!) - 60);
      return { id: item.id, type: item.type, title: item.title.slice(0, 300), scope: args.scope, teamId: args.teamId,
        description: item.description.slice(0, 400), snippet: item.content.slice(start, start + 400) };
    });
    return bounded({ items, nextOffset: args.offset + items.length < matches.length ? args.offset + items.length : null });
  }

  async getResource(input: unknown) {
    const args = resourceRead.parse(input);
    const item = (await this.resources(args)).find(item => item.type === args.type && item.id === args.id);
    if (!item) throw new Error("资源不存在，请重新搜索。");
    const content = item.content.slice(args.offset, args.offset + args.maxChars);
    return bounded({ id: item.id, type: item.type, title: item.title, scope: args.scope, teamId: args.teamId, content,
      totalChars: item.content.length, nextOffset: args.offset + content.length < item.content.length ? args.offset + content.length : null });
  }
}
