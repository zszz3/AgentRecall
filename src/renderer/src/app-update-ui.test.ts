import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("./features/settings/settings-dialog.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("application update UI", () => {
  it("keeps a minimal About entry without starting the legacy update UI", () => {
    expect(appSource).toContain('setInfoSection("about")');
    expect(appSource).toContain("<h2>AgentRecall 1.0</h2>");
    expect(appSource).not.toContain("getAppUpdateStatus");
    expect(appSource).not.toContain("installAppUpdate");
    expect(appSource).not.toContain('className="update-indicator"');
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
