export interface ProviderModelProbeRequest {
  baseUrl: string;
  apiKey: string;
  apiFormat?: "openai_chat" | "openai_responses" | "anthropic" | "gemini_native";
}

export interface ProviderModelProbeResult {
  models: string[];
  /** First endpoint that answered, kept for status messages. */
  endpoint: string;
  /** Every endpoint that answered, in probe order. */
  endpoints: string[];
}

export type ProviderModelsFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

/** Aggregator gateways page their catalog; stop well before a broken cursor loops forever. */
const MAX_MODEL_PAGES = 20;

/** A gateway that has not answered by now is not going to; without this the probe hangs forever. */
const MODEL_PROBE_TIMEOUT_MS = 20_000;

interface ProbeFailure {
  endpoint: string;
  error: Error;
  /** Empty when the endpoint answered and rejected us — that error already explains itself. */
  transportReason: string;
}

export async function probeProviderModels(
  input: ProviderModelProbeRequest,
  fetchImpl: ProviderModelsFetch = fetch,
): Promise<ProviderModelProbeResult> {
  const endpoints = providerModelsEndpoints(input.baseUrl);
  if (endpoints.length === 0) throw new Error("Base URL is required to detect models.");
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("No API key was found in the form, target config, auth file, or environment.");
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (input.apiFormat === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }

  const models = new Set<string>();
  const answered: string[] = [];
  const failures: ProbeFailure[] = [];
  for (const endpoint of endpoints) {
    try {
      const page = await collectModelPages(endpoint, headers, fetchImpl);
      answered.push(endpoint);
      for (const model of page) models.add(model);
    } catch (error) {
      failures.push(describeProbeFailure(endpoint, error));
    }
  }

  if (answered.length === 0) throw combineProbeFailures(failures, endpoints);
  if (models.size === 0) throw new Error(`No model IDs were returned by ${answered.join(", ")}.`);
  return { endpoint: answered[0], endpoints: answered, models: sortModelIds(models) };
}

/**
 * `fetch` collapses every transport failure into the same bare `TypeError: fetch failed` and
 * keeps the actual reason — DNS, refused connection, expired certificate — only in `error.cause`.
 * Reporting that chain is the whole difference between a message the user can act on and one
 * that names neither the URL nor the problem.
 */
function describeProbeFailure(endpoint: string, error: unknown): ProbeFailure {
  if (!(error instanceof Error)) {
    return { endpoint, error: new Error(`Model detection failed at ${endpoint}: ${String(error)}`), transportReason: "" };
  }
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    const reason = `no response within ${Math.round(MODEL_PROBE_TIMEOUT_MS / 1000)}s`;
    return { endpoint, error: new Error(`Model detection could not reach ${endpoint}: ${reason}.`), transportReason: reason };
  }
  const transportReason = transportFailureReason(error);
  if (!transportReason) return { endpoint, error, transportReason: "" };
  return {
    endpoint,
    error: new Error(`Model detection could not reach ${endpoint}: ${transportReason}.`),
    transportReason,
  };
}

/** Empty for anything that is not a transport failure, so those errors are re-thrown untouched. */
function transportFailureReason(error: Error): string {
  const code = errorCauseCode(error);
  if (!code) return "";
  const explanation = TRANSPORT_FAILURE_EXPLANATIONS[code];
  if (explanation) return `${explanation} (${code})`;
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return cause ? `${cause} (${code})` : code;
}

const TRANSPORT_FAILURE_EXPLANATIONS: Readonly<Record<string, string>> = {
  ENOTFOUND: "the host name could not be resolved — check the Base URL, or whether this network needs a proxy",
  EAI_AGAIN: "the host name could not be resolved — check the Base URL, or whether this network needs a proxy",
  ECONNREFUSED: "nothing accepted the connection on that host and port",
  ECONNRESET: "the connection was closed before an answer arrived",
  ETIMEDOUT: "the connection timed out — check whether this network needs a proxy",
  UND_ERR_CONNECT_TIMEOUT: "the connection timed out — check whether this network needs a proxy",
  EPROTO: "the TLS handshake failed — check whether the Base URL should use http:// instead",
  CERT_HAS_EXPIRED: "the server's TLS certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the server uses a self-signed TLS certificate",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "the server's TLS certificate could not be verified",
  ERR_INVALID_URL: "that is not a valid URL — a Base URL needs a scheme such as https://",
};

/** Walks the `cause` chain, because undici nests the OS error one or two levels down. */
function errorCauseCode(error: Error): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code) return code;
    current = current.cause;
  }
  return "";
}

