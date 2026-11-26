import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { resolveNpmInvocation } from "./pack-release.mjs";
import { bumpVersion, parseReleaseNote } from "./release-notes.mjs";

function defaultRunCommand(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

function compareSemver(left, right) {
  const a = String(left).replace(/^v/, "").split(".").map(Number);
  const b = String(right).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function computeReleaseDecision({ mergedSha, noteFile, runCommand = defaultRunCommand, readNote = readFileSync }) {
  runCommand("git", ["fetch", "--tags", "--force"]);
  const existingTag = runCommand("git", [
    "tag",
    "--points-at",
    mergedSha,
    "--list",
    "v[0-9]*",
    "--sort=-v:refname",
  ]).split(/\r?\n/, 1)[0].trim();

  if (existingTag) {
    let releaseDraft = null;
    try {
      releaseDraft = runCommand("gh", ["release", "view", existingTag, "--json", "isDraft", "--jq", ".isDraft"]);
    } catch {
      // A tag without a release is a recoverable partial publication.
    }
    return {
      version: existingTag.slice(1),
      tag: existingTag,
      releaseRequired: releaseDraft?.trim() !== "false",
    };
  }

  const latestTag = runCommand("git", ["tag", "--list", "v[0-9]*", "--sort=-v:refname"])
    .split(/\r?\n/, 1)[0]
    .trim();
  const packageVersion = JSON.parse(readNote("package.json", "utf8")).version;
  const note = parseReleaseNote(readNote(noteFile, "utf8"), noteFile);
  // First unified 2.0 release after legacy v0.x tags starts directly at packageVersion (e.g. 2.0.0).
  if (latestTag && /^\d+\.\d+\.\d+$/.test(packageVersion) && compareSemver(latestTag.slice(1), packageVersion) < 0) {
    return { version: packageVersion, tag: `v${packageVersion}`, releaseRequired: true };
  }
  const currentVersion = latestTag ? latestTag.slice(1) : packageVersion;
  const version = bumpVersion(currentVersion, note);
  return { version, tag: `v${version}`, releaseRequired: true };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function main() {
  const decision = computeReleaseDecision({
    mergedSha: requiredEnv("MERGED_SHA"),
    noteFile: requiredEnv("NOTE_FILE"),
  });
  if (decision.releaseRequired) {
    const npm = resolveNpmInvocation(["version", decision.version, "--no-git-tag-version"]);
    defaultRunCommand(npm.command, npm.args, {
      windowsHide: true,
      ...(npm.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } else {
    console.log(`Release ${decision.tag} is already published for this merge commit; skipping duplicate release run.`);
  }

  const outputFile = requiredEnv("GITHUB_OUTPUT");
  appendFileSync(
    outputFile,
    `version=${decision.version}\ntag=${decision.tag}\nrelease_required=${decision.releaseRequired}\n`,
    "utf8",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
