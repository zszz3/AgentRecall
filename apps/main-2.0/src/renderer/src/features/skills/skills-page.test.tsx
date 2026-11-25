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
const teamCatalog = {
  projectId: "",
  root: null,
  installed: [],
  notice: null,
  assets: {
    teamId: team.id,
    repository,
    commit: "1".repeat(40),
    skills: [
      { id: "gamma", description: "Team gamma" },
      { id: "alpha", description: "Team alpha" },
    ],
    configuration: { instructions: [], mcpServers: [], environment: [] },
    documents: [],
    agentRoles: [],
    outcomes: [],
    organization: [],
  },
} as unknown as TeamCatalog;

let container: HTMLDivElement, root: Root;
let library: InstalledSkill[];
let listSkillImportCandidates: ReturnType<typeof vi.fn>;
let importLocalSkills: ReturnType<typeof vi.fn>;
let adoptLocalSkill: ReturnType<typeof vi.fn>;
let listSkillFiles: ReturnType<typeof vi.fn>;
let readSkillFile: ReturnType<typeof vi.fn>;
let updateManagedSkillFile: ReturnType<typeof vi.fn>;
let openSkillFile: ReturnType<typeof vi.fn>;
let deleteSkill: ReturnType<typeof vi.fn>;
let teamApi: { request: ReturnType<typeof vi.fn> };

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  library = [managed("alpha")];
  listSkillImportCandidates = vi.fn(async () => snapshot(skill("alpha"), skill("beta"), skill("system-tool", "codex-system")));
  importLocalSkills = vi.fn(async () => {
    library = [...library, managed("beta")];
    return [{ managedId: "beta", status: "imported" }];
  });
  adoptLocalSkill = vi.fn(async (_skillPath: string, toggleTarget?: string) => {
    const adopted = managed("beta", toggleTarget ? [toggleTarget] : ["codex"]);
    library = [...library, adopted];
    return adopted;
  });
  listSkillFiles = vi.fn(async () => [{ path: "SKILL.md", bytes: 12 }, { path: "scripts/run.sh", bytes: 24 }]);
  readSkillFile = vi.fn(async (_path: string, relativePath: string) => ({ path: relativePath, content: "echo ok", encoding: "utf8", bytes: 7, truncated: false }));
  updateManagedSkillFile = vi.fn(async (_id: string, relativePath: string, content: string) => ({ path: relativePath, content, encoding: "utf8", bytes: content.length, truncated: false }));
  openSkillFile = vi.fn(async () => undefined);
  deleteSkill = vi.fn(async (skillPath: string) => ({ deletedPath: skillPath.replace(/\/SKILL\.md$/, ""), skillName: "beta", retainedBackupPaths: [] }));
  teamApi = {
    request: vi.fn(async (input: TeamRequest): Promise<TeamReply> => {
      if (input.action === "snapshot") return ok({ kind: "snapshot", value: { config, directories: [], busy: false } });
      if (input.action === "catalog") return ok({ kind: "catalog", value: teamCatalog });
      if (input.action === "skill-preview") {
        return ok({
          kind: "skill-preview",
          value: {
            teamId: team.id,
            repository,
            commit: "1".repeat(40),
            id: "gamma",
            description: "Team gamma",
            file: "SKILL.md",
            content: "# Gamma steps",
            encoding: "utf8",
            files: [{ path: "SKILL.md", bytes: 13, executable: false }],
          },
        } as TeamPayload);
      }
      if (input.action === "skill-copy") return ok({ kind: "complete", message: "已把「gamma」加入 Skill 库。", backups: [] });
      if (input.action === "workspace-stage") return ok({ kind: "workspace-changes", value: [] });
      return ok({ kind: "cancelled" });
    }),
  };
  Object.defineProperty(window, "sessionSearch", {
    configurable: true,
    value: {
      deleteSkill,
      getSkillSyncSnapshot: vi.fn(async () => ({ status: { kind: "unconfigured" as const, setupSql: "", remediation: "settings" as const, message: "" }, remoteSkillGroups: [], bindings: [], scannedAt: 0 })),
      importLocalSkills,
      adoptLocalSkill,
      listSkillFiles,
      readSkillFile,
      updateManagedSkillFile,
      openSkillFile,
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

it("unifies local Skills under My Skills, Team, and Discover tabs without Cloud noise and folds undetected agents", async () => {
  await render();
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter((node) => node.closest('[aria-label="Skills view"]'));
  expect(tabs.map((node) => node.textContent)).toEqual(["My Skills3", "Team2", "Discover"]);
  expect(groups()).toEqual(["Active in agents"]);
  expect(items()).toEqual(["alpha", "beta", "system-tool"]);
  expect(meta("beta")).toBe("Codex");
  expect(container.querySelector(".managed-skill-sync")).toBeNull();
  // Detected targets render inline; undetected targets collapse into "+1 more"
  const pills = [...container.querySelectorAll(".skill-agent-pill")].map((node) => node.textContent);
  expect(pills).toContain("Codex");
  expect(pills).toContain("Claude Code");
  expect(pills.some((label) => label?.includes("+1 more"))).toBe(true);
  // Multi-file package tabs render cleanly
  expect([...container.querySelectorAll(".skill-file-tabs button")].map((node) => node.textContent)).toEqual(["SKILL.md", "scripts/run.sh"]);
});

it("auto-adopts an unmanaged local Skill in one click when toggling an Agent pill", async () => {
  await render();
  await act(async () => item("beta").click());
  const claudePill = [...container.querySelectorAll<HTMLButtonElement>(".skill-agent-pill")].find((node) => node.textContent === "Claude Code")!;
  await act(async () => claudePill.click());
  expect(adoptLocalSkill).toHaveBeenCalledWith("fixtures/codex/skills/beta/SKILL.md", "claude");
});

it("shares a managed Skill directly to Team Space and supports inline SKILL.md editing", async () => {
  const onOpenTeamSpace = vi.fn();
  await render(onOpenTeamSpace);
  await act(async () => button("Share to team").click());
  expect(teamApi.request).toHaveBeenCalledWith({
    action: "workspace-stage",
    scope: { teamId: "example", repository },
    items: [{ kind: "library-skill", key: "library-skill:alpha", skill: "alpha" }],
  });
  await act(async () => button("Open Team Space").click());
  expect(onOpenTeamSpace).toHaveBeenCalledOnce();

  await act(async () => button("Edit").click());
  const editor = container.querySelector<HTMLTextAreaElement>(".skill-inline-editor")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "# Updated alpha");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  expect(updateManagedSkillFile).toHaveBeenCalledWith("alpha", "SKILL.md", "# Updated alpha");
});

it("deletes an agent's copy only after confirming, rescans agents, and never offers deleting Codex system Skills", async () => {
  await render();
  await act(async () => item("system-tool").click());
  await openMore();
  expect(menuItems()).toEqual(["Finder", "Copy path"]);
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

it("shows all team Skills in the Team tab including local overlaps and installs to local library", async () => {
  const onOpenTeamSpace = vi.fn();
  await render(onOpenTeamSpace);
  const teamTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent?.startsWith("Team"));
  expect(teamTab).toBeTruthy();
  await act(async () => teamTab!.click());
  expect(items()).toEqual(["alpha", "gamma"]);
  await act(async () => item("gamma").click());
  expect(container.querySelector(".catalog-markdown")?.textContent).toContain("Gamma steps");
  await act(async () => button("Install locally").click());
  expect(teamApi.request).toHaveBeenCalledWith({ action: "skill-copy", scope: { teamId: "example", repository }, id: "gamma" });
  expect(container.querySelector(".catalog-detail [role=status]")?.textContent).toContain("已把「gamma」加入 Skill 库。");
  await act(async () => button("Open Team Space").click());
  expect(onOpenTeamSpace).toHaveBeenCalledOnce();
});

it("reads agent folders from the cache on open and rescans them only when asked to look again", async () => {
  await render();
  expect(listSkillImportCandidates.mock.calls.every(([force]) => force !== true)).toBe(true);
  await act(async () => button("Look again").click());
  expect(listSkillImportCandidates).toHaveBeenLastCalledWith(true);
});

it("deduplicates same-named Skills across library, agent roots, and multiple project folders into one row", async () => {
  library = [managed("one-bite-teaching")];
  listSkillImportCandidates.mockResolvedValue(snapshot(
    {
      ...skill("One Bite Teaching", "codex-project"),
      path: "/repos/app-a/.agents/skills/one-bite-teaching/SKILL.md",
      directoryPath: "/repos/app-a/.agents/skills/one-bite-teaching",
      rootPath: "/repos/app-a/.agents/skills",
    },
    {
      ...skill("one-bite-teaching", "claude-project"),
      path: "/repos/app-b/.claude/skills/one-bite-teaching/SKILL.md",
      directoryPath: "/repos/app-b/.claude/skills/one-bite-teaching",
      rootPath: "/repos/app-b/.claude/skills",
    },
    {
      ...skill("repo-only-skill", "codex-project"),
      path: "/repos/app-a/.agents/skills/repo-only-skill/SKILL.md",
      directoryPath: "/repos/app-a/.agents/skills/repo-only-skill",
      rootPath: "/repos/app-a/.agents/skills",
    },
    {
      ...skill("repo-only-skill", "claude-project"),
      path: "/repos/app-b/.claude/skills/repo-only-skill/SKILL.md",
      directoryPath: "/repos/app-b/.claude/skills/repo-only-skill",
      rootPath: "/repos/app-b/.claude/skills",
    },
  ));
  await render();
  expect(items()).toEqual(["one-bite-teaching", "repo-only-skill"]);
  expect(meta("one-bite-teaching")).toBe("Projects · app-a +1");
  expect(meta("repo-only-skill")).toBe("Projects · app-a +1");
  expect([...container.querySelectorAll(".catalog-locations code")].map((node) => node.textContent)).toEqual([
    "/repos/app-a/.agents/skills/one-bite-teaching",
    "/repos/app-b/.claude/skills/one-bite-teaching",
  ]);
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

function managed(name: string, installedTargets: string[] = []): ManagedSkill {
  return {
    ...skill(name),
    id: `agent-recall-v2:${name}`,
    source: "agent-recall-v2",
    path: `library/${name}/SKILL.md`,
    directoryPath: `library/${name}`,
    rootPath: "library",
    managedId: name,
    origin: { kind: "local", label: "Codex" },
    categoryId: null,
    installations: [
      { target: "codex", path: `fixtures/codex/skills/${name}`, state: installedTargets.includes("codex") ? "installed" : "not-installed", detected: true },
      { target: "claude", path: `fixtures/claude/skills/${name}`, state: installedTargets.includes("claude") ? "installed" : "not-installed", detected: true },
      { target: "pi", path: `fixtures/pi/skills/${name}`, state: "not-installed", detected: false },
    ],
  } as ManagedSkill;
}
