import { z } from "zod";
import type { MemoryCard, MemoryCardEdit, MemoryExtractionOverview } from "../../core/postgres/memory-card-repository";
import { defineIpcRequest } from "./contract";

export type { MemoryCard, MemoryCardEdit, MemoryExtractionOverview };

export interface ExperienceCardStatus extends MemoryExtractionOverview {
  running: boolean;
  lastRunError: string | null;
}

const cardText = z.string().trim().min(1).max(4000);
const cardList = z.array(z.string().trim().min(1).max(500)).max(50);

const cardEdit = z.object({
  problem: cardText,
  solution: cardText,
  failedAttempts: cardList,
  keywords: cardList,
}).strict();

export const EXPERIENCE_CARDS_IPC = {
  getStatus: defineIpcRequest("experience-cards:get-status", z.tuple([])),
  list: defineIpcRequest("experience-cards:list", z.tuple([z.object({
    query: z.string().max(1000),
    includeSuperseded: z.boolean(),
  }).strict()])),
  edit: defineIpcRequest("experience-cards:edit", z.tuple([z.string().min(1).max(64), cardEdit])),
  remove: defineIpcRequest("experience-cards:remove", z.tuple([z.string().min(1).max(64)])),
  retryFailed: defineIpcRequest("experience-cards:retry-failed", z.tuple([z.string().min(1).max(4096).nullable()])),
} as const;
