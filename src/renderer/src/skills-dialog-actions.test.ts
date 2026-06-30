import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { summarizeSkillRoots } from "./components/skills-dialog";
import type { SkillRootStatus } from "../../core/skill-manager";

const skillsDialogSource = readFileSync(new URL("./components/skills-dialog.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("skills dialog actions", () => {
  it("copies the SKILL.md path but reveals the skill directory", () => {
    expect(skillsDialogSource).toContain("onCopyPath(skillContextMenu.skill.path)");
    expect(skillsDialogSource).toContain("onReveal(skillContextMenu.skill.directoryPath)");
    expect(skillsDialogSource).not.toContain("onReveal(skillContextMenu.skill.path)");
  });

  it("summarizes noisy project skill roots", () => {
    const roots: SkillRootStatus[] = [
      { agent: "codex", source: "codex-user", path: "/home/.codex/skills", exists: true, skillCount: 10 },
      { agent: "codex", source: "codex-shared", path: "/home/.agents/skills", exists: true, skillCount: 3 },
      { agent: "codex", source: "codex-project", path: "/repo/.codex/skills", exists: true, skillCount: 2 },
      { agent: "codex", source: "codex-project", path: "/repo/app/.codex/skills", exists: false, skillCount: 0 },
      { agent: "claude", source: "claude-project", path: "/repo/.claude/skills", exists: false, skillCount: 0 },
    ];

    expect(summarizeSkillRoots(roots).map((root) => ({ source: root.source, exists: root.exists, skillCount: root.skillCount }))).toEqual([
      { source: "codex-user", exists: true, skillCount: 10 },
      { source: "codex-shared", exists: true, skillCount: 3 },
      { source: "codex-project", exists: true, skillCount: 2 },
    ]);
  });

  it("surfaces Supabase sync configuration and local/remote skill actions", () => {
    const supabaseSettings = appSource.slice(appSource.indexOf("Supabase skill sync"), appSource.indexOf("Appearance", appSource.indexOf("Supabase skill sync")));

    expect(appSource).toContain("skillSyncSupabaseUrl");
    expect(appSource).toContain("skillSyncSupabaseAnonKey");
    expect(appSource).toContain("supabase.com/dashboard");
    expect(appSource.match(/settings-field skills-sync-field/g)).toHaveLength(2);
    expect(supabaseSettings.match(/settings-field skills-sync-field/g)).toHaveLength(2);
    expect(skillsDialogSource).toContain("syncView");
    expect(skillsDialogSource).toContain("onUpload");
    expect(skillsDialogSource).toContain("onInstallRemote");
    expect(skillsDialogSource).toContain("onCopySetupSql");
  });
});
