import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  V2_STABLE_ASSET_NAMES,
  probeV2StableRelease,
} from "../.github/scripts/probe-v2-stable-release.mjs";

import {
  bumpVersion,
  combineReleaseNotes,
  combineReleaseNotesForTarget,
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
    target: "v1",
    features: ["终端显示新版本。"],
    fixes: ["修复重启失败。"],
  });
  assert.match(renderReleaseNotes(note), /## 新增功能[\s\S]*## Bug 修复/);
});

test("rejects missing and vague release notes", () => {
  assert.throws(() => parseReleaseNote("# Empty\n"), /at least one bullet/);
  assert.throws(() => parseReleaseNote("# Vague\n\n## Bug 修复\n\n- 修复一些问题\n"), /vague/);
  assert.throws(
    () => parseReleaseNote("# Invalid\n\n<!-- release-target: future -->\n\n## Bug 修复\n\n- Clear fix.\n"),
    /invalid release target/,
  );
});

test("routes V1 and V2 notes without publishing V2 notes in V1 releases", () => {
  const v1 = parseReleaseNote("# Stable\n\n<!-- release-target: v1 -->\n\n## Bug 修复\n\n- Stable fix.\n");
  const v2 = parseReleaseNote("# Preview\n\n<!-- release-target: v2 -->\n\n## Bug 修复\n\n- Preview fix.\n");
  const both = parseReleaseNote("# Shared\n\n<!-- release-target: both -->\n\n## Bug 修复\n\n- Shared fix.\n");
  assert.equal(v1.target, "v1");
  assert.equal(v2.target, "v2");
  assert.equal(both.target, "both");
  assert.deepEqual(
    combineReleaseNotes([v1, v2, both], { target: "v1" }).fixes,
    ["Stable fix.", "Shared fix."],
  );
  assert.doesNotMatch(renderReleaseNotes(v2), /release-target/);
});

test("renders each product's release notes independently", () => {
  const v1 = parseReleaseNote("# Stable\n\n## 新增功能\n\n- Stable feature.\n");
  const v2 = parseReleaseNote("# Preview\n\n<!-- release-target: v2 -->\n\n## Bug 修复\n\n- Preview fix.\n");
  const both = parseReleaseNote("# Shared\n\n<!-- release-target: both -->\n\n## Bug 修复\n\n- Shared fix.\n");

  const renderedV1 = renderReleaseNotes(combineReleaseNotesForTarget([v1, v2, both], "v1"));
  const renderedV2 = renderReleaseNotes(combineReleaseNotesForTarget([v1, v2, both], "v2"));

  assert.match(renderedV1, /^# AgentRecall 1\.0 更新/m);
  assert.match(renderedV1, /- Stable feature\.[\s\S]*- Shared fix\./);
  assert.doesNotMatch(renderedV1, /Preview fix\./);
  assert.match(renderedV2, /^# agent-recall-v2 更新/m);
  assert.match(renderedV2, /- Preview fix\.[\s\S]*- Shared fix\./);
  assert.doesNotMatch(renderedV2, /Stable feature\./);
});

test("bumps minor for features and patch for fix-only releases", () => {
  const feature = { title: "Feature", features: ["New behavior"], fixes: [] };
  const fix = { title: "Fix", features: [], fixes: ["Fixed behavior"] };
  assert.equal(releaseBumpFor(feature), "minor");
  assert.equal(bumpVersion("v0.1.9", feature), "0.2.0");
  assert.equal(bumpVersion("0.2.0", fix), "0.2.1");
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

test("validates staged notes against staged and unstaged application changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-staged-release-note-"));
  const noteFile = path.join(root, "note.md");
  await writeFile(noteFile, "# Wrong target\n\n<!-- release-target: v1 -->\n\n## Bug 修复\n\n- Visible fix.\n", "utf8");

  try {
    assert.throws(
      () => validateReleaseNoteRange("origin/main", "HEAD", (args) => {
        if (args[0] === "ls-files") return "";
        if (args.includes("--diff-filter=A")) return args.includes("--cached") ? `${noteFile}\n` : "";
        if (args.some((arg) => arg.includes("..."))) return "";
        if (args.includes("--cached")) return "apps/main-2.0/src/main/staged.ts\n";
        return "apps/main-2.0/src/main/unstaged.ts\n";
      }),
      /target "v1" does not cover changes under apps\/main-2\.0/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
      return ".github/workflows/quality-check.yml\napps/main-1.0/src/main/index.ts\n";
    }),
    /Expected exactly one added \.release-notes\/\*\.md file/,
  );
});

