import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import type { UsageQuota, UsageQuotaCard, UsageQuotaProvider, UsageQuotaSnapshot } from "./types";

const CODEX_USAGE_PRIMARY_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_FALLBACK_URL = "https://chatgpt.com/api/codex/usage";
const HTTP_BODY_LIMIT = 64 * 1024;

const QUOTA_FIVE_HOUR = "five_hour";
const QUOTA_SEVEN_DAY = "seven_day";
const QUOTA_CODE_REVIEW = "code_review";
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;
const CLAUDE_STATUSLINE_SCRIPT_BASENAME = "claude-statusline-snapshot.cjs";
const CLAUDE_STATUSLINE_BIN_NAME = "agent-recall-claude-statusline";

interface QuotaLoadOptions {
  now?: Date;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export interface UsageQuotaLoadOptions extends QuotaLoadOptions {
  codexFetcher?: CodexUsageFetcher;
  hideCodexQuota?: boolean;
  hideClaudeQuota?: boolean;
}

export type CodexUsageFetcher = (accessToken: string, accountId: string) => Promise<CodexUsageResponse>;

export interface CodexUsageWindow {
  used_percent?: number;
  percent_left?: number;
  remaining_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
}

export interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: CodexUsageWindow | null;
    secondary_window?: CodexUsageWindow | null;
  };
  code_review_rate_limit?: {
    primary_window?: CodexUsageWindow | null;
  };
}

interface CodexAuthFile {
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

interface ClaudeStatuslineFile {
  plan?: string;
  source?: string;
  updated_at?: string;
  quotas?: Record<string, ClaudeStatuslineQuota | undefined>;
  model?: unknown;
  cost?: unknown;
  context_window?: unknown;
  session_id?: string;
  five_hour_used_percent?: number;
  five_hour_remaining_percent?: number;
  five_hour_resets_at?: string;
  seven_day_used_percent?: number;
  seven_day_remaining_percent?: number;
  seven_day_resets_at?: string;
  rate_limits?: {
    five_hour?: ClaudeOnwatchWindow;
    seven_day?: ClaudeOnwatchWindow;
  };
}

interface ClaudeOnwatchWindow {
  used_percentage?: number;
  remaining_percentage?: number;
  resets_at?: number;
}

interface ClaudeStatuslineQuota {
  label?: string;
  used_percent?: number;
  used_percentage?: number;
  remaining_percent?: number;
  remaining_percentage?: number;
  resets_at?: string;
  stale?: boolean;
}

export async function loadUsageQuotaSnapshot(options: UsageQuotaLoadOptions = {}): Promise<UsageQuotaSnapshot> {
  const now = options.now ?? new Date();
  // Hidden providers are skipped at the source: no HTTP/file load and no card. They are still
  // reported in hiddenProviders so the UI can distinguish "user hid everything" from a real failure.
  const [codex, claudeCode] = await Promise.all([
    options.hideCodexQuota ? Promise.resolve(null) : loadCodexQuotaCard({ ...options, now }),
    options.hideClaudeQuota ? Promise.resolve(null) : Promise.resolve(loadClaudeQuotaCard({ ...options, now })),
  ]);
  const hiddenProviders: UsageQuotaProvider[] = [];
  if (options.hideCodexQuota) hiddenProviders.push("codex");
  if (options.hideClaudeQuota) hiddenProviders.push("claude-code");
  return {
    generatedAt: now.toISOString(),
    providers: [codex, claudeCode].filter((card): card is UsageQuotaCard => card !== null),
    hiddenProviders,
  };
}

export async function loadCodexQuotaCard(options: UsageQuotaLoadOptions = {}): Promise<UsageQuotaCard> {
  const now = options.now ?? new Date();
  const card = baseQuotaCard("codex", "Codex", "Run `codex login` to show subscription quota.");
  const authPath = firstExistingFile(codexAuthCandidates(options));
  if (!authPath) return card;

  let auth: CodexAuthFile;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8")) as CodexAuthFile;
  } catch (error) {
    return {
      ...card,
      status: "error",
      source: "auth.json",
      detail: error instanceof SyntaxError ? "auth.json is not valid JSON." : "Could not read auth.json.",
    };
  }

