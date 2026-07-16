import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionSearchResult } from "../../core/types";
import { SessionMigrationDialog } from "./components/session-migration-dialog";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const detailPanelSource = readFileSync(new URL("./features/session-detail/detail-panel.tsx", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("./components/session-migration-dialog.tsx", import.meta.url), "utf8");
const sessionUiSource = readFileSync(new URL("./session-ui.ts", import.meta.url), "utf8");

describe("session migration UI wiring", () => {
  it("wires migration controls through detail panel, context menu, dialog, and progress events", () => {
    const contextMenuSource = appSource.slice(appSource.indexOf("function ContextMenu"));

    expect(detailPanelSource).toContain("onMigrate");
    expect(detailPanelSource).toMatch(/Migrate to/);
    expect(appSource).toContain("<SessionMigrationDialog");
    expect(appSource).toContain("window.sessionSearch.migrateSession");
    expect(appSource).toContain("window.sessionSearch.onMigrationProgress");
    expect(contextMenuSource).toMatch(/Migrate to/);
    expect(sessionUiSource).toContain("Remote session migration is not supported yet");
    expect(dialogSource).toContain("targetSessionId");
    expect(dialogSource).toContain("resumeCommand");
  });

  it("renders a compression progress bar inside the migration dialog", () => {
    expect(appSource).toContain("progress={migrationProgress}");
    expect(dialogSource).toContain("MigrationProgressPanel");
    expect(dialogSource).toContain("migration-progress-bar");
    expect(dialogSource).toContain("migration-progress-fill");
    expect(dialogSource).toContain('role="progressbar"');
  });

  it("renders caller-provided concrete targets instead of a hardcoded family list", () => {
    expect(dialogSource).toContain("targets: readonly MigrationTarget[]");
    expect(dialogSource).toContain("availableTargets.map((target)");
    expect(dialogSource).not.toContain('(["claude", "codex", "codebuddy"] as const)');
    expect(appSource).toContain("targets={migrationTargetsForSession(");
  });

  it("shows an empty state and no target buttons when a remote dialog is opened programmatically", () => {
    const session = {
      source: "claude-cli",
      environmentId: "ssh-dev",
      environmentKind: "ssh",
      displayTitle: "Remote session",
    } as SessionSearchResult;
    const html = renderToStaticMarkup(SessionMigrationDialog({
      session,
      language: "en",
      busy: false,
      targets: ["claude", "codex-internal"],
      onSelect: () => undefined,
      onClose: () => undefined,
    }));

    expect(html).toContain("No migration targets are available for this session.");
    expect(html).not.toContain(">Claude Code</button>");
    expect(html).not.toContain(">Codex Internal</button>");
  });

  it("keeps local target buttons and omits the empty state", () => {
    const session = {
      source: "claude-cli",
      environmentId: "local",
      environmentKind: "local",
      displayTitle: "Local session",
    } as SessionSearchResult;
    const html = renderToStaticMarkup(SessionMigrationDialog({
      session,
      language: "zh",
      busy: false,
      targets: ["tcodex"],
      onSelect: () => undefined,
      onClose: () => undefined,
    }));

    expect(html).toContain(">TCodex</button>");
    expect(html).not.toContain("当前会话没有可用的迁移目标。");
  });

  it("keeps Node-backed platform helpers out of the renderer bundle", () => {
    expect(appSource).toContain('import type { AppSettings, AppSettingsUpdate } from "../../core/platform"');
    expect(appSource).not.toContain("defaultSettings");
    expect(appSource).toContain("DEFAULT_MIGRATION_TARGET_SETTINGS");
  });
});
