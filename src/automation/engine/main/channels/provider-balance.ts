import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AgentChannel, ProviderBalanceItem, ProviderBalanceResult } from "../../shared/types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface BalanceProviderDefinition {
  id: string;
  label: string;
  endpoint: string;
  parse: (body: unknown) => ProviderBalanceItem[];
}

export interface ProviderBalanceQueryOptions {
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  codexAuth?: CodexAuthFile;
  codexUsageFetcher?: CodexUsageFetcher;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const CODEX_USAGE_PRIMARY_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_FALLBACK_URL = "https://chatgpt.com/api/codex/usage";
const CODEX_REQUEST_TIMEOUT_MS = 20_000;
const HTTP_BODY_LIMIT = 64 * 1024;

export type CodexUsageFetcher = (accessToken: string, accountId: string) => Promise<CodexUsageResponse>;

interface CodexAuthFile {
  OPENAI_API_KEY?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

interface CodexUsageWindow {
  used_percent?: number;
  percent_left?: number;
  remaining_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
}

interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: CodexUsageWindow | null;
    secondary_window?: CodexUsageWindow | null;
  };
  code_review_rate_limit?: {
    primary_window?: CodexUsageWindow | null;
  };
}

const BALANCE_PROVIDERS: BalanceProviderDefinition[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/user/balance",
    parse: parseDeepSeekBalance,
  },
  {
    id: "stepfun",
    label: "StepFun",
    endpoint: "https://api.stepfun.com/v1/accounts",
    parse: parseStepFunBalance,
  },
  {
    id: "siliconflow-cn",
    label: "SiliconFlow",
    endpoint: "https://api.siliconflow.cn/v1/user/info",
    parse: (body) => parseSiliconFlowBalance(body, "SiliconFlow", "CNY"),
  },
  {
    id: "siliconflow-en",
    label: "SiliconFlow (EN)",
    endpoint: "https://api.siliconflow.com/v1/user/info",
    parse: (body) => parseSiliconFlowBalance(body, "SiliconFlow (EN)", "USD"),
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/credits",
    parse: parseOpenRouterBalance,
  },
  {
    id: "novita",
    label: "Novita AI",
    endpoint: "https://api.novita.ai/v3/user/balance",
    parse: parseNovitaBalance,
  },
];