  const accessToken = auth.tokens?.access_token?.trim() ?? "";
  const accountId = auth.tokens?.account_id?.trim() ?? "";
  const apiKey = auth.OPENAI_API_KEY?.trim() ?? "";

  if (!accessToken && apiKey) {
    return {
      ...card,
      status: "unsupported_api_key",
      source: "auth.json",
      detail: "Codex is using an API key, so subscription quota is not available.",
    };
  }
  if (!accessToken) {
    return {
      ...card,
      status: "not_configured",
      source: "auth.json",
      detail: "auth.json exists but has no OAuth access token. Run `codex login` again.",
    };
  }

  const proxyUrl = selectProxyUrl(options.env ?? process.env);
  const fetcher: CodexUsageFetcher = options.codexFetcher ?? ((token, account) => fetchCodexUsageHTTP(token, account, { proxyUrl }));
  try {
    const usage = await fetcher(accessToken, accountId);
    const quotas = codexQuotasFromResponse(usage, now);
    return {
      provider: "codex",
      displayName: "Codex",
      status: "supported",
      source: "chatgpt.com",
      plan: displayPlanName(usage.plan_type),
      quotas,
      detail: quotas.length === 0 ? "Subscription detected, but the quota response did not include limits." : undefined,
    };
  } catch (error) {
    return {
      ...card,
      status: "error",
      source: "auth.json",
      detail: sanitizeCodexError(error),
    };
  }
}

export function loadClaudeQuotaCard(options: QuotaLoadOptions = {}): UsageQuotaCard {
  const now = options.now ?? new Date();
  const card = baseQuotaCard("claude-code", "Claude Code", "Install a Claude Code statusline bridge that writes ~/.claude/statusline-snapshot.json.");
  const bridgeStatus = ensureClaudeStatuslineBridge(options);
  const statuslinePath = firstExistingFile(claudeStatuslineCandidates(options));
  if (!statuslinePath) {
    return {
      ...card,
      detail:
        bridgeStatus === "installed"
          ? "Claude Code statusline bridge installed. Restart Claude Code, then run one request to generate quota data."
          : bridgeStatus === "conflict"
            ? "Claude Code has a different statusLine configured, so AgentRecall cannot generate quota data automatically."
            : card.detail,
    };
  }

  let raw: ClaudeStatuslineFile;
  try {
    raw = JSON.parse(readFileSync(statuslinePath, "utf8")) as ClaudeStatuslineFile;
  } catch (error) {
    return {
      ...card,
      status: "error",
      source: "statusline",
      detail: error instanceof SyntaxError ? "Statusline file is not valid JSON." : "Could not read statusline file.",
    };
  }

  const quotas = claudeQuotasFromStatusline(raw, now);
  const next: UsageQuotaCard = {
    provider: "claude-code",
    displayName: "Claude Code",
    status: quotas.length > 0 ? "supported" : "not_configured",
    source: raw.source?.trim() || "statusline",
    plan: displayPlanName(raw.plan),
    quotas,
  };

  if (quotas.length === 0) {
    next.status = looksLikeClaudeApiUsage(raw) ? "unsupported_api_key" : "not_configured";
    next.detail = looksLikeClaudeApiUsage(raw)
      ? "Claude statusline has API usage data, but no subscription quota."
      : "Claude statusline file has no quota data.";
  }
  return next;
}

type ClaudeStatuslineBridgeStatus = "installed" | "already" | "conflict" | "error" | "skipped";

