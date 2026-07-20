import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ManagedSkill } from "../../core/managed-skill-library";
import type { SkillSyncSnapshot } from "../../core/skill-sync";
import { SkillsPage } from "./features/skills/skills-page";

const pageStyles = readFileSync(new URL("./styles/skills-page.css", import.meta.url), "utf8");

function managedSkill(overrides: Partial<ManagedSkill> = {}): ManagedSkill {
  return {
    id: "agent-recall:/library/review/SKILL.md",
    managedId: "review",
    name: "review",
    description: "Review code changes",
    agent: "codex",
    source: "agent-recall",
    path: "/library/review/SKILL.md",
    directoryPath: "/library/review",
    rootPath: "/library",
    markdown: "# Review\n",
    mtimeMs: 100,
    usageCount: 12,
    lastUsedAt: 99,
    origin: { kind: "local", label: "Codex" },
    installations: [
      { target: "codex", path: "/home/.codex/skills/review", state: "installed" },
      { target: "claude", path: "/home/.claude/skills/review", state: "not-installed" },
      { target: "trae", path: "/home/.trae/skills/review", state: "not-installed" },
    ],
    ...overrides,
  };
}

const syncSnapshot: SkillSyncSnapshot = {
  status: { kind: "ready", setupSql: "" },
  remoteSkillGroups: [],
  bindings: [],
  relations: [{
    identity: "agent-recall/review",
    localSkillPath: "/library/review/SKILL.md",
    localContentHash: "local",
    remoteFingerprint: null,
    remoteLatestId: null,
    remoteContentHash: "",
    state: "local-only",
  }],
  scannedAt: 100,
};

describe("managed Skills page", () => {
  it("centers the installed AgentRecall library and keeps discovery secondary", () => {
    const html = renderToStaticMarkup(createElement(SkillsPage, {
      snapshot: { skills: [managedSkill()], roots: [], scannedAt: 100 },
      syncSnapshot,
      loading: false,
      feedback: null,
      language: "zh" as const,
      revealLabel: "Finder",
      onRefresh: () => undefined,
      onUpload: async () => null,
      onUploadSelected: async () => ({ remainingSkillIds: [] }),
      onInstallRemote: async () => undefined,
      onFetchVersion: async () => { throw new Error("not used"); },
      onRefreshRemote: () => undefined,
      onCopySetupSql: () => undefined,
      onOpenSqlEditor: () => undefined,
      onCopyPath: () => undefined,
      onReveal: () => undefined,
      onDelete: async () => undefined,
    }));

    expect(html).toContain("Skill 库");
    expect(html).toContain("导入本机 Skill");
    expect(html).toContain("发现 Skill");
    expect(html).toContain("使用 12 次");
    expect(html).toContain("Codex");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Trae");
    expect(html).not.toContain("Codex 1 · Claude Code 0");
  });

  it("uses a dense two-column workspace with independent scrolling and responsive collapse", () => {
    expect(pageStyles).toMatch(/\.managed-skills-grid\s*\{[^}]*grid-template-columns:\s*minmax\(260px,\s*340px\)\s+minmax\(0,\s*1fr\)/s);
    expect(pageStyles).toMatch(/\.skill-library-scroll\s*\{[^}]*overflow:\s*auto/s);
    expect(pageStyles).toMatch(/\.skill-library-detail\s*\{[^}]*overflow:\s*auto/s);
    expect(pageStyles).toContain(".managed-skill-targets");
    expect(pageStyles).toContain("@media (max-width: 820px)");
    expect(pageStyles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
