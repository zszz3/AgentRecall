import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  OPENVIKING_RUNTIME_TARGETS,
  createRuntimeInputsSidecar,
  loadOpenVikingRuntimeInputs,
  probeOpenVikingRuntimeRelease,
  runtimeReleaseAssetNames,
  runtimeInputsSidecarName,
  validateRuntimeRevisionChange,
  verifyLocalRuntimeAssets,
} from "../.github/scripts/probe-openviking-runtime-release.mjs";
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

test("repository guidance treats release notes as sanitized product copy", async () => {
  const instructions = await readFile("AGENTS.md", "utf8");
  const templateGuidance = await readFile(".release-notes/README.md", "utf8");
  const pullRequestTemplate = await readFile(".github/pull_request_template.md", "utf8");
  const claudeGuidance = await readFile("CLAUDE.md", "utf8");
  assert.match(instructions, /product copy for end users, not engineering change logs/);
  assert.match(instructions, /Remove internal-only changes entirely/);
  assert.match(instructions, /omit identifiers, hosts, paths, table names, credentials/);
  assert.match(instructions, /Every new note must put exactly one of .*release-target: v1.*release-target: v2.*release-target: both/s);
  assert.match(instructions, /manually starting the workflow does not force both products to release/);
  assert.match(templateGuidance, /Write this as product copy for users, not as an engineering log/);
  assert.match(templateGuidance, /Release routing is explicit for every new note/);
  assert.match(pullRequestTemplate, /release-target: v1.*v2.*both/);
  assert.match(claudeGuidance, /an explicit `<!-- release-target: v1\|v2\|both -->` marker/);
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
  assert.match(
    qualityWorkflow,
    /probe-openviking-runtime-release\.mjs[\s\\]*--config \.github\/openviking-runtime-inputs\.json[\s\\]*--check-revision-base "\$BASE_SHA"/,
  );
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
  assert.match(qualityWorkflow, /name: Quality gate[\s\S]*needs: \[preflight, verify\][\s\S]*if: \$\{\{ always\(\) \}\}/);
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
  assert.match(releaseWorkflow, /^\s{2}plan:\s*\r?\n\s{4}runs-on:\s*ubuntu-latest/mu);
  assert.match(
    releaseWorkflow,
    /openviking-runtime:\s+needs:\s*plan\s+if:\s*needs\.plan\.outputs\.v2_publish == 'true' && needs\.plan\.outputs\.runtime_reuse != 'true'[\s\S]*fail-fast:\s*false/,
  );
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

test("V2 releases reuse only fingerprinted complete OpenViking runtime sets", async () => {
  const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
  const runtimeConfig = JSON.parse(await readFile(".github/openviking-runtime-inputs.json", "utf8"));
  const runtimeInputScript = await readFile("apps/main-2.0/scripts/verify-openviking-runtime-inputs.mjs", "utf8");
  const runtimeResolver = await readFile("apps/main-2.0/src/main/services/openviking-artifact-resolver.ts", "utf8");
  const planJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  plan:"),
    releaseWorkflow.indexOf("  openviking-runtime:"),
  );
  const runtimeJob = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  openviking-runtime:"),
    releaseWorkflow.indexOf("  release:"),
  );
  const stableJobStart = releaseWorkflow.indexOf("  refresh-v2-stable:");
  assert.ok(stableJobStart > releaseWorkflow.indexOf("  release:"));
  const releaseJob = releaseWorkflow.slice(releaseWorkflow.indexOf("  release:"), stableJobStart);
  const stableJob = releaseWorkflow.slice(stableJobStart);

  assert.match(releaseWorkflow, /permissions:\s+contents:\s*read/);
  assert.match(releaseJob, /permissions:\s+contents:\s*write/);
  assert.match(planJob, /runs-on:\s*ubuntu-latest/);
  assert.match(planJob, /latest_v2_tag:[\s\S]*runtime_reuse:[\s\S]*runtime_source_tag:/);
  assert.match(planJob, /v2_stable_repair:[\s\S]*probe-v2-stable-release\.mjs/);
  assert.match(planJob, /probe-openviking-runtime-release\.mjs[\s\S]*--describe/);
  assert.match(planJob, /download_status=0[\s\S]*probe_status[\s\S]*probe_status" = "2"/);
  assert.match(planJob, /Published runtime assets are not reusable; rebuilding all platforms/);
  assert.match(planJob, /--pattern "\$RUNTIME_SIDECAR_NAME"/);
  assert.equal(
    (planJob.match(/--pattern "openviking-runtime-\$\{OPENVIKING_RUNTIME_VERSION\}-[^"\r\n]+\.tar\.gz\.json"/gu) ?? []).length,
    3,
  );
  assert.doesNotMatch(
    planJob,
    /--pattern "openviking-runtime-\$\{OPENVIKING_RUNTIME_VERSION\}-[^"\r\n]+\.tar\.gz"\s*(?:\\)?\r?\n/u,
  );
  assert.match(releaseWorkflow, /^\s{2}openviking-runtime:\s*$/m);
  assert.match(runtimeJob, /needs:\s*plan/);
  assert.match(runtimeJob, /if:\s*needs\.plan\.outputs\.v2_publish == 'true' && needs\.plan\.outputs\.runtime_reuse != 'true'/);
  assert.match(runtimeJob, /matrix:\s*\$\{\{ fromJSON\(needs\.plan\.outputs\.runtime_matrix\) \}\}/);
  assert.doesNotMatch(runtimeJob, /\bmapfile\b/);
  assert.deepEqual(runtimeConfig.targets.map(({ runner, platform, arch }) => ({ runner, platform, arch })), [
    { runner: "macos-15", platform: "darwin", arch: "arm64" },
    { runner: "macos-15-intel", platform: "darwin", arch: "x64" },
    { runner: "windows-2025", platform: "win32", arch: "x64" },
  ]);
  assert.match(releaseWorkflow, /apps\/main-2\.0\/scripts\/build-openviking-runtime\.mjs/);
  assert.match(runtimeJob, /npm ci --prefix apps\/main-2\.0 --ignore-scripts/);
  assert.doesNotMatch(runtimeJob, /npm run setup:v2/);
  const releaseRuntimeVersion = /OPENVIKING_RUNTIME_VERSION:\s*(\S+)/u.exec(releaseWorkflow)?.[1];
  assert.ok(releaseRuntimeVersion, "release workflow must pin the OpenViking runtime version");
  assert.equal(releaseRuntimeVersion, runtimeConfig.runtimeVersion);
  assert.equal(
    releaseRuntimeVersion,
    /OPENVIKING_RUNTIME_VERSION = "([^"]+)"/u.exec(runtimeResolver)?.[1],
  );
  assert.match(runtimeInputScript, new RegExp(`OPENVIKING_VERSION = "${releaseRuntimeVersion.replace(/-r[1-9][0-9]*$/u, "")}"`, "u"));
  assert.equal(runtimeConfig.nodeVersion, "22.23.1");
  assert.equal(runtimeConfig.rustToolchain, "1.97.1");
  assert.match(runtimeJob, /node-version:\s*\$\{\{ needs\.plan\.outputs\.runtime_node_version \}\}/);
  assert.match(runtimeJob, /rustup default "\$\{\{ needs\.plan\.outputs\.runtime_rust_toolchain \}\}"/);
  assert.match(runtimeJob, /RUSTUP_HOME:\s*\$\{\{ runner\.temp \}\}\/openviking-rustup/);
  assert.match(runtimeJob, /CARGO_HOME:\s*\$\{\{ runner\.temp \}\}\/openviking-cargo/);
  assert.match(runtimeJob, /overwrite:\s*true/);

  assert.match(releaseJob, /needs:\s*\[plan, openviking-runtime\]/);
  assert.match(releaseJob, /always\(\)[\s\S]*!cancelled\(\)[\s\S]*needs\.plan\.result == 'success'/);
  assert.match(
    releaseJob,
    /needs\.openviking-runtime\.result == 'skipped'[\s\S]*needs\.plan\.outputs\.v2_publish == 'false'[\s\S]*needs\.plan\.outputs\.runtime_reuse == 'true'/,
  );
  assert.match(releaseJob, /name:\s*Download reused OpenViking runtime artifacts[\s\S]*runtime_reuse == 'true'/);
  assert.match(releaseJob, /name:\s*Download freshly built OpenViking runtime artifacts[\s\S]*runtime_reuse != 'true'/);
  assert.match(releaseJob, /name:\s*Reverify reused OpenViking runtime source[\s\S]*--small-assets-dir release\/v2/);
  assert.match(releaseJob, /name:\s*Write OpenViking runtime input sidecar[\s\S]*--write-sidecar/);
  assert.match(releaseJob, /name:\s*Verify OpenViking runtime artifacts[\s\S]*--verify-local-assets release\/v2/);
  assert.match(releaseJob, /name:\s*Publish V2 GitHub Release[\s\S]*--verify-local-assets "\$verify_directory"/);
  assert.match(releaseWorkflow, /pattern:\s*openviking-runtime-\*/);
  assert.match(releaseWorkflow, /apps\/main-2\.0\/scripts\/verify-openviking-runtime-assets\.mjs/);
  assert.match(
    releaseWorkflow,
    /gh release upload "\$V2_TAG"[\s\S]*release\/v2\/openviking-runtime-\*\.tar\.gz/,
  );
  assert.match(
    releaseWorkflow,
    /gh release download "\$V2_TAG"[\s\S]*--pattern "openviking-runtime-\*"/,
  );
  assert.match(releaseWorkflow, /"release\/v2\/\$RUNTIME_SIDECAR_NAME"/);
  assert.doesNotMatch(releaseJob, /name:\s*Refresh V2 stable install release|git tag -f/);
  assert.match(stableJob, /needs:\s*\[plan, release\]/);
  assert.match(stableJob, /always\(\)[\s\S]*!cancelled\(\)[\s\S]*needs\.release\.result == 'success'/);
  assert.match(stableJob, /needs\.plan\.outputs\.v2_publish == 'true'[\s\S]*needs\.plan\.outputs\.v2_stable_repair == 'true'/);
  assert.match(stableJob, /NEW_V2_TAG:\s*\$\{\{ needs\.release\.outputs\.v2_tag \}\}/);
  assert.match(stableJob, /--pattern "agent-recall-v2-\$\{V2_VERSION\}\.tgz"[\s\S]*--pattern "update-v2\.json"/);
  const stableSourceValidation = stableJob.indexOf("node apps/main-2.0/scripts/create-release-assets.mjs");
  const stableSourceVerification = stableJob.indexOf("node apps/main-2.0/scripts/verify-stable-install-assets.mjs");
  const stableMutation = stableJob.indexOf('git tag -f -a "$V2_LATEST_TAG"');
  assert.ok(stableSourceValidation >= 0 && stableSourceValidation < stableMutation);
  assert.ok(stableSourceVerification >= 0 && stableSourceVerification < stableMutation);
  assert.match(stableJob, /git tag -f -a "\$V2_LATEST_TAG" "\$V2_SOURCE_SHA"/);
  assert.doesNotMatch(stableJob, /MERGED_SHA|github\.sha/);
});