function ensureClaudeStatuslineBridge(options: QuotaLoadOptions): ClaudeStatuslineBridgeStatus {
  const home = getHomeDir(options);
  if (!home) return "skipped";
  const settingsPath = path.join(home, ".claude", "settings.json");
  const command = buildClaudeStatuslineCommand();

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf8");
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as unknown;
        if (!isPlainObject(parsed)) return "error";
        settings = parsed;
      }
    } catch {
      return "error";
    }
  }

  const existing = settings.statusLine;
  if (existing !== undefined && existing !== null) {
    const existingCommand = isPlainObject(existing) && typeof existing.command === "string" ? existing.command : "";
    // If the existing statusLine command is already ours (regardless of path), leave it alone.
    // Changing the path risks breaking the bridge when the resolved path differs between runs.
    if (isOurClaudeStatuslineCommand(existingCommand)) return "already";
    if (existingCommand) return "conflict";
  }

  settings.statusLine = { type: "command", command };
  try {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeJsonAtomic(settingsPath, settings);
    return "installed";
  } catch {
    return "error";
  }
}

function buildClaudeStatuslineCommand(): string {
  const scriptPath = localClaudeStatuslineScriptPath();
  if (scriptPath) {
    return process.platform === "win32" ? `node "${scriptPath}"` : `"${scriptPath}"`;
  }
  return process.platform === "win32" ? `${CLAUDE_STATUSLINE_BIN_NAME}.cmd` : CLAUDE_STATUSLINE_BIN_NAME;
}

