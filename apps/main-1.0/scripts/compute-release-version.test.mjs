import assert from "node:assert/strict";
import { test } from "node:test";

import { computeReleaseDecision } from "./compute-release-version.mjs";

const fixNote = "# 修复重复发布\n\n## Bug 修复\n\n- 修复重复发布失败。\n";

function runner({ existingTag = "v0.6.0", releaseDraft = "false", latestTag = "v0.6.0" } = {}) {
  const calls = [];
  return {
    calls,
    run(command, args) {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "fetch") return "";
      if (command === "git" && args.includes("--points-at")) return existingTag;
      if (command === "git" && args[0] === "tag") return latestTag;
      if (command === "gh" && releaseDraft instanceof Error) throw releaseDraft;
      if (command === "gh") return releaseDraft;
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };
}

test("same commit with a published release is an idempotent no-op", () => {
  const commands = runner({ releaseDraft: "false" });
  const decision = computeReleaseDecision({
    mergedSha: "merge-sha",
    noteFile: "note.md",
    readNote: () => fixNote,
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "0.6.0", tag: "v0.6.0", releaseRequired: false });
});

test("V1 versioning ignores V2 tags on the same commit", () => {
  const commands = runner({
    existingTag: "v2-0.2.0\nv0.6.0",
    latestTag: "v2-0.2.0\nv0.6.0",
    releaseDraft: "false",
  });
  const decision = computeReleaseDecision({
    mergedSha: "merge-sha",
    noteFile: "note.md",
    readNote: () => fixNote,
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "0.6.0", tag: "v0.6.0", releaseRequired: false });
});

test("same commit with a draft release resumes publication", () => {
  const commands = runner({ releaseDraft: "true" });
  const decision = computeReleaseDecision({
    mergedSha: "merge-sha",
    noteFile: "note.md",
    readNote: () => fixNote,
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "0.6.0", tag: "v0.6.0", releaseRequired: true });
});

test("same commit with a tag but no release resumes publication", () => {
  const commands = runner({ releaseDraft: new Error("release not found") });
  const decision = computeReleaseDecision({
    mergedSha: "merge-sha",
    noteFile: "note.md",
    readNote: () => fixNote,
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "0.6.0", tag: "v0.6.0", releaseRequired: true });
});

test("a different merged PR commit computes and publishes a new version", () => {
  const commands = runner({ existingTag: "", latestTag: "v0.6.0" });
  const decision = computeReleaseDecision({
    mergedSha: "new-merge-sha",
    noteFile: "note.md",
    readNote: () => fixNote,
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "0.6.1", tag: "v0.6.1", releaseRequired: true });
});

test("a repository without tags bumps from package.json", () => {
  const commands = runner({ existingTag: "", latestTag: "" });
  const decision = computeReleaseDecision({
    mergedSha: "first-merge-sha",
    noteFile: "note.md",
    readNote: (path) => (path === "package.json" ? '{"version":"1.2.3"}' : fixNote),
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "1.2.4", tag: "v1.2.4", releaseRequired: true });
});
