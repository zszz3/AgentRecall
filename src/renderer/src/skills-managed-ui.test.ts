import { createElement } from "react";
import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ManagedSkill } from "../../core/managed-skill-library";
import type { SkillSyncSnapshot } from "../../core/skill-sync";
import { SkillsPage } from "./features/skills/skills-page";

const pageStyles = readFileSync(new URL("./styles/skills-page.css", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./features/skills/skills-page.tsx", import.meta.url), "utf8");
const discoveryDialogSource = readFileSync(new URL("./features/skills/skill-discovery-dialog.tsx", import.meta.url), "utf8");
const localSkillsTabUrl = new URL("./features/skills/local-skills-tab.tsx", import.meta.url);

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
  it("separates app-managed and local Skills into first-level tabs", () => {
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

    expect(html).toContain('role="tablist"');
    expect(html).toContain("本 App Skill");
    expect(html).toContain("本地 Skill");
    expect(html).toContain("发现 Skill");
    expect(html).toContain("使用 12 次");
    expect(html).toContain("Codex");
    expect(html).toContain("Claude Code");
    expect(html).not.toContain("导入本机 Skill");
    expect(html).not.toContain("Codex 1 · Claude Code 0");
  });

  it("uses a dense two-column workspace with independent scrolling and responsive collapse", () => {
    expect(pageStyles).toMatch(/\.managed-skills-grid\s*\{[^}]*grid-template-columns:\s*minmax\(260px,\s*340px\)\s+minmax\(0,\s*1fr\)/s);
    expect(pageStyles).toMatch(/\.skill-library-scroll\s*\{[^}]*overflow:\s*auto/s);
    expect(pageStyles).toMatch(/\.skill-library-detail\s*\{[^}]*overflow:\s*auto/s);
    expect(pageStyles).toContain(".managed-skill-target-options");
    expect(pageStyles).toContain("@media (max-width: 820px)");
    expect(pageStyles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps discovery independent while local Skills live inside their own tab", () => {
    expect(pageSource).toContain('role="tablist"');
    expect(pageSource).toContain('role="tab"');
    expect(pageSource).toContain("<LocalSkillsTab");
    expect(pageSource).not.toContain("SkillImportDialog");
    expect(pageStyles).toMatch(/\.managed-skills-toolbar-actions button\s*\{[^}]*white-space:\s*nowrap/s);
    expect(pageStyles).toMatch(/\.skill-library-tabs\s*\{[^}]*display:\s*flex/s);
    expect(pageStyles).toMatch(/\.skill-library-tab\.active\s*\{[^}]*color:\s*var\(--text\)/s);
  });

  it("lets the local tab search, preview, and explicitly add selected Skills to the app", () => {
    expect(existsSync(localSkillsTabUrl)).toBe(true);
    if (!existsSync(localSkillsTabUrl)) return;
    const localTabSource = readFileSync(localSkillsTabUrl, "utf8");
    expect(localTabSource).toContain("listSkillImportCandidates");
    expect(localTabSource).toContain("filterInstalledSkills");
    expect(localTabSource).toContain("importLocalSkills");
    expect(localTabSource).toContain('useState<SkillSortKey>("usage")');
    expect(localTabSource).toContain('l("Add to this app", "加入本 App")');
    expect(localTabSource).toContain("managedSourcePaths.has(skill.directoryPath)");
  });

  it("keeps local Skill tab switches responsive after the first scan", () => {
    expect(existsSync(localSkillsTabUrl)).toBe(true);
    if (!existsSync(localSkillsTabUrl)) return;
    const localTabSource = readFileSync(localSkillsTabUrl, "utf8");
    expect(localTabSource).toContain("loadedRequestKey.current === requestKey");
    expect(localTabSource).toContain("listSkillImportCandidates(refreshVersion > 0 || reloadVersion > 0)");
    expect(localTabSource).toContain("LOCAL_SKILL_RENDER_BATCH");
    expect(localTabSource).toContain("filteredSkills.slice(0, visibleCount)");
    expect(localTabSource).toContain("onScroll={showMoreSkillsNearBottom}");
  });

  it("keys local Skill rows by path so duplicate catalog identities remain distinct", () => {
    expect(existsSync(localSkillsTabUrl)).toBe(true);
    if (!existsSync(localSkillsTabUrl)) return;
    const localTabSource = readFileSync(localSkillsTabUrl, "utf8");
    expect(localTabSource).toContain("key={skill.path}");
    expect(localTabSource).not.toContain("key={skill.id}");
  });

  it("adds one-shot AI search to discovery without hiding keyword search", () => {
    expect(discoveryDialogSource).toContain("aiSearchDiscoveredSkills");
    expect(discoveryDialogSource).toContain('className="skill-discovery-ai-action"');
    expect(discoveryDialogSource).toContain('className="skill-discovery-ai-insight"');
    expect(discoveryDialogSource).toContain('l("AI search", "AI 搜索")');
    expect(discoveryDialogSource).toContain("aiResult.queries.map");
    expect(pageStyles).toMatch(/\.skill-discovery-search\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+auto/s);
    expect(pageStyles).toMatch(/\.skill-discovery-ai-action\s*\{[^}]*background:\s*var\(--accent-soft\)[^}]*color:\s*var\(--accent-bright\)/s);
  });
});