function localClaudeStatuslineScriptPath(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../bin", CLAUDE_STATUSLINE_SCRIPT_BASENAME),
    path.resolve(process.cwd(), "bin", CLAUDE_STATUSLINE_SCRIPT_BASENAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isOurClaudeStatuslineCommand(command: string): boolean {
  return command.includes(CLAUDE_STATUSLINE_SCRIPT_BASENAME) || command.includes(CLAUDE_STATUSLINE_BIN_NAME);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function baseQuotaCard(provider: UsageQuotaCard["provider"], displayName: string, detail: string): UsageQuotaCard {
  return {
    provider,
    displayName,
    status: "not_configured",
    quotas: [],
    detail,
  };
}

function codexAuthCandidates(options: QuotaLoadOptions): string[] {
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return [path.join(codexHome, "auth.json")];
  const home = getHomeDir(options);
  return home ? [path.join(home, ".codex", "auth.json")] : [];
}

function claudeStatuslineCandidates(options: QuotaLoadOptions): string[] {
  const env = options.env ?? process.env;
  const home = getHomeDir(options);
  const candidates: string[] = [];
  const explicitPaths = [env.AGENT_RECALL_CLAUDE_STATUSLINE?.trim(), env.KABOO_CLAUDE_STATUSLINE?.trim()];
  for (const explicitPath of explicitPaths) {
    if (explicitPath) candidates.push(expandHome(explicitPath, home));
  }
  if (home) {
    candidates.push(
      path.join(home, ".claude", "statusline-snapshot.json"),
      path.join(home, ".claude", "kaboo-statusline.json"),
      path.join(home, ".claude", "anthropic-statusline.json"),
      path.join(home, ".local", "share", "kaboo", "claude_statusline.json"),
      path.join(home, ".onwatch", "data", "anthropic-statusline.json"),
      path.join(home, ".local", "share", "onwatch", "claude_statusline.json"),
    );
  }
  return candidates;
}

function firstExistingFile(paths: string[]): string | null {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Ignore invalid paths from environment overrides.
    }
  }
  return null;
}

function getHomeDir(options: QuotaLoadOptions): string {
  return options.homeDir ?? homedir();
}

function expandHome(value: string, homeDir: string): string {
  if (!value.startsWith("~/")) return value;
  return homeDir ? path.join(homeDir, value.slice(2)) : value;
}

function pickNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function codexWindowUsedPercent(window: CodexUsageWindow): number | undefined {
  if (isFiniteNumber(window.used_percent)) return window.used_percent;
  // Some API versions return the remaining percentage instead of the used percentage.
  if (isFiniteNumber(window.percent_left)) return 100 - window.percent_left;
  if (isFiniteNumber(window.remaining_percent)) return 100 - window.remaining_percent;
  return undefined;
}

function codexWindowResetAt(window: CodexUsageWindow, now: Date): number | undefined {
  if (isFiniteNumber(window.reset_at)) return window.reset_at;
  if (isFiniteNumber(window.reset_after_seconds) && window.reset_after_seconds >= 0) {
    return Math.floor(now.getTime() / 1000) + window.reset_after_seconds;
  }
  return undefined;
}

function codexWindowIdentity(
  window: CodexUsageWindow,
  fallback: { key: string; label: string },
): { key: string; label: string } {
  if (window.limit_window_seconds === FIVE_HOURS_SECONDS) return { key: QUOTA_FIVE_HOUR, label: "5h" };
  if (window.limit_window_seconds === SEVEN_DAYS_SECONDS) return { key: QUOTA_SEVEN_DAY, label: "7d" };
  return fallback;
}

function codexQuotasFromResponse(response: CodexUsageResponse, now: Date): UsageQuota[] {
  const quotas: UsageQuota[] = [];
  const primary = response.rate_limit?.primary_window ?? null;
  const secondary = response.rate_limit?.secondary_window ?? null;
  const codeReview = response.code_review_rate_limit?.primary_window ?? null;
  if (primary) {
    const identity = codexWindowIdentity(primary, { key: QUOTA_FIVE_HOUR, label: "5h" });
    quotas.push(quotaFromUsedPercent(identity.key, identity.label, codexWindowUsedPercent(primary), codexWindowResetAt(primary, now), now));
  }
  if (secondary) {
    const identity = codexWindowIdentity(secondary, { key: QUOTA_SEVEN_DAY, label: "7d" });
    quotas.push(quotaFromUsedPercent(identity.key, identity.label, codexWindowUsedPercent(secondary), codexWindowResetAt(secondary, now), now));
  }
  if (codeReview) quotas.push(quotaFromUsedPercent(QUOTA_CODE_REVIEW, "Review", codexWindowUsedPercent(codeReview), codexWindowResetAt(codeReview, now), now));
  return quotas.filter(Boolean);
}

function claudeQuotasFromStatusline(raw: ClaudeStatuslineFile, now: Date): UsageQuota[] {
  const quotas: UsageQuota[] = [];
  const add = (key: string, label: string, used?: number, remaining?: number, resetsAt?: string, stale?: boolean): void => {
    const quota = quotaFromPair(key, label, used, remaining, resetsAt, now, stale);
    if (quota) quotas.push(quota);
  };

  if (raw.quotas && Object.keys(raw.quotas).length > 0) {
    for (const [key, value] of Object.entries(raw.quotas)) {
      if (!value) continue;
      // Some tools write used_percentage / remaining_percentage (with "age" suffix)
      // instead of used_percent / remaining_percent.
      const usedPct = pickNumber(value.used_percent) ?? pickNumber(value.used_percentage);
      const remainingPct = pickNumber(value.remaining_percent) ?? pickNumber(value.remaining_percentage);
      // Leave stale undefined (not false) when the field is absent so normalizeQuota can still
      // auto-detect staleness from resets_at; an explicit `false` would suppress that.
      const staleFlag = value.stale === true ? true : undefined;
      add(key, value.label || quotaLabel(key), usedPct, remainingPct, value.resets_at, staleFlag);
    }
    return quotas;
  }

  if (raw.rate_limits) {
    const fiveHour = raw.rate_limits.five_hour;
    const sevenDay = raw.rate_limits.seven_day;
    if (fiveHour) {
      add(QUOTA_FIVE_HOUR, "5h", fiveHour.used_percentage, fiveHour.remaining_percentage, unixSecondsToIso(fiveHour.resets_at));
    }
    if (sevenDay) {
      add(QUOTA_SEVEN_DAY, "7d", sevenDay.used_percentage, sevenDay.remaining_percentage, unixSecondsToIso(sevenDay.resets_at));
    }
    return quotas;
  }

  add(QUOTA_FIVE_HOUR, "5h", raw.five_hour_used_percent, raw.five_hour_remaining_percent, raw.five_hour_resets_at);
  add(QUOTA_SEVEN_DAY, "7d", raw.seven_day_used_percent, raw.seven_day_remaining_percent, raw.seven_day_resets_at);
  return quotas;
}

function quotaFromUsedPercent(key: string, label: string, usedPercent: number | undefined, resetAtUnix: number | undefined, now: Date): UsageQuota {
  const used = normalizePercent(usedPercent);
  return normalizeQuota({
    key,
    label,
    usedPercent: used,
    remainingPercent: 100 - used,
    resetsAt: unixSecondsToIso(resetAtUnix),
  }, now);
}

function quotaFromPair(
  key: string,
  label: string,
  usedPercent: number | undefined,
  remainingPercent: number | undefined,
  resetsAt: string | undefined,
  now: Date,
  stale?: boolean,
): UsageQuota | null {
  if (!isFiniteNumber(usedPercent) && !isFiniteNumber(remainingPercent)) return null;
  const used = isFiniteNumber(usedPercent) ? normalizePercent(usedPercent) : normalizePercent(100 - Number(remainingPercent));
  const remaining = isFiniteNumber(remainingPercent) ? normalizePercent(remainingPercent) : normalizePercent(100 - used);
  return normalizeQuota({ key, label, usedPercent: used, remainingPercent: remaining, resetsAt, stale }, now);
}

function normalizeQuota(quota: Omit<UsageQuota, "usedDisplay" | "remainingDisplay">, now: Date): UsageQuota {
  const usedPercent = normalizePercent(quota.usedPercent);
  const remainingPercent = normalizePercent(quota.remainingPercent);
  const resetsAt = quota.resetsAt?.trim() || undefined;
  // Round consistently so usedDisplay + remainingDisplay always sums to 100.
  const roundedUsed = Math.round(usedPercent);
  return {
    ...quota,
    usedPercent,
    remainingPercent,
    usedDisplay: `${roundedUsed}%`,
    remainingDisplay: `${100 - roundedUsed}%`,
    resetsAt,
    stale: quota.stale ?? isResetStale(resetsAt, now),
  };
}

function normalizePercent(value: number | undefined): number {
  if (!isFiniteNumber(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unixSecondsToIso(value: number | undefined): string | undefined {
  if (!isFiniteNumber(value) || value <= 0) return undefined;
  return new Date(value * 1000).toISOString();
}

function isResetStale(resetsAt: string | undefined, now: Date): boolean {
  if (!resetsAt) return false;
  const resetTime = Date.parse(resetsAt);
  return Number.isFinite(resetTime) ? now.getTime() > resetTime + 60_000 : false;
}

function quotaLabel(key: string): string {
  if (key === QUOTA_FIVE_HOUR) return "5h";
  if (key === QUOTA_SEVEN_DAY) return "7d";
  if (key === QUOTA_CODE_REVIEW) return "Review";
  return key;
}

const CODEX_REQUEST_TIMEOUT_MS = 20_000;

// chatgpt.com is unreachable directly on many networks; Node's https does not honor proxy
// env vars, so we resolve one here and tunnel through it via HTTP CONNECT. SOCKS proxies are
// skipped because CONNECT tunneling only works with http(s) proxies.
export function selectProxyUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const candidates = [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (!value) continue;
    if (/^socks/i.test(value)) continue;
    return value;
  }
  return undefined;
}

async function fetchCodexUsageHTTP(accessToken: string, accountId: string, options: { proxyUrl?: string } = {}): Promise<CodexUsageResponse> {
  if (process.platform === "win32") {
    return codexRequestWith404Fallback(
      () => doCodexUsagePowerShellRequest(CODEX_USAGE_PRIMARY_URL, accessToken, accountId),
      () => doCodexUsagePowerShellRequest(CODEX_USAGE_FALLBACK_URL, accessToken, accountId),
    );
  }

  // On macOS/Linux, prefer a Python subprocess: Node's bundled TLS ClientHello fingerprint is
  // silently dropped by chatgpt.com's Cloudflare edge (the connection hangs until timeout),
  // while Python's system-OpenSSL handshake passes through. Falls back to the Node https path
  // only when python3 is not on PATH.
  try {
    return await codexRequestWith404Fallback(
      () => doCodexUsagePythonRequest(CODEX_USAGE_PRIMARY_URL, accessToken, accountId, options.proxyUrl),
      () => doCodexUsagePythonRequest(CODEX_USAGE_FALLBACK_URL, accessToken, accountId, options.proxyUrl),
    );
  } catch (error) {
    if (!isCodexPythonUnavailable(error)) throw error;
    return codexRequestWith404Fallback(
      () => doCodexUsageRequest(CODEX_USAGE_PRIMARY_URL, accessToken, accountId, options.proxyUrl),
      () => doCodexUsageRequest(CODEX_USAGE_FALLBACK_URL, accessToken, accountId, options.proxyUrl),
    );
  }
}

async function codexRequestWith404Fallback(
  primary: () => Promise<CodexUsageResponse>,
  fallback: () => Promise<CodexUsageResponse>,
): Promise<CodexUsageResponse> {
  try {
    return await primary();
  } catch (error) {
    if (error instanceof CodexHttpError && error.statusCode === 404) return fallback();
    throw error;
  }
}

function isCodexPythonUnavailable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function doCodexUsagePowerShellRequest(endpoint: string, accessToken: string, accountId: string): Promise<CodexUsageResponse> {
  const script = `
$ErrorActionPreference = 'Stop'
$headers = @{
  Accept = 'application/json'
  Authorization = 'Bearer ' + $env:AGENT_RECALL_CODEX_ACCESS_TOKEN
  'User-Agent' = 'agent-recall'
}
if ($env:AGENT_RECALL_CODEX_ACCOUNT_ID) {
  $headers['X-Account-Id'] = $env:AGENT_RECALL_CODEX_ACCOUNT_ID
  $headers['ChatClaude-Account-Id'] = $env:AGENT_RECALL_CODEX_ACCOUNT_ID
  $headers['ChatGPT-Account-Id'] = $env:AGENT_RECALL_CODEX_ACCOUNT_ID
}
try {
  $response = Invoke-WebRequest -Uri $env:AGENT_RECALL_CODEX_USAGE_URL -Headers $headers -Method GET -TimeoutSec 15 -UseBasicParsing
  [Console]::Out.Write($response.Content)
} catch {
  $statusCode = $null
  if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
    $statusCode = [int]$_.Exception.Response.StatusCode
  }
  if ($statusCode) {
    [Console]::Error.Write("HTTP $statusCode")
  } else {
    [Console]::Error.Write($_.Exception.Message)
  }
  exit 1
}
`;

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        timeout: 20_000,
        maxBuffer: HTTP_BODY_LIMIT,
        env: {
          ...process.env,
          AGENT_RECALL_CODEX_USAGE_URL: endpoint,
          AGENT_RECALL_CODEX_ACCESS_TOKEN: accessToken,
          AGENT_RECALL_CODEX_ACCOUNT_ID: accountId,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || error.message;
          const statusCode = Number(message.match(/HTTP\s+(\d+)/)?.[1]);
          if (Number.isFinite(statusCode)) {
            reject(new CodexHttpError(codexHttpStatusMessage(statusCode), statusCode));
            return;
          }
          reject(new Error(message));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as CodexUsageResponse);
        } catch (parseError) {
          reject(parseError instanceof Error ? new Error(`Invalid Codex usage response: ${parseError.message}`) : parseError);
        }
      },
    );
  });
}

