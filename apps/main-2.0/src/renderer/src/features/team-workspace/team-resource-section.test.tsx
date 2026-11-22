// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "@agentrecall/workspace-core";
import type { TeamCatalog, TeamPayload, TeamReply, TeamRequest } from "../../../../shared/ipc/team-workspace";
import { TeamResourceSection } from "./team-resource-section";

const repository = "https://github.com/example/assets", revision = "1".repeat(40), rootPath = path.resolve("fixtures/team");
const team = { id: "example", name: "Example", repository };
const other = { id: "other", name: "Other", repository: "https://github.com/example/other" };
const config = (teams = [team]): WorkspaceConfig => ({ schemaVersion: 3, teamEnabled: true, defaultTeamId: null, teams, projects: [], directories: [{ id: "directory-one", teamId: team.id, path: rootPath, enabled: true, targets: ["codex"] }] });
const ok = (data: TeamPayload): TeamReply => ({ ok: true, data });
const catalog: TeamCatalog = { projectId: "", root: null, installed: [], notice: null, assets: { teamId: team.id, repository, commit: revision, skills: [{ id: "review", description: "Review code", files: 1, digest: "b".repeat(64) }], configuration: { instructions: [{ id: "rules", name: "代码约定", path: "rules.md", content: "Run focused tests.", digest: "c".repeat(64), targets: ["codex", "claude"] }], mcpServers: [{ id: "docs", name: "知识工具", transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "DOCS_AUTH" } }, targets: ["codex", "claude"] }], environment: [] }, documents: [], agentRoles: [], outcomes: [], organization: [], reviewRules: null } } as unknown as TeamCatalog;
function base(input: TeamRequest, teams = [team]): TeamReply {
  if (input.action === "snapshot") return ok({ kind: "snapshot", value: { config: config(teams), directories: config(teams).directories, busy: false } });
  if (input.action === "catalog") return ok({ kind: "catalog", value: catalog });
  if (input.action === "workspace-changes") return ok({ kind: "workspace-changes", value: [] });
  if (input.action === "local-assets") return ok({ kind: "local-assets", value: { directory: rootPath, entries: [], limited: false, skipped: 0 } });
  return ok({ kind: "cancelled" });
}
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
function button(label: string) { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(label) || item.getAttribute("aria-label")?.includes(label)); if (!value) throw new Error("Missing button " + label); return value; }
async function fill(selector: string, value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("points to the team space when no team is connected", async () => {
  const onOpenTeamSpace = vi.fn();
  const request = vi.fn(async (input: TeamRequest) => base(input, []));
  await act(async () => root.render(<TeamResourceSection kind="instructions" language="zh" api={{ request }} onOpenTeamSpace={onOpenTeamSpace} />));
  expect(container.textContent).toContain("还没有连接团队");
  await act(async () => button("打开团队空间").click());
  expect(onOpenTeamSpace).toHaveBeenCalledOnce();
});

it.each([["instructions", "共享指令", "代码约定"], ["mcp", "MCP", "知识工具"]] as const)("edits the team's %s on the resource page by saving to the local copy without publishing", async (kind, label, existing) => {
  let pending = 0;
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "workspace-stage") { pending = 1; return ok({ kind: "workspace-changes", value: [] }); }
    if (input.action === "workspace-changes") return ok({ kind: "workspace-changes", value: Array.from({ length: pending }, () => ({ item: { kind: "local-resource" as const, key: "x" }, title: "Resource", subtitle: "本地修改" })) });
    return base(input);
  });
  await act(async () => root.render(<TeamResourceSection kind={kind} language="zh" api={{ request }} />));
  expect(container.textContent).toContain(existing);
  await act(async () => button("新增 " + label).click());
  await fill('dialog input[maxlength="200"]', "Team resource");
  if (kind === "instructions") await fill("dialog textarea", "Review before publishing.");
  else await fill('dialog input[type="url"]', "https://example.invalid/tools");
  await act(async () => button("保存到共享空间").click());
  const staged = request.mock.calls.find(([input]) => input.action === "workspace-stage")?.[0];
  expect(staged).toMatchObject({ scope: { teamId: team.id, repository }, items: [{ kind: "configuration", change: { kind, operation: "create" } }] });
  expect(container.textContent).toContain("已保存到这个团队的本地副本");
  expect(container.textContent).toContain("1 项本地修改尚未 Push");
  expect(request.mock.calls.some(([input]) => input.action === "configuration-publish" || input.action === "push-publish")).toBe(false);
});

