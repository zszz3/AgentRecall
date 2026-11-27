import assert from "node:assert/strict";
import { test } from "node:test";

import { computeReleaseDecision, main } from "./compute-release-version.mjs";

const fixNote = "# 修复重复发布\n\n## Bug 修复\n\n- 修复重复发布失败。\n";

function runner({ existingTag = "v2.0.0", releaseDraft = "false", latestTag = "v2.0.0" } = {}) {
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

  assert.deepEqual(decision, { version: "2.0.0", tag: "v2.0.0", releaseRequired: false });
});

test("same commit with a draft release resumes publication", () => {
  const commands = runner({ releaseDraft: "true" });
  const decision = computeReleaseDecision({
    mergedSha: "merge-sha",
    noteFile: "note.md",
    readNote: () => fixNote,
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "2.0.0", tag: "v2.0.0", releaseRequired: true });
});

test("same commit with a tag but no release resumes publication", () => {
  const commands = runner({ releaseDraft: new Error("release not found") });
  const decision = computeReleaseDecision({
    mergedSha: "merge-sha",
    noteFile: "note.md",
    readNote: () => fixNote,
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "2.0.0", tag: "v2.0.0", releaseRequired: true });
});

test("a different merged PR commit computes and publishes a new version", () => {
  const commands = runner({ existingTag: "", latestTag: "v2.0.0" });
  const decision = computeReleaseDecision({
    mergedSha: "new-merge-sha",
    noteFile: "note.md",
    readNote: (path) => (path === "package.json" ? '{"version":"2.0.0"}' : fixNote),
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "2.0.1", tag: "v2.0.1", releaseRequired: true });
});

test("inaugural unified release jumps to package.json version when only legacy v0.x tags exist", () => {
  const commands = runner({ existingTag: "", latestTag: "v0.62.2" });
  const decision = computeReleaseDecision({
    mergedSha: "unified-merge-sha",
    noteFile: "note.md",
    readNote: (path) => (path === "package.json" ? '{"version":"2.0.0"}' : fixNote),
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "2.0.0", tag: "v2.0.0", releaseRequired: true });
});

test("a repository without tags bumps from package.json", () => {
  const commands = runner({ existingTag: "", latestTag: "" });
  const decision = computeReleaseDecision({
    mergedSha: "first-merge-sha",
    noteFile: "note.md",
    readNote: (path) => (path === "package.json" ? '{"version":"2.0.0"}' : fixNote),
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "2.0.1", tag: "v2.0.1", releaseRequired: true });
});

test("ignores legacy v2-prefixed tags when computing the inaugural 2.0 release", () => {
  const commands = runner({
    existingTag: "v2-latest\nv2-0.42.0",
    latestTag: "v2-latest\nv2-0.42.0\nv2-0.41.0\nv0.62.2\nv0.62.1",
  });
  const decision = computeReleaseDecision({
    mergedSha: "unified-merge-sha",
    noteFile: "note.md",
    readNote: (path) => (path === "package.json" ? '{"version":"2.0.0"}' : fixNote),
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "2.0.0", tag: "v2.0.0", releaseRequired: true });
});

test("ignores legacy v2-prefixed tags after v2.0.0 is published", () => {
  const commands = runner({
    existingTag: "",
    latestTag: "v2-latest\nv2.0.0\nv2-0.42.0\nv0.62.2",
  });
  const decision = computeReleaseDecision({
    mergedSha: "post-2-0-sha",
    noteFile: "note.md",
    readNote: (path) => (path === "package.json" ? '{"version":"2.0.0"}' : fixNote),
    runCommand: commands.run,
  });

  assert.deepEqual(decision, { version: "2.0.1", tag: "v2.0.1", releaseRequired: true });
});

test("main passes --allow-same-version when stamping a version that matches package.json", () => {
  const calls = [];
  const outputs = [];
  main({
    env: {
      MERGED_SHA: "unified-merge-sha",
      NOTE_FILE: "note.md",
      GITHUB_OUTPUT: "/tmp/github-output",
    },
    readNote: (path) => (path === "package.json" ? '{"version":"2.0.0"}' : fixNote),
    runCommand(command, args) {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "fetch") return "";
      if (command === "git" && args.includes("--points-at")) return "";
      if (command === "git" && args[0] === "tag") return "v2-latest\nv2-0.42.0\nv0.62.2";
      return "";
    },
    appendOutput(file, content) {
      outputs.push({ file, content });
    },
  });

  const npmCall = calls.find((entry) => entry.includes("version"));
  assert.ok(npmCall, "expected an npm version invocation");
  assert.ok(npmCall.includes("2.0.0"));
  assert.ok(npmCall.includes("--no-git-tag-version"));
  assert.ok(npmCall.includes("--allow-same-version"));
  assert.deepEqual(outputs, [
    {
      file: "/tmp/github-output",
      content: "version=2.0.0\ntag=v2.0.0\nrelease_required=true\n",
    },
  ]);
});
