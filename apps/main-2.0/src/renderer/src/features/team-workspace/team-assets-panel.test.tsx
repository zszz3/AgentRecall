// @vitest-environment happy-dom
import path from "node:path";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "@agentrecall/workspace-core";
import type { TeamPayload, TeamReply, TeamRequest, TeamCatalog } from "../../../../shared/ipc/team-workspace";
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
    expect(container.textContent).toContain("各功能页中查看");
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);
    expect(request.mock.calls.map(([input]) => input.action)).not.toContain("sync");
    expect(container.textContent).toContain("添加资产仓库");
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
    await act(async () => root.render(<TeamAssetsPanel language="zh" api={{ request }} onOpenSettings={() => undefined} />));
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
    await act(async () => root.render(<TeamAssetsPanel language="zh" api={{ request }} onOpenSettings={() => undefined} />));
    const selector = container.querySelector<HTMLSelectElement>(".team-workspace-toolbar select")!;
    await act(async () => { selector.value = "second"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
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
    await act(async () => root.render(<TeamAssetsPanel language="zh" api={{ request }} onOpenSettings={() => undefined} />));
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
    expect(container.textContent).toContain("Session 不会自动上传");
    await act(async () => button("团队设置").click());
    expect(openSettings).toHaveBeenCalledOnce();
    await act(async () => button("返回本地").click());
    expect(container.textContent).toContain("私人会话内容");
  });

  it("refreshes team state after closing settings and cancels sync when leaving the asset view", async () => {
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
    await act(async () => root.render(<TeamAssetsPanel language="zh" api={api} onOpenSettings={() => undefined} />));
    await act(async () => root.render(<TeamAssetsPanel language="zh" api={api} settingsOpen onOpenSettings={() => undefined} />));
    saved = { ...saved, teamEnabled: false };
    await act(async () => root.render(<TeamAssetsPanel language="zh" api={api} onOpenSettings={() => undefined} />));
    expect(container.textContent).toContain("团队功能未启用");
    expect(button("同步资产").disabled).toBe(true);
    saved = { ...saved, teamEnabled: true };
    await act(async () => button("刷新").click());
    await act(async () => button("同步资产").click());
    await act(async () => root.render(<p>Local content</p>));
    expect(request).toHaveBeenCalledWith({ action: "cancel-sync" });
  });

});
