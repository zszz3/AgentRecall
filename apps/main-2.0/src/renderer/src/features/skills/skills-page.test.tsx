// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceConfig } from "@agentrecall/workspace-core";
import type { InstalledSkill, InstalledSkillsSnapshot } from "../../../../core/skill-manager";
import type { ManagedSkill } from "../../../../core/managed-skill-library";
import type { TeamCatalog, TeamPayload, TeamReply, TeamRequest } from "../../../../shared/ipc/team-workspace";
import { SkillsPage } from "./skills-page";
import { useSkillsController } from "./use-skills-controller";

const repository = "https://github.com/example/assets";
const team = { id: "example", name: "Example", repository };
const config: WorkspaceConfig = { schemaVersion: 3, teamEnabled: true, defaultTeamId: null, teams: [team], projects: [], directories: [] };
const ok = (data: TeamPayload): TeamReply => ({ ok: true, data });
const teamCatalog = { projectId: "", root: null, installed: [], notice: null, assets: { teamId: team.id, repository, commit: "1".repeat(40), skills: [{ id: "gamma", description: "Team gamma" }, { id: "alpha", description: "Team alpha" }], configuration: { instructions: [], mcpServers: [], environment: [] }, documents: [], agentRoles: [], outcomes: [], organization: [] } } as unknown as TeamCatalog;

