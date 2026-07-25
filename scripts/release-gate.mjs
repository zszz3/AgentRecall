import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_GATE_SCHEMA_VERSION = 1;
export const RELEASE_GATE_STATUSES = Object.freeze(["PASS", "FAIL", "BLOCKED"]);

export const RELEASE_GATE_DEFINITIONS = Object.freeze([
  {
    id: "install.macos-arm64",
    category: "installation",
    title: "macOS arm64 DMG and zip install",
    expected: { platform: "macos", arch: "arm64" },
  },
  {
    id: "install.macos-x64",
    category: "installation",
    title: "macOS x64 DMG and zip install",
    expected: { platform: "macos", arch: "x64" },
  },
  {
    id: "install.windows-x64",
    category: "installation",
    title: "Windows x64 NSIS install",
    expected: { platform: "windows", arch: "x64" },
  },
  {
    id: "startup.first-window-3s",
    category: "experience",
    title: "First usable window within 3 seconds",
    expected: { maxFirstUsableWindowMs: 3000 },
  },
  {
    id: "search.10k-p95-200ms",
    category: "experience",
    title: "10,000-session search p95 within 200 ms",
    expected: { minSessions: 10_000, maxQueryP95Ms: 200 },
  },
  {
    id: "render.markdown",
    category: "experience",
    title: "Markdown and code rendering",
  },
  {
    id: "resume.claude-code",
    category: "experience",
    title: "Resume a Claude Code session",
  },
  {
    id: "resume.codex",
    category: "experience",
    title: "Resume a Codex session",
  },
  {
    id: "config.persistence-isolation",
    category: "privacy",
    title: "Settings persist without changing upstream configuration",
    expected: { unchangedArtifacts: true },
  },
  {
    id: "privacy.upstream-files-unchanged",
    category: "privacy",
    title: "Upstream session files remain unchanged",
    expected: { unchangedArtifacts: true },
  },
  {
    id: "network.disabled-means-off",
    category: "privacy",
    title: "No automatic network when updates and advanced tasks are off",
    expected: {
      updatesDisabled: true,
      advancedTasksStarted: 0,
      unexpectedRequests: 0,
    },
  },
  {
    id: "update.user-controlled",
    category: "lifecycle",
    title: "Update check is user-controlled and never auto-downloads",
  },
  {
    id: "update.backup-and-db-close",
    category: "lifecycle",
    title: "Database closes safely and a versioned backup exists before update",
  },
  {
    id: "rollback.previous-signed",
    category: "lifecycle",
    title: "Rollback to the previous signed version",
  },
  {
    id: "uninstall.windows-preserve",
    category: "lifecycle",
    title: "Windows default uninstall preserves user data",
  },
  {
    id: "uninstall.windows-clean",
    category: "lifecycle",
    title: "Windows explicit cleanup removes only AgentRecall data",
  },
  {
    id: "uninstall.macos",
    category: "lifecycle",
    title: "macOS standard uninstall and explicit data cleanup",
  },
  {
    id: "quality.no-p0-p1",
    category: "quality",
    title: "No open P0 or P1 defects",
    expected: { p0Open: 0, p1Open: 0 },
  },
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validateTimestamp(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function validateEvidenceMetadata(record) {
  const errors = [];
  if (!validateTimestamp(record.observedAt)) {
    errors.push("observedAt must be a valid ISO 8601 timestamp");
  }
  if (typeof record.evidence !== "string" || record.evidence.trim().length === 0) {
    errors.push("evidence must reference a sanitized log, screenshot, checksum, or report");
  }
  return errors;
}

function validatePlatform(definition, record) {
  const errors = [];
  if (definition.expected?.platform && record.platform !== definition.expected.platform) {
    errors.push(`platform must be ${definition.expected.platform}`);
  }
  if (definition.expected?.arch && record.arch !== definition.expected.arch) {
    errors.push(`arch must be ${definition.expected.arch}`);
  }
  return errors;
}

function validateUnchangedArtifacts(record) {
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    return ["artifacts must contain at least one synthetic file hash comparison"];
  }
  const errors = [];
  for (const [index, artifact] of record.artifacts.entries()) {
    const prefix = `artifacts[${index}]`;
    if (typeof artifact?.label !== "string" || artifact.label.trim().length === 0) {
      errors.push(`${prefix}.label must identify a sanitized synthetic fixture`);
    }
    if (!SHA256_PATTERN.test(artifact?.beforeSha256 ?? "")) {
      errors.push(`${prefix}.beforeSha256 must be a SHA-256 digest`);
    }
    if (!SHA256_PATTERN.test(artifact?.afterSha256 ?? "")) {
      errors.push(`${prefix}.afterSha256 must be a SHA-256 digest`);
    }
    if (
      SHA256_PATTERN.test(artifact?.beforeSha256 ?? "")
      && SHA256_PATTERN.test(artifact?.afterSha256 ?? "")
      && artifact.beforeSha256.toLowerCase() !== artifact.afterSha256.toLowerCase()
    ) {
      errors.push(`${prefix} changed during the test`);
    }
  }
  return errors;
}

function validatePassClaim(definition, record) {
  const errors = [
    ...validateEvidenceMetadata(record),
    ...validatePlatform(definition, record),
  ];

  if (definition.id === "startup.first-window-3s") {
    const value = asFiniteNumber(record.metrics?.firstUsableWindowMs);
    if (value === null) errors.push("metrics.firstUsableWindowMs must be a finite number");
    else if (value > definition.expected.maxFirstUsableWindowMs) {
      errors.push(`first usable window took ${value} ms, above ${definition.expected.maxFirstUsableWindowMs} ms`);
    }
  }

  if (definition.id === "search.10k-p95-200ms") {
    const sessions = asFiniteNumber(record.dataset?.sessions);
    const queryP95Ms = asFiniteNumber(record.metrics?.queryP95Ms);
    if (sessions === null) errors.push("dataset.sessions must be a finite number");
    else if (sessions < definition.expected.minSessions) {
      errors.push(`dataset contains ${sessions} sessions, below ${definition.expected.minSessions}`);
    }
    if (queryP95Ms === null) errors.push("metrics.queryP95Ms must be a finite number");
    else if (queryP95Ms > definition.expected.maxQueryP95Ms) {
      errors.push(`search p95 was ${queryP95Ms} ms, above ${definition.expected.maxQueryP95Ms} ms`);
    }
  }

  if (definition.expected?.unchangedArtifacts) {
    errors.push(...validateUnchangedArtifacts(record));
  }

  if (definition.id === "network.disabled-means-off") {
    if (record.settings?.updatesDisabled !== true) {
      errors.push("settings.updatesDisabled must be true");
    }
    if (record.metrics?.advancedTasksStarted !== 0) {
      errors.push("metrics.advancedTasksStarted must be 0");
    }
    if (record.metrics?.unexpectedRequests !== 0) {
      errors.push("metrics.unexpectedRequests must be 0");
    }
  }

  if (definition.id === "quality.no-p0-p1") {
    if (record.metrics?.p0Open !== 0) errors.push("metrics.p0Open must be 0");
    if (record.metrics?.p1Open !== 0) errors.push("metrics.p1Open must be 0");
  }

  return errors;
}

function normalizeClaimedStatus(value) {
  return typeof value === "string" ? value.toUpperCase() : "";
}

function evaluateDefinition(definition, record) {
  if (!record) {
    return {
      ...definition,
      status: "BLOCKED",
      reason: "No evidence supplied for this release candidate.",
    };
  }

  const claimedStatus = normalizeClaimedStatus(record.status);
  if (!RELEASE_GATE_STATUSES.includes(claimedStatus)) {
    return {
      ...definition,
      status: "FAIL",
      reason: `Invalid evidence status: ${String(record.status)}`,
    };
  }

  if (claimedStatus === "BLOCKED") {
    return {
      ...definition,
      status: "BLOCKED",
      reason: typeof record.reason === "string" && record.reason.trim()
        ? record.reason.trim()
        : "Evidence explicitly marks this gate as blocked.",
      notes: record.notes,
    };
  }

  const metadataErrors = validateEvidenceMetadata(record);
  if (claimedStatus === "FAIL") {
    return {
      ...definition,
      status: "FAIL",
      reason: metadataErrors.length > 0
        ? `Invalid failure evidence: ${metadataErrors.join("; ")}`
        : (record.reason || "The observed result did not meet the release requirement."),
      observedAt: record.observedAt,
      evidence: record.evidence,
      notes: record.notes,
    };
  }

  const errors = validatePassClaim(definition, record);
  return {
    ...definition,
    status: errors.length === 0 ? "PASS" : "FAIL",
    reason: errors.length === 0
      ? "Evidence meets the release requirement."
      : `Invalid PASS claim: ${errors.join("; ")}`,
    observedAt: record.observedAt,
    evidence: record.evidence,
    notes: record.notes,
  };
}

export function evaluateReleaseGate(evidence = {}, options = {}) {
  const records = evidence?.gates && typeof evidence.gates === "object" ? evidence.gates : {};
  const gates = RELEASE_GATE_DEFINITIONS.map((definition) =>
    evaluateDefinition(definition, records[definition.id]));
  const counts = Object.fromEntries(
    RELEASE_GATE_STATUSES.map((status) => [
      status,
      gates.filter((gate) => gate.status === status).length,
    ]),
  );
  const status = counts.FAIL > 0 ? "FAIL" : counts.BLOCKED > 0 ? "BLOCKED" : "PASS";

  return {
    schemaVersion: RELEASE_GATE_SCHEMA_VERSION,
    release: evidence.release ?? null,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    status,
    counts,
    gates,
  };
}

export function createEvidenceTemplate(release = "{{version}}") {
  return {
    schemaVersion: RELEASE_GATE_SCHEMA_VERSION,
    release,
    gates: Object.fromEntries(
      RELEASE_GATE_DEFINITIONS.map((definition) => [
        definition.id,
        {
          status: "BLOCKED",
          reason: "Not yet verified on this release candidate.",
        },
      ]),
    ),
  };
}

export function exitCodeForStatus(status) {
  if (status === "PASS") return 0;
  if (status === "BLOCKED") return 2;
  return 1;
}

export function renderTextReport(report) {
  const lines = [
    `AgentRecall 1.0 release gate: ${report.status}`,
    `PASS ${report.counts.PASS} | FAIL ${report.counts.FAIL} | BLOCKED ${report.counts.BLOCKED}`,
    "",
  ];
  for (const gate of report.gates) {
    lines.push(`[${gate.status}] ${gate.id} — ${gate.title}`);
    lines.push(`  ${gate.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

function usage() {
  return [
    "Usage: node scripts/release-gate.mjs [options]",
    "",
    "Options:",
    "  --evidence <path>       Read explicit synthetic/CI evidence JSON",
    "  --format <text|json>    Output format (default: text)",
    "  --write-template <path> Write a BLOCKED evidence template and exit",
    "  --release <version>     Release label used by --write-template",
    "  --help                  Show this help",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--evidence") options.evidencePath = argv[++index];
    else if (argument === "--format") options.format = argv[++index];
    else if (argument === "--write-template") options.templatePath = argv[++index];
    else if (argument === "--release") options.release = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["text", "json"].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }
  if (options.evidencePath === undefined && argv.includes("--evidence")) {
    throw new Error("--evidence requires a path");
  }
  if (options.templatePath === undefined && argv.includes("--write-template")) {
    throw new Error("--write-template requires a path");
  }
  return options;
}

export async function runReleaseGateCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const options = parseArguments(argv);
  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  if (options.templatePath) {
    const templatePath = path.resolve(options.templatePath);
    await writeFile(
      templatePath,
      `${JSON.stringify(createEvidenceTemplate(options.release), null, 2)}\n`,
      "utf8",
    );
    stdout.write(`Wrote BLOCKED evidence template: ${templatePath}\n`);
    return 0;
  }

  let evidence = {};
  if (options.evidencePath) {
    evidence = JSON.parse(await readFile(path.resolve(options.evidencePath), "utf8"));
  }
  const report = evaluateReleaseGate(evidence);
  stdout.write(options.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderTextReport(report));
  return exitCodeForStatus(report.status);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    process.exitCode = await runReleaseGateCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Release gate error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
