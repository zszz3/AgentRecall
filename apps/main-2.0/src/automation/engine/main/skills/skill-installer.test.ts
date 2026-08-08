import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installBundledSkill, uninstallBundledSkill } from "./skill-installer";

describe("bundled Skill installation", () => {
  it("materializes auxiliary files when the packaged source tree is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentrecall-bundled-skill-"));
    const homeDir = path.join(root, "home");
    const bundledRoot = path.join(root, "bundled-skills");

    try {
      const installed = await installBundledSkill({ templateId: "brainstorming", target: "codex" }, homeDir, bundledRoot);
      const referencePath = path.join(path.dirname(installed.sourcePath), "references", "visual-companion.md");
      await expect(readFile(referencePath, "utf8")).resolves.toContain("visual");
      await expect(readFile(installed.path, "utf8")).resolves.toContain("references/visual-companion.md");

      await uninstallBundledSkill({ templateId: "brainstorming", target: "codex" }, homeDir, bundledRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
