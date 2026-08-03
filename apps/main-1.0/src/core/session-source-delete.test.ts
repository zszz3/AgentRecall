import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteLocalSessionSources, sessionSourceDeletionPaths } from "./session-source-delete";

describe("session source deletion", () => {
  it("rejects relative source paths before deleting anything", () => {
    expect(() => sessionSourceDeletionPaths([{
      source: "codex-cli",
      rawId: "relative",
      filePath: "sessions/relative.jsonl",
      isSubagent: false,
    }])).toThrow("Session source file path must be absolute.");
  });

  it("deletes Claude subagent files and owned companion directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-session-tree-delete-"));
    const parentId = "parent-session";
    const parentFile = path.join(root, `${parentId}.jsonl`);
    const sessionDirectory = path.join(root, parentId);
    const subagentsDirectory = path.join(sessionDirectory, "subagents");
    const toolResultsDirectory = path.join(sessionDirectory, "tool-results");
    const childFile = path.join(subagentsDirectory, "agent-child.jsonl");
    const childMetadata = path.join(subagentsDirectory, "agent-child.meta.json");
    const unrelatedFile = path.join(sessionDirectory, "keep.txt");
    fs.mkdirSync(subagentsDirectory, { recursive: true });
    fs.mkdirSync(toolResultsDirectory, { recursive: true });
    for (const filePath of [parentFile, childFile, childMetadata, unrelatedFile]) {
      fs.writeFileSync(filePath, "fixture", "utf8");
    }

    try {
      deleteLocalSessionSources([
        { source: "claude-cli", rawId: parentId, filePath: parentFile, isSubagent: false },
        { source: "claude-cli", rawId: "child", filePath: childFile, isSubagent: true },
      ]);

      expect(fs.existsSync(parentFile)).toBe(false);
      expect(fs.existsSync(subagentsDirectory)).toBe(false);
      expect(fs.existsSync(toolResultsDirectory)).toBe(false);
      expect(fs.existsSync(unrelatedFile)).toBe(true);
      expect(fs.existsSync(sessionDirectory)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the same owned artifacts for Windows paths", () => {
    expect(sessionSourceDeletionPaths([
      {
        source: "claude-cli",
        rawId: "parent-session",
        filePath: "C:\\Users\\me\\.claude\\projects\\repo\\parent-session.jsonl",
        isSubagent: false,
      },
    ], path.win32)).toEqual({
      files: ["C:\\Users\\me\\.claude\\projects\\repo\\parent-session.jsonl"],
      directories: [
        "C:\\Users\\me\\.claude\\projects\\repo\\parent-session\\subagents",
        "C:\\Users\\me\\.claude\\projects\\repo\\parent-session\\tool-results",
      ],
      emptyDirectories: ["C:\\Users\\me\\.claude\\projects\\repo\\parent-session"],
      requiredAbsentFiles: [],
    });
    expect(sessionSourceDeletionPaths([{
      source: "claude-cli",
      rawId: "child",
      filePath: "C:\\Users\\me\\.claude\\projects\\repo\\missing-parent\\subagents\\agent-child.jsonl",
      isSubagent: true,
      orphanedParentSessionId: "missing-parent",
    }], path.win32).requiredAbsentFiles).toEqual([
      "C:\\Users\\me\\.claude\\projects\\repo\\missing-parent.jsonl",
    ]);
  });

  it("removes the complete artifact directory for an orphaned Claude family", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-orphan-tree-delete-"));
    const sessionDirectory = path.join(root, "missing-parent");
    const subagentsDirectory = path.join(sessionDirectory, "subagents");
    const toolResultsDirectory = path.join(sessionDirectory, "tool-results");
    const childFile = path.join(subagentsDirectory, "agent-child.jsonl");
    const siblingFile = path.join(subagentsDirectory, "agent-sibling.jsonl");
    const unrelatedFile = path.join(sessionDirectory, "keep.txt");
    fs.mkdirSync(subagentsDirectory, { recursive: true });
    fs.mkdirSync(toolResultsDirectory, { recursive: true });
    for (const filePath of [childFile, siblingFile, path.join(toolResultsDirectory, "tool.txt"), unrelatedFile]) {
      fs.writeFileSync(filePath, "fixture", "utf8");
    }

    try {
      deleteLocalSessionSources([{
        source: "claude-cli",
        rawId: "child",
        filePath: childFile,
        isSubagent: true,
        orphanedParentSessionId: "missing-parent",
      }]);

      expect(fs.existsSync(subagentsDirectory)).toBe(false);
      expect(fs.existsSync(toolResultsDirectory)).toBe(false);
      expect(fs.existsSync(unrelatedFile)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates every path before deleting any source file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-atomic-source-delete-"));
    const validFile = path.join(root, "valid.jsonl");
    const invalidDirectory = path.join(root, "invalid.jsonl");
    fs.writeFileSync(validFile, "fixture", "utf8");
    fs.mkdirSync(invalidDirectory);

    try {
      expect(() => deleteLocalSessionSources([
        { source: "codex-cli", rawId: "valid", filePath: validFile, isSubagent: false },
        { source: "codex-cli", rawId: "invalid", filePath: invalidDirectory, isSubagent: false },
      ])).toThrow("Refusing to delete a directory as a session file.");
      expect(fs.existsSync(validFile)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an orphan candidate untouched when its parent source still exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-orphan-parent-guard-"));
    const parentId = "missing-from-index";
    const parentFile = path.join(root, `${parentId}.jsonl`);
    const sessionDirectory = path.join(root, parentId);
    const subagentsDirectory = path.join(sessionDirectory, "subagents");
    const childFile = path.join(subagentsDirectory, "agent-child.jsonl");
    fs.mkdirSync(subagentsDirectory, { recursive: true });
    fs.writeFileSync(parentFile, "parent", "utf8");
    fs.writeFileSync(childFile, "child", "utf8");

    try {
      expect(() => deleteLocalSessionSources([{
        source: "claude-cli",
        rawId: "child",
        filePath: childFile,
        isSubagent: true,
        orphanedParentSessionId: parentId,
      }])).toThrow("parent session source still exists");
      expect(fs.existsSync(parentFile)).toBe(true);
      expect(fs.existsSync(childFile)).toBe(true);
      expect(fs.existsSync(subagentsDirectory)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
