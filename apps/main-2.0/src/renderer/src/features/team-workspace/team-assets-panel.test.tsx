// @vitest-environment happy-dom
import path from "node:path";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "@agentrecall/workspace-core";
import type { TeamPayload, TeamReply, TeamRequest, TeamCatalog } from "../../../../shared/ipc/team-workspace";
import { TeamProjectBrowser } from "./team-project-browser";
import { TeamAssetsPanel } from "./team-assets-panel";
import { TeamSettings } from "../settings/team-settings";
import { FeatureScope } from "./feature-scope";
import { AppNavigation } from "../../components/app-navigation";

const repository = "https://github.com/example/assets";
const revision = "1".repeat(40);
const projectRoot = path.resolve("fixtures/team-workspace");
const ok = (data: TeamPayload): TeamReply => ({ ok: true, data });
const config = (): WorkspaceConfig => ({
  schemaVersion: 1, teamEnabled: true, defaultTeamId: "example",
  teams: [{ id: "example", name: "Example", repository }],
  projects: [{ id: "business", name: "业务项目", root: projectRoot, gitCommonDir: path.join(projectRoot, ".git"), repository: null, remote: null }],
});
const selection = (saved = config(), id = saved.projects[0]!.id) => {
  const project = saved.projects.find((item) => item.id === id)!;
  const teamId = project.teamId === undefined ? saved.defaultTeamId : project.teamId;
  return { project, team: saved.teams.find((item) => item.id === teamId) ?? null, enabled: saved.teamEnabled, busy: false };
};
const catalog = (id = "business", root = projectRoot, skillId = "review"): TeamCatalog => ({
  projectId: id, root, notice: null, installed: [],
  assets: { teamId: "example", repository, commit: revision, skills: [{ id: skillId, description: "Review changes", files: 1, digest: "a".repeat(64) }], workConfigs: [] },
});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error("Button missing: " + label);
  return found;
}

