// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledSkill, InstalledSkillsSnapshot } from "../../../../core/skill-manager";
import { SkillsPage } from "./skills-page";
import { useSkillsController } from "./use-skills-controller";

describe("SkillsPage local Skills lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let listSkillImportCandidates: ReturnType<typeof vi.fn>;
  let importLocalSkills: ReturnType<typeof vi.fn>;
  let deleteSkill: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    listSkillImportCandidates = vi.fn();
    importLocalSkills = vi.fn();
    deleteSkill = vi.fn(async (skillPath: string) => ({
      deletedPath: skillPath.replace(/\/SKILL\.md$/, ""),
      skillName: "alpha",
      retainedBackupPaths: [],
    }));
    Object.defineProperty(window, "sessionSearch", {
      configurable: true,
      value: {
        deleteSkill,
        getSkillSyncSnapshot: vi.fn(async () => ({
          status: { kind: "unconfigured" as const, setupSql: "", remediation: "settings" as const, message: "" },
          remoteSkillGroups: [],
          bindings: [],
          scannedAt: 0,
        })),
        importLocalSkills,
        listSkillImportCandidates,
        listSkills: vi.fn(async () => snapshot()),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("keeps the loaded list visible while refreshing usage after a page remount", async () => {
    listSkillImportCandidates
      .mockResolvedValueOnce(snapshot(skill("alpha"), skill("beta")))
      .mockResolvedValueOnce(snapshot(skill("alpha"), skill("beta", 2)));

    await act(async () => root.render(<Harness />));
    await click("#local-skills-tab");

    expect(listSkillImportCandidates).toHaveBeenCalledTimes(1);
    expect(listSkillImportCandidates).toHaveBeenLastCalledWith(false);
    expect(localSkillCount()).toBe("2");
    expect(localSkillNames()).toEqual(["alpha", "beta"]);

    await click("#toggle-page");
    expect(container.querySelector(".skills-page")).toBeNull();
    await click("#toggle-page");

    expect(localSkillCount()).toBe("2");
    await click("#local-skills-tab");
    expect(localSkillNames()).toEqual(["beta", "alpha"]);
    expect(container.textContent).not.toContain("Scanning local Skills");
    expect(listSkillImportCandidates).toHaveBeenCalledTimes(2);
    expect(listSkillImportCandidates).toHaveBeenNthCalledWith(2, false);
  });

  it("forces a rescan only when the user explicitly refreshes local Skills", async () => {
    listSkillImportCandidates
      .mockResolvedValueOnce(snapshot(skill("alpha")))
      .mockResolvedValueOnce(snapshot(skill("alpha"), skill("beta")));

    await act(async () => root.render(<Harness />));
    await click("#local-skills-tab");
    expect(localSkillCount()).toBe("1");

    await click('button[aria-label="Refresh local Skills"]');

    expect(listSkillImportCandidates).toHaveBeenCalledTimes(2);
    expect(listSkillImportCandidates).toHaveBeenNthCalledWith(1, false);
    expect(listSkillImportCandidates).toHaveBeenNthCalledWith(2, true);
    expect(localSkillCount()).toBe("2");
    expect(localSkillNames()).toEqual(["alpha", "beta"]);
  });

  it("shows an import failure instead of a stale refresh failure", async () => {
    listSkillImportCandidates
      .mockResolvedValueOnce(snapshot(skill("alpha")))
      .mockRejectedValueOnce(new Error("Local Skill refresh failed."));
    importLocalSkills.mockRejectedValue(new Error("Local Skill import failed."));

    await act(async () => root.render(<Harness />));
    await click("#local-skills-tab");
    await click('button[aria-label="Refresh local Skills"]');
    expect(errorMessage()).toBe("Local Skill refresh failed.");

    await click(".local-skill-add-action");

    expect(errorMessage()).toBe("Local Skill import failed.");
  });

  it("clears a stale refresh error when the page resumes", async () => {
    listSkillImportCandidates
      .mockResolvedValueOnce(snapshot(skill("alpha")))
      .mockRejectedValueOnce(new Error("Local Skill refresh failed."))
      .mockResolvedValueOnce(snapshot(skill("alpha")));

    await act(async () => root.render(<Harness />));
    await click("#local-skills-tab");
    await click('button[aria-label="Refresh local Skills"]');
    expect(errorMessage()).toBe("Local Skill refresh failed.");

    await click("#toggle-page");
    await click("#toggle-page");

    expect(errorMessage()).toBeNull();
    expect(listSkillImportCandidates).toHaveBeenCalledTimes(3);
    expect(listSkillImportCandidates).toHaveBeenNthCalledWith(3, false);
  });

  it("does not carry an in-flight refresh failure into a remounted page", async () => {
    let rejectRefresh!: (reason: Error) => void;
    listSkillImportCandidates
      .mockResolvedValueOnce(snapshot(skill("alpha")))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectRefresh = reject;
      }));

    await act(async () => root.render(<Harness />));
    await click("#local-skills-tab");
    await click('button[aria-label="Refresh local Skills"]');

    await click("#toggle-page");
    await click("#toggle-page");
    await act(async () => {
      rejectRefresh(new Error("Local Skill refresh failed."));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(errorMessage()).toBeNull();
    expect(listSkillImportCandidates).toHaveBeenCalledTimes(2);
  });

  it("opens a context menu, confirms deletion, and rescans the local list", async () => {
    listSkillImportCandidates
      .mockResolvedValueOnce(snapshot(skill("alpha")))
      .mockResolvedValueOnce(snapshot());

    await act(async () => root.render(<Harness />));
    await click("#local-skills-tab");
    await contextMenu(".local-skill-row");
    expect(container.querySelector('[role="menu"]')?.textContent).toContain("Delete");
    await mouseDown('[role="menuitem"]');
    await click('[role="menuitem"]');

    expect(container.querySelector('[role="dialog"]')?.textContent)
      .toContain("permanently deletes the local Skill");
    await click(".managed-skill-delete-dialog .danger-action");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteSkill).toHaveBeenCalledWith("fixtures/codex/skills/alpha/SKILL.md");
    expect(listSkillImportCandidates).toHaveBeenLastCalledWith(true);
    expect(localSkillNames()).toEqual([]);
  });

  it("does not offer deletion for Codex system Skills", async () => {
    listSkillImportCandidates.mockResolvedValueOnce(snapshot({
      ...skill("system-skill"),
      source: "codex-system",
    }));

    await act(async () => root.render(<Harness />));
    await click("#local-skills-tab");
    await contextMenu(".local-skill-row");

    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  function localSkillCount(): string | null {
    return container.querySelector("#local-skills-tab small")?.textContent ?? null;
  }

  function localSkillNames(): string[] {
    return [...container.querySelectorAll(".local-skill-row strong")]
      .map((node) => node.textContent ?? "");
  }

  function errorMessage(): string | null {
    return container.querySelector(".managed-skills-feedback.error span")?.textContent ?? null;
  }

  async function click(selector: string): Promise<void> {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    await act(async () => {
      element!.click();
      await Promise.resolve();
    });
  }

  async function contextMenu(selector: string): Promise<void> {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    await act(async () => {
      element!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 140,
        clientY: 90,
      }));
      await Promise.resolve();
    });
  }

  async function mouseDown(selector: string): Promise<void> {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element).not.toBeNull();
    await act(async () => {
      element!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
  }
});

