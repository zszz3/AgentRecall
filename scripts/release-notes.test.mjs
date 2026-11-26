import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  bumpVersion,
  combineReleaseNotes,
  findAddedReleaseNoteFiles,
  parseReleaseNote,
  releaseBumpFor,
  renderReleaseNotes,
  validateReleaseNoteRange,
} from "./release-notes.mjs";

test("parses feature and bug-fix sections as user-facing release copy", () => {
  const note = parseReleaseNote(`# 自动更新\n\n## 新增功能\n\n- 终端显示新版本。\n\n## Bug 修复\n\n- 修复重启失败。\n`);
  assert.deepEqual(note, {
    title: "自动更新",
    features: ["终端显示新版本。"],
    fixes: ["修复重启失败。"],
  });
  assert.match(renderReleaseNotes(note), /## 新增功能[\s\S]*## Bug 修复/);
});

test("rejects missing and vague release notes", () => {
  assert.throws(() => parseReleaseNote("# Empty\n"), /at least one bullet/);
  assert.throws(() => parseReleaseNote("# Vague\n\n## Bug 修复\n\n- 修复一些问题\n"), /vague/);
});

test("ignores legacy HTML comments when rendering release notes", () => {
  const note = parseReleaseNote("# 统一版本\n\n<!-- release-target: v2 -->\n\n## Bug 修复\n\n- 修复启动问题。\n");
  assert.deepEqual(note.fixes, ["修复启动问题。"]);
  assert.doesNotMatch(renderReleaseNotes(note), /release-target/);
});

test("bumps minor for features and patch for fix-only releases", () => {
  const feature = { title: "Feature", features: ["New behavior"], fixes: [] };
  const fix = { title: "Fix", features: [], fixes: ["Fixed behavior"] };
  assert.equal(releaseBumpFor(feature), "minor");
  assert.equal(bumpVersion("v2.0.9", feature), "2.1.0");
  assert.equal(bumpVersion("2.1.0", fix), "2.1.1");
});

test("combines pending release notes and deduplicates exact bullets", () => {
  const combined = combineReleaseNotes([
    { title: "First", features: ["New search"], fixes: ["Fixed update"] },
    { title: "Second", features: ["New search", "New sync"], fixes: ["Fixed layout"] },
  ]);
  assert.deepEqual(combined, {
    title: "AgentRecall 更新",
    features: ["New search", "New sync"],
    fixes: ["Fixed update", "Fixed layout"],
  });
  assert.equal(releaseBumpFor(combined), "minor");
});

test("finds only newly added non-template release notes", () => {
  const files = findAddedReleaseNoteFiles("origin/main", "HEAD", (args) =>
    args[0] === "diff" ? ".release-notes/README.md\n.release-notes/auto-update.md\n" : ".release-notes/auto-update.md\n",
  );
  assert.deepEqual(files, [".release-notes/auto-update.md"]);
});

test("allows a branch with only GitHub metadata changes to omit product release notes", () => {
  const result = validateReleaseNoteRange("origin/main", "HEAD", (args) => {
    if (args[0] === "ls-files") return "";
    if (args.includes("--diff-filter=A")) return "";
    return ".github/workflows/contributors.yml\n";
  });

  assert.deepEqual(result, { internalOnly: true, file: null, note: null });
});

test("still requires a product release note when a branch mixes GitHub metadata with product changes", () => {
  assert.throws(
    () => validateReleaseNoteRange("origin/main", "HEAD", (args) => {
      if (args[0] === "ls-files") return "";
      if (args.includes("--diff-filter=A")) return "";
      return ".github/workflows/quality-check.yml\napps/main-2.0/src/main/index.ts\n";
    }),
    /Expected exactly one added \.release-notes\/\*\.md file/,
  );
});

test("validates a single added release note file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-release-note-"));
  const noteFile = path.join(root, "note.md");
  await writeFile(noteFile, "# 桌面更新\n\n## Bug 修复\n\n- 修复界面显示问题。\n", "utf8");
  try {
    const result = validateReleaseNoteRange("origin/main", "HEAD", (args) => {
      if (args[0] === "ls-files") return "";
      if (args.includes("--diff-filter=A")) return `${noteFile}\n`;
      return "apps/main-2.0/src/main/index.ts\n";
    });
    assert.equal(result.internalOnly, false);
    assert.equal(result.file, noteFile);
    assert.deepEqual(result.note.fixes, ["修复界面显示问题。"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflows require branch notes and publish unified releases every day or on demand", async () => {
  const qualityWorkflow = await readFile(".github/workflows/quality-check.yml", "utf8");
  const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(qualityWorkflow, /pull_request:/);
  assert.match(qualityWorkflow, /concurrency:[\s\S]*cancel-in-progress:\s*true/);
  assert.match(qualityWorkflow, /run: node scripts\/release-notes\.mjs check-range/);
  assert.match(qualityWorkflow, /quality-check-scope\.mjs --base "\$BASE_SHA" --head "\$HEAD_SHA" >> "\$GITHUB_OUTPUT"/);
  assert.match(qualityWorkflow, /run: npm run test:repo/);
  assert.match(qualityWorkflow, /matrix:\s*\$\{\{ fromJSON\(needs\.preflight\.outputs\.matrix\) \}\}/);
  assert.match(qualityWorkflow, /if: needs\.preflight\.outputs\.verify == 'true'/);
  assert.match(qualityWorkflow, /run: npm run setup/);
  assert.match(qualityWorkflow, /ELECTRON_SKIP_BINARY_DOWNLOAD:\s*["']1["']/);
  assert.match(qualityWorkflow, /npm_config_cache:\s*\$\{\{ github\.workspace \}\}\/\.ci-npm-cache/);
  assert.match(qualityWorkflow, /AGENT_RECALL_TEST_NPM_CACHE:\s*\$\{\{ github\.workspace \}\}\/\.ci-npm-cache/);
  assert.match(qualityWorkflow, /if: runner\.os == 'Linux'\s+run: npm --prefix "\$\{\{ matrix\.directory \}\}" test/);
  assert.match(qualityWorkflow, /if: runner\.os != 'Linux'\s+run: \|\s+npm --prefix "\$\{\{ matrix\.directory \}\}" run test:scripts\s+npm --prefix "\$\{\{ matrix\.directory \}\}" run test:cli/);
  assert.match(qualityWorkflow, /npm --prefix "\$\{\{ matrix\.directory \}\}" run typecheck\s+node "\$\{\{ matrix\.directory \}\}\/scripts\/package-smoke\.mjs"/);
  assert.equal(qualityWorkflow.match(/run typecheck/gu)?.length, 1);
  assert.doesNotMatch(qualityWorkflow, /run build(?:\r?\n|$)/u);
  assert.match(qualityWorkflow, /cache-dependency-path: \$\{\{ matrix\.directory \}\}\/package-lock\.json/);
  assert.match(qualityWorkflow, /name: Quality gate[\s\S]*needs: \[preflight, verify\][\s\S]*if: \$\{\{ always\(\) \}\}/);
  assert.doesNotMatch(qualityWorkflow, /package:smoke:cli/);
  assert.match(qualityWorkflow, /success:true:success\|success:false:skipped/);

  assert.match(releaseWorkflow, /schedule:[\s\S]*cron:\s*["']0 2 \* \* \*["']/);
  assert.match(releaseWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(releaseWorkflow, /^\s{2}push:/m);
  assert.match(releaseWorkflow, /gh api --paginate "repos\/\$\{GITHUB_REPOSITORY\}\/releases\?per_page=100"/);
  assert.match(releaseWorkflow, /published_tags_output="\$\([\s\S]*gh api --paginate/);
  const capturedTagsAssignment = /\r?\n\s*\)"\r?\n\s*mapfile -t published_tags <<< "\$published_tags_output"/;
  assert.match(releaseWorkflow, capturedTagsAssignment);
  assert.match(releaseWorkflow, /select\(\.draft == false and \.prerelease == false\)/);
  assert.match(releaseWorkflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(releaseWorkflow, /No unreleased user-facing changes; skipping application release/);
  assert.match(releaseWorkflow, /release-notes\.mjs combine/);
  assert.match(releaseWorkflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(releaseWorkflow, /apps\/main-1\.0/);
  assert.doesNotMatch(releaseWorkflow, /v2-latest/);
  assert.doesNotMatch(releaseWorkflow, /openviking/iu);
  assert.match(releaseWorkflow, /working-directory: apps\/main-2\.0/);
  assert.match(releaseWorkflow, /npm test[\s\S]*npm run typecheck[\s\S]*npm run build/);
  assert.match(releaseWorkflow, /npm run setup/);
  assert.match(releaseWorkflow, /cd apps\/main-2\.0 && node scripts\/pack-release\.mjs/);
  assert.match(releaseWorkflow, /apps\/main-2\.0\/scripts\/create-release-assets\.mjs/);
  assert.match(releaseWorkflow, /agent-recall-\$\{RELEASE_VERSION\}\.tgz/);
  assert.match(releaseWorkflow, /agent-recall\.tgz/);
  assert.match(releaseWorkflow, /update\.json/);
  assert.match(releaseWorkflow, /gh release create "\$RELEASE_TAG"[\s\S]*--title "AgentRecall \$RELEASE_TAG"[\s\S]*--latest/);
  assert.match(releaseWorkflow, /gh release view "\$RELEASE_TAG" --json isDraft --jq '\.isDraft'/);
  assert.match(releaseWorkflow, /already exists and is published; refusing to overwrite it/);
  assert.match(releaseWorkflow, /node scripts\/compute-release-version\.mjs/);
  assert.match(releaseWorkflow, /gh release edit "\$RELEASE_TAG" --draft=false --latest/);
  const tagIdentityName = releaseWorkflow.indexOf('git config user.name "github-actions[bot]"');
  const tagIdentityEmail = releaseWorkflow.indexOf('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  const annotatedTag = releaseWorkflow.indexOf('git tag -a "$RELEASE_TAG"');
  assert.ok(tagIdentityName >= 0, "release workflow must configure the tag creator name");
  assert.ok(tagIdentityEmail > tagIdentityName, "release workflow must configure the tag creator email after its name");
  assert.ok(annotatedTag > tagIdentityEmail, "release workflow must configure an identity before creating an annotated tag");
});

test("manual contributor updates only write the default branch", async () => {
  const workflow = await readFile(".github/workflows/contributors.yml", "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contrib-readme-job:\s+if:\s+github\.ref == 'refs\/heads\/main'/);
});

test("scheduled release and star-history jobs only run in the canonical repository", async () => {
  const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
  const starHistoryWorkflow = await readFile(".github/workflows/update-star-history.yml", "utf8");
  const guard = /^\s*if: github\.repository == 'zszz3\/AgentRecall'$/mu;
  assert.match(releaseWorkflow.slice(releaseWorkflow.indexOf("  release:")), guard);
  assert.match(starHistoryWorkflow.slice(starHistoryWorkflow.indexOf("  update:")), guard);
});

function runQualityCheckScope(paths) {
  const result = spawnSync(
    process.execPath,
    [".github/scripts/quality-check-scope.mjs", "--paths", ...paths],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries(
    result.stdout.trim().split(/\r?\n/u).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  return {
    verify: outputs.verify,
    matrix: JSON.parse(outputs.matrix),
  };
}

test("quality checks route desktop changes without dropping platform coverage", () => {
  const desktop = runQualityCheckScope([
    ".release-notes/fix-update.md",
    "apps/main-2.0/bin/update-client.cjs",
  ]);
  assert.equal(desktop.verify, "true");
  assert.deepEqual(desktop.matrix.include, [
    { app: "desktop", label: "Desktop", directory: "apps/main-2.0", os: "ubuntu-latest" },
    { app: "desktop", label: "Desktop", directory: "apps/main-2.0", os: "macos-latest" },
    { app: "desktop", label: "Desktop", directory: "apps/main-2.0", os: "windows-latest" },
  ]);
});

test("quality checks keep infrastructure-only changes on the repository fast path", () => {
  const repository = runQualityCheckScope([
    ".github/workflows/release.yml",
    ".release-notes/runtime-reuse.md",
    "README.md",
    "assets/logo.png",
    "apps/main-2.0/docs/README.en.md",
    "scripts/release-notes.test.mjs",
    "docs/v2/guide.md",
  ]);
  assert.equal(repository.verify, "false");
  assert.deepEqual(repository.matrix.include, [
    { app: "repository", label: "Repository", directory: "", os: "ubuntu-latest" },
  ]);
});

test("quality checks fail closed for routing and shared build inputs", () => {
  for (const file of [
    ".github/scripts/quality-check-scope.mjs",
    "scripts/setup-app.mjs",
  ]) {
    const plan = runQualityCheckScope([file]);
    assert.equal(plan.verify, "true", file);
    assert.equal(plan.matrix.include.length, 3, file);
    assert.deepEqual([...new Set(plan.matrix.include.map(({ app }) => app))], ["desktop"]);
  }
});
