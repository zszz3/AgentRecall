import { describe, expect, it } from "vitest";

import { libraryFileTargets, parseLibraryFile, renderLibraryFile } from "./library-files";

const targets = (kind: "commands" | "subagents") => libraryFileTargets(kind, "/home/u", {});
const target = (kind: "commands" | "subagents", id: string) => targets(kind).find((item) => item.id === id)!;
const review = { description: "Review the diff: \"strict\"", body: "Review $ARGUMENTS and list risks." };

describe("library file targets", () => {
  it("names each agent's folder for slash commands and subagents", () => {
    expect(targets("commands").map((item) => [item.id, item.directory, item.extension])).toEqual([
      ["claude-code", "/home/u/.claude/commands", ".md"],
      ["gemini", "/home/u/.gemini/commands", ".toml"],
      ["opencode", "/home/u/.config/opencode/commands", ".md"],
      ["pi", "/home/u/.pi/agent/prompts", ".md"],
      ["stepcode", "/home/u/.stepcode/agent/prompts", ".md"],
      ["qwen", "/home/u/.qwen/commands", ".md"],
    ]);
    expect(targets("subagents").map((item) => [item.id, item.directory, item.extension])).toEqual([
      ["claude-code", "/home/u/.claude/agents", ".md"],
      ["codex", "/home/u/.codex/agents", ".toml"],
      ["gemini", "/home/u/.gemini/agents", ".md"],
      ["opencode", "/home/u/.config/opencode/agents", ".md"],
      ["qwen", "/home/u/.qwen/agents", ".md"],
      ["cursor", "/home/u/.cursor/agents", ".md"],
    ]);
  });

  it("writes each agent's format and reads it back", () => {
    expect(renderLibraryFile(target("commands", "claude-code"), "review", review)).toBe(
      '---\ndescription: "Review the diff: \\"strict\\""\n---\n\nReview $ARGUMENTS and list risks.\n',
    );
    expect(renderLibraryFile(target("commands", "gemini"), "review", review)).toBe(
      'description = "Review the diff: \\"strict\\""\nprompt = "Review {{args}} and list risks."\n',
    );
    expect(renderLibraryFile(target("commands", "qwen"), "review", review)).toContain("Review {{args}} and list risks.");
    expect(renderLibraryFile(target("subagents", "claude-code"), "reviewer", review)).toBe(
      '---\nname: "reviewer"\ndescription: "Review the diff: \\"strict\\""\n---\n\nReview $ARGUMENTS and list risks.\n',
    );
    expect(renderLibraryFile(target("subagents", "opencode"), "reviewer", review)).toContain('mode: "subagent"');
    expect(renderLibraryFile(target("subagents", "codex"), "reviewer", review)).toBe(
      'name = "reviewer"\ndescription = "Review the diff: \\"strict\\""\ndeveloper_instructions = "Review $ARGUMENTS and list risks."\n',
    );

    for (const kind of ["commands", "subagents"] as const) {
      for (const item of targets(kind)) expect(parseLibraryFile(item, renderLibraryFile(item, "x", review))).toEqual(review);
    }
    expect(parseLibraryFile(target("commands", "claude-code"), "Just a prompt.\n")).toEqual({ description: "", body: "Just a prompt." });
    expect(parseLibraryFile(target("commands", "gemini"), "not = [toml")).toBeNull();
  });
});
