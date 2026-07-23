import { asRecord, type RecordValue } from "./sqlite-values";

export function postgresTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function postgresJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return value;
}

export function postgresRecord(value: unknown): RecordValue {
  return asRecord(postgresJson(value));
}

export function jsonParameter(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