export function doCodexUsagePythonRequest(endpoint: string, accessToken: string, accountId: string, proxyUrl?: string): Promise<CodexUsageResponse> {
  // urllib's default opener honors both *_proxy env vars and macOS SystemConfiguration proxies;
  // Node's https honors neither unless wired up by hand. For users whose only proxy is set at the
  // OS level (no env vars), the Node path connects directly to chatgpt.com and times out, while
  // Python transparently routes through the system proxy. An explicit proxyUrl from selectProxyUrl
  // (env-var based) overrides this when present.
  const script = `
import os, sys, urllib.request, urllib.error

url = os.environ["AGENT_RECALL_CODEX_USAGE_URL"]
token = os.environ["AGENT_RECALL_CODEX_ACCESS_TOKEN"]
account = (os.environ.get("AGENT_RECALL_CODEX_ACCOUNT_ID") or "").strip()
proxy_url = (os.environ.get("AGENT_RECALL_CODEX_PROXY") or "").strip()

headers = {
    "Accept": "application/json",
    "Authorization": "Bearer " + token,
    "User-Agent": "agent-recall",
}
if account:
    headers["X-Account-Id"] = account
    headers["ChatClaude-Account-Id"] = account
    headers["ChatGPT-Account-Id"] = account

if proxy_url:
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    )
else:
    # Default handlers install a ProxyHandler that reads macOS SystemConfiguration proxies AND
    # *_proxy env vars — this is exactly what the Node path is missing.
    opener = urllib.request.build_opener()
req = urllib.request.Request(url, headers=headers, method="GET")

try:
    resp = opener.open(req, timeout=15)
except urllib.error.HTTPError as exc:
    sys.stderr.write("HTTP {}".format(exc.code))
    sys.exit(1)
except Exception as exc:
    name = type(exc).__name__
    sys.stderr.write(name + (": " + str(exc) if str(exc) else ""))
    sys.exit(1)
else:
    sys.stdout.buffer.write(resp.read())
`;

  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      ["-c", script],
      {
        timeout: CODEX_REQUEST_TIMEOUT_MS,
        maxBuffer: HTTP_BODY_LIMIT,
        env: {
          ...process.env,
          AGENT_RECALL_CODEX_USAGE_URL: endpoint,
          AGENT_RECALL_CODEX_ACCESS_TOKEN: accessToken,
          AGENT_RECALL_CODEX_ACCOUNT_ID: accountId,
          AGENT_RECALL_CODEX_PROXY: proxyUrl ?? "",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            const err = new Error("python3 is not installed on PATH.");
            (err as NodeJS.ErrnoException).code = "ENOENT";
            reject(err);
            return;
          }
          const message = stderr.trim() || error.message;
          const statusCode = Number(message.match(/HTTP\s+(\d+)/)?.[1]);
          if (Number.isFinite(statusCode)) {
            reject(new CodexHttpError(codexHttpStatusMessage(statusCode), statusCode));
            return;
          }
          reject(new Error(message));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as CodexUsageResponse);
        } catch (parseError) {
          reject(parseError instanceof Error ? new Error(`Invalid Codex usage response: ${parseError.message}`) : parseError);
        }
      },
    );
  });
}