describe("V2 team settings and feature scopes", () => {
  it("starts disabled and enabling never triggers an automatic sync", async () => {
    let saved: WorkspaceConfig | null = null;
    const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
      if (input.action === "enable") saved = { schemaVersion: 1, teamEnabled: input.enabled, defaultTeamId: null, teams: [], projects: [] };
      return ok({ kind: "snapshot", value: { config: saved, busy: false } });
    });
    await act(async () => root.render(<TeamSettings language="zh" api={{ request }} />));
    const toggle = container.querySelector<HTMLInputElement>('[aria-label="启用团队功能"]')!;
    expect(toggle.checked).toBe(false);
    expect(container.textContent).toContain("各功能页使用团队资产");
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);
    expect(request.mock.calls.map(([input]) => input.action)).not.toContain("sync");
    expect(container.querySelector("form")).toBeNull();
    await act(async () => button("连接团队").click());
    expect(container.textContent).toContain("仓库地址");
    expect(container.textContent).not.toContain("团队 ID");
    expect(container.textContent).not.toContain("项目 ID");
    expect(request.mock.calls.map(([input]) => input.action)).not.toContain("catalog");
  });

  it("previews before installing the pinned project, repository and revision and prevents duplicate submission", async () => {
    let finish!: (reply: TeamReply) => void;
    const install = new Promise<TeamReply>((resolve) => { finish = resolve; });
    const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
      if (input.action === "snapshot") return ok({ kind: "snapshot", value: { config: config(), busy: false } });
      if (input.action === "catalog") return ok({ kind: "catalog", value: catalog() });
      if (input.action === "skill-preview") return ok({ kind: "skill-preview", value: {
        teamId: "example", repository, commit: revision, id: "review", description: "Review changes",
        file: "SKILL.md", content: "Preview the review instructions.", encoding: "utf8",
        files: [{ path: "SKILL.md", bytes: 32, executable: false }], destination: path.join(projectRoot, ".agents", "skills", "review"),
      } });
      if (input.action === "skill-install") return install;
      return ok({ kind: "cancelled" });
    });
    await act(async () => root.render(<TeamAssetsPanel language="zh" selection={selection()} api={{ request }} onOpenSettings={() => undefined} />));
    expect(request.mock.calls.some(([input]) => input.action === "skill-install")).toBe(false);
    await act(async () => button("预览").click());
    expect(container.textContent).toContain("Preview the review instructions.");
    expect(container.textContent).toContain(revision);
    await act(async () => { button("安装此版本").click(); button("安装此版本").click(); });
    expect(request.mock.calls.filter(([input]) => input.action === "skill-install")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith({ action: "skill-install", id: "review", target: "codex", revision, scope: { projectId: "business", root: projectRoot, repository } });
    expect(button("安装此版本").disabled).toBe(true);
    await act(async () => finish(ok({ kind: "complete", message: "已安装", backups: [] })));
    expect(container.textContent).toContain("已安装");
  });

  it("discards a late catalog response after switching projects", async () => {
    let finish!: (reply: TeamReply) => void;
    const first = new Promise<TeamReply>((resolve) => { finish = resolve; });
    const saved = config();
    const secondRoot = path.resolve("fixtures/second-team-project");
    saved.projects.push({ ...saved.projects[0]!, id: "second", name: "第二项目", root: secondRoot, gitCommonDir: path.join(secondRoot, ".git") });
    const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
      if (input.action === "snapshot") return ok({ kind: "snapshot", value: { config: saved, busy: false } });
      if (input.action === "catalog") return input.scope.projectId === "business" ? first : ok({ kind: "catalog", value: catalog("second", secondRoot, "second-skill") });
      return ok({ kind: "cancelled" });
    });
    await act(async () => root.render(<TeamAssetsPanel language="zh" selection={selection(saved)} api={{ request }} onOpenSettings={() => undefined} />));
    await act(async () => root.render(<TeamAssetsPanel language="zh" selection={selection(saved, "second")} api={{ request }} onOpenSettings={() => undefined} />));
    expect(container.textContent).toContain("second-skill");
    await act(async () => finish(ok({ kind: "catalog", value: catalog("business", projectRoot, "stale-skill") })));
    expect(container.textContent).not.toContain("stale-skill");
    expect(container.textContent).toContain("second-skill");
  });

  it("allows local group removal while disabled and retains the preview when native confirmation is cancelled", async () => {
    const saved = config();
    saved.teamEnabled = false;
    const installed = { id: "backend", name: "后端配置", target: "codex" as const, repository, revision, skills: ["review"] };
    const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
      if (input.action === "snapshot") return ok({ kind: "snapshot", value: { config: saved, busy: false } });
      if (input.action === "catalog") return ok({ kind: "catalog", value: { ...catalog(), assets: null, installed: [installed] } });
      if (input.action === "work-status") return ok({ kind: "work-status", value: { ...installed, skills: [{ id: "review", state: "ready", action: "backup", otherConfigs: [] }] } });
      return ok({ kind: "cancelled" });
    });
    await act(async () => root.render(<TeamAssetsPanel language="zh" selection={selection(saved)} api={{ request }} onOpenSettings={() => undefined} />));
    await act(async () => button("查看状态").click());
    expect(button("卸载工作配置").disabled).toBe(false);
    await act(async () => button("卸载工作配置").click());
    expect(request).toHaveBeenCalledWith({ action: "work-uninstall", id: "backend", target: "codex", revision, scope: { projectId: "business", root: projectRoot, repository } });
    expect(container.querySelector(".team-workspace-inspection")).not.toBeNull();
    expect(request.mock.calls.some(([input]) => input.action === "sync")).toBe(false);
  });
  it("keeps local content separate, respects the leave guard and routes team setup to settings", async () => {
    const leave = vi.fn(async () => false);
    const openSettings = vi.fn();
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: { teamWorkspace: { request: async () => ok({ kind: "snapshot", value: { config: config(), busy: false } }) } } });
    function Page() {
      const [scope, setScope] = useState<"local" | "team">("local");
      return <><AppNavigation activePage="sessions" settingsOpen={false} signalUpdate={false} language="zh" onNavigate={() => undefined} onOpenSettings={openSettings} />
        <FeatureScope page="sessions" language="zh" scope={scope} settingsOpen={false} onOpenSettings={openSettings} onScopeChange={async (next) => { if (!await leave()) return false; setScope(next); return true; }}><p>私人会话内容</p></FeatureScope></>;
    }
    await act(async () => root.render(<Page />));
    expect(container.querySelector('[data-page="team-workspace"]')).toBeNull();
    const teamButton = container.querySelector<HTMLButtonElement>('.feature-scope-switch button:last-child')!;
    await act(async () => teamButton.click());
    expect(container.textContent).toContain("私人会话内容");
    expect(teamButton.getAttribute("aria-pressed")).toBe("false");
    leave.mockResolvedValue(true);
    await act(async () => teamButton.click());
    expect(container.textContent).not.toContain("私人会话内容");
    await act(async () => button("Example").click());
    await act(async () => button("业务项目").click());
    expect(container.textContent).toContain("Session 不会自动上传");
    await act(async () => button("团队设置").click());
    expect(openSettings).toHaveBeenCalledOnce();
    await act(async () => button("返回本地").click());
    expect(container.textContent).toContain("私人会话内容");
  });

  it("uses refreshed ownership state and cancels sync when leaving the asset view", async () => {
    let saved = config();
    let finish!: (reply: TeamReply) => void;
    const sync = new Promise<TeamReply>((resolve) => { finish = resolve; });
    const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
      if (input.action === "snapshot") return ok({ kind: "snapshot", value: { config: saved, busy: false } });
      if (input.action === "catalog") return ok({ kind: "catalog", value: { ...catalog(), assets: saved.teamEnabled ? catalog().assets : null } });
      if (input.action === "sync") return sync;
      if (input.action === "cancel-sync") finish(ok({ kind: "cancelled" }));
      return ok({ kind: "cancelled" });
    });
    const api = { request };
    await act(async () => root.render(<TeamAssetsPanel language="zh" selection={selection(saved)} api={api} onOpenSettings={() => undefined} />));
    saved = { ...saved, teamEnabled: false };
    await act(async () => root.render(<TeamAssetsPanel language="zh" selection={selection(saved)} api={api} onOpenSettings={() => undefined} />));
    expect(container.textContent).toContain("团队功能未启用");
    expect(button("同步资产").disabled).toBe(true);
    saved = { ...saved, teamEnabled: true };
    await act(async () => root.render(<TeamAssetsPanel language="zh" selection={selection(saved)} api={api} onOpenSettings={() => undefined} />));
    await act(async () => button("同步资产").click());
    await act(async () => root.render(<p>Local content</p>));
    expect(request).toHaveBeenCalledWith({ action: "cancel-sync" });
  });

  it("opens a minimal team form, retains failed input, and closes it only after the repository is saved", async () => {
    let fail = true;
    let saved = { ...config(), teams: [], projects: [], defaultTeamId: null } as WorkspaceConfig;
    const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
      if (input.action === "add-team") {
        if (fail) return { ok: false, error: { code: "TEAM_OPERATION_FAILED", message: "请重试" } };
        saved = config();
      }
      return ok({ kind: "snapshot", value: { config: saved, busy: false } });
    });
    await act(async () => root.render(<TeamSettings language="zh" api={{ request }} />));
    expect(container.querySelector("form")).toBeNull();
    await act(async () => button("连接团队").click());
    const input = container.querySelector<HTMLInputElement>('input[placeholder="https://github.com/your-team/ai-assets"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, repository); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(input.value).toBe(repository);
    expect(container.textContent).toContain("请重试");
    expect(request).toHaveBeenCalledWith({ action: "add-team", repository, name: undefined });
    fail = false;
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Example");
    expect(container.textContent).toContain("团队已连接");
  });

  it("navigates team then project, preserves selection across features, and drops a moved project after refresh", async () => {
    let saved = config();
    saved.teams.push({ id: "other", name: "第二团队", repository: "https://github.com/other/assets" });
    saved.projects.push({ ...saved.projects[0]!, id: "other-project", name: "其他团队项目", teamId: "other" });
    const request = vi.fn(async (): Promise<TeamReply> => ok({ kind: "snapshot", value: { config: saved, busy: false } }));
    Object.defineProperty(window, "sessionSearch", { configurable: true, value: { teamWorkspace: { request } } });
    const props = { language: "zh" as const, scope: "team" as const, settingsOpen: false, onScopeChange: vi.fn(async () => true), onOpenSettings: vi.fn() };
    await act(async () => root.render(<FeatureScope {...props} page="sessions">Local sessions</FeatureScope>));
    expect(container.textContent).toContain("我的团队");
    expect(container.textContent).not.toContain("其他团队项目");
    await act(async () => button("Example").click());
    expect(container.textContent).toContain("业务项目");
    expect(container.textContent).not.toContain("其他团队项目");
    await act(async () => button("业务项目").click());
    expect(container.querySelector('[aria-label="团队与项目"]')?.textContent).toContain("Example业务项目");
    await act(async () => root.render(<FeatureScope {...props} page="memories">Local memory</FeatureScope>));
    expect(container.querySelector('[aria-label="团队与项目"]')?.textContent).toContain("Example业务项目");
    expect(container.textContent).toContain("Memory");
    saved = { ...saved, projects: saved.projects.map((item) => item.id === "business" ? { ...item, teamId: "other" } : item) };
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新团队与项目"]')!.click());
    expect(container.textContent).not.toContain("业务项目");
    expect(container.textContent).not.toContain("其他团队项目");
  });

  it("creates a project inside the selected team without inheriting another team's default", async () => {
    let saved = config();
    saved.teams.push({ id: "other", name: "第二团队", repository: "https://github.com/other/assets" });
    const directory = path.resolve("fixtures/new-team-project");
    let holdRefresh = false;
    let finishRefresh!: (reply: TeamReply) => void;
    const previous = saved;
    const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
      if (input.action === "snapshot" && holdRefresh) { holdRefresh = false; return new Promise((resolve) => { finishRefresh = resolve; }); }
      if (input.action === "choose-folder") return ok({ kind: "folder", value: directory });
      if (input.action === "add-project") saved = { ...saved, projects: [...saved.projects, { ...saved.projects[0]!, id: "new", name: "new-project", root: directory, teamId: input.teamId }] };
      return ok({ kind: "snapshot", value: { config: saved, busy: false } });
    });
    await act(async () => root.render(<TeamProjectBrowser language="zh" api={{ request }} settingsOpen={false} onOpenSettings={vi.fn()}>{({ project }) => <p>{project.name}</p>}</TeamProjectBrowser>));
    await act(async () => button("第二团队").click());
    expect(container.textContent).not.toContain("业务项目");
    holdRefresh = true;
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新团队与项目"]')!.click());
    await act(async () => button("新建项目").click());
    await act(async () => button("选择").click());
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(request).toHaveBeenCalledWith({ action: "add-project", teamId: "other", directory, name: undefined, remote: undefined });
    await act(async () => finishRefresh(ok({ kind: "snapshot", value: { config: previous, busy: false } })));
    expect(saved.defaultTeamId).toBe("example");
    expect(container.textContent).toContain("new-project");
    expect(container.textContent).not.toContain("业务项目");
  });

});
