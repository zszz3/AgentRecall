// @vitest-environment happy-dom
import type { TeamPushDraft } from "../../../../shared/team-push";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceConfig, TeamPullReport } from "@agentrecall/workspace-core";
import type { TeamPayload, TeamReply, TeamRequest, TeamCatalog } from "../../../../shared/ipc/team-workspace";
import { TeamSessionsPanel } from "./team-sessions-panel";
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
const catalog: TeamCatalog = { projectId: "", root: null, installed: [], notice: null, assets: { teamId: team.id, repository, commit: revision, skills: [{ id: "review", description: "Review code", files: 1, digest: "b".repeat(64) }], configuration: { instructions: [{ id: "rules", name: "代码约定", path: "rules.md", content: "Run focused tests.", digest: "c".repeat(64), targets: ["codex", "claude"] }], mcpServers: [{ id: "docs", name: "知识工具", transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "DOCS_AUTH" } }, targets: ["codex", "claude"] }], environment: [{ name: "TEAM_MODE", value: "review", targets: ["codex"] }] }, workConfigs: [], organization: [], documents: [documentAsset, { ...documentAsset, id: "second", name: "第二文档", path: "docs/second.md", target: "docs/second.md" }] } };
const preview = (id: string, content: string): TeamReply => ok({ kind: "document-preview", value: { ...documentAsset, id, content, repository, commit: revision, destination: null, local: null, status: "unselected" } });
function localResources(names: string[]): TeamReply { return ok({ kind: "workspace-changes", value: names.map(name => ({ item: { kind: "local-resource", key: `skills:${name}` }, title: name, subtitle: "Skill" })) }); }
const localSession: TeamPushDraft = { item: { kind: "local-session", key: "session:-1", id: -1 }, title: "Queued session", subtitle: "本地待上传" };
function base(input: TeamRequest): TeamReply {
  if (input.action === "workspace-changes" || input.action === "workspace-stage") return ok({ kind: "workspace-changes", value: [] });
  if (input.action === "push-inspect") return ok({ kind: "push-inspection", value: { bytes: 100, item: { key: input.item.key, name: "Resource", status: "added", files: [{ path: "agentrecall.json", before: null, after: "New resource" }] } } });
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
  expect(request.mock.calls.every(([input]) => ["workspace-changes", "snapshot", "session-status", "session-list", "sync-status", "catalog", "cancel-sync"].includes(input.action))).toBe(true);
});

it.each(["共享指令", "MCP", "Env"])("adds %s by saving locally before opening Push", async (label) => {
  const token = "00000000-0000-4000-8000-000000000001";
  let keys: string[] = [];
  let saved: TeamPushDraft[] = [];
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "workspace-stage") { saved = input.items.map(item => ({ item: { kind: "local-resource", key: item.key }, title: "Resource", subtitle: "本地修改" })); return ok({ kind: "workspace-changes", value: saved }); }
    if (input.action === "workspace-changes") return ok({ kind: "workspace-changes", value: saved });
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
  await act(async () => button("保存到共享空间").click());
  expect(container.querySelector('dialog[aria-label="按项推送"]')).toBeNull();
  expect(container.textContent).toContain("已保存到本地共享空间");
  await act(async () => button("Push 推送").click());
  await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="选择 Resource"]')!.click());
  expect(request.mock.calls.some(([input]) => input.action === "push-publish")).toBe(false);
  await act(async () => button("查看所选 Diff").click());
  const prepared = request.mock.calls.find(([input]) => input.action === "workspace-stage")?.[0];
  if (prepared?.action !== "workspace-stage" || prepared.items[0]?.kind !== "configuration") throw new Error("Preview missing");
  const change = prepared.items[0].change;
  expect(change.operation).toBe("create");
  if (change.kind === "mcp" && change.value.transport === "http") expect(change.value.headers).toEqual({ Authorization: { fromEnv: "TEAM_TOKEN" } });
  expect(container.querySelector('[aria-label="文件差异"]')?.textContent).toContain("+");
  await act(async () => button("Push 所选 1 项").click());
  expect(request).toHaveBeenCalledWith({ action: "push-publish", scope: { teamId: team.id, repository }, token });
  expect(container.textContent).toContain("已推送 1 项");
  expect(request.mock.calls.some(([input]) => input.action === "sync")).toBe(false);
});