class CodexHttpError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "CodexHttpError";
  }
}

// Opens an HTTP CONNECT tunnel through an http(s) proxy and resolves the raw tunneled socket.
export function connectViaProxy(proxyUrl: string, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let proxy: URL;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      reject(new Error(`Invalid proxy URL: ${proxyUrl}`));
      return;
    }

    const headers: Record<string, string> = { Host: `${host}:${port}` };
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }

    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      timeout: timeoutMs,
    });

    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new CodexHttpError(`Proxy CONNECT failed: HTTP ${response.statusCode}.`, response.statusCode));
        return;
      }
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.once("timeout", () => request.destroy(new Error("Proxy connection timed out.")));
    request.once("error", (error) => reject(normalizeNetworkError(error)));
    request.end();
  });
}

async function doCodexUsageRequest(endpoint: string, accessToken: string, accountId: string, proxyUrl?: string): Promise<CodexUsageResponse> {
  const target = new URL(endpoint);
  const host = target.hostname;
  const port = target.port ? Number(target.port) : 443;
  const tunnelSocket = proxyUrl ? await connectViaProxy(proxyUrl, host, port, CODEX_REQUEST_TIMEOUT_MS) : undefined;

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "agent-recall",
    };
    if (accountId) {
      headers["X-Account-Id"] = accountId;
      headers["ChatClaude-Account-Id"] = accountId;
      headers["ChatGPT-Account-Id"] = accountId;
    }

    const requestOptions: https.RequestOptions = { method: "GET", headers, timeout: CODEX_REQUEST_TIMEOUT_MS };
    if (tunnelSocket) {
      // Run TLS over the proxy tunnel instead of opening a direct socket. A one-off agent whose
      // createConnection returns the tunneled TLS socket is the reliable way to do this; the bare
      // `createConnection` request option is ignored once an agent (default or `false`) is in play.
      const agent = new https.Agent({ maxSockets: 1 });
      (agent as unknown as { createConnection: () => net.Socket }).createConnection = () =>
        tls.connect({ socket: tunnelSocket, servername: host }) as unknown as net.Socket;
      requestOptions.agent = agent;
    }

    const request = https.request(endpoint, requestOptions, (response) => {
      const statusCode = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;

      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > HTTP_BODY_LIMIT) {
          request.destroy(new Error("Codex usage response is too large."));
          return;
        }
        chunks.push(chunk);
      });

      response.on("end", () => {
        if (statusCode !== 200) {
          reject(new CodexHttpError(codexHttpStatusMessage(statusCode), statusCode));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as CodexUsageResponse);
        } catch (error) {
          reject(error instanceof Error ? new Error(`Invalid Codex usage response: ${error.message}`) : error);
        }
      });
    });

    request.on("timeout", () => request.destroy(new Error("Codex quota refresh timed out.")));
    request.on("error", (error) => reject(normalizeNetworkError(error)));
    request.end();
  });
}

