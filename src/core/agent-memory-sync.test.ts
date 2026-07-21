import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanAgentMemoryDirectory } from "./agent-memory";
import {
  applyPreparedAgentMemorySync,
  loadAgentMemoryEffectiveContext,
  prepareAgentMemorySync,
  undoPreparedAgentMemorySync,
} from "./agent-memory-sync";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createProject(): string {
  const projectPath = mkdtempSync(path.join(os.tmpdir(), "agent-recall-memory-sync-"));
  temporaryRoots.push(projectPath);
  mkdirSync(path.join(projectPath, ".git"));
  mkdirSync(path.join(projectPath, "apps", "web", ".cursor", "rules"), { recursive: true });
  return projectPath;
}

describe("effective Agent memory", () => {
  it("loads the target-specific inherited context in directory order", async () => {
    const projectPath = createProject();
    writeFileSync(path.join(projectPath, "AGENTS.md"), "# Shared root\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "AGENTS.md"), "# Shared apps\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "CLAUDE.md"), "# Claude apps\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "web", ".cursor", "rules", "web.mdc"), "# Cursor web\n", "utf8");
    const snapshot = await scanAgentMemoryDirectory(path.join(projectPath, "apps", "web"));

    const codex = await loadAgentMemoryEffectiveContext(snapshot, "codex");
    const claude = await loadAgentMemoryEffectiveContext(snapshot, "claude");
    const cursor = await loadAgentMemoryEffectiveContext(snapshot, "cursor");

    expect(codex.sources.map((source) => source.relativePath)).toEqual(["AGENTS.md", "apps/AGENTS.md"]);
    expect(codex.content).toContain("<!-- Source: AGENTS.md -->\n# Shared root");
    expect(codex.content.indexOf("# Shared root")).toBeLessThan(codex.content.indexOf("# Shared apps"));
    expect(claude.sources.map((source) => source.relativePath)).toEqual(["apps/CLAUDE.md"]);
    expect(cursor.sources.map((source) => source.relativePath)).toEqual([
      "AGENTS.md",
      "apps/AGENTS.md",
      "apps/web/.cursor/rules/web.mdc",
    ]);
  });
});

describe("Agent memory sync", () => {
  it("previews target paths and line differences without writing", async () => {
    const projectPath = createProject();
    writeFileSync(path.join(projectPath, "AGENTS.md"), "# Shared\n\nUse pnpm.\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "# Old Claude memory\n", "utf8");
    const snapshot = await scanAgentMemoryDirectory(path.join(projectPath, "apps", "web"));

    const prepared = await prepareAgentMemorySync(snapshot, "AGENTS.md", ["claude", "cursor"]);

    expect(prepared.preview.items.map((item) => ({
      target: item.target,
      relativePath: item.relativePath,
      action: item.action,
    }))).toEqual([
      { target: "claude", relativePath: "apps/web/CLAUDE.md", action: "update" },
      { target: "cursor", relativePath: "apps/web/.cursor/rules/agent-recall.mdc", action: "create" },
    ]);
    expect(prepared.preview.items[0]?.diff.some((line) => line.kind === "remove" && line.text.includes("Old Claude"))).toBe(true);
    expect(prepared.preview.items[0]?.diff.some((line) => line.kind === "add" && line.text.includes("Use pnpm"))).toBe(true);
    expect(prepared.preview.items[1]?.diff.some((line) => line.kind === "add" && line.text === "alwaysApply: true")).toBe(true);
    expect(existsSync(path.join(projectPath, "apps", "web", ".cursor", "rules", "agent-recall.mdc"))).toBe(false);
  });

  it("applies a prepared sync and can undo the exact operation", async () => {
    const projectPath = createProject();
    writeFileSync(path.join(projectPath, "AGENTS.md"), "# Shared\n\nUse pnpm.\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "# Old Claude memory\n", "utf8");
    const snapshot = await scanAgentMemoryDirectory(path.join(projectPath, "apps", "web"));
    const prepared = await prepareAgentMemorySync(snapshot, "AGENTS.md", ["claude", "cursor"]);

    const undo = await applyPreparedAgentMemorySync(snapshot.rootPath, prepared);

    expect(readFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "utf8")).toBe("# Shared\n\nUse pnpm.\n");
    expect(readFileSync(path.join(projectPath, "apps", "web", ".cursor", "rules", "agent-recall.mdc"), "utf8")).toContain("# Shared");

    await undoPreparedAgentMemorySync(snapshot.rootPath, undo);

    expect(readFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "utf8")).toBe("# Old Claude memory\n");
    expect(existsSync(path.join(projectPath, "apps", "web", ".cursor", "rules", "agent-recall.mdc"))).toBe(false);
  });

  it("refuses to apply or undo over files changed after the operation was prepared", async () => {
    const projectPath = createProject();
    writeFileSync(path.join(projectPath, "AGENTS.md"), "# Shared\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "# Before\n", "utf8");
    const snapshot = await scanAgentMemoryDirectory(path.join(projectPath, "apps", "web"));
    const stalePreview = await prepareAgentMemorySync(snapshot, "AGENTS.md", ["claude"]);
    writeFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "# Changed outside AgentRecall\n", "utf8");

    await expect(applyPreparedAgentMemorySync(snapshot.rootPath, stalePreview)).rejects.toThrow(/changed since the preview/i);

    const refreshed = await scanAgentMemoryDirectory(path.join(projectPath, "apps", "web"));
    const prepared = await prepareAgentMemorySync(refreshed, "AGENTS.md", ["claude"]);
    const undo = await applyPreparedAgentMemorySync(refreshed.rootPath, prepared);
    writeFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "# New manual edit\n", "utf8");

    await expect(undoPreparedAgentMemorySync(refreshed.rootPath, undo)).rejects.toThrow(/changed after the sync/i);
    expect(readFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "utf8")).toBe("# New manual edit\n");
  });
});
