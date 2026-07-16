import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionSyncItem } from "../../core/remote-session-sync";
import type { SessionSearchResult } from "../../core/types";
import { primarySessionAction, sessionCopySummary } from "./features/remote-sessions/remote-sessions-dialog";

const source = readFileSync(new URL("./features/remote-sessions/remote-sessions-dialog.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const local: SessionSearchResult = {
  sessionKey: "codex:local",
  rawId: "local",
  source: "codex-cli",
  projectPath: "/repo",
  filePath: "/tmp/local.jsonl",
  originalTitle: "Sync UX",
  firstQuestion: "Sync UX",
  timestamp: 100,
  fileMtimeMs: 200,
  fileSize: 10,
  prUrl: null,
  prNumber: null,
  gitBranch: "main",
  environmentId: "local",
  environmentKind: "local",
  environmentLabel: "Local",
  tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
  customTitle: null,
  displayTitle: "Sync UX",
  favorited: false,
  pinned: false,
  hidden: false,
  tags: [],
  matchSnippet: null,
  lastOpenedAt: null,
  lastResumedAt: null,
  lastActivityAt: 4_000,
  messageCount: 41,
  aiSummary: null,
  aiSummaryStale: false,
};

function item(state: SessionSyncItem["state"], sides: { local?: boolean; remote?: boolean } = { local: true, remote: true }): SessionSyncItem {
  return {
    id: state,
    state,
    local: sides.local === false ? null : local,
    remote: sides.remote === false ? null : {
      id: "remote",
      sourceSessionKey: "codex:local",
      sourceAgent: "codex",
      sourceSource: "codex-cli",
      sourceEnvironmentId: "local",
      sourceEnvironmentKind: "local",
      sourceEnvironmentLabel: "Local",
      title: "Sync UX",
      projectPath: "/repo",
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: 2_000,
      contentHash: "remote",
      messageCount: 39,
      traceEventCount: 0,
      aiSummary: null,
      tags: [],
      searchText: "",
      detailObjectKey: "detail",
      portableObjectKey: "portable",
      detailSha256: "detail",
      portableSha256: "portable",
      createdAt: 1_000,
      syncedAt: 3_000,
    },
    localRevision: "local",
    remoteRevision: "remote",
    lastSyncedAt: 3_000,
  };
}

describe("remote session comparison cards", () => {
  it("chooses exactly one primary action for every sync state", () => {
    expect(primarySessionAction(item("local-only", { remote: false }))).toBe("upload");
    expect(primarySessionAction(item("local-newer"))).toBe("upload");
    expect(primarySessionAction(item("synced"))).toBe("view");
    expect(primarySessionAction(item("remote-newer"))).toBe("restore");
    expect(primarySessionAction(item("remote-only", { local: false }))).toBe("restore");
    expect(primarySessionAction(item("conflict"))).toBe("resolve");
  });

  it("keeps local and cloud metrics separate", () => {
    expect(sessionCopySummary(item("local-newer"), "local")).toMatchObject({ present: true, updatedAt: 4_000, messageCount: 41 });
    expect(sessionCopySummary(item("local-newer"), "remote")).toMatchObject({ present: true, updatedAt: 2_000, messageCount: 39, syncedAt: 3_000 });
    expect(sessionCopySummary(item("local-only", { remote: false }), "remote")).toEqual({ present: false, missing: "not-uploaded" });
    expect(sessionCopySummary(item("remote-only", { local: false }), "local")).toEqual({ present: false, missing: "no-local-copy" });
  });

  it("renders compact comparisons, keeps View visible, and aligns branch tags", () => {
    expect(source).toContain('className="remote-session-comparison"');
    expect(source).toContain('className={`remote-copy ${isLocal ? "local" : "cloud"}`}');
    expect(source).toContain("remote-session-primary-action");
    expect(source).toContain("remote-session-view-action");
    expect(source).toContain('remote && item.state !== "conflict"');
    expect(source).toContain('l("Restore", "恢复")');
    expect(source).toContain('remote ? l("Update", "更新") : l("Upload", "上传")');
    expect(source).toContain('remote ? "" : "cloud-empty"');
    expect(source).toContain("Number.isFinite(summary.updatedAt)");
    expect(source).toContain('className="remote-session-tags"');
    expect(source).toContain("MoreHorizontal");
    expect(source).toContain("Resolve conflict");
    expect(stylesheet).toMatch(/\.remote-session-comparison\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
    expect(stylesheet).toMatch(/\.remote-copy\s*\{[^}]*display:\s*flex/);
    expect(stylesheet).toMatch(/\.remote-session-row\s*\{[^}]*grid-template-columns:\s*20px minmax\(0, 1fr\) 280px/);
    expect(stylesheet).toMatch(/\.settings-feedback\.inline\.remote-session-feedback\s*\{[^}]*flex:\s*0 0 auto/);
    expect(stylesheet).toMatch(/\.remote-session-action\.primary\s*\{[^}]*width:\s*auto/);
    expect(stylesheet).toMatch(/\.remote-session-actions\.cloud-empty\s*\{[^}]*justify-content:\s*center/);
  });

  it("uses balanced, dialog-specific controls for restoring a remote session", () => {
    const restoreDialog = source.slice(
      source.indexOf("function RemoteRestoreDialog"),
      source.indexOf("function DeleteRemoteSessionsDialog"),
    );

    expect(restoreDialog).toContain('className="remote-restore-session-summary"');
    expect(restoreDialog).toContain('className="remote-restore-targets"');
    expect(restoreDialog).toContain('aria-pressed={target === item}');
    expect(restoreDialog).toContain('className="remote-restore-destination remote-project-picker"');
    expect(restoreDialog).toContain('className="primary-action"');
    expect(restoreDialog).not.toContain('className="remote-targets"');
    expect(restoreDialog).not.toContain('className="primary"');
    expect(stylesheet).toMatch(/\.remote-restore-targets\s*\{[^}]*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/);
    expect(stylesheet).toMatch(/\.remote-restore-destination\s*\{[^}]*height:\s*40px/);
  });
});
