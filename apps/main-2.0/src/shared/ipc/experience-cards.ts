import { z } from "zod";
import type { MemoryCard, MemoryExtractionOverview } from "../../core/storage/types";
import { defineIpcRequest } from "./contract";

export type { MemoryCard, MemoryExtractionOverview };

export interface ExperienceCardStatus extends MemoryExtractionOverview {
  running: boolean;
  lastRunError: string | null;
}

export const EXPERIENCE_CARDS_IPC = {
  getStatus: defineIpcRequest("experience-cards:get-status", z.tuple([])),
  list: defineIpcRequest("experience-cards:list", z.tuple([z.object({
    query: z.string().max(1000),
    includeSuperseded: z.boolean(),
  }).strict()])),
  remove: defineIpcRequest("experience-cards:remove", z.tuple([z.string().min(1).max(64)])),
  retryFailed: defineIpcRequest("experience-cards:retry-failed", z.tuple([z.string().min(1).max(4096).nullable()])),
} as const;
