import type { IndexStatus } from "../core/indexer";

export interface IndexProgressPublisher {
  publish(status: IndexStatus, force?: boolean): void;
}

export function createIndexProgressPublisher(
  publishStatus: (status: IndexStatus) => void,
  options: { minIntervalMs: number; now?: () => number },
): IndexProgressPublisher {
  const minIntervalMs = Math.max(0, options.minIntervalMs);
  const now = options.now ?? Date.now;
  let lastPublishedAt = Number.NEGATIVE_INFINITY;

  return {
    publish(status, force = false) {
      const publishedAt = now();
      if (!force && publishedAt - lastPublishedAt < minIntervalMs) return;
      lastPublishedAt = publishedAt;
      publishStatus(status);
    },
  };
}
