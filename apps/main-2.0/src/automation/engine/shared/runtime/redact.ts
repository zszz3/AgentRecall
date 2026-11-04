const sensitiveKeyPart = /(authorization|cookie|credential|password|passwd|secret|token|api.?key|private.?key)/i;

/**
 * Replaces credential-shaped keys and inline secrets with redaction markers.
 * Strings that parse as JSON are redacted structurally before re-serialization.
 */
export function redactCredentials(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[REDACTED:CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const redacted = value.map((item) => redactValue(item, seen));
    seen.delete(value);
    return redacted;
  }
  const redacted = Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveKeyPart.test(key.replace(/[^a-z0-9]/gi, "")) ? "[REDACTED]" : redactValue(item, seen),
  ]));
  seen.delete(value);
  return redacted;
}

function redactString(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.stringify(redactValue(JSON.parse(trimmed) as unknown, new WeakSet<object>()));
    } catch {
      // Continue with textual redaction when the value only resembles JSON.
    }
  }
  return value
    .replace(/(["'](?:authorization|cookie|credential|password|passwd|secret|token|api.?key|private.?key)["']\s*:\s*["'])[^"'\r\n]*(["'])/gi, "$1[REDACTED]$2")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/([?&][^=&#]*(?:authorization|credential|password|secret|token|key)[^=&#]*=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\b((?:x[-_])?(?:api[-_]?key|auth[-_]?token|client[-_]?secret|authorization|cookie|password|private[-_]?key)\s*[:=]\s*)[^,;\r\n]+/gi, "$1[REDACTED]");
}
