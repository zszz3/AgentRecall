import { canonicalOpenVikingMemoryUri } from "./openviking-memory";
import {
  inferOpenVikingMemoryType,
  type OpenVikingMemoryChange,
} from "./openviking-memory-control";

export function parseOpenVikingMemoryDiff(
  content: string,
  userId: string,
): OpenVikingMemoryChange[] {
  const value = JSON.parse(content) as Record<string, unknown>;
  const operations = objectValue(value.operations);
  if (!operations) return [];
  const changes: OpenVikingMemoryChange[] = [];
  for (const [kind, key] of [["add", "adds"], ["update", "updates"], ["delete", "deletes"]] as const) {
    const values = Array.isArray(operations[key]) ? operations[key] : [];
    for (const candidate of values) {
      const record = objectValue(candidate);
      if (!record) continue;
      const uri = normalizeMemoryUri(stringValue(record.uri), userId);
      if (!uri) continue;
      changes.push({
        kind,
        uri,
        memoryType: stringValue(record.memory_type) || inferOpenVikingMemoryType(uri),
        ...(stringValue(record.before) ? { before: stringValue(record.before) } : {}),
        ...(stringValue(record.after) ? { after: stringValue(record.after) } : {}),
        ...(stringValue(record.deleted_content) ? { before: stringValue(record.deleted_content) } : {}),
      });
    }
  }
  return changes;
}

function normalizeMemoryUri(uri: string, userId: string): string {
  const normalized = uri.trim().replaceAll("\\", "/");
  try {
    return canonicalOpenVikingMemoryUri(normalized, userId);
  } catch {
    // OpenViking Memory Diff may use its internal memory/user/<id>/... path.
  }
  const prefix = `memory/user/${userId}/`;
  if (!normalized.startsWith(prefix)) return "";
  const suffix = normalized.slice(prefix.length);
  try {
    return canonicalOpenVikingMemoryUri(`viking://user/memories/${suffix}`, userId);
  } catch {
    return "";
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
