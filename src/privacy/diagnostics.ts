import * as os from "node:os";
import * as path from "node:path";
import { inspectLegacyIntegrations, type LegacyIntegrationInspection } from "./legacy-integrations";

export type DiagnosticHealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";
export type DiagnosticPathMode = "full" | "home" | "basename";

export interface DiagnosticHealth {
  status: DiagnosticHealthStatus;
  detail?: string;
  path?: string;
  [key: string]: unknown;
}

export interface DiagnosticSourceCount {
  source: string;
  count: number;
  status?: DiagnosticHealthStatus;
  detail?: string;
}

export interface DiagnosticCli {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
  [key: string]: unknown;
}

export interface DiagnosticTerminal {
  selected: string;
  available: boolean;
  path?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface DiagnosticUpdate {
  automaticChecksEnabled: boolean;
  status: string;
  currentVersion?: string;
  availableVersion?: string;
  lastCheckedAt?: string | null;
  errorCode?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

export interface PrivacyDiagnosticInput {
  version: string;
  homeDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  osRelease?: string;
  data: DiagnosticHealth;
  database: DiagnosticHealth;
  sources: readonly DiagnosticSourceCount[];
  cli: readonly DiagnosticCli[];
  terminal: DiagnosticTerminal;
  update: DiagnosticUpdate;
  pathMode?: DiagnosticPathMode;
  generatedAt?: Date;
  legacy?: LegacyIntegrationInspection;
}

export interface PrivacyDiagnosticReport {
  schemaVersion: 1;
  generatedAt: string;
  app: { version: string };
  system: { platform: NodeJS.Platform; arch: string; release: string };
  storage: { data: DiagnosticHealth; database: DiagnosticHealth };
  sessions: { total: number; sources: DiagnosticSourceCount[] };
  cli: DiagnosticCli[];
  terminal: DiagnosticTerminal;
  update: DiagnosticUpdate;
  legacyIntegrations: {
    findingCount: number;
    issueCount: number;
    findings: LegacyIntegrationInspection["findings"];
    issues: LegacyIntegrationInspection["issues"];
  };
}

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)/i;
const SECRET_ASSIGNMENT = /((?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const URL_SECRET = /([?&](?:api[-_]?key|access[-_]?token|auth|password|secret|token)=)[^&#\s]+/gi;
const PROVIDER_KEY = /\b(?:sk|sk-ant|ghp|github_pat)-[A-Za-z0-9_-]{8,}\b/gi;

function redactPathInString(value: string, homeDir: string, mode: DiagnosticPathMode): string {
  if (mode === "full") return value;
  const normalizedHome = path.resolve(homeDir);
  const homeVariants = new Set([
    normalizedHome,
    normalizedHome.replaceAll(path.sep, "/"),
    normalizedHome.replaceAll(path.sep, "\\"),
  ]);
  let redacted = value;
  for (const home of homeVariants) {
    if (!home) continue;
    if (mode === "home") redacted = redacted.replaceAll(home, "~");
    else {
      const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      redacted = redacted.replace(new RegExp(`${escaped}(?:[/\\\\][^\\s"'<>]+)*`, "gi"), "<path>");
    }
  }
  if (mode === "basename" && path.isAbsolute(redacted)) return `<path>/${path.basename(redacted)}`;
  return redacted;
}

function sanitizeString(value: string, homeDir: string, pathMode: DiagnosticPathMode): string {
  const withoutSecrets = value
    .replace(SECRET_ASSIGNMENT, "$1<redacted>")
    .replace(BEARER_TOKEN, "$1 <redacted>")
    .replace(URL_SECRET, "$1<redacted>")
    .replace(PROVIDER_KEY, "<redacted>");
  return redactPathInString(withoutSecrets, homeDir, pathMode);
}

/** Credentials are always redacted. Path redaction is independently selectable. */
export function sanitizeDiagnosticValue(
  value: unknown,
  options: { homeDir: string; pathMode?: DiagnosticPathMode },
  key = "",
): unknown {
  if (SENSITIVE_KEY.test(key)) return "<redacted>";
  const pathMode = options.pathMode ?? "home";
  if (typeof value === "string") return sanitizeString(value, options.homeDir, pathMode);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, options));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      sanitizeDiagnosticValue(nestedValue, options, nestedKey),
    ]));
  }
  return value;
}

/**
 * Collects only supplied local state plus read-only integration inspection.
 * It does not execute a CLI, contact an update server, or start background work.
 */
export async function collectPrivacyDiagnostics(
  input: PrivacyDiagnosticInput,
): Promise<PrivacyDiagnosticReport> {
  const legacy = input.legacy ?? await inspectLegacyIntegrations({ homeDir: input.homeDir });
  const raw: PrivacyDiagnosticReport = {
    schemaVersion: 1,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    app: { version: input.version },
    system: {
      platform: input.platform ?? process.platform,
      arch: input.arch ?? process.arch,
      release: input.osRelease ?? os.release(),
    },
    storage: { data: input.data, database: input.database },
    sessions: {
      total: input.sources.reduce((total, source) => total + Math.max(0, source.count), 0),
      sources: [...input.sources],
    },
    cli: [...input.cli],
    terminal: input.terminal,
    update: input.update,
    legacyIntegrations: {
      findingCount: legacy.findings.length,
      issueCount: legacy.issues.length,
      findings: legacy.findings,
      issues: legacy.issues,
    },
  };
  return sanitizeDiagnosticValue(raw, {
    homeDir: input.homeDir,
    pathMode: input.pathMode,
  }) as PrivacyDiagnosticReport;
}

export function formatPrivacyDiagnostics(report: PrivacyDiagnosticReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
