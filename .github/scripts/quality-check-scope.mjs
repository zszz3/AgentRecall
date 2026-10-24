#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const APPLICATIONS = [
  { app: "v1", label: "V1", directory: "apps/main-1.0" },
  { app: "v2", label: "V2", directory: "apps/main-2.0" },
];
const OPERATING_SYSTEMS = ["ubuntu-latest", "macos-latest", "windows-latest"];
const REPOSITORY_ONLY_FILES = new Set([
  ".gitignore",
  ".github/openviking-runtime-inputs.json",
  ".github/pull_request_template.md",
  ".github/scripts/probe-openviking-runtime-release.mjs",
  ".github/scripts/probe-v2-stable-release.mjs",
  ".github/workflows/contributors.yml",
  ".github/workflows/release.yml",
  ".github/workflows/update-star-history.yml",
  ".npmignore",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "Install.md",
  "LICENSE",
  "README.md",
  "assets/app-icon.png",
  "assets/logo.png",
  "assets/show.png",
  "assets/star-history-data.json",
  "assets/star-history.svg",
  "assets/tray-icon-template.svg",
  "assets/tray-iconTemplate.png",
  "assets/tray-iconTemplate@2x.png",
  "scripts/generate-star-history.mjs",
  "scripts/generate-star-history.test.mjs",
  "scripts/install-docs.test.mjs",
  "scripts/monorepo-layout.test.mjs",
  "scripts/release-notes.mjs",
  "scripts/release-notes.test.mjs",
]);

function applicationForPath(file) {
  for (const application of APPLICATIONS) {
    const prefix = `${application.directory}/`;
    if (!file.startsWith(prefix)) continue;
    const relativePath = file.slice(prefix.length);
    const documentation = relativePath === "README.md"
      || relativePath === "Install.md"
      || relativePath === "LICENSE"
      || relativePath.startsWith("docs/");
    return documentation ? null : application.app;
  }
  return undefined;
}

function createPlan(paths) {
  const selected = new Set();
  for (const rawPath of paths) {
    const file = rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (!file) continue;

    const application = applicationForPath(file);
    if (application) {
      selected.add(application);
      continue;
    }
    if (application === null
      || REPOSITORY_ONLY_FILES.has(file)
      || file.startsWith(".release-notes/")
      || file.startsWith("docs/")) continue;

    // Unknown shared paths fail closed so new build inputs cannot silently skip checks.
    selected.add("v1");
    selected.add("v2");
  }

  const applications = APPLICATIONS.filter(({ app }) => selected.has(app));
  const include = applications.length > 0
    ? applications.flatMap((application) => OPERATING_SYSTEMS.map((os) => ({ ...application, os })))
    : [{ app: "repository", label: "Repository", directory: "", os: "ubuntu-latest" }];
  return {
    verify: applications.length > 0,
    matrix: { include },
  };
}

function parseArguments(args) {
  if (args[0] === "--paths") return args.slice(1);
  if (args.length === 4 && args[0] === "--base" && args[2] === "--head") {
    const base = args[1];
    const head = args[3];
    if (!/^[0-9a-f]{40}$/iu.test(base) || !/^[0-9a-f]{40}$/iu.test(head)) {
      throw new Error("--base and --head must be full Git commit SHAs.");
    }
    const output = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return output.split("\0").filter(Boolean);
  }
  throw new Error("Usage: quality-check-scope.mjs --base <sha> --head <sha> | --paths [file ...]");
}

try {
  const plan = createPlan(parseArguments(process.argv.slice(2)));
  process.stdout.write(`verify=${plan.verify}\n`);
  process.stdout.write(`matrix=${JSON.stringify(plan.matrix)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