let container: HTMLDivElement, root: Root;
let library: InstalledSkill[];
let listSkillImportCandidates: ReturnType<typeof vi.fn>;
let importLocalSkills: ReturnType<typeof vi.fn>;
let deleteSkill: ReturnType<typeof vi.fn>;
let teamApi: { request: ReturnType<typeof vi.fn> };

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  // Node 26 exposes an undefined `localStorage` global that shadows happy-dom's storage.
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, String(value)), removeItem: (key: string) => values.delete(key) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  library = [managed("alpha")];
  listSkillImportCandidates = vi.fn(async () => snapshot(skill("alpha"), skill("beta"), skill("system-tool", "codex-system")));
  importLocalSkills = vi.fn(async () => { library = [...library, managed("beta")]; return [{ managedId: "beta", status: "imported" }]; });
  deleteSkill = vi.fn(async (skillPath: string) => ({ deletedPath: skillPath.replace(/\/SKILL\.md$/, ""), skillName: "beta", retainedBackupPaths: [] }));
  teamApi = { request: vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
    if (input.action === "snapshot") return ok({ kind: "snapshot", value: { config, directories: [], busy: false } });
    if (input.action === "catalog") return ok({ kind: "catalog", value: teamCatalog });
    if (input.action === "skill-preview") return ok({ kind: "skill-preview", value: { teamId: team.id, repository, commit: "1".repeat(40), id: "gamma", description: "Team gamma", file: "SKILL.md", content: "# Gamma steps", encoding: "utf8", files: [{ path: "SKILL.md", bytes: 13, executable: false }] } } as TeamPayload);
    if (input.action === "skill-copy") return ok({ kind: "complete", message: "已把「gamma」加入 Skill 库。", backups: [] });
    return ok({ kind: "cancelled" });
  }) };
  Object.defineProperty(window, "sessionSearch", {
    configurable: true,
    value: {
      deleteSkill,
      getSkillSyncSnapshot: vi.fn(async () => ({ status: { kind: "unconfigured" as const, setupSql: "", remediation: "settings" as const, message: "" }, remoteSkillGroups: [], bindings: [], scannedAt: 0 })),
      importLocalSkills,
      listSkillImportCandidates,
      listSkills: vi.fn(async () => snapshot(...library)),
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("separates Active, Library, and Team & cloud views, shows truthful agent status, hides unconfigured cloud sync, and searches across views", async () => {
  await render();
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map((node) => node.textContent)).toEqual(["Active3", "Library1", "Team & cloud1"]);
  expect(groups()).toEqual(["Managed & active", "Only in agents"]);
  expect(items()).toEqual(["alpha", "beta", "system-tool"]);
  expect(meta("alpha")).toBe("Codex");
  expect(meta("beta")).toBe("Codex · Unmanaged");
  expect(container.querySelector(".catalog-head-meta")?.textContent).toBe("3 active · 1 in library · 1 shared");
  expect(container.querySelector(".catalog-detail h3")?.textContent).toBe("alpha");
  expect(button("Install to agents…")).toBeTruthy();
  expect(container.querySelector(".skill-agent-matrix")).toBeTruthy();
  expect(container.querySelector(".managed-skill-sync")).toBeNull();
  expect([...container.querySelectorAll(".catalog-locations code")].map((node) => node.textContent)).toEqual(["fixtures/codex/skills/alpha", "alpha"]);

  // Switch to Library view
  await act(async () => tabs[1]!.click());
  expect(groups()).toEqual(["Installed in agents"]);
  expect(items()).toEqual(["alpha"]);

  // Search spans every view (including Team & cloud)
  await type("gam");
  expect(items()).toEqual(["gamma"]);
  await type("nothing-like-this");
  expect(container.querySelector(".catalog-list-empty")?.textContent).toBe("Nothing matches.");
});

it("adds a Skill found only in an agent to the library and selects it there", async () => {
  await render();
  await act(async () => item("beta").click());
  await act(async () => button("Add to Skill library").click());
  expect(importLocalSkills).toHaveBeenCalledWith(["fixtures/codex/skills/beta/SKILL.md"]);
  expect(container.querySelector(".catalog-item[aria-current] .catalog-item-title")?.textContent).toBe("beta");
  expect(meta("beta")).toBe("Codex");
  expect(button("Install to agents…")).toBeTruthy();
});

it("deletes an agent's copy only after confirming, rescans agents, and never offers deleting Codex system Skills", async () => {
  await render();
  await act(async () => item("system-tool").click());
  await openMore();
  expect(menuItems()).toEqual(["Copy path"]);
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

  await act(async () => item("beta").click());
  await openMore();
  await act(async () => menuItem("Delete from the agent").click());
  expect(deleteSkill).not.toHaveBeenCalled();
  expect(container.querySelector(".catalog-confirm")?.textContent).toContain("permanently deletes its folder");
  const scansBefore = listSkillImportCandidates.mock.calls.length;
  await act(async () => button("Delete", container.querySelector(".catalog-confirm")!).click());
  expect(deleteSkill).toHaveBeenCalledWith("fixtures/codex/skills/beta/SKILL.md");
  expect(listSkillImportCandidates.mock.calls.slice(scansBefore)).toContainEqual([true]);
});

it("shows a team Skill's SKILL.md under Team & cloud and adds it to the library without leaving the page", async () => {
  const onOpenTeamSpace = vi.fn();
  await render(onOpenTeamSpace);
  const sharedTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent?.startsWith("Team & cloud"));
  expect(sharedTab).toBeTruthy();
  await act(async () => sharedTab!.click());
  await act(async () => item("gamma").click());
  expect(container.querySelector(".catalog-markdown")?.textContent).toContain("Gamma steps");
  await act(async () => button("Add to Skill library").click());
  expect(teamApi.request).toHaveBeenCalledWith({ action: "skill-copy", scope: { teamId: "example", repository }, id: "gamma" });
  expect(container.querySelector(".catalog-detail [role=status]")?.textContent).toBe("已把「gamma」加入 Skill 库。");
  await act(async () => button("Edit in team space").click());
  expect(onOpenTeamSpace).toHaveBeenCalledOnce();
});

it("reads agent folders from the cache on open and rescans them only when asked to look again", async () => {
  await render();
  expect(listSkillImportCandidates.mock.calls.every(([force]) => force !== true)).toBe(true);
  await act(async () => button("Look again").click());
  expect(listSkillImportCandidates).toHaveBeenLastCalledWith(true);
});

function Harness({ onOpenTeamSpace }: { onOpenTeamSpace?(): void }) {
  const skills = useSkillsController("en");
  const { ensureLoaded } = skills;
  useEffect(() => { ensureLoaded(); }, [ensureLoaded]);
  return <SkillsPage
    snapshot={skills.snapshot} syncSnapshot={skills.syncSnapshot} loading={skills.loading} feedback={skills.feedback}
    localSnapshot={skills.localSnapshot} localLoading={skills.localLoading} localError={skills.localError}
    language="en" revealLabel="Finder" teamApi={teamApi as never} onOpenTeamSpace={onOpenTeamSpace}
    onRefresh={() => void skills.load({ refreshUsage: true })} onEnsureLocalLoaded={skills.ensureLocalLoaded}
    onRefreshLoadedLocal={skills.refreshLoadedLocal} onRefreshLocal={skills.refreshLocal}
    onUpload={async () => null} onInstallRemote={async () => undefined} onFetchVersion={async () => { throw new Error("Not used by this test."); }}
    onRefreshRemote={() => undefined} onCopySetupSql={() => undefined} onOpenSqlEditor={() => undefined}
    onCopyPath={() => undefined} onReveal={() => undefined} onDelete={skills.deleteSkill}
  />;
}

async function render(onOpenTeamSpace?: () => void) {
  await act(async () => root.render(<Harness onOpenTeamSpace={onOpenTeamSpace} />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const groups = () => [...container.querySelectorAll(".catalog-group h3 > span")].map((node) => node.textContent);
const items = () => [...container.querySelectorAll(".catalog-item-title")].map((node) => node.textContent);
function item(name: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".catalog-item")].find((node) => node.querySelector(".catalog-item-title")?.textContent === name);
  if (!found) throw new Error(`Missing item ${name}`);
  return found;
}
const meta = (name: string) => item(name).querySelector(".catalog-item-meta")?.textContent;
function button(label: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function openMore() { await act(async () => button("More actions", container.querySelector(".catalog-detail-actions")!).click()); }
const menuItems = () => [...document.querySelectorAll('[role="menuitem"] span')].map((node) => node.textContent);
function menuItem(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.querySelector("span")?.textContent === label);
  if (!found) throw new Error(`Missing menu item ${label}`);
  return found;
}
async function type(value: string) {
  const search = container.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function snapshot(...skills: InstalledSkill[]): InstalledSkillsSnapshot {
  return { skills, roots: [], scannedAt: 1 };
}

function skill(name: string, source: InstalledSkill["source"] = "codex-user"): InstalledSkill {
  return {
    id: `codex:${name}`, name, description: `${name} description`, agent: "codex", source,
    path: `fixtures/codex/skills/${name}/SKILL.md`, directoryPath: `fixtures/codex/skills/${name}`, rootPath: "fixtures/codex/skills",
    markdown: `# ${name}`, mtimeMs: 1, usageCount: 0, lastUsedAt: null,
  };
}

function managed(name: string): ManagedSkill {
  return {
    ...skill(name), id: `agent-recall-v2:${name}`, source: "agent-recall-v2", path: `library/${name}/SKILL.md`, directoryPath: `library/${name}`, rootPath: "library",
    managedId: name, origin: { kind: "local", label: "Codex" }, categoryId: null, installations: [{ target: "codex", path: `fixtures/codex/skills/${name}`, state: "not-installed" }],
  } as ManagedSkill;
}