test("requires explicit release routing and rejects clear application target mismatches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-recall-release-target-"));
  const noteFile = path.join(root, "note.md");
  let changedFiles = ["apps/main-2.0/src/main/index.ts"];
  const runGit = (args) => {
    if (args[0] === "ls-files") return "";
    if (args.includes("--diff-filter=A")) return `${noteFile}\n`;
    return `${changedFiles.join("\n")}\n`;
  };

  try {
    await writeFile(noteFile, "# Missing target\n\n## Bug 修复\n\n- Visible fix.\n", "utf8");
    assert.throws(
      () => validateReleaseNoteRange("origin/main", "HEAD", runGit),
      /must explicitly declare <!-- release-target: v1\|v2\|both -->/,
    );

    await writeFile(noteFile, "# Misplaced target\n\n## Bug 修复\n\n- Visible fix.\n\n<!-- release-target: v2 -->\n", "utf8");
    assert.throws(
      () => validateReleaseNoteRange("origin/main", "HEAD", runGit),
      /immediately after its title/,
    );

    await writeFile(noteFile, "# Wrong target\n\n<!-- release-target: v1 -->\n\n## Bug 修复\n\n- Visible fix.\n", "utf8");
    changedFiles = ["apps\\main-2.0\\src\\main\\index.ts", "apps/main-1.0/src/main/index.test.ts"];
    assert.throws(
      () => validateReleaseNoteRange("origin/main", "HEAD", runGit),
      /target "v1" does not cover changes under apps\/main-2\.0/,
    );

    await writeFile(noteFile, "# V2 target\n\n<!-- release-target: v2 -->\n\n## Bug 修复\n\n- Visible fix.\n", "utf8");
    assert.equal(validateReleaseNoteRange("origin/main", "HEAD", runGit).note.target, "v2");

    await writeFile(noteFile, "# Both targets\n\n<!-- release-target: both -->\n\n## Bug 修复\n\n- Visible fix.\n", "utf8");
    assert.equal(validateReleaseNoteRange("origin/main", "HEAD", runGit).note.target, "both");

    changedFiles = ["apps/main-1.0/src/main/index.ts"];
    await writeFile(noteFile, "# Wrong V1 target\n\n<!-- release-target: v2 -->\n\n## Bug 修复\n\n- Visible fix.\n", "utf8");
    assert.throws(
      () => validateReleaseNoteRange("origin/main", "HEAD", runGit),
      /target "v2" does not cover changes under apps\/main-1\.0/,
    );

    changedFiles = ["apps/main-1.0/src/main/index.ts", "apps/main-2.0/src/main/index.ts"];
    assert.equal(validateReleaseNoteRange("origin/main", "HEAD", runGit).note.target, "v2");

    changedFiles = ["scripts/shared.mjs"];
    assert.equal(validateReleaseNoteRange("origin/main", "HEAD", runGit).note.target, "v2");

    changedFiles = ["apps/main-2.0/src/main/index.test.ts", "apps/main-2.0/docs/release.md"];
    await writeFile(noteFile, "# V1 target\n\n<!-- release-target: v1 -->\n\n## Bug 修复\n\n- Visible fix.\n", "utf8");
    assert.equal(validateReleaseNoteRange("origin/main", "HEAD", runGit).note.target, "v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflows require branch notes and publish accumulated changes every day or on demand", async () => {
  const qualityWorkflow = await readFile(".github/workflows/quality-check.yml", "utf8");
  const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(qualityWorkflow, /pull_request:/);
  assert.match(qualityWorkflow, /concurrency:[\s\S]*cancel-in-progress:\s*true/);
  assert.match(qualityWorkflow, /run: node scripts\/release-notes\.mjs check-range/);
  assert.match(qualityWorkflow, /quality-check-scope\.mjs --base "\$BASE_SHA" --head "\$HEAD_SHA" >> "\$GITHUB_OUTPUT"/);
  assert.match(qualityWorkflow, /run: npm run test:repo/);
  assert.match(qualityWorkflow, /matrix:\s*\$\{\{ fromJSON\(needs\.preflight\.outputs\.matrix\) \}\}/);
  assert.match(qualityWorkflow, /if: needs\.preflight\.outputs\.verify == 'true'/);
  assert.match(qualityWorkflow, /npm run setup:\$\{\{ matrix\.app \}\}/);
  assert.match(qualityWorkflow, /ELECTRON_SKIP_BINARY_DOWNLOAD:\s*["']1["']/);
  assert.match(qualityWorkflow, /npm_config_cache:\s*\$\{\{ github\.workspace \}\}\/\.ci-npm-cache/);
  assert.match(qualityWorkflow, /AGENT_RECALL_TEST_NPM_CACHE:\s*\$\{\{ github\.workspace \}\}\/\.ci-npm-cache/);
  assert.match(qualityWorkflow, /if: runner\.os == 'Linux'\s+run: npm --prefix "\$\{\{ matrix\.directory \}\}" test/);
  assert.match(qualityWorkflow, /if: runner\.os != 'Linux'\s+run: npm --prefix "\$\{\{ matrix\.directory \}\}" run test:scripts/);
  assert.match(qualityWorkflow, /npm --prefix "\$\{\{ matrix\.directory \}\}" run typecheck\s+node "\$\{\{ matrix\.directory \}\}\/scripts\/package-smoke\.mjs"/);
  assert.equal(qualityWorkflow.match(/run typecheck/gu)?.length, 1);
  assert.doesNotMatch(qualityWorkflow, /run build(?:\r?\n|$)/u);
  assert.match(qualityWorkflow, /cache-dependency-path: \$\{\{ matrix\.directory \}\}\/package-lock\.json/);
  assert.doesNotMatch(qualityWorkflow, /npm run package:smoke:all/);
  assert.match(qualityWorkflow, /name: Quality gate[\s\S]*needs: \[preflight, verify, cli\][\s\S]*if: \$\{\{ always\(\) \}\}/);
  assert.match(qualityWorkflow, /run: npm run test:cli/);
  assert.match(qualityWorkflow, /run: npm run package:smoke:cli/);
  assert.match(qualityWorkflow, /test "\$CLI_RESULT" = "success"/);
  assert.match(qualityWorkflow, /success:true:success\|success:false:skipped/);
  assert.match(releaseWorkflow, /schedule:[\s\S]*cron:\s*["']0 2 \* \* \*["']/);
  assert.match(releaseWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(releaseWorkflow, /^\s{2}push:/m);
  assert.match(releaseWorkflow, /gh api --paginate "repos\/\$\{GITHUB_REPOSITORY\}\/releases\?per_page=100"/);
  assert.match(releaseWorkflow, /published_tags_output="\$\([\s\S]*gh api --paginate/);
  const capturedTagsAssignment = /\r?\n\s*\)"\r?\n\s*mapfile -t published_tags <<< "\$published_tags_output"/;
  assert.match(releaseWorkflow, capturedTagsAssignment);
  const windowsReleaseWorkflow = releaseWorkflow.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  assert.match(windowsReleaseWorkflow, capturedTagsAssignment);
  assert.match(releaseWorkflow, /mapfile -t published_tags <<< "\$published_tags_output"/);
  assert.doesNotMatch(releaseWorkflow, /mapfile -t published_tags < <\(/);
  assert.match(releaseWorkflow, /select\(\.draft == false and \.prerelease == false\)/);
  assert.match(releaseWorkflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(releaseWorkflow, /\^v2-\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.doesNotMatch(releaseWorkflow, /latest_v1_tag="\$\(git describe/);
  assert.doesNotMatch(releaseWorkflow, /latest_v2_tag="\$\(git describe/);
  assert.match(releaseWorkflow, /V2_BOOTSTRAP_TAG:\s*v0\.34\.2/);
  assert.match(releaseWorkflow, /No unreleased user-facing changes; skipping application release/);
  assert.match(releaseWorkflow, /release-notes\.mjs target/);
  assert.match(releaseWorkflow, /release-notes\.mjs combine --target v1/);
  assert.match(releaseWorkflow, /release-notes\.mjs combine --target v2/);
  assert.doesNotMatch(releaseWorkflow, /release-notes\.mjs dual/);
  assert.match(releaseWorkflow, /cancel-in-progress:\s*false/);
  assert.match(releaseWorkflow, /^\s{2}plan:\s*\r?\n(?:\s*(?:#.*|if:.*)\r?\n)*\s{4}runs-on:\s*ubuntu-latest/mu);
  assert.doesNotMatch(releaseWorkflow, /openviking/iu);
  assert.match(releaseWorkflow, /working-directory: apps\/main-1\.0/);
  assert.match(releaseWorkflow, /working-directory: apps\/main-2\.0/);
  assert.match(releaseWorkflow, /npm test[\s\S]*npm run typecheck[\s\S]*npm run build/);
  assert.match(releaseWorkflow, /npm run setup/);
  assert.match(releaseWorkflow, /cd apps\/main-1\.0 && node scripts\/pack-release\.mjs/);
  assert.match(releaseWorkflow, /cd apps\/main-2\.0 && node scripts\/pack-release\.mjs/);
  assert.match(releaseWorkflow, /apps\/main-1\.0\/scripts\/create-release-assets\.mjs/);
  assert.match(releaseWorkflow, /apps\/main-2\.0\/scripts\/create-release-assets\.mjs/);
  assert.match(releaseWorkflow, /release\/v1/);
  assert.match(releaseWorkflow, /release\/v2/);
  assert.match(releaseWorkflow, /agent-recall-v2-\$\{V2_VERSION\}\.tgz/);
  assert.match(releaseWorkflow, /agent-recall-v2\.tgz/);
  assert.match(releaseWorkflow, /update-v2\.json/);
  assert.match(releaseWorkflow, /id: v1_version/);
  assert.match(releaseWorkflow, /id: v2_version/);
  assert.match(releaseWorkflow, /gh release create "\$V1_TAG"[\s\S]*--title "AgentRecall \$V1_TAG"/);
  assert.match(releaseWorkflow, /gh release create "\$V2_TAG"[\s\S]*--title "agent-recall-v2 v\$\{V2_VERSION\}"[\s\S]*--latest=false/);
  assert.doesNotMatch(releaseWorkflow, /V1 \+ V2/);
  assert.match(releaseWorkflow, /gh release view "\$V1_TAG" --json isDraft --jq '\.isDraft'/);
  assert.match(releaseWorkflow, /gh release view "\$V2_TAG" --json isDraft --jq '\.isDraft'/);
  assert.match(releaseWorkflow, /already exists and is published; refusing to overwrite it/);
  assert.match(releaseWorkflow, /node scripts\/compute-release-version\.mjs/);
  assert.match(releaseWorkflow, /node apps\/main-1\.0\/scripts\/create-release-assets\.mjs/);
  assert.match(releaseWorkflow, /gh release edit "\$V1_TAG" --draft=false --latest/);
  assert.match(releaseWorkflow, /gh release edit "\$V2_TAG" --draft=false --latest=false/);
  const tagIdentityName = releaseWorkflow.indexOf('git config user.name "github-actions[bot]"');
  const tagIdentityEmail = releaseWorkflow.indexOf('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  const annotatedTag = releaseWorkflow.indexOf('git tag -a "$V1_TAG"');
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
  // A fork carries no release tags, and its copy of the star-history data names a
  // different project, so both entry jobs have to skip there rather than fail.
  const planJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  plan:"),
    releaseWorkflow.indexOf("  openviking-runtime:"),
  );
  assert.match(planJob, guard);
  assert.match(starHistoryWorkflow.slice(starHistoryWorkflow.indexOf("  update:")), guard);
});

test("V2 stable install probe repairs only stale or incomplete rolling releases", () => {
  const sourceCommitSha = "1".repeat(40);
  const sourceRelease = {
    tag_name: "v2-0.11.1",
    draft: false,
    prerelease: false,
    published_at: "2026-08-15T00:00:00Z",
    assets: V2_STABLE_ASSET_NAMES.map((name, index) => ({
      name,
      state: "uploaded",
      size: index + 1,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    })),
  };
  const stableRelease = structuredClone(sourceRelease);
  stableRelease.tag_name = "v2-latest";

  assert.equal(probeV2StableRelease({
    sourceRelease,
    stableRelease,
    sourceCommitSha,
    stableCommitSha: sourceCommitSha,
  }), false);
  assert.equal(probeV2StableRelease({
    sourceRelease,
    stableRelease: null,
    sourceCommitSha,
    stableCommitSha: "",
  }), true);
  assert.equal(probeV2StableRelease({
    sourceRelease,
    stableRelease,
    sourceCommitSha,
    stableCommitSha: "2".repeat(40),
  }), true);

  const incompleteStable = structuredClone(stableRelease);
  incompleteStable.assets.pop();
  assert.equal(probeV2StableRelease({
    sourceRelease,
    stableRelease: incompleteStable,
    sourceCommitSha,
    stableCommitSha: sourceCommitSha,
  }), true);

  const invalidSource = structuredClone(sourceRelease);
  invalidSource.assets[0].digest = "missing";
  assert.throws(() => probeV2StableRelease({
    sourceRelease: invalidSource,
    stableRelease,
    sourceCommitSha,
    stableCommitSha: sourceCommitSha,
  }), /invalid agent-recall-v2\.tgz asset/);
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

test("quality checks route application changes without dropping platform coverage", () => {
  const v2 = runQualityCheckScope([
    ".release-notes/fix-v2-update.md",
    "apps/main-2.0/bin/update-client.cjs",
  ]);
  assert.equal(v2.verify, "true");
  assert.deepEqual(v2.matrix.include, [
    { app: "v2", label: "V2", directory: "apps/main-2.0", os: "ubuntu-latest" },
    { app: "v2", label: "V2", directory: "apps/main-2.0", os: "macos-latest" },
    { app: "v2", label: "V2", directory: "apps/main-2.0", os: "windows-latest" },
  ]);

  const v1 = runQualityCheckScope(["apps\\main-1.0\\src\\main\\index.ts"]);
  assert.equal(v1.verify, "true");
  assert.equal(v1.matrix.include.length, 3);
  assert.ok(v1.matrix.include.every(({ app }) => app === "v1"));
});

test("quality checks keep infrastructure-only changes on the repository fast path", () => {
  const repository = runQualityCheckScope([
    ".github/workflows/release.yml",
    ".release-notes/runtime-reuse.md",
    "README.md",
    "assets/logo.png",
    "apps/main-1.0/docs/README.en.md",
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
    assert.equal(plan.matrix.include.length, 6, file);
    assert.deepEqual([...new Set(plan.matrix.include.map(({ app }) => app))], ["v1", "v2"]);
  }
});
