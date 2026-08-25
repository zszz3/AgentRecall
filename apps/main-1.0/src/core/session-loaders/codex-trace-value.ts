import { truncateTraceDetail } from "../trace-detail";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeCodexTraceValuePart(value: unknown, key = "", preserveEncrypted = false): unknown {
  if (typeof value === "string") {
    const normalizedKey = key.toLocaleLowerCase();
    const opaqueField = normalizedKey === "image_url"
      || normalizedKey === "audio_url"
      || normalizedKey === "result"
      || normalizedKey === "data";
    const looksLikeEncodedBinary = value.length > 1_024 && /^[a-z0-9+/=\r\n]+$/iu.test(value);
    if (opaqueField && (value.startsWith("data:") || looksLikeEncodedBinary)) {
      return "[binary omitted]";
    }
    return truncateTraceDetail(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeCodexTraceValuePart(item, "", preserveEncrypted));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([nestedKey]) => preserveEncrypted || !nestedKey.toLocaleLowerCase().includes("encrypted"))
      .map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeCodexTraceValuePart(nestedValue, nestedKey, preserveEncrypted),
      ]),
  );
}

export function sanitizeCodexTraceValue(value: unknown, preserveEncrypted = false): unknown {
  const existing = record(value);
  if (existing && existing.truncated === true && typeof existing.preview === "string") return value;
  const sanitized = sanitizeCodexTraceValuePart(value, "", preserveEncrypted);
  if (!sanitized || typeof sanitized !== "object") return sanitized;
  const serialized = JSON.stringify(sanitized);
  return serialized.length > 0 && truncateTraceDetail(serialized) !== serialized
    ? { preview: truncateTraceDetail(serialized), truncated: true }
    : sanitized;
}