/** Every endpoint failing the same way is one problem, and should read as one problem. */
function combineProbeFailures(failures: ProbeFailure[], endpoints: string[]): Error {
  if (failures.length === 0) return new Error(`No model IDs were returned by ${endpoints[0]}.`);
  const reasons = new Set(failures.map((failure) => failure.transportReason));
  if (failures.length > 1 && reasons.size === 1 && failures[0].transportReason) {
    const tried = failures.map((failure) => failure.endpoint).join(", ");
    return new Error(`Model detection could not reach ${tried}: ${failures[0].transportReason}.`);
  }
  return failures[0].error;
}

async function collectModelPages(
  endpoint: string,
  headers: Record<string, string>,
  fetchImpl: ProviderModelsFetch,
): Promise<string[]> {
  const models = new Set<string>();
  let url: string | null = endpoint;
  for (let page = 0; page < MAX_MODEL_PAGES && url; page += 1) {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS) });
    if (!response.ok) {
      // A follow-up page failing should not discard the models already collected.
      if (page > 0) break;
      throw new Error(`Model detection failed at ${url} (${response.status}${response.statusText ? ` ${response.statusText}` : ""}).`);
    }
    const payload = await response.json();
    const before = models.size;
    for (const model of parseProviderModels(payload)) models.add(model);
    if (models.size === before) break;
    url = nextModelPageUrl(endpoint, url, payload);
  }
  return [...models];
}

/**
 * Ordered, de-duplicated endpoints worth asking for a model catalog. A single
 * gateway often exposes the same catalog under both its versioned base path and
 * its origin, and each surface can list a different subset.
 */
export function providerModelsEndpoints(baseUrl: string): string[] {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) return [];
  if (/\/models$/i.test(normalized)) return [normalized];

  const candidates = [`${normalized}/models`];
  if (!/\/v\d+(?:beta|alpha)?$/i.test(normalized)) candidates.push(`${normalized}/v1/models`);
  try {
    const origin = new URL(normalized).origin;
    candidates.push(`${origin}/v1/models`);
  } catch {
    // Relative or malformed base URLs only get the path-relative candidates.
  }
  return [...new Set(candidates)];
}

export function providerModelsEndpoint(baseUrl: string): string {
  return providerModelsEndpoints(baseUrl)[0] ?? "";
}

export function parseProviderModels(payload: unknown): string[] {
  const models = new Set<string>();
  collectModelContainer(payload, models, false);
  return sortModelIds(models);
}

function sortModelIds(models: Set<string>): string[] {
  return [...models].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function nextModelPageUrl(endpoint: string, currentUrl: string, payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const explicit = firstString(payload.next, payload.next_page, payload.next_page_url, payload.nextPageUrl);
  if (explicit) return resolveUrl(explicit, currentUrl);
  if (payload.has_more !== true && payload.hasMore !== true) return null;
  const cursor = firstString(payload.last_id, payload.lastId, payload.next_cursor, payload.nextCursor)
    || lastEntryId(payload.data);
  if (!cursor) return null;
  const next = new URL(endpoint, "http://localhost");
  next.searchParams.set("after_id", cursor);
  next.searchParams.set("limit", "1000");
  return /^[a-z][a-z0-9+.-]*:/i.test(endpoint) ? next.toString() : `${next.pathname}${next.search}`;
}

function resolveUrl(value: string, baseUrl: string): string | null {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function lastEntryId(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const last = value[value.length - 1];
  if (typeof last === "string") return last.trim();
  return isRecord(last) ? firstString(last.id, last.slug, last.model) : "";
}

function collectModelContainer(value: unknown, models: Set<string>, allowObjectKeys: boolean): void {
  if (typeof value === "string") {
    addModelId(models, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelEntry(item, models);
    return;
  }
  if (!isRecord(value)) return;

  let foundContainer = false;
  for (const key of ["data", "models", "result", "items"]) {
    if (key in value) {
      foundContainer = true;
      collectModelContainer(value[key], models, true);
    }
  }
  if (allowObjectKeys || !foundContainer) {
    for (const [key, item] of Object.entries(value)) {
      if (["data", "models", "result", "items"].includes(key)) continue;
      if (PAGINATION_KEYS.has(key)) continue;
      const before = models.size;
      collectModelEntry(item, models);
      if (models.size === before) addModelId(models, key);
    }
  }
}

const PAGINATION_KEYS = new Set([
  "has_more",
  "hasMore",
  "last_id",
  "lastId",
  "first_id",
  "firstId",
  "next",
  "next_page",
  "next_page_url",
  "nextPageUrl",
  "next_cursor",
  "nextCursor",
  "object",
  "success",
  "total",
]);

function collectModelEntry(value: unknown, models: Set<string>): void {
  if (typeof value === "string") {
    addModelId(models, value);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ["id", "slug", "model", "model_id", "modelId", "name"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      addModelId(models, value[key]);
      return;
    }
  }
}

function addModelId(models: Set<string>, value: string): void {
  const id = value.trim();
  if (id) models.add(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
