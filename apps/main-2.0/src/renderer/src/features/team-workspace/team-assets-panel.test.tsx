// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceConfig, TeamPullReport } from "@agentrecall/workspace-core";
import type { TeamPayload, TeamReply, TeamRequest, TeamCatalog } from "../../../../shared/ipc/team-workspace";
import { TeamAssetsPanel } from "./team-assets-panel";
import { TeamDocumentsPanel } from "./team-documents-panel";
import { TeamWorkspacePage } from "./team-workspace-page";
import { TeamSessionShareDialog } from "./team-session-share-dialog";
import { TeamSettings } from "../settings/team-settings";

const repository = "https://github.com/example/assets", revision = "1".repeat(40), rootPath = path.resolve("fixtures/team");
const team = { id: "example", name: "Example", repository };
const config: WorkspaceConfig = { schemaVersion: 3, teamEnabled: true, defaultTeamId: null, teams: [team], projects: [], directories: [{ id: "directory-one", teamId: team.id, path: rootPath, enabled: true, targets: ["codex"] }] };
const selection = { team, enabled: true, busy: false };
const ok = (data: TeamPayload): TeamReply => ({ ok: true, data });
const documentAsset = { id: "rules", name: "团队规范", path: "AGENTS.md", target: "AGENTS.md", digest: "a".repeat(64) };
const catalog: TeamCatalog = { projectId: "", root: null, installed: [], notice: null, assets: { teamId: team.id, repository, commit: revision, skills: [{ id: "review", description: "Review code", files: 1, digest: "b".repeat(64) }], configuration: { instructions: [{ id: "rules", name: "代码约定", path: "rules.md", content: "Run focused tests.", digest: "c".repeat(64), targets: ["codex", "claude"] }], mcpServers: [{ id: "docs", name: "知识工具", transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "DOCS_AUTH" } }, targets: ["codex", "claude"] }], environment: [{ name: "TEAM_MODE", value: "review", targets: ["codex"] }] }, workConfigs: [], documents: [documentAsset, { ...documentAsset, id: "second", name: "第二文档", path: "docs/second.md", target: "docs/second.md" }] } };
const preview = (id: string, content: string): TeamReply => ok({ kind: "document-preview", value: { ...documentAsset, id, content, repository, commit: revision, destination: null, local: null, status: "unselected" } });
function base(input: TeamRequest): TeamReply {
  if (input.action === "snapshot") return ok({ kind: "snapshot", value: { config, directories: config.directories, busy: false } });
  if (input.action === "catalog") return ok({ kind: "catalog", value: catalog });
  if (input.action === "sync-status") return ok({ kind: "sync-status", value: null });
  if (input.action === "session-list") return ok({ kind: "session-list", value: { items: [], page: 1, hasMore: false } });
  return ok({ kind: "cancelled" });
}
let container: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
function button(label: string) { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(label) || item.getAttribute("aria-label")?.includes(label)); if (!value) throw new Error("Missing button " + label); return value; }

it("opens a team without a project and performs one full sync, exposing partial results", async () => {
  let finish!: (reply: TeamReply) => void;
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "sync" ? new Promise((resolve) => { finish = resolve; }) : base(input));
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click());
  expect(container.textContent).not.toContain("新建项目");
  expect(request.mock.calls.some(([input]) => input.action === "sync")).toBe(false);
  const syncButton = button("同步团队");
  await act(async () => { syncButton.click(); syncButton.click(); });
  expect(request.mock.calls.filter(([input]) => input.action === "sync")).toHaveLength(1);
  expect(request).toHaveBeenCalledWith({ action: "sync", scope: { teamId: team.id, repository } });
  const report: TeamPullReport = { schemaVersion: 1, repository, commit: revision, startedAt: 1, finishedAt: 2, status: "partial", directories: [{ id: "directory-one", path: rootPath, status: "partial", items: [{ kind: "skill", id: "review", target: "codex", status: "conflict", message: "保留了本地修改" }] }] };
  await act(async () => finish(ok({ kind: "sync-result", value: report })));
  expect(container.textContent).toContain("部分内容未同步"); expect(container.textContent).toContain("保留了本地修改");
});

it("Skills only displays team resources and opens a reader without local/install controls", async () => {
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "skill-preview" ? ok({ kind: "skill-preview", value: { teamId: team.id, repository, commit: revision, id: "review", description: "Review code", file: "SKILL.md", content: "Review instructions", encoding: "utf8", files: [{ path: "SKILL.md", bytes: 20, executable: false }] } }) : base(input));
  await act(async () => root.render(<TeamAssetsPanel language="zh" selection={selection} api={{ request }} />));
  expect(container.textContent).not.toContain("本地 Skills"); expect(container.textContent).not.toContain("工作配置"); expect(container.textContent).not.toContain("HTTPS");
  await act(async () => button("review").click());
  expect(container.querySelector('[aria-label="Skill 详情"]')?.textContent).toContain("Review instructions");
  expect(container.textContent).not.toContain("安装此版本");
  expect(request.mock.calls.every(([input]) => input.action === "catalog" || input.action === "skill-preview")).toBe(true);
});

