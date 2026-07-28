import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { bumpVersion, parseReleaseNote } from "./release-notes.mjs";

function defaultRunCommand(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function firstStableV1Tag(output) {
  return String(output).split(/\r?\n/).find((tag) => /^v\d+\.\d+\.\d+$/.test(tag.trim()))?.trim() ?? "";
}

export function computeReleaseDecision({ mergedSha, noteFile, runCommand = defaultRunCommand, readNote = readFileSync }) {
  runCommand("git", ["fetch", "--tags", "--force"]);
  const existingTag = firstStableV1Tag(runCommand("git", [
    "tag",
    "--points-at",
    mergedSha,
    "--list",
    "v[0-9]*",
    "--sort=-v:refname",
  ]));

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

  const latestTag = firstStableV1Tag(runCommand("git", ["tag", "--list", "v[0-9]*", "--sort=-v:refname"]));
  const currentVersion = latestTag ? latestTag.slice(1) : JSON.parse(readNote("package.json", "utf8")).version;
  const note = parseReleaseNote(readNote(noteFile, "utf8"), noteFile);
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
    defaultRunCommand("npm", ["version", decision.version, "--no-git-tag-version"]);
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