it("keeps a failed local save editable and does not publish", async () => {
  let fail = true;
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "workspace-stage" && fail ? { ok: false, error: { code: "SAVE_FAILED", message: "Retry local save" } } : base(input));
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click()); await act(async () => button("Env").click());
  await act(async () => button("TEAM_MODE").click()); await act(async () => button("编辑").click());
  expect(container.querySelector<HTMLInputElement>('dialog input[placeholder="TEAM_LOCALE"]')!.value).toBe("TEAM_MODE");
  await act(async () => button("保存到共享空间").click());
  expect(container.textContent).toContain("Retry local save"); expect(container.querySelector("dialog")?.open).toBe(true);
  fail = false; await act(async () => button("保存到共享空间").click());
  expect(container.querySelector("dialog")).toBeNull();
  expect(request.mock.calls.some(([input]) => input.action === "push-publish")).toBe(false);
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
    if (input.action === "workspace-changes") return localResources(["first", "second", "unchecked"]);
    if (input.action === "push-inspect") return ok({ kind: "push-inspection", value: { bytes: 100, item: { key: input.item.key, name: input.item.key, status: "modified", files: [{ path: "SKILL.md", before: "Keep\nOld rule\n", after: "Keep\nNew rule\n" }] } } });
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
  expect(request.mock.calls.filter(([input]) => input.action === "push-inspect")).toHaveLength(2);
  expect(request.mock.calls.some(([input]) => input.action === "push-preview")).toBe(false);
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
    if (input.action === "workspace-changes") return localResources(["slow", "fast"]);
    if (input.action === "push-inspect") {
      inspections.push(input.item.key);
      if (input.item.key === "skills:slow") return new Promise(resolve => { first = resolve; });
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
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "workspace-stage" ? ok({ kind: "workspace-changes", value: [localSession] }) : input.action === "workspace-changes" ? ok({ kind: "workspace-changes", value: [localSession, { ...localSession, item: { kind: "local-session", key: "session:-2", id: -2 }, title: "Older pending" }] }) : base(input));
  await act(async () => root.render(<TeamUploadDialog language="zh" onClose={vi.fn()} onPushed={vi.fn()} onOpenSettings={vi.fn()} drafts={[{ item: { kind: "session", key: "session:one", sessionKey: "one" }, title: "Queued session", subtitle: "完整会话快照" }]} api={{ request }} />));
  expect(container.querySelector('dialog[aria-label="按项推送"]')).not.toBeNull();
  expect(container.textContent).toContain("Queued session");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="选择 Older pending"]')!.checked).toBe(false);
  expect(request.mock.calls.filter(([input]) => input.action === "workspace-stage")).toHaveLength(1);
  expect(request.mock.calls.some(([input]) => ["session-preview", "session-publish", "push-preview", "push-publish"].includes(input.action))).toBe(false);
});