it("lists team Skills, adds Skills from working directories and switches between teams", async () => {
  const request = vi.fn(async (input: TeamRequest) => base(input, [team, other]));
  await act(async () => root.render(<TeamResourceSection kind="skills" language="zh" api={{ request }} />));
  expect(container.textContent).toContain("Review code");
  await act(async () => button("从工作目录添加").click());
  expect(container.querySelector("dialog")?.open).toBe(true);
  await act(async () => button("关闭").click());
  const select = container.querySelector<HTMLSelectElement>(".team-embedded-team select")!;
  await act(async () => { select.value = other.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { teamId: other.id, repository: other.repository } }));
});

it.each([["instructions", "代码约定"], ["mcp", "知识工具"]] as const)("copies a team %s item with the page's own copy action and reports the outcome", async (kind, name) => {
  const request = vi.fn(async (input: TeamRequest) => base(input));
  const run = vi.fn(async () => "Copied it.");
  await act(async () => root.render(<TeamResourceSection kind={kind} language="zh" api={{ request }} copy={{ label: "Copy to mine", run }} />));
  await act(async () => button(name).click());
  await act(async () => button("Copy to mine").click());
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind, value: expect.objectContaining({ name }) }), expect.objectContaining({ id: team.id, name: team.name }));
  expect(container.querySelector("[role=status]")?.textContent).toContain("Copied it.");
  run.mockRejectedValueOnce(new Error("Nothing to copy."));
  await act(async () => button("Copy to mine").click());
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Nothing to copy.");
});

it("adds a team Skill to the member's Skill library and tells the page to reload it", async () => {
  const onSkillCopied = vi.fn();
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "skill-preview") return ok({ kind: "skill-preview", value: { teamId: team.id, repository, commit: revision, id: "review", description: "Review code", file: "SKILL.md", content: "Review instructions", encoding: "utf8", files: [{ path: "SKILL.md", bytes: 20, executable: false }] } });
    if (input.action === "skill-copy") return ok({ kind: "complete", message: "已把「review」加入 Skill 库。", backups: [] });
    return base(input);
  });
  await act(async () => root.render(<TeamResourceSection kind="skills" language="zh" api={{ request }} onSkillCopied={onSkillCopied} />));
  await act(async () => button("review").click());
  await act(async () => button("加入 Skill 库").click());
  expect(request).toHaveBeenCalledWith({ action: "skill-copy", scope: { teamId: team.id, repository }, id: "review" });
  expect(container.textContent).toContain("已把「review」加入 Skill 库。");
  expect(onSkillCopied).toHaveBeenCalledOnce();
});

it("opens a personal item offered by the page as a new team item and refuses choices it cannot share", async () => {
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "workspace-stage" ? ok({ kind: "workspace-changes", value: [] }) : base(input));
  const change = { kind: "instructions" as const, operation: "create" as const, value: { id: "instructions-tests", name: "写测试", content: "Always add tests.", targets: ["codex" as const, "claude" as const] } };
  await act(async () => root.render(<TeamResourceSection kind="instructions" language="zh" api={{ request }} share={{ label: "从个人指令添加", choices: [{ key: "tests", label: "写测试", change }, { key: "empty", label: "空段落", problem: "没有内容" }] }} />));
  await act(async () => button("从个人指令添加").click());
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(items[1]!.disabled).toBe(true);
  expect(items[1]!.textContent).toContain("没有内容");
  await act(async () => items[0]!.click());
  expect(document.querySelector("dialog")?.getAttribute("aria-label")).toBe("新增 共享指令");
  expect(document.querySelector<HTMLTextAreaElement>("dialog textarea")!.value).toBe("Always add tests.");
  await act(async () => button("保存到共享空间").click());
  expect(request.mock.calls.find(([input]) => input.action === "workspace-stage")?.[0]).toMatchObject({ items: [{ kind: "configuration", change }] });
});

it("adds a Skill from the member's Skill library to the team's local copy", async () => {
  const request = vi.fn(async (input: TeamRequest): Promise<TeamReply> => input.action === "workspace-stage"
    ? (input.items[0]!.kind === "library-skill" && input.items[0]!.skill === "broken" ? { ok: false, error: { code: "SKILL_ID_INVALID", message: "标识不能用" } } : ok({ kind: "workspace-changes", value: [] }))
    : base(input));
  await act(async () => root.render(<TeamResourceSection kind="skills" language="zh" api={{ request }} librarySkills={[{ id: "review-guide", name: "Review guide" }, { id: "broken", name: "Broken" }]} />));
  await act(async () => button("从 Skill 库添加").click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][0]!.click());
  expect(request.mock.calls.find(([input]) => input.action === "workspace-stage")?.[0]).toMatchObject({ scope: { teamId: team.id, repository }, items: [{ kind: "library-skill", key: "library-skill:review-guide", skill: "review-guide" }] });
  expect(container.textContent).toContain("已保存到这个团队的本地副本");
  await act(async () => button("从 Skill 库添加").click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][1]!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("标识不能用");
});