test("accepts only a complete published OpenViking runtime release with matching input fingerprint", () => {
  const runtimeVersion = "0.4.11-r4";
  const expectedTag = "v2-0.10.1";
  const inputFingerprint = `sha256:${"a".repeat(64)}`;
  const smallAssets = new Map();
  const assets = [];
  const runtimeAssets = [];
  for (const target of OPENVIKING_RUNTIME_TARGETS) {
    const archiveName = `openviking-runtime-${runtimeVersion}-${target.platform}-${target.arch}.tar.gz`;
    const archiveSha256 = createHash("sha256").update(`archive:${archiveName}`).digest("hex");
    const manifestName = `${archiveName}.json`;
    const manifestBytes = Buffer.from(`${JSON.stringify({
      version: runtimeVersion,
      platform: target.platform,
      arch: target.arch,
      sha256: archiveSha256,
      archiveType: "tar.gz",
      executablePath: target.executablePath,
      file: archiveName,
    }, null, 2)}\n`);
    smallAssets.set(manifestName, manifestBytes);
    const archiveSize = 1_000_000;
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    runtimeAssets.push(
      { name: archiveName, size: archiveSize, sha256: archiveSha256 },
      { name: manifestName, size: manifestBytes.byteLength, sha256: manifestSha256 },
    );
    assets.push(
      { name: archiveName, state: "uploaded", size: archiveSize, digest: `sha256:${archiveSha256}` },
      { name: manifestName, state: "uploaded", size: manifestBytes.byteLength, digest: `sha256:${manifestSha256}` },
    );
  }
  const sidecarName = runtimeInputsSidecarName(runtimeVersion);
  const sidecarBytes = createRuntimeInputsSidecar({ runtimeVersion, inputFingerprint, runtimeAssets });
  smallAssets.set(sidecarName, sidecarBytes);
  assets.push({
    name: sidecarName,
    state: "uploaded",
    size: sidecarBytes.byteLength,
    digest: `sha256:${createHash("sha256").update(sidecarBytes).digest("hex")}`,
  });
  const release = {
    tag_name: expectedTag,
    draft: false,
    prerelease: false,
    published_at: "2026-08-15T00:00:00Z",
    assets,
  };

  assert.deepEqual(runtimeReleaseAssetNames(runtimeVersion), assets.slice(0, 6).map(({ name }) => name));
  assert.deepEqual(
    probeOpenVikingRuntimeRelease({ release, expectedTag, runtimeVersion, inputFingerprint, smallAssets }),
    { reusable: true, runtimeSourceTag: expectedTag },
  );

  const badManifestDigest = structuredClone(release);
  badManifestDigest.assets.find(({ name }) => name.endsWith(".json")).digest = `sha256:${"0".repeat(64)}`;
  assert.match(
    probeOpenVikingRuntimeRelease({
      release: badManifestDigest, expectedTag, runtimeVersion, inputFingerprint, smallAssets,
    }).reason,
    /sidecar does not match GitHub metadata/,
  );

  const badArchiveDigest = structuredClone(release);
  badArchiveDigest.assets.find(({ name }) => name.endsWith(".tar.gz")).digest = `sha256:${"f".repeat(64)}`;
  assert.match(
    probeOpenVikingRuntimeRelease({
      release: badArchiveDigest, expectedTag, runtimeVersion, inputFingerprint, smallAssets,
    }).reason,
    /sidecar does not match GitHub metadata/,
  );

  const missingPlatform = structuredClone(release);
  missingPlatform.assets = missingPlatform.assets.filter(({ name }) => !name.includes("win32-x64"));
  assert.match(
    probeOpenVikingRuntimeRelease({
      release: missingPlatform, expectedTag, runtimeVersion, inputFingerprint, smallAssets,
    }).reason,
    /missing trusted metadata for win32-x64/,
  );

  const wrongManifestSize = structuredClone(release);
  wrongManifestSize.assets.find(({ name }) => name.endsWith(".json")).size += 1;
  assert.match(
    probeOpenVikingRuntimeRelease({
      release: wrongManifestSize, expectedTag, runtimeVersion, inputFingerprint, smallAssets,
    }).reason,
    /sidecar does not match GitHub metadata/,
  );

  const tamperedSmallAssets = new Map(smallAssets);
  const manifestName = runtimeAssets.find(({ name }) => name.endsWith(".json")).name;
  const tamperedManifest = Buffer.from(tamperedSmallAssets.get(manifestName));
  tamperedManifest[0] ^= 1;
  tamperedSmallAssets.set(manifestName, tamperedManifest);
  assert.match(
    probeOpenVikingRuntimeRelease({
      release, expectedTag, runtimeVersion, inputFingerprint, smallAssets: tamperedSmallAssets,
    }).reason,
    /manifest .* digest does not match GitHub/,
  );

  const revisionConflict = probeOpenVikingRuntimeRelease({
    release,
    expectedTag,
    runtimeVersion,
    inputFingerprint: `sha256:${"b".repeat(64)}`,
    smallAssets,
  });
  assert.equal(revisionConflict.hardFailure, true);
  assert.match(revisionConflict.reason, /fingerprint changed without a runtime revision bump/);

  const legacyRelease = structuredClone(release);
  legacyRelease.assets = legacyRelease.assets.filter(({ name }) => name !== sidecarName);
  assert.deepEqual(
    probeOpenVikingRuntimeRelease({
      release: legacyRelease, expectedTag, runtimeVersion, inputFingerprint, smallAssets,
    }),
    {
      reusable: false,
      reason: "published release predates runtime input sidecars",
      legacyBootstrap: true,
      hardFailure: false,
    },
  );

  const unexpectedAsset = structuredClone(release);
  unexpectedAsset.assets.push({
    name: `openviking-runtime-${runtimeVersion}-linux-x64.tar.gz`,
    state: "uploaded",
    size: 1,
    digest: `sha256:${"0".repeat(64)}`,
  });
  assert.match(
    probeOpenVikingRuntimeRelease({
      release: unexpectedAsset, expectedTag, runtimeVersion, inputFingerprint, smallAssets,
    }).reason,
    /unexpected current runtime asset/,
  );
});

