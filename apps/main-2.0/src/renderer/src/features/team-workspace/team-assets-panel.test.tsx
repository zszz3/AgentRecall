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
const catalog: TeamCatalog = { projectId: "", root: null, installed: [], notice: null, assets: { teamId: team.id, repository, commit: revision, skills: [{ id: "review", description: "Review code", files: 1, digest: "b".repeat(64) }], workConfigs: [], documents: [documentAsset, { ...documentAsset, id: "second", name: "第二文档", path: "docs/second.md", target: "docs/second.md" }] } };
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
