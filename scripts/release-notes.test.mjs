import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  bumpVersion,
  combineReleaseNotes,
  combineReleaseNotesForTarget,
  findAddedReleaseNoteFiles,
  parseReleaseNote,
  releaseBumpFor,
  renderReleaseNotes,
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
  const v1 = parseReleaseNote("# Stable\n\n## Bug 修复\n\n- Stable fix.\n");
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
  assert.match(instructions, /product copy for end users, not engineering change logs/);
  assert.match(instructions, /Remove internal-only changes entirely/);
  assert.match(instructions, /omit identifiers, hosts, paths, table names, credentials/);
  assert.match(templateGuidance, /Write this as product copy for users, not as an engineering log/);
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

test("workflows require branch notes and publish accumulated changes every day or on demand", async () => {
  const noteWorkflow = await readFile(".github/workflows/release-note-check.yml", "utf8");
  const qualityWorkflow = await readFile(".github/workflows/quality-check.yml", "utf8");
  const releaseWorkflow = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(noteWorkflow, /pull_request:/);
  assert.match(noteWorkflow, /release-notes\.mjs check-range/);
  assert.match(qualityWorkflow, /os:\s*\[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(qualityWorkflow, /npm run setup/);
  assert.match(qualityWorkflow, /- name: Test\s+if: runner\.os != 'Windows'\s+run: npm test/);
  assert.match(qualityWorkflow, /- name: Test update and install scripts \(Windows\)\s+if: runner\.os == 'Windows'\s+run: npm run test:scripts/);
  assert.match(qualityWorkflow, /- name: Typecheck\s+run: npm run typecheck/);
  assert.match(qualityWorkflow, /- name: Build\s+run: npm run build/);
  assert.match(qualityWorkflow, /run: npm run package:smoke\s/);
  assert.match(qualityWorkflow, /run: npm run package:smoke:v2/);
  assert.match(releaseWorkflow, /schedule:[\s\S]*cron:\s*["']0 2 \* \* \*["']/);
  assert.match(releaseWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(releaseWorkflow, /^\s{2}push:/m);
  assert.match(releaseWorkflow, /gh api --paginate "repos\/\$\{GITHUB_REPOSITORY\}\/releases\?per_page=100"/);
  assert.match(releaseWorkflow, /published_tags_output="\$\([\s\S]*gh api --paginate/);
  const capturedTagsAssignment = /\r?\n\s*\)"\r?\n\s*mapfile -t published_tags <<< "\$published_tags_output"/;
  assert.match(releaseWorkflow, capturedTagsAssignment);
  const windowsReleaseWorkflow = releaseWorkflow.replaceAll("\n", "\r\n");
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