test("OpenViking runtime probe CLI falls back for ordinary misses but fails a revision conflict", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-probe-cli-"));
  const smallAssetsDirectory = path.join(directory, "small-assets");
  const runtimeVersion = "0.4.11-r7";
  const expectedTag = "v2-0.10.1";
  const inputs = await loadOpenVikingRuntimeInputs({ configPath: ".github/openviking-runtime-inputs.json" });
  assert.equal(inputs.config.runtimeVersion, runtimeVersion);
  const runtimeAssets = runtimeReleaseAssetNames(runtimeVersion).map((name) => ({
    name,
    size: 1,
    sha256: "0".repeat(64),
  }));
  const invokeProbe = () => spawnSync(process.execPath, [
    ".github/scripts/probe-openviking-runtime-release.mjs",
    "--config", ".github/openviking-runtime-inputs.json",
    "--release-json", path.join(directory, "release.json"),
    "--small-assets-dir", smallAssetsDirectory,
    "--tag", expectedTag,
  ], { cwd: process.cwd(), encoding: "utf8" });

  try {
    await writeFile(path.join(directory, "placeholder"), "fixture");
    await writeFile(path.join(directory, "release.json"), `${JSON.stringify({
      tag_name: expectedTag,
      draft: false,
      prerelease: false,
      published_at: "2026-08-15T00:00:00Z",
      assets: [],
    })}\n`);
    const legacyMiss = invokeProbe();
    assert.equal(legacyMiss.status, 2, legacyMiss.stderr);
    assert.match(legacyMiss.stderr, /reuse miss/);

    await mkdir(smallAssetsDirectory);
    const sidecarName = runtimeInputsSidecarName(runtimeVersion);
    const incompleteSidecar = createRuntimeInputsSidecar({
      runtimeVersion,
      inputFingerprint: inputs.inputFingerprint,
      runtimeAssets,
    });
    await writeFile(path.join(smallAssetsDirectory, sidecarName), incompleteSidecar);
    await writeFile(path.join(directory, "release.json"), `${JSON.stringify({
      tag_name: expectedTag,
      draft: false,
      prerelease: false,
      published_at: "2026-08-15T00:00:00Z",
      assets: [{
        name: sidecarName,
        state: "uploaded",
        size: incompleteSidecar.byteLength,
        digest: `sha256:${createHash("sha256").update(incompleteSidecar).digest("hex")}`,
      }],
    })}\n`);
    const incompleteMiss = invokeProbe();
    assert.equal(incompleteMiss.status, 2, incompleteMiss.stderr);
    assert.match(incompleteMiss.stderr, /missing trusted metadata/);

    const conflictingSidecar = createRuntimeInputsSidecar({
      runtimeVersion,
      inputFingerprint: `sha256:${"d".repeat(64)}`,
      runtimeAssets,
    });
    await writeFile(path.join(smallAssetsDirectory, sidecarName), conflictingSidecar);
    await writeFile(path.join(directory, "release.json"), `${JSON.stringify({
      tag_name: expectedTag,
      draft: false,
      prerelease: false,
      published_at: "2026-08-15T00:00:00Z",
      assets: [{
        name: sidecarName,
        state: "uploaded",
        size: conflictingSidecar.byteLength,
        digest: `sha256:${createHash("sha256").update(conflictingSidecar).digest("hex")}`,
      }],
    })}\n`);
    assert.notEqual(inputs.inputFingerprint, `sha256:${"d".repeat(64)}`);
    const revisionConflict = invokeProbe();
    assert.equal(revisionConflict.status, 1, revisionConflict.stderr);
    assert.match(revisionConflict.stderr, /fingerprint changed without a runtime revision bump/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenViking runtime sidecar binds every downloaded archive and manifest byte-for-byte", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-sidecar-"));
  const runtimeVersion = "0.4.11-r4";
  const inputFingerprint = `sha256:${"c".repeat(64)}`;
  try {
    const runtimeAssets = [];
    for (const target of OPENVIKING_RUNTIME_TARGETS) {
      const archiveName = `openviking-runtime-${runtimeVersion}-${target.platform}-${target.arch}.tar.gz`;
      const archiveBytes = Buffer.from(`archive:${target.platform}:${target.arch}`);
      const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
      const manifestName = `${archiveName}.json`;
      const manifestBytes = Buffer.from(`${JSON.stringify({
        version: runtimeVersion,
        platform: target.platform,
        arch: target.arch,
        sha256: archiveSha256,
        archiveType: "tar.gz",
        executablePath: target.executablePath,
        file: archiveName,
      }, null, 2)}\n`);
      runtimeAssets.push(
        { name: archiveName, size: archiveBytes.byteLength, sha256: archiveSha256 },
        {
          name: manifestName,
          size: manifestBytes.byteLength,
          sha256: createHash("sha256").update(manifestBytes).digest("hex"),
        },
      );
      await writeFile(path.join(directory, archiveName), archiveBytes);
      await writeFile(path.join(directory, manifestName), manifestBytes);
    }
    await writeFile(
      path.join(directory, runtimeInputsSidecarName(runtimeVersion)),
      createRuntimeInputsSidecar({ runtimeVersion, inputFingerprint, runtimeAssets }),
    );

    const sidecar = await verifyLocalRuntimeAssets({ directory, runtimeVersion, inputFingerprint });
    assert.deepEqual(sidecar.runtimeAssets, runtimeAssets);

    const archiveName = runtimeAssets[0].name;
    const tamperedBytes = Buffer.from(await readFile(path.join(directory, archiveName)));
    tamperedBytes[0] ^= 1;
    await writeFile(path.join(directory, archiveName), tamperedBytes);
    await assert.rejects(
      verifyLocalRuntimeAssets({ directory, runtimeVersion, inputFingerprint }),
      /does not match its input sidecar/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("OpenViking runtime fingerprint covers the matrix, builder, and dependency locks", async () => {
  const inputs = await loadOpenVikingRuntimeInputs({
    configPath: ".github/openviking-runtime-inputs.json",
  });
  assert.match(inputs.inputFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(inputs.matrix.include.map(({ platform, arch }) => `${platform}-${arch}`), [
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
  ]);
  assert.deepEqual(inputs.config.fingerprintFiles, [
    "apps/main-2.0/package.json",
    "apps/main-2.0/package-lock.json",
    "apps/main-2.0/scripts/build-openviking-runtime.mjs",
  ]);
  assert.deepEqual(inputs.config.nodeDependencies, ["tar"]);
  assert.equal(inputs.config.nodeVersion, "22.23.1");
  assert.equal(inputs.config.rustToolchain, "1.97.1");
});

test("OpenViking runtime fingerprint tracks builder dependencies without following app-only changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-fingerprint-"));
  const relativeFiles = [
    ".github/openviking-runtime-inputs.json",
    "apps/main-2.0/package.json",
    "apps/main-2.0/package-lock.json",
    "apps/main-2.0/scripts/build-openviking-runtime.mjs",
  ];
  try {
    for (const name of relativeFiles) {
      const destination = path.join(directory, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(name));
    }
    const configPath = path.join(directory, ".github/openviking-runtime-inputs.json");
    const loadInputs = () => loadOpenVikingRuntimeInputs({ configPath, rootDirectory: directory });
    const original = await loadInputs();

    const packagePath = path.join(directory, "apps/main-2.0/package.json");
    const lockPath = path.join(directory, "apps/main-2.0/package-lock.json");
    const packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
    const packageLock = JSON.parse(await readFile(lockPath, "utf8"));
    packageManifest.version = "9.8.7";
    packageLock.version = "9.8.7";
    packageLock.packages[""].version = "9.8.7";
    packageManifest.dependencies.electron = "99.0.0";
    packageLock.packages[""].dependencies.electron = "99.0.0";
    packageLock.packages["node_modules/electron"].version = "99.0.0";
    packageLock.packages["node_modules/electron"].integrity = `sha512-${"e".repeat(32)}`;
    await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`);
    await writeFile(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
    assert.equal((await loadInputs()).inputFingerprint, original.inputFingerprint);

    packageLock.packages["node_modules/tar"].integrity = `sha512-${"x".repeat(32)}`;
    await writeFile(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
    assert.notEqual((await loadInputs()).inputFingerprint, original.inputFingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenViking runtime input changes require a new revision before merge", () => {
  const base = {
    config: { runtimeVersion: "0.4.11-r6" },
    inputFingerprint: `sha256:${"a".repeat(64)}`,
  };
  assert.doesNotThrow(() => validateRuntimeRevisionChange(base, structuredClone(base)));
  assert.throws(
    () => validateRuntimeRevisionChange(base, {
      config: { runtimeVersion: "0.4.11-r6" },
      inputFingerprint: `sha256:${"b".repeat(64)}`,
    }),
    /inputs changed.*runtime revision/i,
  );
  assert.doesNotThrow(() => validateRuntimeRevisionChange(base, {
    config: { runtimeVersion: "0.4.11-r7" },
    inputFingerprint: `sha256:${"b".repeat(64)}`,
  }));
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
    ".github/openviking-runtime-inputs.json",
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