// ETIMEDOUT surfaces as an AggregateError with an empty message, which left the quota card
// blank. Turn empty/opaque network errors into something the UI can show.
function normalizeNetworkError(error: unknown): Error {
  if (error instanceof CodexHttpError) return error;
  if (!(error instanceof Error)) return new Error(String(error));
  if (error.message.trim()) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ETIMEDOUT") return new Error("Could not reach chatgpt.com (connection timed out). A proxy may be required.");
  if (code === "ECONNREFUSED") return new Error("Connection to chatgpt.com was refused.");
  return new Error(code ? `Network error (${code}) while contacting chatgpt.com.` : "Network error while contacting chatgpt.com.");
}

function codexHttpStatusMessage(statusCode: number): string {
  if (statusCode === 401) return "Unauthorized. Run `codex login` again.";
  if (statusCode === 403) return "Codex quota endpoint returned forbidden.";
  if (statusCode === 404) return "Codex quota endpoint returned 404.";
  if (statusCode === 429) return "Codex quota refresh was rate limited.";
  return `Codex quota endpoint returned HTTP ${statusCode}.`;
}

function sanitizeCodexError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._~-]+/g, "Bearer [redacted]").replace(/sk-[A-Za-z0-9._-]+/g, "sk-[redacted]");
}

function looksLikeClaudeApiUsage(raw: ClaudeStatuslineFile): boolean {
  return Boolean(raw.model || raw.cost || raw.context_window || raw.session_id?.trim());
}

function displayPlanName(value: string | undefined): string | undefined {
  const key = value?.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (!key) return undefined;
  switch (key) {
    case "plus":
      return "Plus";
    case "pro":
    case "prolite":
      return "Pro";
    case "max":
      return "Max";
    case "team":
      return "Team";
    case "enterprise":
      return "Enterprise";
    case "free":
      return "Free";
    default:
      return undefined;
  }
}
