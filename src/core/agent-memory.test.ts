import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentMemoryFile,
  readAgentMemoryFile,
  scanAgentMemoryDirectory,
  saveAgentMemoryFile,
} from "./agent-memory";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createProject(): string {
  const projectPath = mkdtempSync(path.join(os.tmpdir(), "agent-recall-memory-"));
  temporaryRoots.push(projectPath);
  return projectPath;
}

describe("Agent memory discovery", () => {
  it("only inspects the selected directory and its ancestors up to the Git root", async () => {
    const projectPath = createProject();
    mkdirSync(path.join(projectPath, ".git"));
    mkdirSync(path.join(projectPath, "apps", "web", ".cursor", "rules"), { recursive: true });
    mkdirSync(path.join(projectPath, "apps", "web", "components"), { recursive: true });
    mkdirSync(path.join(projectPath, "apps", "api"), { recursive: true });
    writeFileSync(path.join(projectPath, "AGENTS.md"), "# Root\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "CLAUDE.md"), "# Apps\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "web", ".cursor", "rules", "ui.mdc"), "# UI\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "web", "components", "CLAUDE.md"), "# Child\n", "utf8");
    writeFileSync(path.join(projectPath, "apps", "api", "AGENTS.md"), "# Sibling\n", "utf8");

    const snapshot = await scanAgentMemoryDirectory(path.join(projectPath, "apps", "web"));

    expect(snapshot.rootPath).toBe(realpathSync(projectPath));
    expect(snapshot.selectedDirectoryPath).toBe(realpathSync(path.join(projectPath, "apps", "web")));
    expect(snapshot.selectedDirectory).toBe("apps/web");
    expect(snapshot.files.map((file) => ({
      relativePath: file.relativePath,
      scopeDirectory: file.scopeDirectory,
      kind: file.kind,
    }))).toEqual([
      { relativePath: "AGENTS.md", scopeDirectory: "", kind: "agents" },
      { relativePath: "apps/CLAUDE.md", scopeDirectory: "apps", kind: "claude" },
      { relativePath: "apps/web/.cursor/rules/ui.mdc", scopeDirectory: "apps/web", kind: "cursor" },
    ]);
    expect(snapshot.directories).toEqual(["", "apps", "apps/web"]);
  });

  it("returns the effective inherited stack for the selected directory", async () => {
    const projectPath = createProject();
    mkdirSync(path.join(projectPath, ".git"));
    mkdirSync(path.join(projectPath, "apps", "web", "components"), { recursive: true });
    writeFileSync(path.join(projectPath, "AGENTS.md"), "root", "utf8");
    writeFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "web", "utf8");
    writeFileSync(path.join(projectPath, "apps", "web", "components", "AGENTS.md"), "components", "utf8");

    const snapshot = await scanAgentMemoryDirectory(path.join(projectPath, "apps", "web", "components"));

    expect(snapshot.files.map((file) => file.relativePath)).toEqual([
      "AGENTS.md",
      "apps/web/CLAUDE.md",
      "apps/web/components/AGENTS.md",
    ]);
  });

  it("treats a selected non-Git directory as its own root", async () => {
    const parentPath = createProject();
    const selectedPath = path.join(parentPath, "standalone");
    mkdirSync(selectedPath);
    writeFileSync(path.join(parentPath, "AGENTS.md"), "parent", "utf8");
    writeFileSync(path.join(selectedPath, "CLAUDE.md"), "selected", "utf8");

    const snapshot = await scanAgentMemoryDirectory(selectedPath);

    expect(snapshot.rootPath).toBe(realpathSync(selectedPath));
    expect(snapshot.selectedDirectory).toBe("");
    expect(snapshot.files.map((file) => file.relativePath)).toEqual(["CLAUDE.md"]);
  });
});

describe("Agent memory editing", () => {
  it("creates and saves supported memory files inside existing project directories", async () => {
    const projectPath = createProject();
    mkdirSync(path.join(projectPath, "apps", "web"), { recursive: true });

    const created = await createAgentMemoryFile(projectPath, {
      directory: "apps\\web",
      kind: "claude",
    });
    expect(created.relativePath).toBe("apps/web/CLAUDE.md");
    expect((await readAgentMemoryFile(projectPath, created.relativePath)).content).toContain("Claude Code");

    const saved = await saveAgentMemoryFile(projectPath, created.relativePath, "# Web memory\n\nUse pnpm.\n");
    expect(saved.content).toBe("# Web memory\n\nUse pnpm.\n");
    expect(readFileSync(path.join(projectPath, "apps", "web", "CLAUDE.md"), "utf8")).toBe(saved.content);

    const cursor = await createAgentMemoryFile(projectPath, {
      directory: "apps/web",
      kind: "cursor",
      fileName: "frontend",
    });
    expect(cursor.relativePath).toBe("apps/web/.cursor/rules/frontend.mdc");
    expect(existsSync(path.join(projectPath, "apps", "web", ".cursor", "rules", "frontend.mdc"))).toBe(true);
  });

  it("does not overwrite an existing file through create", async () => {
    const projectPath = createProject();
    writeFileSync(path.join(projectPath, "AGENTS.md"), "keep me", "utf8");

    await expect(createAgentMemoryFile(projectPath, { directory: "", kind: "agents" })).rejects.toThrow(/already exists/i);
    expect(readFileSync(path.join(projectPath, "AGENTS.md"), "utf8")).toBe("keep me");
  });

  it("rejects traversal, unsupported files, Windows absolute paths, and symlink escapes", async () => {
    const projectPath = createProject();
    const outsidePath = createProject();
    mkdirSync(path.join(projectPath, "docs"), { recursive: true });
    symlinkSync(outsidePath, path.join(projectPath, "linked"), "dir");

    await expect(createAgentMemoryFile(projectPath, { directory: "..\\outside", kind: "agents" })).rejects.toThrow(/inside the project/i);
    await expect(createAgentMemoryFile(projectPath, { directory: "C:\\Users\\person", kind: "agents" })).rejects.toThrow(/relative/i);
    await expect(saveAgentMemoryFile(projectPath, "docs/README.md", "unsafe")).rejects.toThrow(/supported Agent memory/i);
    await expect(createAgentMemoryFile(projectPath, { directory: "linked", kind: "agents" })).rejects.toThrow(/inside the project/i);
    expect(existsSync(path.join(outsidePath, "AGENTS.md"))).toBe(false);
  });
});
