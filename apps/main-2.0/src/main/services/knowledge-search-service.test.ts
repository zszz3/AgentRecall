import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceService, TeamAssetService } from "@agentrecall/workspace-core";
import { TeamWorkspaceService } from "./team-workspace-service";
import { KnowledgeSearchService } from "./knowledge-search-service";

let root: string, workspace: WorkspaceService, team: TeamWorkspaceService, service: KnowledgeSearchService;
const localSearch = vi.fn(async () => [{ sessionKey: "codex:test", title: "history" }]);
const localRead = vi.fn(async () => ({ messages: [{ content: "history" }] }));
const resources = [{ id: "review", type: "skill" as const, title: "Review", description: "代码审查", content: "检查错误 retry 与测试。" },
  { id: "guide", type: "document" as const, title: "Guide", description: "", content: "retry 端口冲突" }];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-search-"));
  workspace = new WorkspaceService(root); await workspace.store.initialize();
  await workspace.addTeam({ id: "team", repository: "https://github.com/example/assets" }); await workspace.setTeamEnabled(true);
  team = new TeamWorkspaceService(root, { chooseFolder: async () => null, confirm: async () => false });
  service = new KnowledgeSearchService({ workspace, team: () => team, localSearch, localRead, localSkills: () => [resources[0]!] });
});
afterEach(async () => { await team.close(); vi.restoreAllMocks(); vi.clearAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
it("keeps resource and session searches separate and pages resource content", async () => {
  expect(await service.searchSessions({ query: "retry" })).toEqual([{ sessionKey: "codex:test", title: "history" }]);
  expect(localSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "retry" }));
  const search = await service.searchResources({ query: "错误 retry" });
  expect(search.items).toHaveLength(1); expect(search.items[0]).not.toHaveProperty("content");
  expect(await service.searchResources({ query: "missing" })).toEqual({ items: [], nextOffset: null });
  const first = await service.getResource({ id: "review", type: "skill", maxChars: 2 });
  expect(first.content).toBe("检查"); expect(first.nextOffset).toBe(2);
  expect((await service.getResource({ id: "review", type: "skill", offset: 2 })).content).toBe(resources[0]!.content.slice(2));
  expect(localRead).not.toHaveBeenCalled();
});
it("team resource search uses the working copy, validates scope and never exposes config secrets", async () => {
  const read = vi.spyOn(TeamAssetService.prototype, "resourceEntries").mockResolvedValue(resources);
  expect((await service.searchResources({ query: "retry", scope: "team", teamId: "team", limit: 1 })).nextOffset).toBe(1);
  expect((await service.searchResources({ query: "retry", scope: "team", teamId: "team", type: "document" })).items[0]?.id).toBe("guide");
  await expect(service.searchResources({ query: "retry", scope: "team" })).rejects.toThrow("teamId");
  await expect(service.searchResources({ query: "retry", type: "environment" })).rejects.toThrow();
  await expect(service.searchResources({ query: "retry", type: "document" })).rejects.toThrow("仅包含");
  read.mockClear(); await workspace.setTeamEnabled(false);
  await expect(service.searchResources({ query: "retry", scope: "team", teamId: "team" })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
it("team session hits retain scoped references and read turns locally; changed teams invalidate references", async () => {
  const request = vi.spyOn(team, "request").mockResolvedValue({ ok: true, data: { kind: "session-list", value: { page: 1, hasMore: false, items: [{ id: 7, title: "Shared", source: "codex-cli", author: "member", createdAt: "", digest: "a".repeat(64), bytes: 12, canWithdraw: false, match: { record: 0, turnId: "turn", turnIndex: 3, offset: 0, snippet: "retry" } }] } } });
  const result = await service.searchSessions({ query: "retry", scope: "team", teamId: "team" }) as { items: Array<{ sessionKey: string }> };
  expect(request).toHaveBeenCalledWith(-1, expect.objectContaining({ action: "session-list", mode: "turns", includeTools: false }));
  request.mockResolvedValue({ ok: true, data: { kind: "session-turns", value: { turns: [], offset: 0, hasMore: false } } });
  await service.getSession({ sessionKey: result.items[0]!.sessionKey });
  expect(request).toHaveBeenLastCalledWith(-1, expect.objectContaining({ action: "session-turns", id: 7, record: 0 }));
  request.mockResolvedValue({ ok: true, data: { kind: "session-turn", value: null } });
  await service.getSession({ sessionKey: result.items[0]!.sessionKey, turnId: "turn" });
  expect(request).toHaveBeenLastCalledWith(-1, expect.objectContaining({ action: "session-turn", turnId: "turn" }));
  expect(localSearch).not.toHaveBeenCalled(); expect(localRead).not.toHaveBeenCalled();
  await workspace.store.update(config => ({ ...config, teams: config.teams.map(item => ({ ...item, repository: "https://github.com/example/other" })) }));
  await expect(service.getSession({ sessionKey: result.items[0]!.sessionKey })).rejects.toThrow("已改变");
});
it("rejects invalid input and oversized complete replies", async () => {
  for (const args of [{ query: " " }, { query: "x", limit: 0 }, { query: "x", offset: -1 }, { query: "x", unknown: true }]) await expect(service.searchResources(args)).rejects.toThrow();
  const overhead = Buffer.byteLength(JSON.stringify({ messages: [{ content: "" }] }));
  localRead.mockResolvedValueOnce({ messages: [{ content: "a".repeat(1024 * 1024 - overhead) }] });
  await expect(service.getSession({ sessionKey: "codex:test" })).resolves.toHaveProperty("messages");
  localRead.mockResolvedValueOnce({ messages: [{ content: "a".repeat(1024 * 1024 - overhead + 1) }] });
  await expect(service.getSession({ sessionKey: "codex:test" })).rejects.toThrow("1 MiB");
  localRead.mockResolvedValueOnce({ messages: [{ content: "中".repeat(400000) }] });
  await expect(service.getSession({ sessionKey: "codex:test" })).rejects.toThrow("1 MiB");
  await expect(service.getSession({ sessionKey: "shared:bad" })).rejects.toThrow();
});
