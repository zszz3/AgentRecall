import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentMemoryPage } from "./features/agent-memory/agent-memory-page";
import { AgentMemoryEffectiveView } from "./features/agent-memory/agent-memory-effective-view";
import { AgentMemorySyncDialog } from "./features/agent-memory/agent-memory-sync-dialog";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./features/agent-memory/agent-memory-page.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles/agent-memory.css", import.meta.url), "utf8");
const effectiveViewSource = readFileSync(new URL("./features/agent-memory/agent-memory-effective-view.tsx", import.meta.url), "utf8");
const syncDialogSource = readFileSync(new URL("./features/agent-memory/agent-memory-sync-dialog.tsx", import.meta.url), "utf8");

describe("directory Agent memory page", () => {
  it("starts with an explicit directory chooser instead of scanning every indexed project", () => {
    const html = renderToStaticMarkup(createElement(AgentMemoryPage, { language: "zh" }));

    expect(html).toContain("选择目录");
    expect(html).toContain("不会扫描整个项目");
    expect(html).not.toContain("<textarea");
    expect(pageSource).toContain("chooseAgentMemoryDirectory");
    expect(pageSource).not.toContain("listProjects");
  });

  it("exposes refresh, read, create, and save actions for the selected directory context", () => {
    expect(pageSource).toContain("refreshAgentMemories");
    expect(pageSource).toContain("readAgentMemory");
    expect(pageSource).toContain("createAgentMemory");
    expect(pageSource).toContain("saveAgentMemory");
    expect(pageSource).toContain("snapshot.directories.map");
    expect(pageSource).toContain("inherited");
  });

  it("adds Memory to the primary navigation and keeps the inheritance rail compact", () => {
    expect(appSource).toContain('data-page="memories"');
    expect(appSource).toContain("<AgentMemoryPage");
    expect(stylesheet).toMatch(/\.agent-memory-layout\s*\{[^}]*grid-template-columns:\s*minmax\(240px,\s*300px\)\s+minmax\(0,\s*1fr\)/s);
    expect(stylesheet).toContain(".agent-memory-scope::before");
  });

  it("renders the effective context with target selection and source attribution", () => {
    const html = renderToStaticMarkup(createElement(AgentMemoryEffectiveView, {
      language: "zh",
      target: "cursor",
      context: {
        target: "cursor",
        sources: [{
          relativePath: "AGENTS.md",
          scopeDirectory: "",
          name: "AGENTS.md",
          kind: "agents",
          size: 8,
          modifiedAt: 1,
          content: "# Shared",
        }],
        content: "<!-- Source: AGENTS.md -->\n# Shared",
      },
      loading: false,
      onTargetChange: () => undefined,
    }));

    expect(html).toContain("最终生效内容");
    expect(html).toContain("AGENTS.md");
    expect(html).toContain("# Shared");
    expect(effectiveViewSource).toContain('(["codex", "claude", "cursor"]');
  });

  it("renders a reviewable sync diff before applying changes", () => {
    const html = renderToStaticMarkup(createElement(AgentMemorySyncDialog, {
      language: "zh",
      sourcePath: "AGENTS.md",
      targets: ["claude"],
      preview: {
        id: "preview-1",
        sourceRelativePath: "AGENTS.md",
        items: [{
          target: "claude",
          relativePath: "apps/web/CLAUDE.md",
          action: "update",
          diff: [
            { kind: "remove", text: "old rule", oldLine: 1, newLine: null },
            { kind: "add", text: "new rule", oldLine: null, newLine: 1 },
          ],
        }],
      },
      busy: null,
      error: null,
      onToggleTarget: () => undefined,
      onPreview: () => undefined,
      onApply: () => undefined,
      onClose: () => undefined,
    }));

    expect(html).toContain("确认同步差异");
    expect(html).toContain("apps/web/CLAUDE.md");
    expect(html).toContain("old rule");
    expect(html).toContain("new rule");
    expect(syncDialogSource).toContain("应用同步");
  });

  it("wires effective context, sync preview, apply, and undo through the preload API", () => {
    expect(pageSource).toContain("getAgentMemoryEffectiveContext");
    expect(pageSource).toContain("previewAgentMemorySync");
    expect(pageSource).toContain("applyAgentMemorySync");
    expect(pageSource).toContain("undoAgentMemorySync");
  });
});
