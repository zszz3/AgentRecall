// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceConfig, TeamPullReport } from "@agentrecall/workspace-core";
import type { TeamPayload, TeamReply, TeamRequest, TeamCatalog } from "../../../../shared/ipc/team-workspace";
import { TeamAssetsPanel } from "./team-assets-panel";
import { TeamDocumentsPanel } from "./team-documents-panel";
import { TeamUploadDialog } from "./team-upload-dialog";
import { TeamWorkspacePage } from "./team-workspace-page";
import { TeamSessionContentView } from "./team-session-content";
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
  if (input.action === "local-assets") return ok({ kind: "local-assets", value: { directory: rootPath, entries: [], limited: false, skipped: 0 } });
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
  const syncButton = button("Pull 拉取");
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
  await act(async () => button("Pull 拉取").click()); await act(async () => root.render(<p>Local page</p>));
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

it.each(["共享指令", "MCP", "Env"])("adds %s by staging an item, reviewing Diff and pushing only selected changes", async (label) => {
  const token = "00000000-0000-4000-8000-000000000001";
  let keys: string[] = [];
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "push-preview") { keys = input.items.map(item => item.key); return ok({ kind: "push-preview", value: { token, expiresAt: Date.now() + 600000, repository, items: input.items.map(item => ({ key: item.key, name: "Resource", status: "added", files: [{ path: "agentrecall.json", before: null, after: JSON.stringify(item) }] })) } }); }
    if (input.action === "push-publish") return ok({ kind: "push-result", value: { items: keys.map(key => ({ key, status: "published" })) } });
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
  await act(async () => button("加入待上传").click());
  expect(container.querySelector('dialog[aria-label="按项推送"]')).not.toBeNull();
  expect(request.mock.calls.some(([input]) => input.action === "push-publish")).toBe(false);
  await act(async () => button("查看所选 Diff").click());
  const prepared = request.mock.calls.find(([input]) => input.action === "push-preview")?.[0];
  if (prepared?.action !== "push-preview" || prepared.items[0]?.kind !== "configuration") throw new Error("Preview missing");
  const change = prepared.items[0].change;
  expect(change.operation).toBe("create");
  if (change.kind === "mcp" && change.value.transport === "http") expect(change.value.headers).toEqual({ Authorization: { fromEnv: "TEAM_TOKEN" } });
  expect(container.querySelector('[aria-label="文件差异"]')?.textContent).toContain("+");
  await act(async () => button("Push 所选 1 项").click());
  expect(request).toHaveBeenCalledWith({ action: "push-publish", scope: { teamId: team.id, repository }, token });
  expect(container.textContent).toContain("已推送 1 项");
  expect(request.mock.calls.some(([input]) => input.action === "sync")).toBe(false);
});

it("prefills edits and discards a preview on close without publishing", async () => {
  const token = "00000000-0000-4000-8000-000000000002";
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "push-preview" ? ok({ kind: "push-preview", value: { token, expiresAt: Date.now() + 600000, repository, items: input.items.map(item => ({ key: item.key, name: "Example", status: "modified", files: [] })) } }) : base(input));
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click()); await act(async () => button("Env").click());
  await act(async () => button("TEAM_MODE").click()); await act(async () => { const edit = button("编辑"); edit.focus(); edit.click(); });
  const name = container.querySelector<HTMLInputElement>('dialog input[placeholder="TEAM_LOCALE"]')!;
  expect(name.value).toBe("TEAM_MODE"); expect(name.disabled).toBe(true);
  expect(container.querySelector("dialog textarea")?.textContent).toBe("review");
  await act(async () => button("加入待上传").click());
  await act(async () => button("查看所选 Diff").click());
  await act(async () => button("关闭推送").click());
  expect(request).toHaveBeenCalledWith({ action: "push-discard", token });
  expect(request.mock.calls.some(([input]) => input.action === "configuration-publish")).toBe(false);
});




