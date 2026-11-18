import { z } from "zod";
import { defineIpcRequest } from "./contract";

/** Data left on disk by the retired directory Memory feature. */
export interface LegacyMemoryDataStatus {
  present: boolean;
  sizeBytes: number;
}

export const LEGACY_MEMORY_DATA_IPC = {
  getStatus: defineIpcRequest("legacy-memory-data:get-status", z.tuple([])),
  remove: defineIpcRequest("legacy-memory-data:remove", z.tuple([])),
} as const;