it("uploads from the dialog in one action and keeps a preparation failure retryable", async () => {
  let fail = true;
  const onPushed = vi.fn();
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "workspace-stage" || input.action === "workspace-changes") return ok({ kind: "workspace-changes", value: [localSession] });
    if (input.action === "push-preview") return fail ? {ok:false,error:{code:"TEAM_SESSION_TOO_LARGE",message:"Reduce selection"}} : ok({kind:"push-preview",value:{token:"prepared",expiresAt:Date.now()+600000,repository,items:[{key:"session:-1",name:"Queued session",status:"added",files:[]}]}});
    if (input.action === "push-publish") return ok({kind:"push-result",value:{items:[{key:"session:-1",status:"published"}]}});
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
    if(input.action === "session-status") return ok({kind:"session-status",value:[{id:item.id,digest:item.digest,phase:"ready",source:"codex-cli"}]});
    if(input.action === "session-open") return ok({kind:"session-open",value:{bytes:100,files:[],missingAttachments:[],partial:false,records:[{sessionKey:"fixture",title:"Fixture",turnCount:0}]}});
    if(input.action === "session-turns") return ok({kind:"session-turns",value:{offset:0,hasMore:false,turns:[]}});
    return base(input);
  });
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{request}}/>));
  await act(async () => button("Example").click());
  expect(container.textContent).toContain("Codex");
  await act(async () => button("Shared fixture").click());
  await act(async () => button("关闭阅读").click());
  await act(async () => button("Shared fixture").click());
  expect(request.mock.calls.filter(([input]) => input.action === "session-open")).toHaveLength(1);
  expect(request.mock.calls.some(([input]) => input.action === "session-turns")).toBe(true);
  expect(request.mock.calls.some(([input]) => input.action === "session-turn")).toBe(false);
  await act(async () => button("刷新会话").click());
  await act(async () => button("Shared fixture").click());
  expect(request.mock.calls.filter(([input]) => input.action === "session-open")).toHaveLength(1);
});


it("never downloads while browsing unprepared sessions and directs preparation to Pull", async () => {
  const item = {id:18,title:"Remote fixture",source:"claude-cli",author:"fixture",createdAt:"2026-09-30",bytes:100,digest:"b".repeat(64),canWithdraw:false};
  let started = false;
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if(input.action === "session-list") return ok({kind:"session-list",value:{items:[item],page:1,hasMore:false}});
    if(input.action === "session-status") return ok({kind:"session-status",value:started ? [{id:item.id,digest:item.digest,phase:"downloading"}] : []});
    if(input.action === "session-fetch") { started = true; return ok({kind:"session-fetch",value:{id:item.id,digest:item.digest,phase:"downloading"}}); }
    return base(input);
  });
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{request}}/>));
  await act(async () => button("Example").click());
  expect(container.textContent).toContain("Claude Code");
  await act(async () => button("Remote fixture").click());
  expect(request.mock.calls.some(([input]) => ["session-fetch", "session-open"].includes(input.action))).toBe(false);
  expect(container.textContent).toContain("请先 Pull 同步这条会话");
  await act(async () => button("关闭阅读").click());
  await act(async () => root.render(<div/>));
  expect(request.mock.calls.filter(([input]) => input.action === "session-fetch")).toHaveLength(0);
  expect(request.mock.calls.some(([input]) => input.action === "session-fetch-cancel")).toBe(false);
});


it("loads local metadata and first turns concurrently and displays the previous list while refreshing", async () => {
  const item={id:19,title:"Cached listing",author:"fixture",createdAt:"2026-09-30",bytes:100,digest:"c".repeat(64),canWithdraw:false};
  let finishOpen!: (value: TeamReply)=>void, finishList!: (value: TeamReply)=>void, refreshing=false;
  const request=vi.fn(async(input:TeamRequest):Promise<TeamReply>=>{
    if(input.action==="session-list") return refreshing ? new Promise(resolve=>{finishList=resolve;}) : ok({kind:"session-list",value:{items:[item],page:1,hasMore:false}});
    if(input.action==="session-status") return ok({kind:"session-status",value:[{id:item.id,digest:item.digest,phase:"ready"}]});
    if(input.action==="session-open") return new Promise(resolve=>{finishOpen=resolve;});
    if(input.action==="session-turns") return ok({kind:"session-turns",value:{offset:0,hasMore:false,turns:[]}});
    return base(input);
  });
  const api={request};
  await act(async()=>root.render(<TeamSessionsPanel selection={selection} language="zh" api={api}/>));
  await act(async()=>button("Cached listing").click());
  expect(request.mock.calls.some(([input])=>input.action==="session-turns")).toBe(true);
  await act(async()=>finishOpen(ok({kind:"session-open",value:{bytes:100,files:[],missingAttachments:[],partial:false,records:[{sessionKey:"fixture",title:"Fixture",turnCount:0}]}})));
  await act(async()=>root.render(<div/>)); refreshing=true;
  await act(async()=>root.render(<TeamSessionsPanel selection={selection} language="zh" api={api}/>));
  expect(container.textContent).toContain("Cached listing");
  expect(container.textContent).not.toContain("正在读取…");
  await act(async()=>finishList(ok({kind:"session-list",value:{items:[],page:1,hasMore:false}})));
  expect(container.textContent).not.toContain("Cached listing");
});

