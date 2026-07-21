export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

export interface StatementSync {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

export interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

export type RecordValue = Record<string, unknown>;

export function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}

export function asArray(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : undefined;
}

export function optional(target: RecordValue, key: string, value: unknown): void {
  if (value !== null && value !== undefined) target[key] = value;
}

export function rowCount(db: DatabaseSync, table: string): number {
  const row = asRecord(db.prepare(`select count(*) as count from ${table}`).get());
  return asNumber(row.count);
}
