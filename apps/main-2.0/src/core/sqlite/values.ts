/** Shared value conversion helpers for SQLite repositories. */

export function sqliteText(value: string): string {
  // Strip NUL bytes to keep text clean and compatible with historical Postgres sanitization.
  return value.includes("\u0000") ? value.replace(/\u0000/gu, "") : value;
}

export function sqliteTime(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function sqliteOptionalTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function sqliteJsonParameter(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(sanitizeJsonValue(value));
}

export function sqliteJson<T = unknown>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return structuredClone(value) as T;
  return JSON.parse(value) as T;
}

export function sqliteRecord(value: unknown): Record<string, unknown> {
  const parsed = sqliteJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export function sqliteStringArray(value: unknown): string[] {
  const parsed = sqliteJson(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export function sqliteStringRecord(value: unknown): Record<string, string> {
  const record = sqliteRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, String(item)]),
  );
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return sqliteText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[sqliteText(key)] = sanitizeJsonValue(item);
    }
    return out;
  }
  return value;
}