it("searches persisted turns and opens the matched record and page without fetching", async () => {
  const item = { id: 17, title: "Turn search fixture", source: "codex-cli", author: "member", createdAt: "2026-09-30", bytes: 1, digest: "a".repeat(64), canWithdraw: false,
    match: { record: 1, turnId: "matched-turn", turnIndex: 104, offset: 100, snippet: "修复搜索" } };
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "session-list") return ok({ kind: "session-list", value: { items: input.query ? [item] : [], page: 1, hasMore: false } });
    if (input.action === "session-status") return ok({ kind: "session-status", value: [{ id: item.id, digest: item.digest, phase: "ready" }] });
    if (input.action === "session-open") return ok({ kind: "session-open", value: { bytes: 1, files: [], missingAttachments: [], partial: true, records: [0, 1].map(n => ({ sessionKey: String(n), title: String(n), turnCount: 105 })) } });
    if (input.action === "session-turns") return ok({ kind: "session-turns", value: { offset: input.offset, hasMore: false, turns: [] } });
    return base(input);
  });
  await act(async () => root.render(<TeamSessionsPanel selection={selection} language="zh" api={{ request }}/>));
  const input = container.querySelector<HTMLInputElement>('input[placeholder="搜索共享会话…"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "修复"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(request.mock.calls.some(([value]) => value.action === "session-list" && value.query === "修复")).toBe(false);
  expect(container.querySelector('.team-session-mode-tabs')).toBeNull();
  expect(container.querySelector('[title="Resume selected session in the default terminal"]')).toBeNull();
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "session-list", query: "修复", mode: "turns", includeTools: false }));
  expect(container.textContent).toContain("Turn 105");
  await act(async () => button("Turn search fixture").click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "session-turns", record: 1, offset: 100 }));
  await act(async () => button("导出为 Session").click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "session-restore", id: item.id, digest: item.digest }));
  await act(async () => button("导出 JSON").click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "session-export", id: item.id, digest: item.digest, format: "json" }));
  await act(async () => button("导出 MD").click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "session-export", format: "markdown" }));
  expect(request.mock.calls.some(([value]) => ["session-fetch", "session-download", "sync"].includes(value.action))).toBe(false);
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(request.mock.calls.filter(([value]) => value.action === "session-list").at(-1)?.[0]).toMatchObject({ query: "" });
  await act(async () => input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  await act(async () => button("修复").click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "session-list", query: "修复" }));
});

it("keeps the reader open when changing tool search scope without a query and applies it to submitted searches", async () => {
  const item = { id: 18, title: "Scope fixture", source: "codex-cli", author: "member", createdAt: "2026-09-30", bytes: 1, digest: "b".repeat(64), canWithdraw: false };
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "session-list") return ok({ kind: "session-list", value: { items: [item], page: 1, hasMore: false } });
    if (input.action === "session-status") return ok({ kind: "session-status", value: [{ id: item.id, digest: item.digest, phase: "ready" }] });
    if (input.action === "session-open") return ok({ kind: "session-open", value: { bytes: 1, files: [], missingAttachments: [], partial: false, records: [{ sessionKey: "fixture", title: item.title, turnCount: 0 }] } });
    if (input.action === "session-turns") return ok({ kind: "session-turns", value: { offset: 0, hasMore: false, turns: [] } });
    return base(input);
  });
  await act(async () => root.render(<TeamSessionsPanel selection={selection} language="zh" api={{ request }}/>));
  await act(async () => button(item.title).click());
  const option = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(option.closest("label")?.textContent).toContain("搜索包含工具输出");
  const calls = request.mock.calls.length;
  await act(async () => option.click());
  expect(option.checked).toBe(true);
  expect(request.mock.calls).toHaveLength(calls);
  expect(button("导出为 Session").disabled).toBe(false);
  const search = container.querySelector<HTMLInputElement>('input[placeholder="搜索共享会话…"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, "fixture"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(request.mock.calls.filter(([value]) => value.action === "session-list").at(-1)?.[0]).toMatchObject({ query: "fixture", includeTools: true });
  await act(async () => option.click());
  expect(request.mock.calls.filter(([value]) => value.action === "session-list").at(-1)?.[0]).toMatchObject({ query: "fixture", includeTools: false });
});

