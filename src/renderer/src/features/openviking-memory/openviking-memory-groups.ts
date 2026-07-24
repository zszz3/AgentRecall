import type { OpenVikingMemoryItem } from "../../../../core/openviking-memory";

export type OpenVikingMemoryCategory =
  | "identity"
  | "preferences"
  | "cases"
  | "experiences"
  | "events"
  | "trajectories"
  | "manual"
  | "other";

export interface OpenVikingMemoryGroup {
  key: OpenVikingMemoryCategory;
  label: { en: string; zh: string };
  memories: OpenVikingMemoryItem[];
}

const CATEGORIES: ReadonlyArray<{
  key: OpenVikingMemoryCategory;
  label: { en: string; zh: string };
}> = [
  { key: "identity", label: { en: "Identity", zh: "身份" } },
  { key: "preferences", label: { en: "Preferences", zh: "偏好" } },
  { key: "cases", label: { en: "Cases", zh: "案例" } },
  { key: "experiences", label: { en: "Experiences", zh: "经验" } },
  { key: "events", label: { en: "Events", zh: "事件" } },
  { key: "trajectories", label: { en: "Trajectories", zh: "轨迹" } },
  { key: "manual", label: { en: "Manual", zh: "手动" } },
  { key: "other", label: { en: "Other", zh: "其他" } },
];

const CATEGORY_KEYS = new Set<OpenVikingMemoryCategory>(
  CATEGORIES.map((category) => category.key),
);

export function groupOpenVikingMemories(
  memories: OpenVikingMemoryItem[],
): OpenVikingMemoryGroup[] {
  const grouped = new Map<OpenVikingMemoryCategory, OpenVikingMemoryItem[]>();
  for (const memory of memories) {
    const key = memoryCategory(memory);
    const bucket = grouped.get(key) ?? [];
    bucket.push(memory);
    grouped.set(key, bucket);
  }
  return CATEGORIES.flatMap((category) => {
    const items = grouped.get(category.key);
    return items?.length ? [{ ...category, memories: items }] : [];
  });
}

function memoryCategory(memory: OpenVikingMemoryItem): OpenVikingMemoryCategory {
  if (!memory.id) return "manual";
  const uriMatch = /^viking:\/\/user\/memories\/?([^/]*)/iu.exec(memory.id);
  const uriSegment = uriMatch?.[1]?.toLowerCase() ?? "";
  const source = memory.source?.trim().toLowerCase() ?? "";
  for (const candidate of [uriSegment, source]) {
    if (candidate === "identity.md" || candidate === "soul.md") return "identity";
    if (CATEGORY_KEYS.has(candidate as OpenVikingMemoryCategory)) {
      return candidate as OpenVikingMemoryCategory;
    }
  }
  return "other";
}
