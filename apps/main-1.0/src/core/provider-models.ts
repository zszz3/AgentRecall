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

export type ProviderModelsFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}>;

/** Aggregator gateways page their catalog; stop well before a broken cursor loops forever. */
const MAX_MODEL_PAGES = 20;

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
  let firstFailure: Error | null = null;
  for (const endpoint of endpoints) {
    try {
      const page = await collectModelPages(endpoint, headers, fetchImpl);
      answered.push(endpoint);
      for (const model of page) models.add(model);
    } catch (error) {
      firstFailure ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  if (answered.length === 0) throw firstFailure ?? new Error(`No model IDs were returned by ${endpoints[0]}.`);
  if (models.size === 0) throw new Error(`No model IDs were returned by ${answered.join(", ")}.`);
  return { endpoint: answered[0], endpoints: answered, models: sortModelIds(models) };
}

async function collectModelPages(
  endpoint: string,
  headers: Record<string, string>,
  fetchImpl: ProviderModelsFetch,
): Promise<string[]> {
  const models = new Set<string>();
  let url: string | null = endpoint;
  for (let page = 0; page < MAX_MODEL_PAGES && url; page += 1) {
    const response = await fetchImpl(url, { headers });
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
