import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./features/settings/settings-dialog.tsx", import.meta.url), "utf8");
const updateUiSource = `${appSource}\n${settingsSource}`;
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("application update UI", () => {
  it("shows an update indicator and a dedicated About settings section", () => {
    expect(updateUiSource).toContain('activeSection === "about"');
    expect(updateUiSource).toContain('className="update-release-card"');
    expect(updateUiSource).toContain('className="update-primary-button"');
    expect(updateUiSource).toContain('className="update-secondary-button"');
    expect(updateUiSource).toContain('onSkipAppUpdate(false)');
    expect(updateUiSource).toContain('onSkipAppUpdate(true)');
    expect(updateUiSource).toContain("!appUpdateStatus.updateSkipped && !appUpdateStatus.promptSnoozed");
    expect(updateUiSource).toContain(") : shouldSignalAppUpdate && appUpdateStatus?.manifest ? (");
    expect(updateUiSource).toContain("Update prompt skipped");
    expect(updateUiSource).toContain("Use Check for updates to show the skipped release again.");
    expect(updateUiSource).toContain('className="update-indicator"');
    expect(updateUiSource).toContain('className="update-brand-mark"');
    expect(updateUiSource).toContain('className="update-state-copy"');
    expect(updateUiSource).toContain('className="update-available-card"');
    expect(updateUiSource).toContain('className={`update-release-section ${kind}`}');
    expect(updateUiSource).toContain("appUpdateStatus.manifest.notes.features");
    expect(updateUiSource).toContain("appUpdateStatus.manifest.notes.fixes");
    expect(updateUiSource).not.toContain("<h4>{appUpdateStatus.manifest.title}</h4>");
  });

  it("keeps the About page readable and scrolls long release notes", () => {
    const card = stylesheet.match(/\.update-release-card\s*\{[^}]*\}/)?.[0] ?? "";
    expect(card).toMatch(/max-height:\s*280px/);
    expect(card).toMatch(/overflow-y:\s*auto/);
    expect(settingsSource).toContain("content.scrollTop = 0");
    expect(settingsSource).toContain("window.requestAnimationFrame");
  });

  it("labels development builds without presenting release actions", () => {
    expect(settingsSource).toContain("appUpdateStatus?.developmentBuild");
    expect(settingsSource).toContain('l("Development build", "开发版本")');
    expect(settingsSource).toContain('l("Release updates are disabled while running from source.", "从源码运行时不检查或安装正式版本更新。")');
  });
});