function Harness() {
  const skills = useSkillsController("en");
  const [showSkills, setShowSkills] = useState(true);
  return (
    <>
      <button id="toggle-page" type="button" onClick={() => setShowSkills((visible) => !visible)}>
        Toggle page
      </button>
      {showSkills ? (
        <SkillsPage
          snapshot={skills.snapshot}
          syncSnapshot={skills.syncSnapshot}
          loading={skills.loading}
          feedback={skills.feedback}
          localSnapshot={skills.localSnapshot}
          localLoading={skills.localLoading}
          localError={skills.localError}
          language="en"
          revealLabel="Finder"
          onRefresh={() => undefined}
          onEnsureLocalLoaded={skills.ensureLocalLoaded}
          onRefreshLoadedLocal={skills.refreshLoadedLocal}
          onRefreshLocal={() => void skills.refreshLocal()}
          onUpload={async () => null}
          onUploadSelected={async () => ({ remainingSkillIds: [] })}
          onInstallRemote={async () => undefined}
          onFetchVersion={async () => {
            throw new Error("Not used by this test.");
          }}
          onRefreshRemote={() => undefined}
          onCopySetupSql={() => undefined}
          onOpenSqlEditor={() => undefined}
          onCopyPath={() => undefined}
          onReveal={() => undefined}
          onDelete={skills.deleteSkill}
        />
      ) : null}
    </>
  );
}

function snapshot(...skills: InstalledSkill[]): InstalledSkillsSnapshot {
  return {
    skills,
    roots: [],
    scannedAt: 1,
  };
}

function skill(name: string, usageCount = 0): InstalledSkill {
  return {
    id: `codex:${name}`,
    name,
    description: `${name} description`,
    agent: "codex",
    source: "codex-user",
    path: `fixtures/codex/skills/${name}/SKILL.md`,
    directoryPath: `fixtures/codex/skills/${name}`,
    rootPath: "fixtures/codex/skills",
    markdown: `# ${name}`,
    mtimeMs: 1,
    usageCount,
    lastUsedAt: null,
  };
}
