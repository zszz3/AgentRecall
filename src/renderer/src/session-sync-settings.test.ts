import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const settingsSource = fs.readFileSync(
  path.resolve("src", "renderer", "src", "features", "settings", "settings-dialog.tsx"),
  "utf8",
);

describe("remote session sync settings", () => {
  it("places the feature toggle before the dependent connection settings", () => {
    const section = settingsSource.slice(settingsSource.indexOf('{activeSection === "remote" ? ('), settingsSource.indexOf('{activeSection === "skills" ? ('));
    expect(section.indexOf("remoteSyncEnabled")).toBeGreaterThan(-1);
    expect(section.indexOf("remoteSyncEnabled")).toBeLessThan(section.indexOf("remoteSyncSupabaseUrl"));
    expect(section).toContain("settings?.remoteSyncEnabled ? (");
    expect(section).toContain('l("Sync session attachments", "同步会话附件")');
    expect(section).toContain("settings.syncSessionAttachments !== false");
  });

  it("shows install and remove controls only inside the enabled session section", () => {
    const section = settingsSource.slice(settingsSource.indexOf('{activeSection === "remote" ? ('), settingsSource.indexOf('{activeSection === "skills" ? ('));
    expect(section).toContain('l("Automatic session sync", "会话自动同步")');
    expect(section).toContain('l("Install Hook", "安装 Hook")');
    expect(section).toContain('l("Remove Hook", "移除 Hook")');
    expect(section).toContain("onSessionHookChange");
  });

  it("keeps Skill sync on its own settings and enable switch", () => {
    const section = settingsSource.slice(settingsSource.indexOf('activeSection === "skills"'));
    expect(section).toContain("skillSyncSupabaseUrl");
    expect(section).toContain("skillSyncEnabled");
  });
});
