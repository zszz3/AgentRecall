import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_NOTES_DIRECTORY = ".release-notes";
export const RELEASE_NOTE_HEADINGS = {
  features: "新增功能",
  fixes: "Bug 修复",
};

const VAGUE_RELEASE_NOTE_PATTERNS = [
  /^优化代码[。.]?$/,
  /^修复一些问题[。.]?$/,
  /^新增若干功能[。.]?$/,
  /^代码重构[。.]?$/,
];

export function parseReleaseNote(markdown, filePath = "release note") {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const titleLines = lines.filter((line) => /^#\s+\S/.test(line));
  const errors = [];
  if (titleLines.length !== 1) errors.push("must contain exactly one level-one title");

  const title = titleLines[0]?.replace(/^#\s+/, "").trim() ?? "";
  const features = [];
  const fixes = [];
  let section = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1];
    if (heading) {
      section = heading === RELEASE_NOTE_HEADINGS.features ? "features" : heading === RELEASE_NOTE_HEADINGS.fixes ? "fixes" : null;
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.+?)\s*$/)?.[1];
    if (!bullet || !section) continue;
    if (VAGUE_RELEASE_NOTE_PATTERNS.some((pattern) => pattern.test(bullet))) {
      errors.push(`contains vague user-facing copy: ${JSON.stringify(bullet)}`);
      continue;
    }
    if (section === "features") features.push(bullet);
    else fixes.push(bullet);
  }

  if (features.length + fixes.length === 0) {
    errors.push(`must contain at least one bullet under "## ${RELEASE_NOTE_HEADINGS.features}" or "## ${RELEASE_NOTE_HEADINGS.fixes}"`);
  }
  if (errors.length > 0) throw new Error(`${filePath}: ${errors.join("; ")}`);
  return { title, features, fixes };
}

export function readReleaseNote(filePath) {
  return parseReleaseNote(readFileSync(filePath, "utf8"), filePath);
}

export function releaseBumpFor(note) {
  return note.features.length > 0 ? "minor" : "patch";
}

export function bumpVersion(currentVersion, note) {
  const match = String(currentVersion).trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid stable semantic version: ${currentVersion}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return releaseBumpFor(note) === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export function renderReleaseNotes(note) {
  const sections = [`# ${note.title}`];
  if (note.features.length > 0) sections.push(`## ${RELEASE_NOTE_HEADINGS.features}\n\n${note.features.map((item) => `- ${item}`).join("\n")}`);
  if (note.fixes.length > 0) sections.push(`## ${RELEASE_NOTE_HEADINGS.fixes}\n\n${note.fixes.map((item) => `- ${item}`).join("\n")}`);
  return `${sections.join("\n\n")}\n`;
}

export function combineReleaseNotes(notes, title = "AgentRecall 更新") {
  return {
    title,
    features: [...new Set(notes.flatMap((note) => note.features))],
    fixes: [...new Set(notes.flatMap((note) => note.fixes))],
  };
}

export function findAddedReleaseNoteFiles(baseRef = "origin/main", headRef = "HEAD", runGit = defaultRunGit) {
  const committedOutput = runGit([
    "diff",
    "--name-only",
    "--diff-filter=A",
    `${baseRef}...${headRef}`,
    "--",
    RELEASE_NOTES_DIRECTORY,
  ]);
  const untrackedOutput = runGit(["ls-files", "--others", "--exclude-standard", "--", RELEASE_NOTES_DIRECTORY]);
  return [...new Set(`${committedOutput}\n${untrackedOutput}`
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.endsWith(".md") && path.basename(file).toLowerCase() !== "readme.md"))];
}

export function validateReleaseNoteRange(baseRef = "origin/main", headRef = "HEAD", runGit = defaultRunGit) {
  const files = findAddedReleaseNoteFiles(baseRef, headRef, runGit);
  if (files.length !== 1) {
    throw new Error(`Expected exactly one added ${RELEASE_NOTES_DIRECTORY}/*.md file between ${baseRef} and ${headRef}; found ${files.length}.`);
  }
  return { file: files[0], note: readReleaseNote(files[0]) };
}

function defaultRunGit(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function printUsage() {
  process.stderr.write(
    "Usage:\n" +
      "  node scripts/release-notes.mjs check-file <file>\n" +
      "  node scripts/release-notes.mjs check-range [base-ref] [head-ref]\n" +
      "  node scripts/release-notes.mjs next-version <current-version> <file>\n" +
      "  node scripts/release-notes.mjs render <file>\n" +
      "  node scripts/release-notes.mjs combine <file> [file...]\n",
  );
}

export function runCli(argv) {
  const [command, ...args] = argv;
  if (command === "check-file" && args[0]) {
    const note = readReleaseNote(args[0]);
    process.stdout.write(`${args[0]}: ${note.features.length} feature(s), ${note.fixes.length} fix(es)\n`);
    return;
  }
  if (command === "check-range") {
    const result = validateReleaseNoteRange(args[0] || "origin/main", args[1] || "HEAD");
    process.stdout.write(`${result.file}: ${result.note.features.length} feature(s), ${result.note.fixes.length} fix(es)\n`);
    return;
  }
  if (command === "next-version" && args[0] && args[1]) {
    process.stdout.write(`${bumpVersion(args[0], readReleaseNote(args[1]))}\n`);
    return;
  }
  if (command === "render" && args[0]) {
    process.stdout.write(renderReleaseNotes(readReleaseNote(args[0])));
    return;
  }
  if (command === "combine" && args.length > 0) {
    process.stdout.write(renderReleaseNotes(combineReleaseNotes(args.map(readReleaseNote))));
    return;
  }
  printUsage();
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