it("reuses the session Turn reader for shared fragments without accessing local attachments", async () => {
  const previewAttachment = vi.fn(); Object.assign(window, { sessionSearch: { previewAttachment } });
  const turn = { id: "selected-turn", turnIndex: 8, sourceMessageIndex: 16, synthetic: false, status: "completed" as const,
    startedAt: null, endedAt: null, userPreview: "Review **changes**", assistantPreview: "Done", inputTokens: 0, outputTokens: 0,
    cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, errorCount: 0, toolNames: ["read"], messageCount: 1, spanCount: 1,
    messages: [{ messageIndex: 0, sourceMessageIndex: 16, role: "user" as const, content: "Review **changes**", timestamp: "", attachments: [{ id: "shared", fileName: "selected.txt", mimeType: "text/plain", previewKind: "text" as const, status: "available" as const }] }],
    spans: [{ id: "read", parentSpanId: null, spanIndex: 0, kind: "tool" as const, name: "read", status: "completed" as const, startedAt: null, endedAt: null, callId: "call", input: { path: "selected.txt" }, output: { text: "Selected output" }, error: null, attributes: {} }],
  };
  await act(async () => root.render(<TeamSessionContentView language="zh" content={{ bytes: 50, children: [], files: [], missingAttachments: [], selectedTurns: [turn], root: { schemaVersion: 2, exportedAt: 1, session: { sessionKey: "codex:one", originalTitle: "Example", displayTitle: "Example", source: "codex-cli" }, messages: [], traceEvents: [] } }} />));
  expect(container.querySelector(".team-session-record")).toBeNull();
  expect(container.querySelector(".turn-card-summary")!.textContent).toContain("第 9 轮");
  await act(async () => container.querySelector<HTMLButtonElement>(".turn-card-summary")!.click());
  expect(container.querySelector(".msg-body strong")?.textContent).toBe("changes");
  expect(container.querySelector(".msg.tool")).not.toBeNull();
  expect(container.textContent).toContain("Selected output");
  const attachment = container.querySelector<HTMLButtonElement>(".message-attachments button")!;
  expect(attachment.disabled).toBe(true); expect(attachment.title).toContain("下载分享包");
  await act(async () => attachment.click()); expect(previewAttachment).not.toHaveBeenCalled();
});