export async function queryProviderBalance(channel: AgentChannel, options: ProviderBalanceQueryOptions = {}): Promise<ProviderBalanceResult> {
  const now = options.now ?? Date.now;
  if (isCodexOpenAiChannel(channel)) return queryCodexOpenAiQuota(channel, options);

  const provider = balanceProviderForChannel(channel);
  if (!provider) {
    return {
      channelId: channel.id,
      ...optionalProviderName(channel.providerName),
      supported: false,
      status: "unsupported",
      message: "Balance query is not supported for this provider.",
      items: [],
      queriedAt: now(),
    };
  }

  const apiKey = apiKeyFromChannel(channel);
  if (!apiKey) {
    return {
      channelId: channel.id,
      providerName: channel.providerName ?? provider.label,
      supported: true,
      status: "missing_key",
      message: "API Key is not configured.",
      items: [],
      queriedAt: now(),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl(provider.endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        channelId: channel.id,
        providerName: channel.providerName ?? provider.label,
        supported: true,
        status: "error",
        message: `Authentication failed (HTTP ${response.status}).`,
        items: [
          {
            label: provider.label,
            isValid: false,
            invalidMessage: `Authentication failed (HTTP ${response.status}).`,
          },
        ],
        queriedAt: now(),
      };
    }

    if (!response.ok) {
      return {
        channelId: channel.id,
        providerName: channel.providerName ?? provider.label,
        supported: true,
        status: "error",
        message: `Balance API error (HTTP ${response.status}): ${await response.text()}`,
        items: [],
        queriedAt: now(),
      };
    }

    const body = (await response.json()) as unknown;
    return {
      channelId: channel.id,
      providerName: channel.providerName ?? provider.label,
      supported: true,
      status: "success",
      message: "Balance query succeeded.",
      items: provider.parse(body),
      queriedAt: now(),
    };
  } catch (error) {
    return {
      channelId: channel.id,
      providerName: channel.providerName ?? provider.label,
      supported: true,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      items: [],
      queriedAt: now(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function balanceProviderForChannel(channel: AgentChannel): BalanceProviderDefinition | undefined {
  const identity = `${channel.providerName ?? ""} ${channel.modelProvider ?? ""} ${channel.baseUrl ?? ""}`.toLowerCase();
  if (identity.includes("api.deepseek.com") || identity.includes("deepseek")) return providerById("deepseek");
  if (identity.includes("api.stepfun.ai") || identity.includes("api.stepfun.com") || identity.includes("stepfun")) return providerById("stepfun");
  if (identity.includes("api.siliconflow.com")) return providerById("siliconflow-en");
  if (identity.includes("api.siliconflow.cn") || identity.includes("siliconflow")) return providerById("siliconflow-cn");
  if (identity.includes("openrouter.ai") || identity.includes("openrouter")) return providerById("openrouter");
  if (identity.includes("api.novita.ai") || identity.includes("novita")) return providerById("novita");
  return undefined;
}

function isCodexOpenAiChannel(channel: AgentChannel): boolean {
  const identity = `${channel.agentId} ${channel.providerName ?? ""} ${channel.modelProvider ?? ""} ${channel.baseUrl ?? ""}`.toLowerCase();
  return channel.agentId === "codex" && (identity.includes("openai") || channel.id === "codex-openai");
}

async function queryCodexOpenAiQuota(channel: AgentChannel, options: ProviderBalanceQueryOptions): Promise<ProviderBalanceResult> {
  const nowMs = options.now ?? Date.now;
  const queriedAt = nowMs();
  const auth = options.codexAuth ?? readCodexAuth(options);
  const accessToken = auth?.tokens?.access_token?.trim() ?? "";
  const accountId = auth?.tokens?.account_id?.trim() ?? "";
  const apiKey = auth?.OPENAI_API_KEY?.trim() ?? "";

  if (!auth) {
    return {
      channelId: channel.id,
      providerName: "Codex",
      supported: true,
      status: "missing_key",
      message: "Run `codex login` to show subscription quota.",
      items: [],
      queriedAt,
    };
  }
  if (!accessToken && apiKey) {
    return {
      channelId: channel.id,
      providerName: "Codex",
      supported: true,
      status: "unsupported",
      message: "Codex is using an API key, so subscription quota is not available.",
      items: [],
      queriedAt,
    };
  }
  if (!accessToken) {
    return {
      channelId: channel.id,
      providerName: "Codex",
      supported: true,
      status: "missing_key",
      message: "auth.json exists but has no OAuth access token. Run `codex login` again.",
      items: [],
      queriedAt,
    };
  }

  try {
    const usageFetcher = options.codexUsageFetcher ?? ((token, account) => fetchCodexUsageHTTP(token, account, options));
    const usage = await usageFetcher(accessToken, accountId);
    const items = codexQuotaItemsFromResponse(usage, new Date(queriedAt));
    return {
      channelId: channel.id,
      providerName: "Codex",
      supported: true,
      status: "success",
      message: items.length === 0 ? "Subscription detected, but the quota response did not include limits." : "Codex subscription quota loaded.",
      items,
      queriedAt,
    };
  } catch (error) {
    return {
      channelId: channel.id,
      providerName: "Codex",
      supported: true,
      status: "error",
      message: sanitizeCodexError(error),
      items: [],
      queriedAt,
    };
  }
}

function readCodexAuth(options: ProviderBalanceQueryOptions): CodexAuthFile | undefined {
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME?.trim();
  const home = options.homeDir ?? homedir();
  const authPath = codexHome ? path.join(codexHome, "auth.json") : path.join(home, ".codex", "auth.json");
  try {
    if (!existsSync(authPath)) return undefined;
    return JSON.parse(readFileSync(authPath, "utf8")) as CodexAuthFile;
  } catch {
    return undefined;
  }
}

function codexQuotaItemsFromResponse(response: CodexUsageResponse, now: Date): ProviderBalanceItem[] {
  const plan = displayPlanName(response.plan_type);
  const items: ProviderBalanceItem[] = [];
  const appendWindow = (label: string, window: CodexUsageWindow | null | undefined): void => {
    if (!window) return;
    const used = codexWindowUsedPercent(window);
    const resetAt = codexWindowResetAt(window, now);
    const usedPercent = normalizePercent(used);
    const remainingPercent = normalizePercent(100 - usedPercent);
    items.push({
      label: plan ? `${plan} · ${label}` : label,
      remaining: remainingPercent,
      used: usedPercent,
      total: 100,
      unit: "%",
      isValid: remainingPercent > 0,
      ...(resetAt ? { invalidMessage: `Resets ${new Date(resetAt * 1000).toLocaleString()}` } : {}),
    });
  };

  appendWindow("5h", response.rate_limit?.primary_window);
  appendWindow("7d", response.rate_limit?.secondary_window);
  appendWindow("Review", response.code_review_rate_limit?.primary_window);
  return items;
}

function codexWindowUsedPercent(window: CodexUsageWindow): number | undefined {
  if (isFiniteNumber(window.used_percent)) return window.used_percent;
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

function normalizePercent(value: number | undefined): number {
  if (!isFiniteNumber(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function displayPlanName(value: string | undefined): string | undefined {
  const key = value?.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (!key) return undefined;
  if (key === "plus") return "Plus";
  if (key === "pro" || key === "prolite") return "Pro";
  if (key === "max") return "Max";
  if (key === "team") return "Team";
  if (key === "enterprise") return "Enterprise";
  if (key === "free") return "Free";
  return undefined;
}

async function fetchCodexUsageHTTP(accessToken: string, accountId: string, options: ProviderBalanceQueryOptions): Promise<CodexUsageResponse> {
  const proxyUrl = selectProxyUrl(options.env ?? process.env);
  try {
    return await codexRequestWith404Fallback(
      () => doCodexUsagePythonRequest(CODEX_USAGE_PRIMARY_URL, accessToken, accountId, proxyUrl, options.env),
      () => doCodexUsagePythonRequest(CODEX_USAGE_FALLBACK_URL, accessToken, accountId, proxyUrl, options.env),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return codexRequestWith404Fallback(
      () => doCodexUsageFetchRequest(CODEX_USAGE_PRIMARY_URL, accessToken, accountId, options.fetch ?? fetch, options.timeoutMs),
      () => doCodexUsageFetchRequest(CODEX_USAGE_FALLBACK_URL, accessToken, accountId, options.fetch ?? fetch, options.timeoutMs),
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

function doCodexUsagePythonRequest(
  endpoint: string,
  accessToken: string,
  accountId: string,
  proxyUrl: string | undefined,
  env: Record<string, string | undefined> | undefined,
): Promise<CodexUsageResponse> {
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

opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})) if proxy_url else urllib.request.build_opener()
req = urllib.request.Request(url, headers=headers, method="GET")

try:
    resp = opener.open(req, timeout=15)
except urllib.error.HTTPError as exc:
    sys.stderr.write("HTTP {}".format(exc.code))
    sys.exit(1)
except Exception as exc:
    sys.stderr.write(type(exc).__name__ + (": " + str(exc) if str(exc) else ""))
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
          ...env,
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
          reject(codexErrorFromMessage(stderr.trim() || error.message));
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

async function doCodexUsageFetchRequest(
  endpoint: string,
  accessToken: string,
  accountId: string,
  fetchImpl: FetchLike,
  timeoutMs = CODEX_REQUEST_TIMEOUT_MS,
): Promise<CodexUsageResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
    const response = await fetchImpl(endpoint, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) throw new CodexHttpError(codexHttpStatusMessage(response.status), response.status);
    return (await response.json()) as CodexUsageResponse;
  } finally {
    clearTimeout(timeout);
  }
}

function selectProxyUrl(env: Record<string, string | undefined>): string | undefined {
  const candidates = [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (!value || /^socks/i.test(value)) continue;
    return value;
  }
  return undefined;
}

class CodexHttpError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "CodexHttpError";
  }
}

function codexErrorFromMessage(message: string): Error {
  const statusCode = Number(message.match(/HTTP\s+(\d+)/)?.[1]);
  if (Number.isFinite(statusCode)) return new CodexHttpError(codexHttpStatusMessage(statusCode), statusCode);
  return new Error(message);
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

function providerById(providerId: string): BalanceProviderDefinition | undefined {
  return BALANCE_PROVIDERS.find((provider) => provider.id === providerId);
}

function apiKeyFromChannel(channel: AgentChannel): string | undefined {
  const headers = channel.httpHeaders ?? {};
  const entry = Object.entries(headers).find(([key]) => {
    const normalized = key.toLowerCase();
    return normalized === "authorization" || normalized === "api-key" || normalized === "x-api-key";
  });
  const rawValue = entry?.[1]?.trim();
  if (!rawValue) return undefined;
  return rawValue.replace(/^bearer\s+/i, "").trim() || undefined;
}

function parseDeepSeekBalance(body: unknown): ProviderBalanceItem[] {
  const record = asRecord(body);
  const isAvailable = asBoolean(record?.is_available) ?? true;
  const infos = asArray(record?.balance_infos);
  return infos.flatMap((item) => {
    const info = asRecord(item);
    if (!info) return [];
    const currency = asString(info.currency) ?? "CNY";
    const remaining = numericField(info, "total_balance");
    return [
      {
        label: currency,
        ...optionalNumber("remaining", remaining),
        unit: currency,
        isValid: isAvailable,
        ...(isAvailable ? {} : { invalidMessage: "Insufficient balance." }),
      },
    ];
  });
}

function parseStepFunBalance(body: unknown): ProviderBalanceItem[] {
  const record = asRecord(body);
  return [
    {
      label: "StepFun",
      remaining: numericField(record, "balance") ?? 0,
      unit: "CNY",
      isValid: true,
    },
  ];
}

function parseSiliconFlowBalance(body: unknown, label: string, unit: string): ProviderBalanceItem[] {
  const record = asRecord(body);
  const data = asRecord(record?.data) ?? record;
  return [
    {
      label,
      remaining: numericField(data, "totalBalance") ?? numericField(data, "balance") ?? 0,
      unit,
      isValid: true,
    },
  ];
}

function parseOpenRouterBalance(body: unknown): ProviderBalanceItem[] {
  const record = asRecord(body);
  const data = asRecord(record?.data) ?? record;
  const total = numericField(data, "total_credits") ?? 0;
  const used = numericField(data, "total_usage") ?? 0;
  const remaining = total - used;
  return [
    {
      label: "OpenRouter",
      remaining,
      total,
      used,
      unit: "USD",
      isValid: remaining > 0,
      ...(remaining > 0 ? {} : { invalidMessage: "No credits remaining." }),
    },
  ];
}

function parseNovitaBalance(body: unknown): ProviderBalanceItem[] {
  const record = asRecord(body);
  const remaining = (numericField(record, "availableBalance") ?? 0) / 10_000;
  return [
    {
      label: "Novita AI",
      remaining,
      unit: "USD",
      isValid: remaining > 0,
      ...(remaining > 0 ? {} : { invalidMessage: "No balance remaining." }),
    },
  ];
}

function numericField(record: Record<string, unknown> | undefined, field: string): number | undefined {
  if (!record) return undefined;
  const value = record[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalProviderName(providerName: string | undefined): Pick<ProviderBalanceResult, "providerName"> | Record<string, never> {
  return providerName ? { providerName } : {};
}

function optionalNumber(key: "remaining" | "total" | "used", value: number | undefined): Pick<ProviderBalanceItem, typeof key> | Record<string, never> {
  return typeof value === "number" ? { [key]: value } as Pick<ProviderBalanceItem, typeof key> : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
