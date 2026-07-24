import type { IndexStatus } from "../../core/indexer";

export function coalesceIndexStatusForRender(
  current: IndexStatus | null,
  incoming: IndexStatus,
): IndexStatus {
  if (current?.running && incoming.running) return current;
  return incoming;
}