it("selects individual local assets, shows their current Diff, and keeps only failed checked items after Push", async () => {
  const token = "00000000-0000-4000-8000-000000000003";
  let keys: string[] = [];
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "local-assets") return ok({ kind: "local-assets", value: { directory: rootPath, limited: false, skipped: 0, entries: input.kind === "skills" ? [{ name: "first", path: ".agents/skills/first/SKILL.md", bytes: 10 }, { name: "second", path: ".agents/skills/second/SKILL.md", bytes: 20 }, { name: "unchecked", path: ".agents/skills/unchecked/SKILL.md", bytes: 30 }] : [] } });
    if (input.action === "push-preview") { keys = input.items.map(item => item.key); return ok({ kind: "push-preview", value: { token, repository, expiresAt: Date.now() + 600000, items: input.items.map(item => ({ key: item.key, name: item.key, status: "modified", files: [{ path: "SKILL.md", before: "Keep\nOld rule\n", after: "Keep\nNew rule\n" }] })) } }); }
    if (input.action === "push-publish") return ok({ kind: "push-result", value: { items: keys.map((key, index) => ({ key, status: index === 0 ? "published" : "failed", ...(index ? { message: "fixture failure" } : {}) })) } });
    return base(input);
  });
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click());
  expect(button("Pull 拉取")).toBeTruthy(); await act(async () => button("Push 推送").click());
  const check = (name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="选择 ${name}"]`)!;
  await act(async () => { check("first").click(); check("second").click(); });
  await act(async () => button("查看所选 Diff").click());
  expect(keys).toHaveLength(2); expect(keys.some(key => key.includes("unchecked"))).toBe(false);
  expect(container.querySelector('[aria-label="文件差异"]')?.textContent).toContain("-Old rule");
  expect(container.querySelector('[aria-label="文件差异"]')?.textContent).toContain("+New rule");
  await act(async () => button("Push 所选 2 项").click());
  expect(check("first")).toBeNull(); expect(check("second").checked).toBe(true); expect(check("unchecked").checked).toBe(false);
  expect(container.textContent).toContain("fixture failure"); expect(container.textContent).toContain("已推送 1 项");
});

it("keeps selection responsive during inspection, ignores stale replies and reuses viewed diffs", async () => {
  let first!: (value: TeamReply) => void;
  const inspections: string[] = [];
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "local-assets") return ok({ kind: "local-assets", value: { directory: rootPath, limited: false, skipped: 0, entries: input.kind === "skills" ? [{ name: "slow", path: ".agents/skills/slow/SKILL.md", bytes: 10 }, { name: "fast", path: ".agents/skills/fast/SKILL.md", bytes: 20 }] : [] } });
    if (input.action === "push-inspect") {
      inspections.push(input.item.key);
      if (input.item.kind === "resource" && input.item.id === "slow") return new Promise(resolve => { first = resolve; });
      return ok({ kind: "push-inspection", value: { bytes: 500, item: { key: input.item.key, name: "fast", status: "modified", files: [{ path: "SKILL.md", before: "old", after: "fresh" }] } } });
    }
    return base(input);
  });
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click()); await act(async () => button("Push 推送").click());
  await act(async () => button("slow").click());
  expect(button("fast").disabled).toBe(false);
  await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="选择 fast"]')!.click());
  expect(container.textContent).toContain("已选 1 项");
  await act(async () => button("fast").click());
  expect(container.querySelector('[aria-label="文件差异"]')?.textContent).toContain("+fresh");
  await act(async () => first(ok({ kind: "push-inspection", value: { bytes: 100, item: { key: inspections[0]!, name: "slow", status: "added", files: [{ path: "SKILL.md", before: null, after: "late result" }] } } })));
  expect(container.textContent).not.toContain("late result");
  await act(async () => button("fast").click());
  expect(inspections).toHaveLength(2);
  await act(async () => button("刷新 Diff").click()); expect(inspections).toHaveLength(3);
  expect(request.mock.calls.some(([input]) => input.action === "push-preview" || input.action === "push-publish")).toBe(false);
});

it("opens queued full sessions in Push without invoking the old share preview", async () => {
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => base(input));
  await act(async () => root.render(<TeamUploadDialog language="zh" onClose={vi.fn()} onPushed={vi.fn()} onOpenSettings={vi.fn()} drafts={[{ item: { kind: "session", key: "session:one", sessionKey: "one" }, title: "Queued session", subtitle: "完整会话快照" }]} api={{ request }} />));
  expect(container.querySelector('dialog[aria-label="按项推送"]')).not.toBeNull();
  expect(container.textContent).toContain("Queued session");
  expect(request.mock.calls.some(([input]) => ["session-preview", "session-publish", "push-preview", "push-publish"].includes(input.action))).toBe(false);
});

it("uploads from the dialog in one action and keeps a preparation failure retryable", async () => {
  let fail = true;
  const onPushed = vi.fn();
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "push-preview") return fail ? {ok:false,error:{code:"TEAM_SESSION_TOO_LARGE",message:"Reduce selection"}} : ok({kind:"push-preview",value:{token:"prepared",expiresAt:Date.now()+600000,repository,items:[{key:"session:one",name:"Queued session",status:"added",files:[]}]}});
    if (input.action === "push-publish") return ok({kind:"push-result",value:{items:[{key:"session:one",status:"published"}]}});
    return base(input);
  });
  await act(async () => root.render(<TeamUploadDialog language="zh" onClose={vi.fn()} onPushed={onPushed} onOpenSettings={vi.fn()} drafts={[{item:{kind:"session",key:"session:one",sessionKey:"one"},title:"Queued session",subtitle:"Full session"}]} api={{request}} />));
  expect(request.mock.calls.some(([input]) => input.action === "push-preview")).toBe(false);
  await act(async () => button("上传所选 1 项").click());
  expect(container.textContent).toContain("Reduce selection");
  expect(request.mock.calls.some(([input]) => input.action === "push-publish")).toBe(false);
  fail = false;
  await act(async () => button("上传所选 1 项").click());
  expect(request).toHaveBeenCalledWith({action:"push-publish",scope:{teamId:team.id,repository},token:"prepared"});
  expect(onPushed).toHaveBeenCalledWith(["session:one"]);
  expect(container.textContent).toContain("已推送 1 项");
});

it("asks for the destination inside a dialog when several teams exist", async () => {
  const second = {...team,id:"second",name:"Second team",repository:"https://github.com/example/second"};
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "snapshot" ? ok({kind:"snapshot",value:{config:{...config,teams:[team,second]},directories:[],busy:false}}) : base(input));
  await act(async () => root.render(<TeamUploadDialog language="zh" onClose={vi.fn()} onPushed={vi.fn()} onOpenSettings={vi.fn()} drafts={[{item:{kind:"session",key:"session:one",sessionKey:"one"},title:"Queued session",subtitle:"Full session"}]} api={{request}} />));
  expect(container.querySelector('dialog[aria-label="上传到团队"]')).not.toBeNull();
  expect(request.mock.calls.some(([input]) => input.action === "catalog")).toBe(false);
  await act(async () => button("Second team").click());
  expect(container.querySelector('dialog[aria-label="按项推送"]')).not.toBeNull();
  expect(request).toHaveBeenCalledWith({action:"catalog",scope:{teamId:second.id,repository:second.repository}});
  expect(request.mock.calls.some(([input]) => input.action === "push-publish")).toBe(false);
});

it("opens the durable snapshot and requests turn summaries separately", async () => {
  const item = {id:17,title:"Shared fixture",author:"fixture",createdAt:"2026-09-30",bytes:100,digest:"a".repeat(64),canWithdraw:false};
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if(input.action === "session-list") return ok({kind:"session-list",value:{items:[item],page:1,hasMore:false}});
    if(input.action === "session-open") return ok({kind:"session-open",value:{bytes:100,files:[],missingAttachments:[],partial:false,records:[{sessionKey:"fixture",title:"Fixture",turnCount:0}]}});
    if(input.action === "session-turns") return ok({kind:"session-turns",value:{offset:0,hasMore:false,turns:[]}});
    return base(input);
  });
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{request}}/>));
  await act(async () => button("Example").click());
  await act(async () => button("Shared fixture").click());
  await act(async () => button("返回会话列表").click());
  await act(async () => button("Shared fixture").click());
  expect(request.mock.calls.filter(([input]) => input.action === "session-open")).toHaveLength(2);
  expect(request.mock.calls.some(([input]) => input.action === "session-turns")).toBe(true);
  expect(request.mock.calls.some(([input]) => input.action === "session-turn")).toBe(false);
  await act(async () => button("刷新会话").click());
  await act(async () => button("Shared fixture").click());
  expect(request.mock.calls.filter(([input]) => input.action === "session-open")).toHaveLength(3);
});