it("document reader preserves scroll/focus and ignores stale or closed reads without per-file apply", async () => {
  const pending = new Map<string, (reply: TeamReply) => void>();
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "document-preview" ? new Promise((resolve) => pending.set(input.id, resolve)) : base(input));
  await act(async () => root.render(<TeamDocumentsPanel language="zh" selection={selection} api={{ request }} />));
  const list = container.querySelector<HTMLElement>('[aria-label="文档列表"]')!; list.scrollTop = 150;
  const first = button("团队规范"), second = button("第二文档");
  await act(async () => first.click()); expect(container.textContent).toContain("正在打开文档");
  await act(async () => second.click()); await act(async () => pending.get("second")!(preview("second", "second content")));
  await act(async () => pending.get("rules")!(preview("rules", "late content")));
  expect(container.textContent).toContain("second content"); expect(container.textContent).not.toContain("late content");
  expect(list.querySelector('[aria-label="文档详情"]')).toBeNull(); expect(container.textContent).not.toContain("应用到本地");
  await act(async () => container.querySelector('[aria-label="文档详情"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement).toBe(second); expect(list.scrollTop).toBe(150);
  await act(async () => first.click()); await act(async () => button("关闭文档").click()); await act(async () => pending.get("rules")!(preview("rules", "closed content")));
  expect(container.querySelector('[aria-label="文档详情"]')).toBeNull();
});

it("cancels a running sync on leaving the team and does not sync merely on connection", async () => {
  let finish!: (reply: TeamReply) => void;
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "sync") return new Promise((resolve) => { finish = resolve; });
    if (input.action === "cancel-sync") { finish(ok({ kind: "cancelled" })); return ok({ kind: "cancelled" }); }
    if (input.action === "choose-folder") return ok({ kind: "folder", value: rootPath });
    return base(input);
  });
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click()); await act(async () => button("工作目录").click()); await act(async () => button("接入工作目录").click()); await act(async () => button("选择").click());
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(request).toHaveBeenCalledWith({ action: "connect-directory", teamId: team.id, directory: rootPath, targets: ["codex"] });
  expect(request.mock.calls.some(([input]) => input.action === "sync")).toBe(false);
  await act(async () => button("同步团队").click()); await act(async () => root.render(<p>Local page</p>));
  expect(request).toHaveBeenCalledWith({ action: "cancel-sync" });
});

it("keeps transport in team settings and persists an explicit connection choice", async () => {
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => base(input));
  await act(async () => root.render(<TeamSettings language="zh" api={{ request }} />));
  const select = container.querySelector<HTMLSelectElement>('[aria-label="连接方式：Example"]')!;
  await act(async () => { select.value = "ssh"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(request).toHaveBeenCalledWith({ action: "team-transport", id: team.id, transport: "ssh" });
  expect(request.mock.calls.some(([input]) => input.action === "sync")).toBe(false);
});

it("session sharing remains explicit and never uploads when the dialog opens", async () => {
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "session-preview" ? ok({ kind: "session-preview", value: { token: "00000000-0000-4000-8000-000000000001", repository, projectIdentity: "team:shared", expiresAt: Date.now() + 60_000, bytes: 1, files: [], missingAttachments: [], children: [], root: { schemaVersion: 2, exportedAt: 1, session: { sessionKey: "codex:one", originalTitle: "Example", displayTitle: "Example", source: "codex-cli" }, messages: [], traceEvents: [] } } }) : base(input));
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(() => undefined);
  await act(async () => root.render(<TeamSessionShareDialog sessionKey="codex:one" language="zh" onClose={vi.fn()} api={{ request }} />));
  expect(request.mock.calls.map(([input]) => input.action)).toEqual(["snapshot"]);
  await act(async () => button("预览完整会话").click());
  expect(request.mock.calls.some(([input]) => input.action === "session-publish")).toBe(false);
});