it("imports selected files locally before Push and does not scan source directories in Push", async () => {
  let saved: TeamPushDraft[] = [];
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "workspace-changes") return ok({ kind: "workspace-changes", value: saved });
    if (input.action === "local-assets") return ok({ kind: "local-assets", value: { directory: rootPath, entries: input.kind === "skills" ? [{ name: "new-skill", path: ".agents/skills/new-skill/SKILL.md", bytes: 100 }] : [], skipped: 0, limited: false } });
    if (input.action === "workspace-stage") { saved = [{ item: { kind: "local-resource", key: "skills:new-skill" }, title: "new-skill", subtitle: "Skill" }]; return ok({ kind: "workspace-changes", value: saved }); }
    return base(input);
  });
  await act(async () => root.render(<TeamWorkspacePage language="zh" settingsOpen={false} onOpenSettings={vi.fn()} api={{ request }} />));
  await act(async () => button("Example").click()); await act(async () => button("Skills").click());
  await act(async () => button("添加资源").click());
  await act(async () => container.querySelector<HTMLInputElement>('dialog .team-resource-row input')!.click());
  const filter = container.querySelector<HTMLInputElement>('input[aria-label="筛选资源"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(filter, "no-match"); filter.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.textContent).toContain("没有匹配的资源");
  expect(container.textContent).toContain("已选 1 项");
  expect(container.querySelector("dialog .team-resource-row")).toBeNull();
  await act(async () => button("加入共享空间").click());
  const staged = request.mock.calls.find(([input]) => input.action === "workspace-stage")![0];
  expect(staged).toMatchObject({ items: [{ kind: "resource", id: "new-skill" }] });
  expect(container.querySelector("dialog")).toBeNull();
  const scans = request.mock.calls.filter(([input]) => input.action === "local-assets").length;
  await act(async () => button("Push 推送").click());
  expect(container.textContent).toContain("new-skill");
  expect(request.mock.calls.filter(([input]) => input.action === "local-assets")).toHaveLength(scans);
  expect(request.mock.calls.some(([input]) => input.action === "push-publish")).toBe(false);
});

it("creates folders, moves selected resources and deletes folders without deleting resources", async () => {
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => base(input));
  await act(async () => root.render(<TeamAssetsPanel language="zh" selection={selection} api={{ request }} />));
  await act(async () => button("新建文件夹").click());
  const input = container.querySelector('.team-folder-editor input') as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "前端"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button("确认").click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: "workspace-stage", items: [expect.objectContaining({ change: expect.objectContaining({ kind: "organization", value: expect.objectContaining({ folders: ["前端"] }) }) })] }));
  await act(async () => (container.querySelector('[aria-label="选择 review"]') as HTMLInputElement).click());
  await act(async () => button("移动所选").click());
  const destination = container.querySelector('.team-folder-editor select') as HTMLSelectElement;
  await act(async () => { destination.value = "前端"; destination.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("确认").click());
  const folder = container.querySelector('[aria-label="资源文件夹"]') as HTMLSelectElement;
  await act(async () => { folder.value = "前端"; folder.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("Review code");
  await act(async () => button("删除文件夹").click());
  expect(container.textContent).toContain("不会被删除");
  await act(async () => button("确认").click());
  expect(container.textContent).toContain("Review code");
  expect(folder.value).toBe("");
  expect(request.mock.calls.some(([input]) => input.action === "push-publish")).toBe(false);
});
