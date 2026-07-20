import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const guideSource = readFileSync(new URL("./components/supabase-setup-guide.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./features/settings/settings-dialog.tsx", import.meta.url), "utf8");
const skillsSource = readFileSync(new URL("./features/skills/skills-page.tsx", import.meta.url), "utf8");
const skillSyncSource = readFileSync(new URL("./features/skills/skill-sync-panel.tsx", import.meta.url), "utf8");
const sessionsSource = readFileSync(new URL("./features/remote-sessions/remote-sessions-dialog.tsx", import.meta.url), "utf8");

describe("Supabase setup guidance", () => {
  it("shows the same copy, editor, and refresh workflow everywhere", () => {
    expect(guideSource).toContain('l("Copy latest SQL", "复制最新 SQL")');
    expect(guideSource).toContain('l("Open SQL Editor", "打开 SQL Editor")');
    expect(guideSource).toContain('l("Refresh", "刷新")');
    expect(guideSource).toContain("Run the SQL, then refresh");
  });

  it("offers combined first-time setup and targeted repair actions", () => {
    expect(settingsSource).toContain("copyCombinedSyncSetupSql");
    expect(`${appSource}\n${settingsSource}`).toContain("openSupabaseSqlEditor");
    expect(skillSyncSource).toContain("SupabaseSetupGuide");
    expect(sessionsSource).toContain("SupabaseSetupGuide");
  });

  it("shows SQL actions only for SQL-remediable sync failures", () => {
    expect(guideSource).toContain("showSqlActions = true");
    expect(guideSource).toContain("{showSqlActions ? (");
    expect(skillSyncSource).toContain('showSqlActions={snapshot.status.remediation === "sql"}');
    expect(sessionsSource).toContain('showSqlActions={status.remediation === "sql"}');
  });

  it("directs authentication failures to Supabase settings instead of SQL", () => {
    expect(skillSyncSource).toContain("Check the Supabase URL and anon key in Settings, then refresh.");
    expect(sessionsSource).toContain("Check the Supabase URL and anon key in Remote sync settings, then refresh.");
  });
});