it("opens instructions, MCP and Env independently and clears the previous reader when switching", async () => {
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => base(input));
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click());
  const tabs = container.querySelector('[aria-label="团队资源"]')!;
  expect([...tabs.querySelectorAll("button")].map(item => item.textContent)).toEqual(["共享会话", "Skills", "文档", "共享指令", "MCP", "Env", "工作目录"]);
  await act(async () => button("共享指令").click());
  expect(container.querySelector("h2")?.textContent).toContain("共享指令");
  expect(container.textContent).not.toContain("知识工具"); expect(container.textContent).not.toContain("TEAM_MODE");
  await act(async () => button("代码约定").click());
  expect(container.querySelector('[aria-label="共享指令详情"]')?.textContent).toContain("Run focused tests.");
  await act(async () => button("MCP").click());
  expect(container.querySelector('[aria-label="共享指令详情"]')).toBeNull();
  expect(container.textContent).not.toContain("代码约定"); expect(container.textContent).not.toContain("TEAM_MODE");
  await act(async () => button("知识工具").click());
  expect(container.querySelector('[aria-label="MCP详情"]')?.textContent).toContain("DOCS_AUTH");
  await act(async () => button("关闭详情").click());
  expect(document.activeElement).toBe(button("知识工具"));
  await act(async () => button("Env").click());
  expect(container.querySelector("h2")?.textContent).toContain("Env");
  expect(container.textContent).not.toContain("代码约定"); expect(container.textContent).not.toContain("知识工具");
  await act(async () => button("TEAM_MODE").click());
  expect(container.querySelector('[aria-label="Env详情"]')?.textContent).toContain("TEAM_MODE=review");
  await act(async () => container.querySelector('[aria-label="Env详情"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[aria-label="Env详情"]')).toBeNull();
  expect(request.mock.calls.every(([input]) => ["snapshot", "session-list", "sync-status", "catalog", "cancel-sync"].includes(input.action))).toBe(true);
});

it.each(["共享指令", "MCP", "Env"])("adds %s through an explicit preview and publish flow", async (label) => {
  const token = "00000000-0000-4000-8000-000000000001";
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "configuration-preview") return ok({ kind: "configuration-preview", value: { token, expiresAt: Date.now() + 600000, repository, revision, branch: "main", kind: input.change.kind, operation: input.change.operation, name: input.change.value.name, files: [{ path: "agentrecall.json", before: "{}", after: JSON.stringify(input.change) }] } });
    if (input.action === "configuration-publish") return ok({ kind: "configuration-published", value: { repository, commit: "2".repeat(40), cacheUpdated: true, cleanupRequired: false } });
    return base(input);
  });
  const fill = async (selector: string, value: string) => act(async () => {
    const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click()); await act(async () => button(label).click());
  await act(async () => button("新增 " + label).click());
  expect(container.querySelector("dialog")?.open).toBe(true);
  expect(request.mock.calls.some(([input]) => input.action === "configuration-publish")).toBe(false);
  if (label === "Env") {
    await fill('dialog input[placeholder="TEAM_LOCALE"]', "TEAM_LANG"); await fill("dialog textarea", "zh-CN");
  } else {
    await fill('dialog input[maxlength="200"]', "Team resource");
    if (label === "共享指令") await fill("dialog textarea", "Review before publishing.");
    else {
      await fill('dialog input[type="url"]', "https://example.invalid/tools");
      await act(async () => button("添加字段").click());
      await fill('dialog input[aria-label="字段名 1"]', "Authorization");
      await fill('dialog input[aria-label="字段值 1"]', "TEAM_TOKEN");
    }
  }
  await act(async () => button("预览变更").click());
  const prepared = request.mock.calls.find(([input]) => input.action === "configuration-preview")?.[0];
  expect(prepared?.action).toBe("configuration-preview");
  if (prepared?.action !== "configuration-preview") throw new Error("Preview missing");
  expect(prepared.change.operation).toBe("create");
  if (prepared.change.kind === "mcp" && prepared.change.value.transport === "http") expect(prepared.change.value.headers).toEqual({ Authorization: { fromEnv: "TEAM_TOKEN" } });
  expect(request.mock.calls.some(([input]) => input.action === "configuration-publish")).toBe(false);
  expect(container.querySelector("dialog")?.textContent).toContain("修改后");
  await act(async () => button("发布到团队").click());
  expect(request).toHaveBeenCalledWith({ action: "configuration-publish", scope: { teamId: team.id, repository }, token });
  expect(container.querySelector("dialog")).toBeNull(); expect(container.textContent).toContain("已发布到团队");
  expect(request.mock.calls.some(([input]) => input.action === "sync")).toBe(false);
});

it("prefills edits and discards a preview on close without publishing", async () => {
  const token = "00000000-0000-4000-8000-000000000002";
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "configuration-preview" ? ok({ kind: "configuration-preview", value: { token, expiresAt: Date.now() + 600000, repository, revision, branch: "main", kind: input.change.kind, operation: input.change.operation, name: input.change.value.name, files: [] } }) : base(input));
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click()); await act(async () => button("Env").click());
  await act(async () => button("TEAM_MODE").click()); await act(async () => { const edit = button("编辑"); edit.focus(); edit.click(); });
  const name = container.querySelector<HTMLInputElement>('dialog input[placeholder="TEAM_LOCALE"]')!;
  expect(name.value).toBe("TEAM_MODE"); expect(name.disabled).toBe(true);
  expect(container.querySelector("dialog textarea")?.textContent).toBe("review");
  await act(async () => button("预览变更").click());
  await act(async () => button("关闭编辑").click());
  expect(request).toHaveBeenCalledWith({ action: "configuration-discard", token });
  expect(document.activeElement).toBe(button("编辑"));
  expect(request.mock.calls.some(([input]) => input.action === "configuration-publish")).toBe(false);
});
